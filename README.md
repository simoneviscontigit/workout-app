# Workout App

Webapp personale di allenamento (corpo libero + elastici). Single-file `index.html`, PWA installabile su iPhone, AI Coach via Anthropic API.

## Architettura
- `index.html` — tutta l'app (HTML/CSS/JS inline). Fonte di verità.
- `*.mp4` — video esercizi, path relativi (stessa cartella di `index.html`).
- Backend Google Apps Script (backup `workout_data.json` su Drive): il codice **non sta in questo repo** — è pubblico. Vive nel progetto Apps Script *Workout Backend* sull'account personale, con lo specchio locale in `~/Documents/Claude/Projects/Personal/processi/workout-appscript/`.

## Sicurezza
La API key Anthropic NON va mai nel codice: si inserisce dalle impostazioni (⚙️ Profilo) e vive in `localStorage` (`anthropicKey`).

Dal 22/10/2026 anche il **token di scrittura dello store** vive solo in `localStorage`
(`workoutStoreToken`, si incolla a mano una volta da ⚙️ Profilo › STORE). Questo repo è pubblico:
nessun token, nessun URL con segreto, nessun identificativo di store ci entra.

## Deploy
Hosting statico su **GitHub Pages** (`simoneviscontigit.github.io/workout-app/`), servito dal branch `main` (deploy = `git push origin main`, autenticato via PAT classic repo-scope nel Keychain macOS). Stesso URL = `localStorage` del telefono preservato.

Il deploy Vercel **non è più alternativo**: dal 22/10/2026 serve l'**API dello store**
(`workout-app-eight-iota.vercel.app/api/sync` e `/api/state`, progetto CLI-linked `.vercel/`),
cioè il canale con cui l'app consegna i dati. Due pubblicatori sullo stesso repo, con confini
espliciti: Pages serve la **root** (l'app), Vercel serve **solo `api/`** — è il `.vercelignore`
a tenerlo confinato. Toccarlo rimetterebbe in piedi una seconda copia dell'app su un'altra
origine, cioè un secondo `localStorage` vivo. Il vecchio Netlify
(`workout-standalone-app.netlify.app`) è **dismesso** (404).
