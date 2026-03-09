const express = require('express');
const { chromium } = require('playwright');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// ─── Helper: Fetch JSON from SofaScore (works fine server-side) ─────────────
function fetchSofa(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.sofascore.com',
            path: '/api/v1' + path,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.sofascore.com/',
                'Origin': 'https://www.sofascore.com'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
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
        sofaEventId: ev.id
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
        const liveData = await fetchSofa('/sport/tennis/events/live').catch(() => ({ events: [] }));
        const liveEvents = (liveData?.events || []).filter(isAtpWtaSingles);

        // 2. Scheduled: today + tomorrow
        const dates = [0, 1].map(utcDates);
        const scheduledPacks = await Promise.all(dates.map(d =>
            fetchSofa(`/sport/tennis/scheduled-events/${d}`).catch(() => ({ events: [] }))
        ));
        const nowSec = Math.floor(Date.now() / 1000);
        const scheduledEvents = scheduledPacks
            .flatMap(p => p?.events || [])
            .filter(e => e && e.id && isAtpWtaSingles(e) && (e.startTimestamp || 0) >= nowSec - 600);

        // 3. Merge (live first, then upcoming), deduplicate
        const seen = new Set(liveEvents.map(e => e.id));
        const upcoming = scheduledEvents.filter(e => !seen.has(e.id));

        const events = [
            ...liveEvents.map(e => packTennisEvent(e, true)),
            ...upcoming.map(e => packTennisEvent(e, false))
        ].slice(0, 10);

        if (!events.length) {
            // If no ATP/WTA, try any tennis live
            const anyLive = (liveData?.events || []).filter(e => {
                const catName = (e?.tournament?.category?.name || '').toLowerCase();
                return catName.includes('tennis') || catName.includes('tenis');
            });
            if (anyLive.length) {
                return res.json({ success: true, count: anyLive.length, events: anyLive.slice(0, 6).map(e => packTennisEvent(e, true)) });
            }
        }

        res.json({ success: true, count: events.length, events });
    } catch (error) {
        console.error('[-] /api/tennis/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [] });
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

// ─── ENDPOINT: FUTBOL LIVE (Playwright) ─────────────────────────────────────
app.get('/api/football/live', async (req, res) => {
    try {
        console.log('[GET] /api/football/live');
        const data = await scrapeFlashscoreFootball();
        res.json({ success: true, count: data.length, events: data });
    } catch (error) {
        console.error('[-] /api/football/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [] });
    }
});

app.get('/', (req, res) => {
    res.send('Bolita API 🎾⚽ · /api/tennis/live · /api/football/live');
});

app.listen(PORT, () => {
    console.log(`🚀 API iniciada en puerto ${PORT}`);
});
const express = require('express');
const { chromium } = require('playwright');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// ─── Helper: Fetch JSON from SofaScore (works fine server-side) ─────────────
function fetchSofa(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.sofascore.com',
            path: '/api/v1' + path,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.sofascore.com/',
                'Origin': 'https://www.sofascore.com'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
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
        sofaEventId: ev.id
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
        const liveData = await fetchSofa('/sport/tennis/events/live').catch(() => ({ events: [] }));
        const liveEvents = (liveData?.events || []).filter(isAtpWtaSingles);

        // 2. Scheduled: today + tomorrow
        const dates = [0, 1].map(utcDates);
        const scheduledPacks = await Promise.all(dates.map(d =>
            fetchSofa(`/sport/tennis/scheduled-events/${d}`).catch(() => ({ events: [] }))
        ));
        const nowSec = Math.floor(Date.now() / 1000);
        const scheduledEvents = scheduledPacks
            .flatMap(p => p?.events || [])
            .filter(e => e && e.id && isAtpWtaSingles(e) && (e.startTimestamp || 0) >= nowSec - 600);

        // 3. Merge (live first, then upcoming), deduplicate
        const seen = new Set(liveEvents.map(e => e.id));
        const upcoming = scheduledEvents.filter(e => !seen.has(e.id));

        const events = [
            ...liveEvents.map(e => packTennisEvent(e, true)),
            ...upcoming.map(e => packTennisEvent(e, false))
        ].slice(0, 10);

        if (!events.length) {
            // If no ATP/WTA, try any tennis live
            const anyLive = (liveData?.events || []).filter(e => {
                const catName = (e?.tournament?.category?.name || '').toLowerCase();
                return catName.includes('tennis') || catName.includes('tenis');
            });
            if (anyLive.length) {
                return res.json({ success: true, count: anyLive.length, events: anyLive.slice(0, 6).map(e => packTennisEvent(e, true)) });
            }
        }

        res.json({ success: true, count: events.length, events });
    } catch (error) {
        console.error('[-] /api/tennis/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [] });
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

// ─── ENDPOINT: FUTBOL LIVE (Playwright) ─────────────────────────────────────
app.get('/api/football/live', async (req, res) => {
    try {
        console.log('[GET] /api/football/live');
        const data = await scrapeFlashscoreFootball();
        res.json({ success: true, count: data.length, events: data });
    } catch (error) {
        console.error('[-] /api/football/live error:', error.message);
        res.status(500).json({ success: false, error: error.message, events: [] });
    }
});

app.get('/', (req, res) => {
    res.send('Bolita API 🎾⚽ · /api/tennis/live · /api/football/live');
});

app.listen(PORT, () => {
    console.log(`🚀 API iniciada en puerto ${PORT}`);
});

