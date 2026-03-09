const express = require('express');
const { chromium } = require('playwright');
const https = require('https');
const Tesseract = require('tesseract.js');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// ─── Playwright Helper (Stealth Fetch) ──────────────────────────────────────
let _browser = null;
async function fetchSofaPlaywright(path) {
    if (!_browser) {
        _browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
    }
    const context = await _browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();
    try {
        const url = 'https://api.sofascore.com/api/v1' + path;
        console.log(`[PW] Fetching ${url}...`);
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        if (response.status() === 200) {
            return await response.json();
        } else {
            console.error(`[PW] Error ${response.status()}: ${path}`);
            return { events: [] };
        }
    } catch (e) {
        console.error(`[PW] Exception: ${e.message}`);
        return { events: [] };
    } finally {
        await page.close();
        await context.close();
    }
}
let lastSofaStatus = 200;
let lastSofaError = null;

function fetchSofa(path) {
    return new Promise(async (resolve, reject) => {
        lastSofaError = null;
        const options = {
            hostname: 'api.sofascore.com',
            path: '/api/v1' + path,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Accept-Language': 'en-US,en;q=0.9',
                'Host': 'api.sofascore.com'
            }
        };
        const req = https.request(options, (res) => {
            lastSofaStatus = res.statusCode;
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    if (res.statusCode === 403 || res.statusCode === 429) {
                        console.warn(`[!] Sofa ${res.statusCode} detectado. Usando Playwright Fallback...`);
                        const pwData = await fetchSofaPlaywright(path);
                        return resolve(pwData);
                    }
                    if (res.statusCode !== 200) {
                        lastSofaError = `Sofa Error ${res.statusCode}`;
                        console.error(`[-] Sofa Error ${res.statusCode}: ${data.slice(0, 100)}`);
                        return resolve({ events: [] });
                    }
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    lastSofaError = e.message;
                    reject(new Error('JSON parse error: ' + data.slice(0, 200)));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

// ─── Helper: Is ATP/WTA single ───────────────────────────────────────────────
function isAtpWtaSingles(event) {
    const catSlug = (event?.tournament?.category?.slug || '').toLowerCase();
    const catName = (event?.tournament?.category?.name || '').toLowerCase();
    const isAtpWta = catSlug === 'atp' || catSlug.startsWith('wta') || catName.includes('atp') || catName.includes('wta');
    if (!isAtpWta) return false;
    // Exclude doubles
    const home = event?.homeTeam?.name || event?.homeTeam?.shortName || '';
    const away = event?.awayTeam?.name || event?.awayTeam?.shortName || '';
    if (home.includes(' / ') || away.includes(' / ')) return false;
    return true;
}

// ─── Helper: Pack a SofaScore event into our standard format ────────────────
function packTennisEvent(ev, isLive) {
    const hs = ev?.homeScore || {};
    const as = ev?.awayScore || {};
    const sets = (Number.isFinite(hs.current) && Number.isFinite(as.current))
        ? `${hs.current}-${as.current}` : null;
    const ph = [hs.period1, hs.period2, hs.period3, hs.period4, hs.period5].filter(Number.isFinite);
    const pa = [as.period1, as.period2, as.period3, as.period4, as.period5].filter(Number.isFinite);
    let games = null;
    if (ph.length && pa.length) games = `${ph[ph.length - 1]}-${pa[pa.length - 1]}`;
    const scoreLabel = sets ? (games ? `Sets ${sets} · Games ${games}` : `Sets ${sets}`) : (games || '');

    return {
        home: ev?.homeTeam?.shortName || ev?.homeTeam?.name || 'Jugador 1',
        away: ev?.awayTeam?.shortName || ev?.awayTeam?.name || 'Jugador 2',
        tournament: ev?.tournament?.uniqueTournament?.name || ev?.tournament?.name || '',
        status: isLive ? (scoreLabel || 'En juego') : new Date((ev?.startTimestamp || 0) * 1000).toISOString(),
        isLive,
        score: sets ? { home: String(hs.current ?? ''), away: String(as.current ?? '') } : null,
        sofaEventId: ev.id,
        sport: 'tennis'
    };
}

// ─── Helper: Pack a SofaScore Football event ──────────────────────────────
function packFootballEvent(ev, isLive) {
    const hs = ev?.homeScore || {};
    const as = ev?.awayScore || {};
    const scoreText = `${hs.current ?? 0}-${as.current ?? 0}`;
    const time = ev?.status?.description || ''; // e.g. "90'", "HT", "FT"
    const elapsed = ev?.status?.type === 'inprogress' ? (parseInt(time) || 0) : 0;

    return {
        home: ev?.homeTeam?.shortName || ev?.homeTeam?.name || 'Local',
        away: ev?.awayTeam?.shortName || ev?.awayTeam?.name || 'Visitante',
        tournament: ev?.tournament?.uniqueTournament?.name || ev?.tournament?.name || '',
        status: isLive ? (time || 'En juego') : new Date((ev?.startTimestamp || 0) * 1000).toISOString(),
        isLive,
        score: { home: String(hs.current ?? 0), away: String(as.current ?? 0) },
        elapsed: elapsed,
        sofaEventId: ev.id,
        sport: 'football'
    };
}


// ─── Helper: Today + Tomorrow in YYYY-MM-DD UTC ─────────────────────────────
function utcDates(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ─── ENDPOINT: TENIS LIVE + PRÓXIMOS (SofaScore direct fetch) ───────────────
app.get('/api/tennis/live', async (req, res) => {
    try {
        console.log('[GET] /api/tennis/live');

        // 1. Live matches
        const liveData = await fetchSofa('/sport/tennis/events/live').catch(e => {
            console.error('[-] Tennis Live Fetch Error:', e.message);
            return { events: [] };
        });

        let liveEvents = (liveData?.events || []).filter(isAtpWtaSingles);
        if (!liveEvents.length && liveData?.events?.length) {
            console.log('[!] No ATP/WTA singles found, falling back to any live tennis');
            liveEvents = liveData.events.slice(0, 10);
        }

        // 2. Scheduled: today + tomorrow
        const dates = [0, 1].map(utcDates);
        const scheduledPacks = await Promise.all(dates.map(d =>
            fetchSofa(`/sport/tennis/scheduled-events/${d}`).catch(() => ({ events: [] }))
        ));
        const nowSec = Math.floor(Date.now() / 1000);
        const scheduledEvents = scheduledPacks
            .flatMap(p => p?.events || [])
            .filter(e => e && e.id && (e.startTimestamp || 0) >= nowSec - 600);

        // 3. Merge (live first, then upcoming), deduplicate
        const seen = new Set(liveEvents.map(e => e.id));
        const upcoming = scheduledEvents.filter(e => !seen.has(e.id)).slice(0, 10);

        let events = [
            ...liveEvents.map(e => packTennisEvent(e, true)),
            ...upcoming.map(e => packTennisEvent(e, false))
        ].slice(0, 15);

        // Fallback: TheSportsDB si SofaScore falla
        if (!events.length) {
            console.log('[!] Tennis: SofaScore 403/Empty, attempting TheSportsDB fallback...');
            try {
                const resTS = await new Promise(r => {
                    https.get('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Tennis', (res) => {
                        let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
                    }).on('error', () => r(null));
                });
                if (resTS?.events) {
                    events = resTS.events.map(ev => ({
                        home: ev.strHomeTeam,
                        away: ev.strAwayTeam,
                        tournament: ev.strLeague,
                        status: ev.strStatus,
                        isLive: true,
                        score: { home: ev.intHomeScore, away: ev.intAwayScore },
                        idEvent: ev.idEvent,
                        sport: 'tennis'
                    }));
                }
            } catch (e) { }
        }

        console.log(`[+] Tennis events sent: ${events.length}`);
        res.json({
            success: true,
            count: events.length,
            events,
            debug: { status: lastSofaStatus, error: lastSofaError }
        });
    } catch (error) {
        console.error('[-] /api/tennis/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [], debug: { error: error.message } });
    }
});


// ─── Flashscore Football Scraper (Playwright) ───────────────────────────────
async function scrapeFlashscoreFootball() {
    console.log('[+] Scraping Flashscore for Football...');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();
    let matches = [];

    try {
        await page.goto('https://www.flashscore.es/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.event__match', { timeout: 15000 }).catch(() => { });

        matches = await page.evaluate(() => {
            const results = [];
            const nodes = document.querySelectorAll('.event__match');
            nodes.forEach(node => {
                let tournament = 'Desconocido';
                let prev = node.previousElementSibling;
                while (prev) {
                    if (prev.classList.contains('event__header')) {
                        const t = prev.querySelector('.event__title--name');
                        tournament = t ? t.textContent.trim() : '';
                        break;
                    }
                    prev = prev.previousElementSibling;
                }
                const txtT = tournament.toLowerCase();
                const isWanted = txtT.includes('laliga') || txtT.includes('primera') || txtT.includes('premier league') || txtT.includes('champions') || txtT.includes('liga española');
                if (!isWanted) return;

                const home = node.querySelector('.event__participant--home')?.textContent.trim() || 'Local';
                const away = node.querySelector('.event__participant--away')?.textContent.trim() || 'Visitante';
                const stageNode = node.querySelector('.event__stage');
                const timeNode = node.querySelector('.event__time');
                const isLive = node.classList.contains('event__match--live') || !!stageNode;
                const status = isLive ? (stageNode?.textContent.trim() || 'En juego') : (timeNode?.textContent.trim() || '');
                const homeScore = node.querySelector('.event__score--home')?.textContent.trim() || '0';
                const awayScore = node.querySelector('.event__score--away')?.textContent.trim() || '0';
                results.push({ tournament, home, away, status, isLive, score: { home: homeScore, away: awayScore } });
            });
            return results;
        });
        console.log(`[+] Football matches: ${matches.length}`);
    } catch (e) {
        console.error('[-] Football scraping error:', e.message);
    } finally {
        await browser.close();
    }
    return matches;
}

// ─── ENDPOINT: FUTBOL LIVE (SofaScore API) ──────────────────────────────────
app.get('/api/football/live', async (req, res) => {
    try {
        console.log('[GET] /api/football/live');

        // 1. Live matches
        const liveData = await fetchSofa('/sport/football/events/live').catch(e => {
            console.error('[-] Football Live Fetch Error:', e.message);
            return { events: [] };
        });

        // Filtrar por ligas importantes para evitar ruido
        const importantLeagues = ['laliga', 'premier league', 'serie a', 'bundesliga', 'ligue 1', 'champions league', 'europa league', 'eredivisie', 'liga portugal', 'brazil', 'argentina', 'colombia', 'mexico', 'fa cup', 'copa del rey'];
        let liveEvents = (liveData?.events || []).filter(e => {
            const t = (e?.tournament?.uniqueTournament?.name || e?.tournament?.name || '').toLowerCase();
            return importantLeagues.some(L => t.includes(L));
        });

        // Fallback: si no hay "importantes", permitimos cualquier partido de ligas de primer nivel (Categoría "Soccer")
        if (!liveEvents.length && liveData?.events?.length) {
            console.log('[!] No "important" live matches, returning top 10 general live');
            liveEvents = liveData.events.slice(0, 10);
        }

        // 2. Scheduled today
        const today = utcDates(0);
        const scheduledData = await fetchSofa(`/sport/football/scheduled-events/${today}`).catch(e => {
            console.error('[-] Football Scheduled Fetch Error:', e.message);
            return { events: [] };
        });
        const nowSec = Math.floor(Date.now() / 1000);
        const upcomingEvents = (scheduledData?.events || []).filter(e => {
            if (!e || (e.startTimestamp || 0) < nowSec - 600) return false;
            const t = (e?.tournament?.uniqueTournament?.name || e?.tournament?.name || '').toLowerCase();
            return importantLeagues.some(L => t.includes(L));
        });

        const seen = new Set(liveEvents.map(e => e.id));
        const finalUpcoming = upcomingEvents.filter(e => !seen.has(e.id)).slice(0, 8);

        let events = [
            ...liveEvents.map(e => packFootballEvent(e, true)),
            ...finalUpcoming.map(e => packFootballEvent(e, false))
        ].slice(0, 15);

        // Fallback: TheSportsDB si SofaScore falla (403 detectado)
        if (!events.length || lastSofaStatus !== 200) {
            console.log('[!] Football: SofaScore 403/Empty, attempting TheSportsDB fallback...');
            try {
                const resTS = await new Promise(r => {
                    https.get('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer', (res) => {
                        let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
                    }).on('error', () => r(null));
                });
                if (resTS?.events) {
                    const tsEvents = resTS.events.map(ev => ({
                        home: ev.strHomeTeam,
                        away: ev.strAwayTeam,
                        tournament: ev.strLeague,
                        status: ev.strStatus + (ev.intElapsed ? ` ${ev.intElapsed}'` : ''),
                        isLive: true,
                        score: { home: ev.intHomeScore, away: ev.intAwayScore },
                        matchMins: parseInt(ev.intElapsed) || 0,
                        idEvent: ev.idEvent,
                        sport: 'football'
                    }));
                    events = [...events, ...tsEvents].slice(0, 15);
                }
            } catch (e) { console.error('TSDB Error:', e.message); }
        }

        console.log(`[+] Football events sent: ${events.length}`);
        res.json({
            success: true,
            count: events.length,
            events,
            debug: { status: lastSofaStatus, error: lastSofaError }
        });
    } catch (error) {
        console.error('[-] /api/football/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [], debug: { error: error.message } });
    }
});

app.get('/api/debug', async (req, res) => {
    try {
        console.log('[GET] /api/debug');
        const data = await fetchSofa('/sport/football/events/live');
        res.json({
            success: true,
            lastSofaStatus,
            lastSofaError,
            sampleData: data?.events ? data.events.slice(0, 1) : null
        });
    } catch (e) {
        res.json({ success: false, error: e.message, lastSofaStatus, lastSofaError });
    }
});

// ─── ENDPOINT: GENERIC EVENT DETAILS (Polling) ──────────────────────────────
app.get('/api/event/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[GET] /api/event/${id}`);
        const data = await fetchSofa(`/event/${id}`);
        const ev = data?.event;
        if (!ev) return res.status(404).json({ success: false, error: 'Event not found' });

        const isTennis = (ev.sport?.slug === 'tennis');
        const packed = isTennis ? packTennisEvent(ev, true) : packFootballEvent(ev, true);

        res.json({ success: true, event: packed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ─── ENDPOINT: SCREENSHOT + OCR (Nuclear Fallback) ──────────────────────────
app.get('/api/screenshot', async (req, res) => {
    const sport = req.query.sport || 'tennis';
    console.log(`[OCR] Requesting screenshot for ${sport}...`);

    if (!_browser) {
        _browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
    }
    const context = await _browser.newContext({
        viewport: { width: 400, height: 900 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();
    try {
        const url = `https://www.sofascore.com/${sport}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Esperar a que los partidos aparezcan visualmente
        await page.waitForTimeout(5000);

        const screenshotPath = `screenshot-${sport}.png`;
        await page.screenshot({ path: screenshotPath });
        console.log(`[OCR] Screenshot saved: ${screenshotPath}`);

        // OCR con Tesseract.js
        const { data: { text } } = await Tesseract.recognize(screenshotPath, 'eng+spa');
        console.log(`[OCR] Text extracted (${text.length} chars)`);

        res.json({
            success: true,
            sport,
            ocrText: text,
            info: "Screenshot taken and OCR processed. Bypasses 403 API blocks."
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    } finally {
        await page.close();
        await context.close();
    }
});

app.get('/', (req, res) => {
    res.send('Bolita API 🎾⚽ · /api/tennis/live · /api/football/live');
});

app.listen(PORT, () => {
    console.log(`🚀 API iniciada en puerto ${PORT}`);
});
