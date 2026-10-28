# Ahore Mascon Cup 2026 — live scoring

Live site: https://ahore-mascon-cup.netlify.app (deploys automatically from this repository's `main` branch).

- `index.html`, `style.css`, `app.js` — the site
- `config.js` — Firebase project settings and sponsor strip
- `players.js` — registered player pool and the ten franchises
- `firestore.rules` — paste into Firebase → Firestore → Rules whenever it changes
- `demo.json` — simulated tournament for the "Load demo" button in Setup

Firestore rules deploy automatically from GitHub Actions when `firestore.rules` changes
(secret `KEY` holds the Firebase service-account JSON).
