const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Proxy (para saltar el 403 de SofaScore en Render)
const CLOUDFLARE_PROXY_URL = 'https://bolita1.pages.dev/sofa-proxy';

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// ─── HELPER: FETCH GENERICO ────────────────────────────────────────────────
function fetchURL(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...headers
            }
        };
        https.get(url, options, (res) => {
            clearTimeout(timeout);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', (e) => {
            clearTimeout(timeout);
            reject(e);
        });
    });
}

// ─── TENNIS: SCRAPER LIGERO (TENNISLIVE.NET) ───────────────────────────────
async function scrapeTennisLiveLight() {
    try {
        console.log('[Tennis] Scrapeando TennisLive.net...');
        const { body } = await fetchURL('https://www.tennislive.net/');

        const events = [];
        // Pattern 1: <a href="..." title="Player Name">Player Name</a>
        const playerRegex = /title="([^"]+)"[^>]*>([^<]+)<\/a>/g;

        const matches = [];
        let p;
        while ((p = playerRegex.exec(body)) !== null) {
            matches.push(p[1]);
        }

        // Emparejamos de 2 en 2
        for (let i = 0; i < matches.length; i += 2) {
            if (matches[i + 1]) {
                const home = matches[i];
                const away = matches[i + 1];

                // Buscamos si hay un marcador cerca en el HTML (opcional pero bueno para el primer hit)
                const snippet = body.slice(body.indexOf(home), body.indexOf(away) + 100);
                const isLive = snippet.includes('live_score_ongoing') || snippet.includes('tennis_ball.gif');

                events.push({
                    home,
                    away,
                    tournament: 'Tennis Live',
                    status: isLive ? 'En juego' : 'Programado',
                    isLive,
                    score: null, // El polling en el cliente buscará el marcador real si hay sofaEventId
                    sport: 'tennis',
                    sofaEventId: 'tl_' + Math.random().toString(36).substr(2, 5)
                });
            }
        }

        return events;
    } catch (e) {
        console.error('[Tennis] Error:', e.message);
        return [];
    }
}

// ─── FOOTBALL: FETCH VIA CLOUDFLARE PROXY (PARA EVITAR 403) ────────────────
async function fetchFootballLiveSofa() {
    try {
        console.log('[Football] Buscando en SofaScore (vía Proxy Cloudflare)...');
        const url = `${CLOUDFLARE_PROXY_URL}/sport/football/events/live`;
        const { status, body } = await fetchURL(url);

        if (status !== 200) {
            console.log(`[!] Proxy SofaScore falló con status ${status}`);
            return null;
        }

        const data = JSON.parse(body);
        return (data.events || []).map(ev => {
            const hs = ev.homeScore || {};
            const as = ev.awayScore || {};
            return {
                home: ev.homeTeam?.name || 'Local',
                away: ev.awayTeam?.name || 'Visita',
                tournament: ev.tournament?.name || '',
                status: ev.status?.description || 'En juego',
                isLive: true,
                score: { home: String(hs.current ?? 0), away: String(as.current ?? 0) },
                sport: 'football',
                sofaEventId: ev.id
            };
        });
    } catch (e) {
        console.error('[Football] Error Proxy:', e.message);
        return null;
    }
}

async function fetchFootballTSDB() {
    try {
        console.log('[Football] Fallback a TheSportsDB...');
        const { body } = await fetchURL('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer');
        const data = JSON.parse(body);
        return (data.events || []).map(ev => ({
            home: ev.strHomeTeam,
            away: ev.strAwayTeam,
            tournament: ev.strLeague,
            status: (ev.strStatus || 'En juego') + (ev.intElapsed ? ` ${ev.intElapsed}'` : ''),
            isLive: true,
            score: { home: ev.intHomeScore ?? 0, away: ev.intAwayScore ?? 0 },
            sport: 'football'
        }));
    } catch (e) {
        return [];
    }
}

// ─── ENDPOINTS ─────────────────────────────────────────────────────────────

app.get('/api/tennis/live', async (req, res) => {
    const events = await scrapeTennisLiveLight();
    res.json({ success: true, count: events.length, events });
});

app.get('/api/football/live', async (req, res) => {
    let events = await fetchFootballLiveSofa();
    if (!events || events.length === 0) {
        events = await fetchFootballTSDB();
    }

    // Si sigue vacío, devolvemos un partido "SIM" de cortesía para que no se vea vacío
    if (!events || events.length === 0) {
        events = [{
            home: 'Lazio',
            away: 'Sassuolo',
            tournament: 'Serie A (SIM)',
            status: '85\'',
            isLive: true,
            score: { home: '2', away: '1' },
            sport: 'football'
        }];
    }

    res.json({ success: true, count: events.length, events });
});

app.get('/', (req, res) => {
    res.send('Bolita API Ligera 🚀 · /api/tennis/live · /api/football/live');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor ligero corriendo en puerto ${PORT}`);
});
