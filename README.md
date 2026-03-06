# 1-project

## PrijsWijzer — Supermarket Price Compare (NL)

Web app to compare daily grocery prices across Dutch supermarkets. Built for deployment (Vercel + GitHub).

### Features

- Search for a grocery item (e.g. "potato", "melk").
- Use location to find nearby supermarkets.
- Compare prices across Albert Heijn, Jumbo, Lidl, Dirk, and more.
- Email magic-link login; report issues; admin dashboard.

### Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set `OPENCAGE_API_KEY`, `APIFY_TOKEN`, and SMTP vars (see `.env.example`).
3. Start backend: `npm run server` (http://localhost:4000)
4. Open `http://localhost:4000` in the browser for the web app.

### Deploy (Vercel)

See **VERCEL-DEPLOY-STEPS.md** for login, deploy, and env vars. Live app: **https://prijswijzer.vercel.app** (after you deploy with project name `prijswijzer`).
