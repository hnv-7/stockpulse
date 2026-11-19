import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getQuote, getCloseOn, searchSymbols, getProfile, getDividends, getEvents, funds } from './market.js';
import { createMarkets } from './markets.js';
import { HttpError, createLimiter } from './http.js';
import { createPortfolioData } from './portfolio-data.js';
import { createDigest } from './digest.js';
import { systemRoutes } from './routes/system.js';
import { accountRoutes, publicUser } from './routes/account.js';
import { holdingRoutes } from './routes/holdings.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { reportRoutes } from './routes/reports.js';
import { alertRoutes } from './routes/alerts.js';

/**
 * The Express app: security headers, body limits, rate limits, sessions, and the API routes (one module per area in
 * ./routes). Lookups of outside data can be replaced through `deps` (the tests use fakes).
 */
export function createApp({ store, tracker, auth, config, notifier, deps = {} }) {
  const lookups = {
    quote: deps.getQuote ?? getQuote,
    closeOn: deps.getCloseOn ?? getCloseOn,
    search: deps.searchSymbols ?? searchSymbols,
    profile: deps.getProfile ?? getProfile,
    dividends: deps.getDividends ?? getDividends,
    events: deps.getEvents ?? getEvents,
    fundByIsin: deps.fundByIsin ?? ((isin) => funds.byIsin(isin)),
  };
  const markets = createMarkets({ quoteBatch: deps.getQuoteBatch, dailyHistory: deps.getMarketHistory });
  const limiter = createLimiter(store);
  const data = createPortfolioData({ store, tracker });
  const digest = createDigest({ store, tracker, notifier, data, lookups });
  const ctx = { store, tracker, auth, config, notifier, lookups, markets, limiter, data, digest };

  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel's proxy the client IP is in X-Forwarded-For; trust exactly one hop when deployed over HTTPS.
  if (config.secureCookies) app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { 'upgrade-insecure-requests': config.secureCookies ? [] : null },
      },
    }),
  );
  // Small JSON bodies everywhere, except the import confirm route which carries up to a few hundred rows.
  const smallJson = express.json({ limit: '10kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/holdings/import') ? next() : smallJson(req, res, next)));

  const api = express.Router();
  api.use(limiter('api', 15 * 60_000, 600));
  // Never let browsers or CDNs cache per-user responses.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Reached without a session: scheduled jobs (with the cron secret) and the Telegram webhook (with its secret).
  systemRoutes(api, ctx);

  // ---------- sign-in ----------
  const authLimiter = limiter('auth', 15 * 60_000, 30);
  api.get('/auth/login', authLimiter, (req, res) => auth.login(req, res));
  api.get('/auth/callback', authLimiter, (req, res) => auth.callback(req, res));

  api.use(auth.loadSession);

  api.get('/me', (req, res) => {
    const base = {
      authConfigured: !!(config.google.clientId && config.google.clientSecret),
      emailAvailable: notifier.emailEnabled,
      telegramAvailable: config.telegram.enabled,
    };
    if (!req.session) return res.json({ user: null, ...base });
    res.json({ user: publicUser(req.session.user), csrfToken: req.session.csrfToken, ...base });
  });

  // Everything below needs a signed-in user, and every state-changing call needs the CSRF token.
  api.use(auth.requireAuth, auth.requireCsrf);
  accountRoutes(api, ctx);
  holdingRoutes(api, ctx);
  watchlistRoutes(api, ctx);
  reportRoutes(api, ctx);
  alertRoutes(api, ctx);

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Self-hosted: serve the built dashboard. On Vercel the static files are served by the platform instead.
  const dist = fileURLToPath(new URL('../../client/dist', import.meta.url));
  if (!process.env.VERCEL && existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(`${dist}/index.html`));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status =
      err instanceof HttpError
        ? err.status
        : err?.type === 'entity.parse.failed'
          ? 400
          : err?.type === 'entity.too.large'
            ? 413
            : 500;
    if (status === 500) {
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: err?.message }));
    }
    res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
  });

  return app;
}
