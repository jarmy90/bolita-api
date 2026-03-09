# Bolita - Live Sports Scraper API 🎾⚽

Esta es una API construida con **Node.js, Express y Playwright**.
Funciona como un "Headless Browser" (navegador invisible) para scrapear en tiempo real los marcadores de tenis y fútbol que están ocultos detrás de sistemas interactivos como Flashscore.

## ¿Por qué esta arquitectura?

Sitios interactivos ocultan sus datos bajo scripts bloqueando peticiones estándar (`requests` de Python, `curl`, Workers de Cloudflare, etc.). Al usar Playwright, levantamos un entorno Chromium real en un servidor, esperamos a que la página se pinte, extraemos los datos puros en JSON y esquivamos los baneos de IP.

## Guía de Despliegue en la Nube (Gratis - Render.com)

La mejor manera de usar esta API desde tu aplicación Android (o web `index2.html`) es subir esta carpeta a un servidor en la Nube gratuito como **Render.com**.

### Pasos exactos para Render.com

1. Sube esta carpeta (`tennis-api` entera) a un repositorio nuevo en **GitHub**.
2. Entra en [Render.com](https://render.com) y crea una cuenta.
3. Haz click en **New +** y selecciona **Web Service**.
4. Conecta tu cuenta de GitHub y selecciona el repositorio que acabas de subir.
5. Usa esta configuración exacta en Render:
   - **Environment:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
6. El plan gratuito ('Free') será suficiente. Dale a *Create Web Service*.
   > ⏳ Render tardará unos minutos en instalar el navegador web fantasma la primera vez.

### ¿Cómo conectar tu App Bolita a esta API?

Una vez desplegada, Render te dará una URL (ej: `https://bolita-sports-api.onrender.com`).
Simplemente ve a tu archivo `index2.html` de Bolita, busca la constante:

```javascript
const PW_API_URL = 'http://localhost:3000/api';
```

Y cámbiala por tu nueva URL permanente:

```javascript
const PW_API_URL = 'https://bolita-sports-api.onrender.com/api';
```

¡Listo! Tendrás un feed en tiempo real de Tenis (ATP/WTA) y Fútbol (Top ligas europeas) sin problemas de bloqueos ni errores CORS en tu App.
