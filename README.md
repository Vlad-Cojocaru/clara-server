# clara-server

Minimal backend for Clara LP: creates Retell web calls via `/api/create-web-call`.

## Setup

1. Clone this repo (or copy these files into [Vlad-Cojocaru/clara-server](https://github.com/Vlad-Cojocaru/clara-server)).
2. `npm install`
3. Set env:
   - **RETELL_API_KEY** (required)
   - **RETELL_AGENT_ID** (optional, default `+14313404488`)

## Run

- `npm start` — run server (port 8787 or `PORT` / `SERVER_PORT`)
- `npm run dev` — run with watch

## Deploy (Railway)

Connect this repo to Railway. Set variables `RETELL_API_KEY` and optionally `RETELL_AGENT_ID`. The repo’s `railway.toml` configures the start command.

The Clara LP frontend should call this backend by setting **VITE_API_URL** to this service’s public URL (e.g. `https://clara-server-production.up.railway.app`).
