export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ─── PROXY SOFASCORE ───────────────────────────────────────────────────
        // Intercepta /sofa-proxy/sport/football/events/live
        if (url.pathname.startsWith('/sofa-proxy/')) {
            const sofaPath = url.pathname.replace('/sofa-proxy/', '');
            const sofaUrl = `https://api.sofascore.com/api/v1/${sofaPath}${url.search}`;

            try {
                const sofaRes = await fetch(sofaUrl, {
                    headers: {
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
                        "Origin": "https://www.sofascore.com",
                        "Referer": "https://www.sofascore.com/"
                    }
                });

                const data = await sofaRes.json();
                const response = new Response(JSON.stringify(data), {
                    status: sofaRes.status,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "*"
                    }
                });
                return response;
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 502,
                    headers: { "Access-Control-Allow-Origin": "*" }
                });
            }
        }

        // ─── FALLBACK: SERVE ASSETS ──────────────────────────────────────────
        // Si no es el proxy, deja que Cloudflare Pages maneje el archivo (index.html, etc)
        return env.ASSETS.fetch(request);
    }
};
