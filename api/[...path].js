const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.sofascore.com/"
};

// Fallback Key - Solo para RapidAPI
const RAPIDAPI_KEY_FALLBACK = 'cee67db165msh378621ca28d8f88p1864cajsn0146cc2e8169';

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

function isWithinUpcomingWindow(kickoffMs) {
    if (!kickoffMs) return false;
    const now = Date.now();
    return kickoffMs >= now - 30 * 60 * 1000 && kickoffMs <= now + 12 * 60 * 60 * 1000;
}

function isFromToday(kickoffMs) {
    if (!kickoffMs) return true;
    const kickoffDate = new Date(kickoffMs).toISOString().slice(0, 10);
    const nowStr = new Date().toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return kickoffDate === nowStr || kickoffDate === yesterdayStr;
}

// Handler Principal para Vercel Serverless
export default async function handler(req, res) {
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || RAPIDAPI_KEY_FALLBACK;

    // CORS (No es estrictamente necesario si web y app están en Vercel, pero por si acaso)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    // Normalizar ruta (ej: /api/tennis/live -> /tennis/live)
    let urlPath = req.url.split('?')[0];
    let path = urlPath.toLowerCase();
    if (path.startsWith("/api/")) path = path.slice(4);
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (!path || path === "/api") path = "/";

    const CACHE_TTL_SEC = 30;

    const sendJson = (data, status = 200, cacheSec = CACHE_TTL_SEC) => {
        if (status === 200 && cacheSec > 0) {
            // Caché en la red Edge de Vercel
            res.setHeader('Cache-Control', `s-maxage=${cacheSec}, stale-while-revalidate`);
        } else {
            res.setHeader('Cache-Control', 'no-store');
        }
        res.status(status).json(data);
    };

    // ─── RUTAS ───────────────────────────────────────────────────────────

    if (path === "/") {
        return sendJson({
            ok: true,
            status: "Vercel Perfection Mode Online 💎",
            message: "Has migrado exitosamente a Vercel. Despídete de los bloqueos de Cloudflare.",
            endpoints: ["/test", "/debug", "/football/live", "/football/upcoming", "/tennis/live", "/tennis/upcoming", "/tennis/pbp/:id", "/event/:sport/:id"]
        });
    }

    if (path === "/test") {
        return sendJson({
            ok: true,
            version: "3.0-Vercel",
            api_key_source: process.env.RAPIDAPI_KEY ? "environment_secrets" : "hardcoded_fallback",
            time: new Date().toISOString()
        });
    }

    if (path === "/debug") {
        const results = { _timestamp: new Date().toISOString() };
        try {
            results.sofa_native_live_tennis = await fetchSofaNative('tennis', 'live').catch(e => ({error: e.message}));
            results.sofa_native_live_football = await fetchSofaNative('football', 'live').catch(e => ({error: e.message}));
        } catch (e) { results._error = e.message; }
        return sendJson({ success: true, results }, 200, 0); // debug sin caché
    }

    // --- EVENT DATA ---
    if (path.startsWith("/event/")) {
        const parts = path.split('/');
        const sport = parts[2];
        const id = parts[3]?.replace('sofa_', '').trim();
        try {
            const r = await fetch(`https://api.sofascore.com/api/v1/event/${id}`, { headers: COMMON_HEADERS });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (data.event) {
                return sendJson({ success: true, event: normalizeSofaEvent(data.event, sport, true) });
            }
            return sendJson({ success: false, error: "Event not found" }, 404, 0);
        } catch (e) {
            return sendJson({ success: false, error: e.message }, 500, 0);
        }
    }

    // --- FOOTBALL & TENNIS LIVE ---
    if (path === "/football/live" || path === "/tennis/live") {
        // En Vercel usamos req.query en vez de url.searchParams
        const isNocache = req.query?.nocache === '1' || req.url.includes('nocache=1');
        const sport = path.includes("tennis") ? "tennis" : "football";
        try {
            // 1) Sofa Native (Free & Best)
            let events = await fetchSofaNative(sport, 'live');
            
            // 2) Rapid Fallbacks
            if (!Array.isArray(events) || events.length === 0) {
                if (sport === 'football') {
                    events = await fetchSofaLive('football', RAPIDAPI_KEY);
                    if (!events.length) events = await fetchAPIFootball(RAPIDAPI_KEY);
                } else {
                    events = await fetchSofaLive('tennis', RAPIDAPI_KEY);
                }
            }

            // Global Filter: No expired/today only + Only Live
            events = (events || []).filter(e => e.sport === sport && isFromToday(e.kickoffMs) && e.isLive);
            
            return sendJson({ success: true, count: events.length, events }, 200, isNocache ? 0 : CACHE_TTL_SEC);
        } catch (e) {
            return sendJson({ success: false, error: e.message }, 500, 0);
        }
    }

    // --- UPCOMING ---
    if (path === "/football/upcoming" || path === "/tennis/upcoming") {
        const isNocache = req.query?.nocache === '1' || req.url.includes('nocache=1');
        const sport = path.includes("tennis") ? "tennis" : "football";
        try {
            let events = await fetchSofaNative(sport, 'scheduled');
            if (!Array.isArray(events) || events.length === 0) {
                events = await fetchSofaUpcoming(sport, RAPIDAPI_KEY);
            }

            events = (events || []).filter(e => !e.isLive && isWithinUpcomingWindow(e.kickoffMs));
            events.sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));

            return sendJson({ success: true, count: events.length, events }, 200, isNocache ? 0 : CACHE_TTL_SEC);
        } catch (e) {
            return sendJson({ success: false, error: e.message }, 500, 0);
        }
    }

    // --- POINT-BY-POINT ---
    if (path.startsWith("/tennis/pbp/")) {
        const id = path.split('/')[3]?.replace('sofa_', '').trim();
        try {
            const data = await fetchSofaIncidentsNative(id);
            if (!data?.error) {
                return sendJson({ success: true, source: "sofa_native", eventId: id, incidents: data.incidents || [] }, 200, 0);
            }
            const rapid = await fetchRapidJSON('sportapi7.p.rapidapi.com', `/api/v1/event/${id}/point-by-point`, RAPIDAPI_KEY);
            return sendJson({ success: true, source: "rapid_fallback", eventId: id, data: rapid }, 200, 0);
        } catch (e) {
            return sendJson({ success: false, error: e.message }, 500, 0);
        }
    }

    return sendJson({ ok: false, error: "Not found", path }, 404, 0);
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

async function fetchRapidJSON(host, endpoint, key, params = {}) {
    const query = new URLSearchParams(params).toString();
    const url = `https://${host}${endpoint}${query ? '?' + query : ''}`;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "x-rapidapi-key": key,
                "x-rapidapi-host": host
            }
        });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return await res.json();
    } catch (e) { return { error: e.message }; }
}

async function fetchSofaNative(sport, type = 'live') {
    const today = todayUTC();
    const endpoint = type === 'live' 
        ? `https://api.sofascore.com/api/v1/sport/${sport}/events/live`
        : `https://api.sofascore.com/api/v1/sport/${sport}/scheduled-events/${today}`;
        
    const res = await fetch(endpoint, { headers: COMMON_HEADERS });
    if (!res.ok) return [];
    
    const data = await res.json();
    if (!data?.events) return [];
    
    return data.events
        .filter(ev => isEliteTournament(ev, sport))
        .filter(ev => {
            if (type !== 'live') return true;
            const status = (ev.status?.type || '').toLowerCase();
            return status !== 'finished' && status !== 'ended';
        })
        .map(ev => normalizeSofaEvent(ev, sport, type === 'live'))
        .slice(0, 15);
}

async function fetchSofaIncidentsNative(eventId) {
    const endpoint = `https://api.sofascore.com/api/v1/event/${eventId}/incidents`;
    const res = await fetch(endpoint, { headers: COMMON_HEADERS });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
}

function isEliteTournament(ev, sport) {
    const tName = (ev.tournament?.name || '').toLowerCase();
    const cName = (ev.tournament?.category?.name || '').toLowerCase();
    
    if (sport === 'football') {
        const top = ['premier league', 'la liga', 'laliga', 'champions league', 'serie a', 'bundesliga', 'ligue 1', 'copa del rey'];
        return top.some(x => tName.includes(x) || cName.includes(x));
    }
    
    if (sport === 'tennis') {
        const top = ['atp', 'wta', 'grand slam', 'indian wells', 'miami', 'madrid', 'roma', 'paris', 'open', 'master', 'cup', 'bnp paribas'];
        if (!top.some(x => tName.includes(x) || cName.includes(x))) return false;

        const hN = (ev.homeTeam?.name || '').toLowerCase();
        const aN = (ev.awayTeam?.name || '').toLowerCase();
        if (hN.includes('/') || aN.includes('/') || hN.includes('&') || aN.includes('&')) return false;

        const blocked = ['challenger', 'itf', 'junior', 'exhibition', 'qualifying'];
        return !blocked.some(x => tName.includes(x) || cName.includes(x));
    }
    return false;
}

function normalizeSofaEvent(ev, sport, isLive) {
    const hS = ev.homeScore || {};
    const aS = ev.awayScore || {};
    const statusType = (ev.status?.type || '').toLowerCase();
    const finalized = statusType === 'finished' || statusType === 'ended';

    const setsHome = [], setsAway = [];
    if (sport === 'tennis') {
        for (let i = 1; i <= 3; i++) {
            if (hS[`period${i}`] !== undefined) {
                setsHome.push(String(hS[`period${i}`]));
                setsAway.push(String(aS[`period${i}`]));
            }
        }
    }
    return {
        home: ev.homeTeam?.name || 'Home',
        away: ev.awayTeam?.name || 'Away',
        tournament: ev.tournament?.name || '',
        status: ev.status?.description || (isLive ? 'Live' : 'Upcoming'),
        isLive: isLive && !finalized,
        score: {
            home: String(hS.current ?? '0'),
            away: String(aS.current ?? '0'),
            pointH: hS.point ?? '0',
            pointA: aS.point ?? '0',
            setsHome, setsAway
        },
        kickoffMs: ev.startTimestamp ? ev.startTimestamp * 1000 : null,
        sport,
        eid: `sofa_${ev.id}`,
        sofaId: ev.id
    };
}

async function fetchSofaLive(sport, key) {
    const d = await fetchRapidJSON('sportapi7.p.rapidapi.com', `/api/v1/sport/${sport}/events/live`, key);
    return (d?.events || []).map(ev => normalizeSofaEvent(ev, sport, true));
}

async function fetchSofaUpcoming(sport, key) {
    const today = todayUTC();
    const d = await fetchRapidJSON('sportapi7.p.rapidapi.com', `/api/v1/sport/${sport}/scheduled-events/${today}`, key);
    return (d?.events || []).map(ev => normalizeSofaEvent(ev, sport, false));
}

async function fetchAPIFootball(key) {
    const d = await fetchRapidJSON('api-football-v1.p.rapidapi.com', '/v3/fixtures', key, { live: 'all' });
    return (d?.response || []).map(f => {
        const isLive = f.fixture.status.short !== 'FT' && f.fixture.status.short !== 'AET' && f.fixture.status.short !== 'PEN';
        return {
            home: f.teams.home.name, away: f.teams.away.name, tournament: f.league.name, isLive,
            score: { home: String(f.goals.home ?? '0'), away: String(f.goals.away ?? '0') },
            kickoffMs: f.fixture.timestamp * 1000, sport: 'football', eid: `af_${f.fixture.id}`
        };
    });
}
