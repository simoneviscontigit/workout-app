# Workout App

Webapp personale di allenamento (corpo libero + elastici). Single-file `index.html`, PWA installabile su iPhone, AI Coach via Anthropic API.

## Architettura
- `index.html` — tutta l'app (HTML/CSS/JS inline). Fonte di verità.
- `*.mp4` — video esercizi, path relativi (stessa cartella di `index.html`).
- `appscript_backup.gs` — backend Google Apps Script: backup `workout_data.json` su Drive + spreadsheet "Workout Storia".

## Sicurezza
La API key Anthropic NON va mai nel codice: si inserisce dalle impostazioni (⚙️ Profilo) e vive in `localStorage` (`anthropicKey`).

## Deploy
Hosting statico su Netlify (`workout-standalone-app.netlify.app`). Continuous deployment dal branch `main`. Stesso URL = `localStorage` del telefono preservato.
