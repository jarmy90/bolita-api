const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS if your mobile app or web frontend needs to call it directly from a browser
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Función de scraping encapsulada
async function scrapeFlashscoreTennis() {
    console.log('[+] Iniciando navegador Chrome Headless...');

    // IMPORTANT: In cloud environments (Render, Heroku), we must run in headless mode
    // and often need special args like --no-sandbox
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    // Simular un navegador real para evitar bloqueos
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    let matches = [];

    try {
        console.log('[+] Navegando a Flashscore Tennis...');
        await page.goto('https://www.flashscore.es/tennis/', { waitUntil: 'domcontentloaded', timeout: 30000 });

        console.log('[+] Esperando renderizado de JavaScript (.event__match)...');
        // Esperamos a que los partidos aparezcan en el DOM
        await page.waitForSelector('.event__match', { timeout: 15000 }).catch(() => console.log('Timeout esperando .event__match'));

        matches = await page.evaluate(() => {
            const results = [];
            const matchNodes = document.querySelectorAll('.event__match');

            matchNodes.forEach(node => {
                // Jugadores
                const homeNode = node.querySelector('.event__participant--home');
                const awayNode = node.querySelector('.event__participant--away');
                const home = homeNode ? homeNode.textContent.trim() : 'Jugador 1';
                const away = awayNode ? awayNode.textContent.trim() : 'Jugador 2';

                // Torneo asociado a este partido (buscando hacia atrás)
                let tournament = 'Desconocido';
                let prev = node.previousElementSibling;
                while (prev) {
                    if (prev.classList.contains('event__header')) {
                        const tNode = prev.querySelector('.event__title--name');
                        tournament = tNode ? tNode.textContent.trim() : 'Desconocido';
                        break;
                    }
                    if (prev.classList.contains('event__match')) { }
                    prev = prev.previousElementSibling;
                }

                // Estado actual del partido (Live vs Próximo vs Finalizado)
                const stageNode = node.querySelector('.event__stage');
                const timeNode = node.querySelector('.event__time');
                const isLive = node.classList.contains('event__match--live') || !!stageNode;
                const isFinished = node.classList.contains('event__match--finished') || node.classList.contains('event__match--twoLine');

                let status = '';
                if (isLive) {
                    status = stageNode ? stageNode.textContent.trim() : 'En juego';
                } else if (timeNode && !isFinished) {
                    status = timeNode.textContent.trim(); // ej: "20:30"
                } else {
                    status = 'Finalizado';
                }

                // Puntuaciones (Nuevo DOM de Flashscore)
                const homeSetsNode = node.querySelector('.event__score--home');
                const awaySetsNode = node.querySelector('.event__score--away');
                const homeSets = homeSetsNode ? homeSetsNode.textContent.trim() : '0';
                const awaySets = awaySetsNode ? awaySetsNode.textContent.trim() : '0';

                // Juegos por set
                const homeParts = Array.from(node.querySelectorAll('.event__part--home')).map(n => n.textContent.trim());
                const awayParts = Array.from(node.querySelectorAll('.event__part--away')).map(n => n.textContent.trim());

                results.push({
                    tournament,
                    home,
                    away,
                    status,
                    isLive,
                    isFinished,
                    score: {
                        sets: { home: homeSets, away: awaySets },
                        games: { home: homeParts, away: awayParts }
                    }
                });
            });

            return results;
        });

        console.log(`[+] Recuperados ${matches.length} partidos de Tenis.`);
    } catch (e) {
        console.error('[-] Error durante el scraping:', e.message);
        throw e; // Lanzar para manejarlo en el endpoint
    } finally {
        await browser.close();
    }

    return matches;
}

// Función de scraping de Fútbol (Goles, Tarjetas, Córners)
async function scrapeFlashscoreFootball() {
    console.log('[+] Iniciando navegador Chrome Headless para Fútbol...');
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
        console.log('[+] Navegando a Flashscore Fútbol...');
        await page.goto('https://www.flashscore.es/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[+] Esperando renderizado (.event__match)...');
        await page.waitForSelector('.event__match', { timeout: 15000 }).catch(() => console.log('Timeout esperando .event__match'));

        matches = await page.evaluate(() => {
            const results = [];
            const matchNodes = document.querySelectorAll('.event__match');

            matchNodes.forEach(node => {
                // Filtro rápido por ligas principales (LaLiga, Premier, Champions) si queremos
                let tournament = 'Desconocido';
                let prev = node.previousElementSibling;
                while (prev) {
                    if (prev.classList.contains('event__header')) {
                        const tNode = prev.querySelector('.event__title--name');
                        tournament = tNode ? tNode.textContent.trim() : 'Desconocido';
                        break;
                    }
                    if (prev.classList.contains('event__match')) { }
                    prev = prev.previousElementSibling;
                }

                const txtT = tournament.toLowerCase();
                // Opcional: Solo traer las ligas top pedidas por el usuario
                const isWanted = txtT.includes('laliga') || txtT.includes('premier league') || txtT.includes('champions league') || txtT.includes('primera');

                const homeNode = node.querySelector('.event__participant--home');
                const awayNode = node.querySelector('.event__participant--away');
                const home = homeNode ? homeNode.textContent.trim() : 'Equipo 1';
                const away = awayNode ? awayNode.textContent.trim() : 'Equipo 2';

                const stageNode = node.querySelector('.event__stage');
                const timeNode = node.querySelector('.event__time');
                const isLive = node.classList.contains('event__match--live') || !!stageNode;
                const isFinished = node.classList.contains('event__match--finished');

                let status = '';
                if (isLive) status = stageNode ? stageNode.textContent.trim() : 'En juego';
                else if (timeNode && !isFinished) status = timeNode.textContent.trim();
                else status = 'Finalizado';

                // Goles
                const homeScoreNode = node.querySelector('.event__score--home');
                const awayScoreNode = node.querySelector('.event__score--away');
                const homeScore = homeScoreNode ? homeScoreNode.textContent.trim() : '0';
                const awayScore = awayScoreNode ? awayScoreNode.textContent.trim() : '0';

                // Tarjetas rojas (visibles desde la vista general en Flashscore)
                const homeRed = node.querySelector('.event__participant--home ~ .icn--card-red') ? 1 : 0;
                const awayRed = node.querySelector('.event__participant--away ~ .icn--card-red') ? 1 : 0;

                results.push({
                    tournament,
                    home,
                    away,
                    status,
                    isLive,
                    isFinished,
                    wanted: isWanted,
                    score: {
                        home: homeScore,
                        away: awayScore
                    },
                    cards: {
                        red: { home: homeRed, away: awayRed }
                    }
                });
            });
            return results;
        });

        // Opcional: Si queríamos córners hay que entrar en el detalle del partido, lo cual ralentiza mucho.
        // Devolvemos la lista limpia.
        console.log(`[+] Recuperados ${matches.length} partidos de Fútbol.`);
    } catch (e) {
        console.error('[-] Error scraping Fútbol:', e.message);
        throw e;
    } finally {
        await browser.close();
    }
    return matches;
}

// ENDPOINT TENIS
app.get('/api/tennis/live', async (req, res) => {
    try {
        console.log(`[GET] Petición a /api/tennis/live`);
        const data = await scrapeFlashscoreTennis();
        res.status(200).json({ success: true, count: data.length, events: data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT FUTBOL
app.get('/api/football/live', async (req, res) => {
    try {
        console.log(`[GET] Petición a /api/football/live`);
        let data = await scrapeFlashscoreFootball();
        // Filtrar por ligas pedidas o devolver todo configurando un ?all=true
        if (req.query.wanted !== 'false') {
            const f = data.filter(m => m.wanted || m.isLive); // Priorizamos los pedidos en directo + los que matchean
            if (f.length > 0) data = f;
        }
        res.status(200).json({ success: true, count: data.length, events: data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('API Node.js + Playwright 🎾⚽ endpoints: /api/tennis/live, /api/football/live');
});

app.listen(PORT, () => {
    console.log(`🚀 API iniciada en puerto ${PORT}`);
});
