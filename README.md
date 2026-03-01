# clara-server

Minimal backend for Clara LP: creates Retell web calls via `/api/create-web-call`.

## Setup

1. Clone this repo (or copy these files into [Vlad-Cojocaru/clara-server](https://github.com/Vlad-Cojocaru/clara-server)).
2. `npm install`
3. Set env:
   - **DATABASE_URL** (required, PostgreSQL connection string)
   - **RETELL_API_KEY** (required)
   - **RETELL_AGENT_ID** (optional, default `+14313404488`)
   - **ONBOARDING_PASSWORD** (required for operator login)
   - **SUPERUSER_EMAIL** (optional, default `vlad@curate222.com`)
   - **ONBOARDING_SECRET** (optional, for client password hashing)
   - **GHL_ONBOARDING_WEBHOOK_URL** (optional, POST onboarding payload on submit)
   - **GHL_AGREEMENT_WEBHOOK_URL** (optional, POST agreement data on submit)

## Database

Data is stored in **PostgreSQL** only (external to the server). **DATABASE_URL** (PostgreSQL connection string) is required. Tables are created automatically on startup. On Railway, add a Postgres database and set **DATABASE_URL** so data persists across redeploys.

## Run

- `npm start` — run server (port 8787 or `PORT` / `SERVER_PORT`)
- `npm run dev` — run with watch

## Deploy (Railway)

Connect the repo to Railway and set env vars (`RETELL_API_KEY`, `ONBOARDING_PASSWORD`, etc.). **Add PostgreSQL:** In the Railway project, click **+ New** → **Database** → **PostgreSQL**; Railway will add **DATABASE_URL** to your service. The server uses it when set and creates tables on first run. The repo’s `railway.toml` configures the start command.

The Clara LP frontend should call this backend by setting **VITE_API_URL** to this service’s public URL (e.g. `https://clara-server-production.up.railway.app`).
