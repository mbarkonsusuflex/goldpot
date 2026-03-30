# GoldPot — America's National Pot

A real-time sweepstakes platform where players compete for prize pots. Free entry available — no purchase necessary.

## Stack

- **Server**: Node.js + Express + WebSocket (`ws`)
- **Database**: SQLite via `better-sqlite3` (WAL mode)
- **Payments**: Stripe Checkout + webhooks
- **Auth**: JWT tokens, CSRF cookies, per-IP rate limiting
- **Frontend**: Vanilla JS, single-page app
- **Push**: Web Push via `web-push`

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:3000`. The app runs in demo mode when `STRIPE_SECRET_KEY` is not set (payments are simulated).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes (prod) | Set to `production` for production |
| `JWT_SECRET` | Yes (prod) | Secret for signing JWT tokens |
| `ADMIN_SECRET` | Yes (prod) | Secret for admin API endpoints |
| `STRIPE_SECRET_KEY` | No | Stripe secret key for payments |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `VAPID_PUBLIC_KEY` | No | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | No | Web Push VAPID private key |
| `DB_PATH` | No | SQLite database file path (default: `./goldpot.db`) |
| `LOG_LEVEL` | No | Logging level: `debug`, `info`, `warn`, `error` |
| `DEMO_MODE` | No | Set to `true` for demo bots (dev only, blocked in prod) |
| `CANONICAL_HOST` | No | Canonical hostname (default: `goldpot.us`) |

## Project Structure

```
server.js          Express server, API routes, WebSocket, game logic
db.js              SQLite database layer
package.json       Dependencies and scripts
render.yaml        Render.com deployment config
public/
  index.html       Main SPA shell
  goldmine.html    Deep Gold mini-game
  manifest.json    PWA manifest
  sw.js            Service worker
  css/style.css    All styles
  js/app.js        Client-side application logic
  js/game.js       Game client utilities
  js/goldmine.js   Deep Gold game engine
  img/             Static images
```

## Key Features

- **Three pot tiers**: Mini ($25), Gold ($100), Mega ($500) with automatic draws
- **Jackpot drawings**: Silver, Gold, Platinum, Diamond tiers
- **Flash pots**: 5-minute rapid drawings
- **Free entry**: One per pot per round, no purchase required
- **Deep Gold mini-game**: Play to earn bonus entries
- **Real-time chat**: Mentions, replies, GIFs, polls, slash commands, reactions
- **VIP system**: Weekly/monthly subscriptions with perks
- **Referral program**: Earn entries for inviting friends
- **Responsible gaming**: Self-exclusion, daily deposit limits, session time warnings

## Deployment

Configured for [Render.com](https://render.com) via `render.yaml`. Uses a 1 GB persistent disk for the SQLite database.

```bash
# Deploy via Render dashboard or CLI
render deploy
```

## Legal Pages

- `/rules` — Official sweepstakes rules
- `/privacy` — Privacy policy
- `/terms` — Terms of service
- `/responsible-gaming` — Responsible gaming resources

## Security

- HTTPS-only with HSTS
- CSRF protection on all state-changing endpoints
- Input sanitization on all user inputs
- Per-IP rate limiting on sensitive endpoints
- JWT with token versioning for revocation
- Stripe webhook signature verification
- WebSocket connection limits (per-IP and global)
- Content Security Policy headers

## License

Proprietary — © 2026 GoldPot Inc.
