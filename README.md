# Stock Beat

Track your Indian (NSE/BSE) shares, ETFs and mutual funds, see which holdings are dragging your portfolio down, spot
buy-the-dip opportunities, plan your capital gains tax, and get alerted when a stock falls by a percentage you choose.

Each person signs in with Google and enters their own holdings once (quantity + total invested).
Prices are refreshed automatically on weekdays after the market opens, at midday and at the close (about 09:30, 12:30 and 15:30 IST), so history keeps building even when nobody opens the app.

## What you get

- **Dashboard**: invested, current value, overall profit, and change for **Today / This week / This month / 3 months / 1 year**.
- **XIRR**: your yearly rate of return from the money you paid on each purchase date, the money you received from each sale on its date, and what you hold today, so selling (a winner or a loser) doesn't distort it. Per stock, it covers the shares still held. Purchases or sales without dates are left out, and the dashboard says how many are counted.
- **Dragging you down**: stocks that lost rupee value in the chosen period, worst first (even if you're in profit overall).
- **Buy-the-dip candidates**: stocks still in profit on your cost, but whose price fell in the chosen period, plus distance from the 52-week high.
- **Lagging the portfolio**: stocks earning a lower return on cost than your portfolio average.
- **Charts**: portfolio value vs invested, per-stock price history with your average cost line, and a "what moved my portfolio" bar chart.
- **Portfolios**: keep several (yours, a family member's, one per broker). Every holding and sale belongs to one. The picker at the top of the page shows one portfolio or all of them together, where a stock held in two portfolios counts once. Capital gains, dividends, XIRR and the charts follow it, which matters because each family member is taxed separately. Add, rename and remove portfolios on the Account tab; move a holding between them from its row.
- **Mutual funds and ETFs**: search funds by name next to shares (e.g. "parag parikh flexi"); a fund is stored as `MF:<AMFI scheme code>` and its quantity is in units. Latest NAVs, names and categories come from AMFI's daily NAV file, past NAVs from [mfapi.in](https://www.mfapi.in/). ETFs such as NIFTYBEES are NSE symbols and come from Yahoo like shares. Statements that list funds by ISIN are matched through AMFI's list.
- **Capital gains**: for each financial year (April to March), profit booked from sales split into short-term (held up to 12 months) and long-term, one row per purchase sold (oldest first), with charges shared between them. It estimates the tax (losses set off, the long-term exemption, the rates in force on each sale date, 4% cess) and lists losses to carry forward. For the current year it also shows the long-term exemption left, gains on what you still hold by type, and purchases turning long-term in the next 60 days. Export CSV gives the year's rows. Debt, gold and international funds and ETFs are listed but left out of the estimate, since they are taxed at your slab rate or with a 24-month long-term period.
- **Ways to save tax before 31 March**: for the current year, at today's prices and selling oldest purchases first: holdings where selling everything books a loss, with the tax that loss saves against gains already booked (or how much carries forward), and long-term gains that fit in what is left of the ₹1.25 lakh exemption, which you could book tax-free by selling and buying back.
- **Compared with Nifty 50**: on the dashboard, your stocks against Nifty 50 over the chosen period; since you bought, your XIRR against the same money put into Nifty 50 on the same days, with Nifty sold on the days you sold shares (and what each would be worth, including money taken out); and a chart of both over 1 month to 1 year. The chart is time-weighted (each day counts only the shares held all day), so buying and selling don't show up as gains or losses.
- **Markets**: Nifty 50, Sensex, Nifty Next 50, Midcap 150 and Smallcap 250, and 15 NSE sectors ranked from leading to lagging for today, 1 week, 1 month or 3 months, as a heatmap with trend lines and how many of each sector's popular stocks are up. Open a sector to see six well-known stocks in it (price, change, trend line, distance from the 52-week high), compare any of them with the sector on a chart, and add one to your watchlist. Also the day's top gainers and losers among those stocks, with stocks you hold or watch marked.
- **Where your money is**: the portfolio by sector (from Yahoo's company profiles; funds and ETFs as their own groups), and how much sits in your largest stocks. Set a target share per sector (per portfolio, or for all together) to see how far each is off and what to buy or sell to get back, or how to split new money between the sectors furthest below target without selling.
- **Coming up**: results dates and ex-dividend dates in the next 60 days for what you hold or watch, from Yahoo (results dates Yahoo marks as estimated are shown as expected).
- **Weekly summary** (opt-in, Account tab): every Friday after the close, how the portfolio did over the week against Nifty 50, the biggest movers, alerts that fired, and dates coming up in the next week. It appears under Alerts and goes by email and Telegram if those are on.
- **Dividends**: what you received, worked out from the shares you held going into each ex-dividend date (including shares since sold), by stock with yield on cost, and each payment. The Capital gains tab shows the year's dividend income separately, since it is taxed at your slab rate.
- **Market closed**: on weekends and NSE holidays the header says the market is closed and which session the prices are from. Each price is stored as the close of the day it actually traded, so holidays don't get a made-up close.
- **Telegram alerts** (optional): connect from the Account tab with a one-time link; alerts then arrive as Telegram messages too. Send /stop to the bot to turn them off.
- **Watchlist**: follow stocks you don't own yet: today's, this week's and this month's move, distance from the 52-week high, change since you added it, a price chart, and a note. Set a price alert as you add one ("tell me when it gets to ₹1,400") or from its row; the list shows how far each alert level is from the current price. Price and drop alerts work on watched stocks; "any stock" alerts stay with the portfolio.
- **Drop and price alerts**: e.g. "tell me if any stock falls 5% in a day / 8% in a week / 10% in a month / 15% from its 52-week high", or "when INFY goes below ₹1,400". Shown in-app, and by email if the user opts in. Tick notifications to delete just those, or clear them all; a cleared alert still counts toward its once-a-day limit, so it doesn't fire again straight away.
- **Splits and bonus issues**: found automatically. Price history is restated at once, so a 1:1 bonus never shows up as a 50% fall or fires a drop alert. Your own shares only change when you confirm, on the Holdings tab, with the ratio pre-filled and editable. Confirming restates purchases made before the ex-date (quantity × ratio, same amount invested), earlier sales (same proceeds and profit) and price targets; until then those price targets are paused and the stock is marked "Split to confirm".
- **Accounts**: every user only ever sees their own data. Users can sign out or delete their account and all data.
- **App feel**: each tab has its own address (`/#/holdings`), so reloading, bookmarks and the Back button work. A dark theme follows the device, or choose light or dark on the Account tab. On a phone, *Add to Home Screen* (or the browser's install button) installs it like an app; it needs a connection, there is no offline mode.
- **Broker import / export**: on the Holdings tab, *Import statement* reads the holdings file downloaded from Groww, Zerodha (Console/Kite), Dhan, Upstox, Angel One and similar, as Excel (`.xlsx`), CSV, JSON or PDF. Columns are matched by name (not position), the header is found below any preamble, and stocks are matched to NSE/BSE symbols by ticker, ISIN or company name. You review the result (and untick rows) before anything is saved; imports only add or update, never delete. *Export CSV* downloads your portfolio, which can be edited and imported back. An optional purchase date can be stored per holding.

## Architecture

| Piece | Service | Notes |
|---|---|---|
| Web app + API | Vercel project with two [services](https://vercel.com/docs/services): `client` (Vite/React) and `server` (Express) | no always-on server, nothing binds to `0.0.0.0` |
| Database | Neon (hosted Postgres) | free tier is enough |
| Sign-in | Google OpenID Connect (PKCE, state, nonce) | sessions are random tokens, stored hashed |
| Price refreshes (open, midday, close) | Vercel Cron → `GET /api/cron/poll` | three daily jobs, 09:30, 12:30 and 15:30 IST on weekdays |
| Daily history catch-up | Vercel Cron → `GET /api/cron/history` | 19:00 IST on weekdays; NSE's own end-of-day file fills any NSE close Yahoo is missing |
| Weekly summary | Vercel Cron → `GET /api/cron/digest` | Fridays at 16:30 IST, once per user per day |
| Rate limits | counters in Postgres | shared by every serverless instance; keys are hashed, no addresses stored |

All cron endpoints require `Authorization: Bearer <CRON_SECRET>`.

### Code layout

- `server/src/app.js` sets up security headers, body limits, rate limits and sessions, then mounts the routes in `server/src/routes/` (one file per area: account and portfolios, holdings and sales, watchlist and markets, reports, alerts, cron jobs and the Telegram webhook). Request shapes are in `schemas.js`.
- `server/src/store.js` joins the queries in `server/src/store/` (users, holdings and sales, watchlist, market data, alerts, splits). Every query on user data filters by user id.
- Calculations are plain functions with their own tests: `analytics.js` (report, XIRR, value over time), `capital-gains.js` (tax and harvesting), `income.js` (sectors, targets, dividends), `benchmark.js`, `events.js`, `digest.js`, `assets.js` (how each holding is taxed).
- Outside data: `market.js` (Yahoo, and funds through `mf.js`), `nse.js` (NSE's end-of-day file).
- `client/src/components/` has one component per tab; the Holdings tab's pieces are in `components/holdings/`.

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
   - optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` for Telegram alerts: create a bot with [@BotFather](https://t.me/BotFather), choose a long random secret, deploy, then register the webhook once:
     ```bash
     curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=$APP_BASE_URL/api/telegram/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET&allowed_updates=%5B%22message%22%5D"
     ```
4. **Google sign-in**: in Google Cloud Console → APIs & Services → Credentials, create an *OAuth client ID* of type *Web application*. Add the authorised redirect URI `https://<your-domain>/api/auth/callback`. Configure the OAuth consent screen (set it to *External*; add test users while it's in Testing mode, or publish it so anyone can sign in).
5. **Scheduled refreshes**: nothing to set up beyond `CRON_SECRET`. The `crons` in [`vercel.json`](vercel.json) refresh prices on weekdays after the open, at midday and at the close, catch up history each evening, and send the weekly summary on Fridays; Vercel sends `CRON_SECRET` with each call. Cron jobs run only on the production deployment; check them under the project's *Schedules → Cron Jobs* tab. To test one without waiting, call it yourself:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" "$APP_BASE_URL/api/cron/poll"
   ```

### Limits to know about

- Vercel's free (Hobby) plan runs each cron once a day, at any minute within its hour, so the refreshes land at 09:30-10:29, 12:30-13:29 and 15:30-16:29 IST. Delivery is best effort and a missed run is not retried; a price then shows as *Stale* until the next refresh or a *Refresh prices* click. On the Pro plan you can schedule them to the minute, or add more.
- The close refresh can run while Yahoo's quote still lags the market by a few minutes. The 19:00 IST history job replaces each day's close with the official one.
- Prices come from Yahoo Finance's unofficial API. They are typically delayed ~15 minutes and could change or be rate-limited without notice.
- The *Intraday* chart has a point only for each refresh that ran (three a day, plus any *Refresh prices* clicks). Daily closes are back-filled, so daily/weekly/monthly reports have no gaps.
- Statement import: files up to 2 MB, 500 rows, and 30 PDF pages. PDFs are read by text position, so they work for text-based statements but not scanned images or password-protected files; Excel/CSV is the most reliable. Old `.xls` files must be saved as `.xlsx` first. Brokers change their layouts now and then, so check the preview, especially stocks marked "matched by company name".
- Splits come from Yahoo, which records bonus issues as splits and sometimes gets combined actions wrong (it reported Bajaj Finance's June 2025 4:1 bonus plus 1:2 split as "2:1"). Stock Beat compares the reported ratio with how far the price actually moved and, when they disagree, suggests the price-based ratio and warns you to check it with your broker. Each stock is checked at the first refresh of the day and again straight after any move of more than 8%. If Yahoo publishes a split late, a small bonus (say 1:10) can still set off a drop alert before it is found.
- Which of your entries a split changes is decided by when you entered them: anything entered before the ex-date is taken to be in the old shares, and anything entered later in the new ones. If you have already corrected a quantity yourself, choose "Already done / not needed".
- Nifty 50 (`^NSEI`) is a price index, so neither side of the comparison includes dividends. The since-you-bought comparison covers the same holdings and sales as the portfolio XIRR: those with every purchase dated. Index closes are stored once and kept; older ones are fetched the first time someone's purchases go back further.
- The capital gains tax figure is an estimate for listed shares where STT was paid (20% short-term, 12.5% long-term above ₹1.25 lakh a year since 23 July 2024; 15% and 10% above ₹1 lakh before). It leaves out surcharge, rebates, unused basic exemption, and grandfathering of shares bought before 1 Feb 2018. Bonus shares carry the original purchase date and spread cost (for tax they count from allotment at zero cost). The rules live in `TAX_RULES` in [`server/src/capital-gains.js`](server/src/capital-gains.js); add a row when a budget changes them.
- Sectors come from Yahoo and are missing for some smaller companies ("Sector not known"); each stock is looked up once and again every 90 days. Dividends are Yahoo's per-share amounts by ex-date, before tax deducted at source; purchases without a date count from the day they were entered in the app, and sold purchases without a date aren't counted. Dividends aren't part of XIRR or the Nifty 50 comparison, which are price-only. Up to 5 stocks are looked up per page load, so a large portfolio fills in over a few loads.
- Markets: the popular stocks are a hand-picked list (`SECTORS` in [`server/src/markets.js`](server/src/markets.js)) that needs a look when companies merge, demerge or rename. Yahoo has only today's quote for Nifty Healthcare, Oil & Gas, Consumer Durables and Media, so their week, month and 3-month figures and lines are the average of their popular stocks (marked ≈). With no intraday prices, the lines on *Today* show the past week. The data is the same for everyone and cached per server instance (quotes for a minute, daily closes for 30 minutes), so the first load after a cold start takes a few seconds.
- "Market closed today" for a holiday appears only after 11:00 IST, once the open refresh's hour has passed, so a late refresh isn't mistaken for a holiday. If the open refresh is missed altogether, a normal trading day can show as closed until the midday refresh.
- Mutual fund NAVs are published once a day, in the evening, so a fund's price is the previous day's NAV until then. mfapi.in is a free, unofficial service; if it is down, adding a fund with only a purchase date (no quantity) and fund charts fail until it is back, while current NAVs still come from AMFI. Dividend (IDCW) payouts from funds aren't tracked.
- How a fund or ETF is taxed is worked out from its AMFI category and name ("Equity Scheme", index funds that track Indian shares, arbitrage and aggressive hybrid funds count as equity; debt, gold, silver, international and fund-of-funds don't). Check the Capital gains tab's "Not estimated" rows for anything that looks wrong; the rules are in [`server/src/assets.js`](server/src/assets.js).
- The tax-saving ideas use today's prices and ignore brokerage and the price moving between selling and buying back. India has no wash-sale rule today, but check before acting.
- NSE's end-of-day file comes out at about 16:30 IST and only covers NSE (`.NS`) symbols. NSE sometimes turns away requests from cloud servers; the history job then simply keeps Yahoo's closes.
- This is a tracking tool, not investment advice.

### Not yet verified on a real deployment

The code is tested locally (API tests on an in-process Postgres, plus a browser run against live Yahoo data), but these depend on the hosted services and should be checked on your first deploy:

- the Vercel Services config (Beta) building both services from the npm workspace and routing `/api/*` to Express with the original path (check `https://<domain>/api/me` returns JSON);
- the Google sign-in round trip with your real OAuth client;
- Yahoo Finance not throttling Vercel's shared IPs, and NSE's archive answering them (the NSE fallback is skipped quietly if not);
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
Open the app at the address `APP_BASE_URL` names (`http://localhost:4000` by default): changes are refused from any other
origin, so on `http://127.0.0.1:4000` also set `APP_BASE_URL=http://127.0.0.1:4000`.
The dev server refuses to run with an `https` `APP_BASE_URL`.

For UI work, run `npm run dev -w client` (Vite proxies `/api` to port 4000) alongside the dev server.

## Self-host on one machine

Set `DATABASE_URL`, `APP_BASE_URL` (https), the Google variables and `CRON_SECRET`, then:

```bash
npm install && npm run build
npm start          # binds to 127.0.0.1:4000; put a TLS reverse proxy in front
```

Call `/api/cron/poll` at 09:30, 12:30 and 15:30 IST on weekdays (or more often), `/api/cron/history` once each evening, and `/api/cron/digest` on Friday afternoons, e.g. with `curl -H "Authorization: Bearer $CRON_SECRET" …` from cron or a systemd timer.

## Tests

```bash
npm test
```

Covers authentication and CSRF, per-user data isolation, caps, alert cooldowns, email opt-in, throttled refresh,
account deletion, cron-secret checks, the OIDC state/PKCE/verified-email rules, portfolios, mutual fund data and tax
classes, the tax-saving ideas, the weekly summary, upcoming dates, targets and rebalancing, shared rate limits, and the
NSE fallback. [GitHub Actions](.github/workflows/test.yml) runs them and builds the client on every push and pull request.

## Security notes

- Google OIDC with PKCE, state and nonce; unverified Google emails are refused.
- Session tokens are random and stored hashed; cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over https.
- State-changing calls need a CSRF token and a same-origin `Origin` header.
- All SQL is parameterised; all input is validated server-side; rate limits and per-user caps apply.
- Error responses are generic; logs are structured and never contain tokens or portfolio contents.
- No secrets in the repo: everything comes from environment variables.
