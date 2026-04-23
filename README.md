# oppa-noppa-resolver

Stream-URL resolver for [Oppa Noppa](https://oppanoppa.com). Runs a Playwright-backed scraper against `miruro.to` and hands short-lived, signed stream URLs to the mobile PWA.

Not a public API — CORS is locked to `app.oppanoppa.com`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Railway healthcheck |
| `GET` | `/resolve?anilistId=&ep=&dub=` | → `{ url, expiresAt }` — signed stream URL |
| `GET` | `/stream/:token` | Proxies upstream m3u8 with correct Referer |
| `POST` | `/anilist` | GraphQL passthrough to `graphql.anilist.co` |
| `POST` | `/auth/anilist/exchange` | OAuth code → token exchange (secret server-side) |

## Local dev

```sh
npm install
npm run dev
# → http://localhost:3000/health
```

## Deploy (Railway)

1. Connect this repo as a Railway service.
2. Set env vars:
   - `SIGNING_SECRET` — any 32+ char random string. `openssl rand -hex 32` works.
   - `ALLOWED_ORIGINS` — `https://app.oppanoppa.com` (comma-separate for extras).
   - `ANILIST_MOBILE_CLIENT_ID` / `ANILIST_MOBILE_CLIENT_SECRET` — from https://anilist.co/settings/developer
3. Deploy. Healthcheck path: `/health`.
4. Point `resolver.oppanoppa.com` (CNAME) at the Railway hostname.

## Memory profile

Playwright + Chromium uses ~300MB headroom. Railway free tier's 512MB is tight — OOMs on concurrent traffic will force an upgrade to the paid tier (8GB).
