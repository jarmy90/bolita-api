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
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...headers
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

// ─── TENNIS: SCRAPER LIGERO (TENNISLIVE.NET) ───────────────────────────────
async function scrapeTennisLiveLight() {
    try {
        console.log('[Tennis] Scrapeando TennisLive.net...');
        const { body } = await fetchURL('https://www.tennislive.net/');

        const events = [];
        // Regex para encontrar tablas de partidos
        const tableRegex = /<table class="table_stats_match">([\s\S]*?)<\/table>/g;
        let matchTable;

        while ((matchTable = tableRegex.exec(body)) !== null) {
            const content = matchTable[1];

            // Extraer jugadores
            const playerRegex = /<td class="player[12]">.*?title="([^"]+)"/g;
            const players = [];
            let p;
            while ((p = playerRegex.exec(content)) !== null) players.push(p[1]);

            if (players.length >= 2) {
                // Extraer marcador de sets
                const scoreRegex = /<td class="score">([^<]*)<\/td>/g;
                const scores = [];
                let s;
                while ((s = scoreRegex.exec(content)) !== null) scores.push(s[1].trim());

                // Puntos actuales (si está en vivo)
                const pointMatch = content.match(/<td class="points">([^<]*)<\/td>/);
                const points = pointMatch ? pointMatch[1].trim() : '';
                const isLive = content.includes('live_score_ongoing') || points !== '';

                events.push({
                    home: players[0],
                    away: players[1],
                    tournament: 'Tennis Live',
                    status: isLive ? (points ? `Puntos: ${points}` : 'En juego') : 'Próximamente',
                    isLive,
                    score: scores.length >= 2 ? { home: scores[0], away: scores[1] } : null,
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
            console.log(`[!] Proxy devolvió ${status}. Intentando fallback a TheSportsDB...`);
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
            status: ev.strStatus + (ev.intElapsed ? ` ${ev.intElapsed}'` : ''),
            isLive: true,
            score: { home: ev.intHomeScore, away: ev.intAwayScore },
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
    res.json({ success: true, count: events.length, events });
});

app.get('/', (req, res) => {
    res.send('Bolita API Ligera 🚀 · /api/tennis/live · /api/football/live');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor ligero corriendo en puerto ${PORT}`);
});
