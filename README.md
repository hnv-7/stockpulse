# Stock Beat

Track your Indian (NSE/BSE) stock portfolio, see which stocks are dragging it down, spot buy-the-dip
opportunities, and get alerted when a stock falls by a percentage you choose.

Each person signs in with Google and enters their own holdings once (quantity + total invested).
Prices are fetched automatically on a schedule, so history keeps building even when nobody opens the app.

## What you get

- **Dashboard**: invested, current value, overall profit, and change for **Today / This week / This month / 3 months / 1 year**.
- **Dragging you down**: stocks that lost rupee value in the chosen period, worst first (even if you're in profit overall).
- **Buy-the-dip candidates**: stocks still in profit on your cost, but whose price fell in the chosen period, plus distance from the 52-week high.
- **Lagging the portfolio**: stocks earning a lower return on cost than your portfolio average.
- **Charts**: portfolio value vs invested, per-stock price history with your average cost line, and a "what moved my portfolio" bar chart.
- **Drop alerts**: e.g. "tell me if any stock falls 5% in a day / 8% in a week / 10% in a month / 15% from its 52-week high". Shown in-app, and by email if the user opts in.
- **Accounts**: every user only ever sees their own data. Users can sign out or delete their account and all data.
- **Broker import / export**: on the Holdings tab, *Import statement* reads the holdings file downloaded from Groww, Zerodha (Console/Kite), Dhan, Upstox, Angel One and similar, as Excel (`.xlsx`), CSV, JSON or PDF. Columns are matched by name (not position), the header is found below any preamble, and stocks are matched to NSE/BSE symbols by ticker, ISIN or company name. You review the result (and untick rows) before anything is saved; imports only add or update, never delete. *Export CSV* downloads your portfolio, which can be edited and imported back. An optional purchase date can be stored per holding.

## Architecture

| Piece | Service | Notes |
|---|---|---|
| Web app + API | Vercel project with two [services](https://vercel.com/docs/services): `client` (Vite/React) and `server` (Express) | no always-on server, nothing binds to `0.0.0.0` |
| Database | Neon (hosted Postgres) | free tier is enough |
| Sign-in | Google OpenID Connect (PKCE, state, nonce) | sessions are random tokens, stored hashed |
| Hourly price polling | GitHub Actions schedule → `GET /api/cron/poll` | Vercel's free plan only allows daily cron |
| Daily history catch-up | Vercel Cron → `GET /api/cron/history` | |

Both cron endpoints require `Authorization: Bearer <CRON_SECRET>`.

## Deploy

You need free accounts on GitHub, Neon, Google Cloud and Vercel.

1. **Database**: create a Neon project and copy the connection string (it must include `sslmode=require`). Tables are created automatically on first request.
2. **Push this repo to GitHub.**
3. **Vercel**: import the repo (leave the Root Directory at the repo root; [`vercel.json`](vercel.json) declares the `client` and `server` services, routes `/api/*` to `server` and everything else to `client`; no bindings are needed because the browser is the only caller of the API). Add these environment variables (see [`server/.env.example`](server/.env.example)):
   - `DATABASE_URL`: the Neon string
   - `APP_BASE_URL`: your final `https://…` URL (no trailing slash). You can set it after the first deploy and redeploy.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: see step 4
   - `CRON_SECRET`: a long random value, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - optional `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` for opt-in email alerts
4. **Google sign-in**: in Google Cloud Console → APIs & Services → Credentials, create an *OAuth client ID* of type *Web application*. Add the authorised redirect URI `https://<your-domain>/api/auth/callback`. Configure the OAuth consent screen (set it to *External*; add test users while it's in Testing mode, or publish it so anyone can sign in).
5. **Hourly polling**: in the GitHub repo → Settings → Secrets and variables → Actions, add `APP_URL` (e.g. `https://your-app.vercel.app`) and `CRON_SECRET` (same value as in Vercel). The workflow in [`.github/workflows/poll.yml`](.github/workflows/poll.yml) then runs hourly during market hours (IST) on weekdays. Use *Run workflow* once to test it. If the repo sits inside a larger repo, move the workflow file to the repo's root `.github/workflows/`.

### Limits to know about

- GitHub Actions schedules can start several minutes late, and are paused after 60 days of repository inactivity.
- Vercel Hobby cron runs once a day with up to ±59 minutes of timing slack. That is why hourly polling uses GitHub Actions.
- Prices come from Yahoo Finance's unofficial API. They are typically delayed ~15 minutes and could change or be rate-limited without notice.
- Hourly points exist only for hours the poll actually ran. Daily closes are back-filled, so daily/weekly/monthly reports have no gaps.
- Statement import: files up to 2 MB, 500 rows, and 30 PDF pages. PDFs are read by text position, so they work for text-based statements but not scanned images or password-protected files; Excel/CSV is the most reliable. Old `.xls` files must be saved as `.xlsx` first. Brokers change their layouts now and then, so check the preview, especially stocks marked "matched by company name".
- This is a tracking tool, not investment advice.

### Not yet verified on a real deployment

The code is tested locally (API tests on an in-process Postgres, plus a browser run against live Yahoo data), but these depend on the hosted services and should be checked on your first deploy:

- the Vercel Services config (Beta) building both services from the npm workspace and routing `/api/*` to Express with the original path (check `https://<domain>/api/me` returns JSON);
- the Google sign-in round trip with your real OAuth client;
- Yahoo Finance not throttling Vercel's shared IPs;
- the first request (table creation and history back-fill) finishing within the default function time limit.

## Run locally (no Google or Postgres needed)

Requires Node.js 22.13+.

```bash
npm install
npm run build -w client
cd server
DEV_DEMO_USER=1 node src/dev.js
```

This starts the app on <http://127.0.0.1:4000> using an embedded Postgres (PGlite) in `server/.devdata`,
and prints a `sp_session=…` cookie. Add it in your browser's dev tools (Application → Cookies) to sign in as a demo user.
The dev server refuses to run with an `https` `APP_BASE_URL`.

For UI work, run `npm run dev -w client` (Vite proxies `/api` to port 4000) alongside the dev server.

## Self-host on one machine

Set `DATABASE_URL`, `APP_BASE_URL` (https), the Google variables and `CRON_SECRET`, then:

```bash
npm install && npm run build
npm start          # binds to 127.0.0.1:4000; put a TLS reverse proxy in front
```

Call `/api/cron/poll` hourly (e.g. with `curl -H "Authorization: Bearer $CRON_SECRET" …`) from cron or a systemd timer.

## Tests

```bash
npm test
```

Covers authentication and CSRF, per-user data isolation, caps, alert cooldowns, email opt-in, throttled refresh,
account deletion, cron-secret checks, and the OIDC state/PKCE/verified-email rules.

## Security notes

- Google OIDC with PKCE, state and nonce; unverified Google emails are refused.
- Session tokens are random and stored hashed; cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over https.
- State-changing calls need a CSRF token and a same-origin `Origin` header.
- All SQL is parameterised; all input is validated server-side; rate limits and per-user caps apply.
- Error responses are generic; logs are structured and never contain tokens or portfolio contents.
- No secrets in the repo: everything comes from environment variables.
