import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { istDate, addDays } from './dates.js';
import { toCsv, importHoldings, isPastOrToday, MAX_IMPORT_ROWS } from './portfolio-io.js';
import { previewImport } from './import-mapping.js';
import { ImportError, MAX_FILE_BYTES } from './import-formats.js';
import { buildReport, portfolioHistory } from './analytics.js';
import { getQuote, getCloseOn, searchSymbols } from './market.js';
import { safeEqual } from './auth.js';

const periodSchema = z.enum(['1d', '1w', '1m', '3m', '1y']).default('1w');
const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9&.-]{1,20}$/, 'invalid symbol');
const positive = z.number().finite().positive().max(1e12);

// Optional purchase date: a real YYYY-MM-DD date that is not in the future. null clears it on update.
const purchaseDateSchema = z
  .string()
  .refine(isPastOrToday, 'purchase date must be a valid date, not in the future')
  .nullable()
  .optional();

// On add, quantity or invested may be left out when a purchase date is given: the missing one is worked out from that day's close.
const holdingSchema = z.object({
  symbol: symbolSchema,
  quantity: positive.optional(),
  invested: positive.optional(),
  purchaseDate: purchaseDateSchema,
});
const holdingUpdateSchema = z.object({ quantity: positive, invested: positive, purchaseDate: purchaseDateSchema });
const ruleSchema = z.object({
  symbol: symbolSchema.nullable().optional(),
  window: z.enum(['1d', '1w', '1m', 'high52']),
  thresholdPct: z.number().finite().positive().lt(100),
});
const ruleUpdateSchema = z.object({
  thresholdPct: z.number().finite().positive().lt(100),
  enabled: z.boolean(),
});
const settingsSchema = z.object({ alertEmail: z.boolean() });

const RANGE_DAYS = { '1m': 30, '3m': 90, '6m': 182, '1y': 365 };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message || 'invalid request');
  return r.data;
};
const parseId = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  return id;
};

const limiter = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too many requests, slow down' },
  });

export function createApp({ store, tracker, auth, config, notifier, deps = {} }) {
  const lookupQuote = deps.getQuote ?? getQuote;
  const lookupCloseOn = deps.getCloseOn ?? getCloseOn;
  const search = deps.searchSymbols ?? searchSymbols;
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
  api.use(limiter(15 * 60_000, 600));
  // Never let browsers or CDNs cache per-user responses.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---------- scheduled jobs (called by GitHub Actions / Vercel Cron with a shared secret) ----------
  const cronOnly = (req, res, next) => {
    if (!config.cronSecret) return res.status(503).json({ error: 'scheduler is not configured' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.cronSecret)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  api.all('/cron/poll', cronOnly, async (_req, res) => res.json(await tracker.pollOnce()));
  api.all('/cron/history', cronOnly, async (_req, res) => res.json(await tracker.refreshHistory()));

  // ---------- auth ----------
  const authLimiter = limiter(15 * 60_000, 30);
  api.get('/auth/login', authLimiter, (req, res) => auth.login(req, res));
  api.get('/auth/callback', authLimiter, (req, res) => auth.callback(req, res));

  api.use(auth.loadSession);

  api.get('/me', (req, res) => {
    const base = {
      authConfigured: !!(config.google.clientId && config.google.clientSecret),
      emailAvailable: notifier.emailEnabled,
    };
    if (!req.session) return res.json({ user: null, ...base });
    const { user, csrfToken } = req.session;
    res.json({
      user: { email: user.email, name: user.name, alertEmail: user.alertEmail },
      csrfToken,
      ...base,
    });
  });

  // Everything below needs a signed-in user, and every state-changing call needs the CSRF token.
  api.use(auth.requireAuth, auth.requireCsrf);

  api.post('/auth/logout', (req, res) => auth.logout(req, res));

  api.put('/me/settings', async (req, res) => {
    const { alertEmail } = parse(settingsSchema, req.body);
    if (alertEmail && !notifier.emailEnabled) throw new HttpError(400, 'email alerts are not enabled on this server');
    const u = await store.updateUserSettings(req.session.user.id, { alertEmail });
    res.json({ email: u.email, name: u.name, alertEmail: u.alertEmail });
  });

  api.delete('/me', async (req, res) => {
    await store.deleteUser(req.session.user.id);
    res.set('Set-Cookie', 'sp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.status(204).end();
  });

  api.get('/search', limiter(60_000, 30), async (req, res) => {
    const q = parse(z.string().trim().min(1).max(40), req.query.q);
    res.json(await search(q));
  });

  // ---------- holdings ----------
  api.get('/holdings', async (req, res) => res.json(await store.listHoldings(req.session.user.id)));

  // Download the portfolio as CSV. The same columns are accepted by the import below.
  api.get('/holdings/export', async (req, res) => {
    const holdings = await store.listHoldings(req.session.user.id);
    const csv = toCsv(
      ['Symbol', 'Name', 'Quantity', 'Invested', 'Purchase Date'],
      holdings.map((h) => [h.symbol, h.name, h.quantity, h.invested, h.purchase_date]),
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="stockpulse-portfolio-${istDate()}.csv"`);
    res.send(csv);
  });

  // Step 1 of an import: upload a broker statement (xlsx / csv / json / pdf) and get back what would change.
  // Nothing is saved here.
  api.post(
    '/holdings/import/preview',
    limiter(60_000, 10),
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'choose a file to import');
      try {
        res.json(
          await previewImport({
            buf: req.body,
            existing: await store.listHoldings(req.session.user.id),
            lookupQuote,
            search,
            maxHoldings: config.maxHoldingsPerUser,
          }),
        );
      } catch (e) {
        if (e instanceof ImportError) throw new HttpError(400, e.message);
        throw e;
      }
    },
  );

  // Step 2: save the (possibly edited) preview. New symbols are added, existing ones updated; nothing is deleted.
  api.post('/holdings/import', limiter(60_000, 10), express.json({ limit: '200kb' }), async (req, res) => {
    const { items } = parse(
      z.object({ items: z.array(holdingSchema).min(1, 'nothing to import').max(MAX_IMPORT_ROWS, `too many rows (max ${MAX_IMPORT_ROWS})`) }),
      req.body,
    );
    const result = await importHoldings({
      store,
      tracker,
      lookupQuote,
      maxHoldings: config.maxHoldingsPerUser,
      userId: req.session.user.id,
      rows: items.map((it, i) => ({ line: i + 1, ...it })),
    });
    res.json(result);
  });

  api.post('/holdings', limiter(60_000, 20), async (req, res) => {
    const userId = req.session.user.id;
    const { symbol, quantity: qtyIn, invested: investedIn, purchaseDate } = parse(holdingSchema, req.body);
    if (!qtyIn && !investedIn) throw new HttpError(400, 'enter the quantity, the amount invested, or both');
    if ((await store.countHoldings(userId)) >= config.maxHoldingsPerUser) {
      throw new HttpError(400, `you can track up to ${config.maxHoldingsPerUser} stocks`);
    }
    const existing = await store.listHoldings(userId);
    if (existing.some((h) => h.symbol === symbol)) {
      throw new HttpError(409, 'stock already in portfolio — edit it instead');
    }
    const quote = await lookupQuote(symbol).catch(() => null);
    if (!quote) throw new HttpError(404, 'symbol not found (use NSE/BSE format, e.g. INFY.NS)');

    let quantity = qtyIn;
    let invested = investedIn;
    let priceOn = null;
    if (!quantity || !invested) {
      if (!purchaseDate) throw new HttpError(400, 'enter both quantity and amount invested, or add a purchase date so one can be worked out');
      priceOn = await lookupCloseOn(symbol, purchaseDate).catch(() => null);
      if (!priceOn) throw new HttpError(404, 'no price found for that purchase date — enter both quantity and amount invested');
      if (!quantity) quantity = Math.round((invested / priceOn.close) * 10_000) / 10_000;
      else invested = Math.round(quantity * priceOn.close * 100) / 100;
      if (!(quantity > 0) || !(invested > 0)) throw new HttpError(400, 'amount is too small to buy any shares on that date');
    }

    const holding = await store.addHolding(userId, { symbol, name: quote.name, quantity, invested, purchaseDate: purchaseDate ?? null });
    // History is shared between users, so only fetch it if nobody holds this symbol yet.
    const have = (await store.getSeriesMany([symbol], addDays(istDate(), -60))).get(symbol);
    if (have.length < 20) await tracker.backfill(symbol).catch(() => 0);
    await store.saveSnapshots([{ symbol, ts: Date.now(), price: quote.price }]);
    res.status(201).json(priceOn ? { ...holding, priceOn } : holding);
  });

  api.put('/holdings/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const body = parse(holdingUpdateSchema, req.body);
    const updated = await store.updateHolding(req.session.user.id, id, body);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/holdings/:id', async (req, res) => {
    if (!(await store.removeHolding(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  // ---------- reports ----------
  async function loadAll(userId, period) {
    const holdings = await store.listHoldings(userId);
    const today = istDate();
    const seriesBySymbol = await store.getSeriesMany(
      holdings.map((h) => h.symbol),
      addDays(today, -400),
    );
    const latestBySymbol = new Map();
    for (const h of holdings) {
      const s = seriesBySymbol.get(h.symbol);
      if (s.length) latestBySymbol.set(h.symbol, s[s.length - 1].close);
    }
    return { holdings, today, seriesBySymbol, latestBySymbol, period };
  }

  api.get('/report', async (req, res) => {
    const period = parse(periodSchema, req.query.period);
    const ctx = await loadAll(req.session.user.id, period);
    const report = buildReport(ctx);
    const asOf = await store.lastSnapshotTs(ctx.holdings.map((h) => h.symbol));
    res.json({ ...report, asOf });
  });

  api.get('/portfolio/history', async (req, res) => {
    const range = parse(z.enum(['1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const ctx = await loadAll(req.session.user.id, '1w');
    res.json(portfolioHistory({ ...ctx, fromDate: addDays(ctx.today, -RANGE_DAYS[range]) }));
  });

  api.get('/stocks/:symbol/history', async (req, res) => {
    const symbol = parse(symbolSchema, req.params.symbol);
    const holding = (await store.listHoldings(req.session.user.id)).find((h) => h.symbol === symbol);
    if (!holding) throw new HttpError(404, 'not found');
    const range = parse(z.enum(['1d', '1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const avgCost = holding.invested / holding.quantity;
    if (range === '1d') {
      return res.json({ symbol, avgCost, points: await store.getSnapshots(symbol, Date.now() - 3 * 86_400_000) });
    }
    const series = (await store.getSeriesMany([symbol], addDays(istDate(), -RANGE_DAYS[range]))).get(symbol);
    res.json({ symbol, avgCost, points: series.map((p) => ({ date: p.date, price: p.close })) });
  });

  // ---------- alert rules ----------
  api.get('/rules', async (req, res) => res.json(await store.listRules(req.session.user.id)));

  api.post('/rules', async (req, res) => {
    const userId = req.session.user.id;
    const { symbol, window, thresholdPct } = parse(ruleSchema, req.body);
    if ((await store.countRules(userId)) >= config.maxRulesPerUser) {
      throw new HttpError(400, `you can have up to ${config.maxRulesPerUser} alerts`);
    }
    if (symbol && !(await store.listHoldings(userId)).some((h) => h.symbol === symbol)) {
      throw new HttpError(404, 'stock not in portfolio');
    }
    res.status(201).json(await store.addRule(userId, { symbol: symbol ?? null, window, thresholdPct }));
  });

  api.put('/rules/:id', async (req, res) => {
    const body = parse(ruleUpdateSchema, req.body);
    const updated = await store.updateRule(req.session.user.id, parseId(req.params.id), body);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/rules/:id', async (req, res) => {
    if (!(await store.removeRule(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  // ---------- notifications ----------
  api.get('/notifications', async (req, res) => {
    const userId = req.session.user.id;
    res.json({ unread: await store.unreadCount(userId), items: await store.listNotifications(userId, 50) });
  });
  api.post('/notifications/read', async (req, res) => {
    await store.markAllRead(req.session.user.id);
    res.status(204).end();
  });

  api.post('/refresh', limiter(60_000, 5), async (req, res) => {
    res.json(await tracker.refreshForUser(req.session.user.id));
  });

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
