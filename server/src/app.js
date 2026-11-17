import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { istDate, addDays, isStale } from './dates.js';
import { toCsv, importHoldings, isPastOrToday, MAX_IMPORT_ROWS } from './portfolio-io.js';
import { previewImport } from './import-mapping.js';
import { ImportError, MAX_FILE_BYTES } from './import-formats.js';
import { buildReport, buildWatchlist, portfolioHistory } from './analytics.js';
import { suggestRatio } from './splits.js';
import { BENCHMARK, indexChange, sameMoneyInIndex, relativePerformance } from './benchmark.js';
import { capitalGains, openPositions, fyOf, TAX_RULES } from './capital-gains.js';
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
  // Set once the user has agreed to add this purchase to a stock they already hold.
  merge: z.boolean().optional(),
});
const holdingUpdateSchema = z.object({ quantity: positive, invested: positive, purchaseDate: purchaseDateSchema });
const sellSchema = z.object({
  quantity: positive,
  salePrice: positive,
  // Brokerage, STT and other charges on the sale; reduces the profit.
  charges: z.number().finite().min(0).max(1e12).default(0),
  saleDate: z.string().refine(isPastOrToday, 'sale date must be a valid date, not in the future'),
});
const dropRuleSchema = z.object({
  kind: z.literal('drop').default('drop'),
  symbol: symbolSchema.nullable().optional(),
  window: z.enum(['1d', '1w', '1m', 'high52']),
  thresholdPct: z.number().finite().positive().lt(100),
});
// A price target needs a stock you hold, and a price to compare against.
const priceRuleSchema = z.object({
  kind: z.literal('price'),
  symbol: symbolSchema,
  direction: z.enum(['above', 'below']),
  targetPrice: z.number().finite().positive().max(1e9),
});
const ruleSchema = z.union([priceRuleSchema, dropRuleSchema]);
const ruleUpdateSchema = z.object({
  thresholdPct: z.number().finite().positive().lt(100).optional(),
  targetPrice: z.number().finite().positive().max(1e9).optional(),
  enabled: z.boolean(),
});
const settingsSchema = z.object({ alertEmail: z.boolean() });
const noteSchema = z.string().trim().max(200, 'keep the note under 200 characters');
const watchSchema = z.object({ symbol: symbolSchema, note: noteSchema.default('') });
const watchUpdateSchema = z.object({ note: noteSchema });
// Every `denominator` shares became `numerator` (a 1:1 bonus is 2 for 1).
const splitRatioSchema = z
  .object({
    numerator: z.number().finite().positive().max(1000),
    denominator: z.number().finite().positive().max(1000),
  })
  .refine((r) => r.numerator !== r.denominator, 'a split must change the number of shares');

const RANGE_DAYS = { '1m': 30, '3m': 90, '6m': 182, '1y': 365 };
/** Sold stocks whose daily closes are missing are fetched again, at most this many per request... */
const SOLD_BACKFILL_PER_REQUEST = 5;
/** ...and a symbol is not retried more often than this (a delisted or merged stock may never come back). */
const SOLD_BACKFILL_RETRY_MS = 6 * 3600 * 1000;

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
    res.set('Content-Disposition', `attachment; filename="stockbeat-portfolio-${istDate()}.csv"`);
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
    const { symbol, quantity: qtyIn, invested: investedIn, purchaseDate, merge } = parse(holdingSchema, req.body);
    if (!qtyIn && !investedIn) throw new HttpError(400, 'enter the quantity, the amount invested, or both');
    const current = (await store.listHoldings(userId)).find((h) => h.symbol === symbol);
    if (current && !merge) {
      throw new HttpError(409, 'stock already in portfolio — confirm to add this purchase to the existing holding');
    }
    if (!current && (await store.countHoldings(userId)) >= config.maxHoldingsPerUser) {
      throw new HttpError(400, `you can track up to ${config.maxHoldingsPerUser} stocks`);
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

    if (current) {
      // Another buy of a stock already held: record it as its own purchase (with its own date).
      const merged = await store.addLot(userId, current.id, { quantity, invested, purchaseDate: purchaseDate ?? null });
      if (!merged) throw new HttpError(404, 'not found');
      return res.json({ ...merged, merged: true, ...(priceOn ? { priceOn } : {}) });
    }
    // First purchase of this stock: create the holding.

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

  // Edit or remove one purchase of a stock; the stock's totals follow.
  api.put('/holdings/:id/lots/:lotId', async (req, res) => {
    const body = parse(holdingUpdateSchema, req.body);
    const updated = await store.updateLot(req.session.user.id, parseId(req.params.id), parseId(req.params.lotId), body);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/holdings/:id/lots/:lotId', async (req, res) => {
    const out = await store.removeLot(req.session.user.id, parseId(req.params.id), parseId(req.params.lotId));
    if (out.status === 'missing') throw new HttpError(404, 'not found');
    if (out.status === 'last') throw new HttpError(400, 'this is the only purchase — remove the stock instead');
    res.json(out.holding);
  });

  api.delete('/holdings/:id', async (req, res) => {
    if (!(await store.removeHolding(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  // ---------- sales ----------
  // Sell some or all shares of a stock. Purchases are used oldest first; a fully sold stock leaves the holdings
  // and its sale stays in the history.
  const saleFailure = (out) => {
    if (out.status === 'missing') throw new HttpError(404, 'not found');
    if (out.status === 'cap') throw new HttpError(400, `you can track up to ${config.maxHoldingsPerUser} stocks, so this stock cannot come back to your holdings`);
    if (out.status === 'too_many') throw new HttpError(400, `you only hold ${out.held} shares`);
    if (out.status === 'before_purchase') {
      throw new HttpError(400, `the sale date is before a purchase made on ${out.date} (shares are sold oldest first)`);
    }
  };

  api.post('/holdings/:id/sell', limiter(60_000, 30), async (req, res) => {
    const body = parse(sellSchema, req.body);
    const out = await store.sellShares(req.session.user.id, parseId(req.params.id), body);
    saleFailure(out);
    res.json({ sale: out.sale, holding: out.holding, closed: out.holding === null });
  });

  // Fix a mistake in a sale: the shares go back to your holding and are sold again with the new figures.
  // Either all of it happens or none of it.
  api.put('/sales/:id', limiter(60_000, 30), async (req, res) => {
    const body = parse(sellSchema, req.body);
    const out = await store.updateSale(req.session.user.id, parseId(req.params.id), body, { maxHoldings: config.maxHoldingsPerUser });
    saleFailure(out);
    res.json({ sale: out.sale, holding: out.holding, closed: out.holding === null });
  });

  // Delete a sale: the shares it sold return to your holding with their original cost and purchase dates.
  api.delete('/sales/:id', limiter(60_000, 30), async (req, res) => {
    const out = await store.removeSale(req.session.user.id, parseId(req.params.id), { maxHoldings: config.maxHoldingsPerUser });
    saleFailure(out);
    res.json({ holding: out.holding, reopened: out.reopened });
  });

  api.get('/sales', async (req, res) => {
    const userId = req.session.user.id;
    res.json({ totals: await store.salesTotals(userId), items: await store.listSales(userId) });
  });

  // ---------- watchlist ----------
  // Stocks a user follows without holding them. Prices are polled like held stocks', and alerts can be set on them.
  api.get('/watchlist', async (req, res) => {
    const userId = req.session.user.id;
    const items = await store.listWatchlist(userId);
    const symbols = items.map((w) => w.symbol);
    const today = istDate();
    const seriesBySymbol = await store.getSeriesMany(symbols, addDays(today, -400));
    const latestBySymbol = new Map();
    for (const [symbol, s] of seriesBySymbol) if (s.length) latestBySymbol.set(symbol, s[s.length - 1].close);
    const fetchedAt = await store.lastSnapshotTsBySymbol(symbols);
    const held = new Set((await store.listHoldings(userId)).map((h) => h.symbol));
    const rules = await store.listRules(userId);
    const splitPending = new Set((await store.pendingSplits(userId)).map((p) => p.symbol));
    const now = Date.now();
    res.json(
      buildWatchlist({ items, seriesBySymbol, latestBySymbol, today }).map((r) => {
        const priceAsOf = fetchedAt.get(r.symbol) ?? null;
        return {
          ...r,
          priceAsOf,
          stale: r.price != null && isStale(priceAsOf, now),
          held: held.has(r.symbol),
          splitPending: splitPending.has(r.symbol),
          targets: rules
            .filter((x) => x.kind === 'price' && x.symbol === r.symbol)
            .map((x) => ({ id: x.id, direction: x.direction, targetPrice: x.target_price, enabled: x.enabled })),
        };
      }),
    );
  });

  api.post('/watchlist', limiter(60_000, 30), async (req, res) => {
    const userId = req.session.user.id;
    const { symbol, note } = parse(watchSchema, req.body);
    if ((await store.countWatchlist(userId)) >= config.maxWatchlistPerUser) {
      throw new HttpError(400, `you can watch up to ${config.maxWatchlistPerUser} stocks`);
    }
    if (await store.isWatched(userId, symbol)) throw new HttpError(409, `${symbol} is already on your watchlist`);
    const quote = await lookupQuote(symbol).catch(() => null);
    if (!quote) throw new HttpError(404, 'symbol not found (use NSE/BSE format, e.g. INFY.NS)');
    const item = await store.addWatch(userId, { symbol, name: quote.name, note, addedPrice: quote.price });
    if (!item) throw new HttpError(409, `${symbol} is already on your watchlist`);
    // History is shared, so only fetch it if nobody holds or watches this symbol yet.
    const have = (await store.getSeriesMany([symbol], addDays(istDate(), -60))).get(symbol);
    if (have.length < 20) await tracker.backfill(symbol).catch(() => 0);
    await store.saveSnapshots([{ symbol, ts: Date.now(), price: quote.price }]);
    res.status(201).json(item);
  });

  api.put('/watchlist/:id', async (req, res) => {
    const { note } = parse(watchUpdateSchema, req.body);
    const updated = await store.updateWatchNote(req.session.user.id, parseId(req.params.id), note);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/watchlist/:id', async (req, res) => {
    if (!(await store.removeWatch(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  // ---------- splits and bonus issues ----------
  // Found by the poller; a user's shares only change when they confirm (with a ratio they can correct).
  api.get('/splits', async (req, res) => {
    const reviews = await store.listSplitReviews(req.session.user.id);
    res.json(reviews.map((r) => ({ ...r, suggested: suggestRatio(r.reported, r.priceRatio) })));
  });

  api.post('/splits/:id/apply', limiter(60_000, 30), async (req, res) => {
    const ratio = parse(splitRatioSchema, req.body);
    const r = await store.applySplitReview(req.session.user.id, parseId(req.params.id), ratio);
    if (r.status === 'missing') throw new HttpError(404, 'not found');
    if (r.status === 'resolved') throw new HttpError(409, 'this split was already confirmed or dismissed');
    res.json(r);
  });

  api.post('/splits/:id/dismiss', limiter(60_000, 30), async (req, res) => {
    if (!(await store.dismissSplitReview(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
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
    const symbols = ctx.holdings.map((h) => h.symbol);
    const asOf = await store.lastSnapshotTs(symbols);
    // Per stock: when its price was last fetched, and whether that is too old to call "current".
    const fetchedAt = await store.lastSnapshotTsBySymbol(symbols);
    const now = Date.now();
    // Until a split is confirmed, the stock's quantity is in the old shares and its value is off.
    const pendingSplits = await store.pendingSplits(req.session.user.id);
    const splitPending = new Set(pendingSplits.map((p) => p.symbol));
    const rows = report.holdings.map((r) => {
      const priceAsOf = fetchedAt.get(r.symbol) ?? null;
      return { ...r, priceAsOf, stale: r.price != null && isStale(priceAsOf, now), splitPending: splitPending.has(r.symbol) };
    });
    res.json({ ...report, holdings: rows, asOf, pendingSplits, realised: await store.salesTotals(req.session.user.id) });
  });

  // symbol -> when its history was last fetched for the chart because it was missing (per server instance).
  const soldBackfillTried = new Map();

  /**
   * What a user held at any point since `fromDate` (holdings plus the purchases sales used up) and their closes from a
   * couple of weeks before it, so the first day can carry forward a close over holidays.
   */
  async function loadHeld(userId, fromDate) {
    const holdings = await store.listHoldings(userId);
    // Stocks sold inside the range were still held for part of it, so they count up to their sale.
    const soldLots = await store.listSoldLots(userId, fromDate);
    const symbols = [...new Set([...holdings, ...soldLots].map((x) => x.symbol))];
    const seriesFrom = addDays(fromDate, -14);
    let seriesBySymbol = await store.getSeriesMany(symbols, seriesFrom);

    // Stocks sold before their closes were kept have no prices any more: fetch them again.
    const held = new Set(holdings.map((h) => h.symbol));
    const now = Date.now();
    const missing = symbols
      .filter((s) => !held.has(s) && !seriesBySymbol.get(s).length)
      .filter((s) => now - (soldBackfillTried.get(s) ?? 0) > SOLD_BACKFILL_RETRY_MS)
      .slice(0, SOLD_BACKFILL_PER_REQUEST);
    if (missing.length) {
      for (const s of missing) soldBackfillTried.set(s, now);
      await Promise.allSettled(missing.map((s) => tracker.backfill(s)));
      seriesBySymbol = await store.getSeriesMany(symbols, seriesFrom);
    }
    return { holdings, soldLots, seriesBySymbol };
  }

  api.get('/portfolio/history', async (req, res) => {
    const range = parse(z.enum(['1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const fromDate = addDays(istDate(), -RANGE_DAYS[range]);
    const { holdings, soldLots, seriesBySymbol } = await loadHeld(req.session.user.id, fromDate);
    res.json(portfolioHistory({ holdings, soldLots, seriesBySymbol, fromDate }));
  });

  // ---------- capital gains ----------
  // Realised gains for a financial year split into short- and long-term, an estimate of the tax, and (for the current
  // year) what is still held: unrealised gains by term and purchases about to turn long-term.
  api.get('/capital-gains', async (req, res) => {
    const userId = req.session.user.id;
    const today = istDate();
    const current = fyOf(today);
    const fy = parse(z.coerce.number().int().min(2000).max(current).default(current), req.query.fy);
    const lots = await store.listSaleLotsForGains(userId);
    const years = [...new Set([current, ...lots.map((l) => fyOf(l.saleDate))])].sort((a, b) => b - a);
    const result = capitalGains({ lots, fy });
    let open = null;
    if (fy === current) {
      const ctx = await loadAll(userId, '1d');
      open = openPositions({ holdings: ctx.holdings, latestBySymbol: ctx.latestBySymbol, today });
    }
    res.json({ ...result, years, current: fy === current, open, rules: TAX_RULES });
  });

  // ---------- comparison with Nifty 50 ----------
  /** Stored index closes from `fromDate` (fetched first if they don't reach back that far), or [] if unavailable. */
  async function indexSeriesFrom(fromDate) {
    await tracker.ensureIndexHistory(fromDate);
    return (await store.getSeriesMany([BENCHMARK.symbol], addDays(fromDate, -15))).get(BENCHMARK.symbol);
  }

  // Your stocks against Nifty 50: over the report period, and since you bought (the same money on the same days).
  api.get('/benchmark', async (req, res) => {
    const period = parse(periodSchema, req.query.period);
    const ctx = await loadAll(req.session.user.id, period);
    const report = buildReport(ctx);
    const { today } = ctx;
    // The XIRR comparison uses the holdings the portfolio XIRR uses: every purchase dated, and a price known.
    const rows = new Map(report.holdings.map((r) => [r.symbol, r]));
    const lotsOf = (h) => (h.lots?.length ? h.lots : [{ invested: h.invested, purchase_date: h.purchase_date }]);
    const dated = ctx.holdings.filter((h) => lotsOf(h).every((l) => l.purchase_date) && rows.get(h.symbol)?.value != null);
    const lots = dated.flatMap(lotsOf);
    const earliest = lots.map((l) => l.purchase_date).sort()[0];
    const yearAgo = addDays(today, -400);
    const indexSeries = await indexSeriesFrom(earliest && earliest < yearAgo ? earliest : yearAgo);
    if (!indexSeries.length) return res.json({ ...BENCHMARK, available: false });

    const indexNow = indexSeries[indexSeries.length - 1].close;
    const same = sameMoneyInIndex({ lots, indexSeries, indexNow, today });
    res.json({
      ...BENCHMARK,
      available: true,
      asOf: indexSeries[indexSeries.length - 1].date,
      period: { period, yoursPct: report.totals.changePct, indexPct: indexChange({ indexSeries, indexNow, today, period }) },
      sincePurchase: same && {
        yourXirrPct: report.totals.xirrPct,
        indexXirrPct: same.xirrPct,
        invested: same.invested,
        yourValue: dated.reduce((sum, h) => sum + rows.get(h.symbol).value, 0),
        indexValue: same.value,
        coverage: report.totals.xirrCoverage,
      },
    });
  });

  api.get('/benchmark/history', async (req, res) => {
    const range = parse(z.enum(['1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const fromDate = addDays(istDate(), -RANGE_DAYS[range]);
    const { holdings, soldLots, seriesBySymbol } = await loadHeld(req.session.user.id, fromDate);
    const indexSeries = await indexSeriesFrom(fromDate);
    res.json({ ...BENCHMARK, points: relativePerformance({ holdings, soldLots, seriesBySymbol, indexSeries, fromDate }) });
  });

  api.get('/stocks/:symbol/history', async (req, res) => {
    const userId = req.session.user.id;
    const symbol = parse(symbolSchema, req.params.symbol);
    const holding = (await store.listHoldings(userId)).find((h) => h.symbol === symbol);
    if (!holding && !(await store.isWatched(userId, symbol))) throw new HttpError(404, 'not found');
    const range = parse(z.enum(['1d', '1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const avgCost = holding ? holding.invested / holding.quantity : null;
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
    const body = parse(ruleSchema, req.body);
    const { symbol } = body;
    if ((await store.countRules(userId)) >= config.maxRulesPerUser) {
      throw new HttpError(400, `you can have up to ${config.maxRulesPerUser} alerts`);
    }
    if (symbol && !(await store.listHoldings(userId)).some((h) => h.symbol === symbol) && !(await store.isWatched(userId, symbol))) {
      throw new HttpError(404, 'stock not in your portfolio or watchlist');
    }
    const fields =
      body.kind === 'price'
        ? { kind: 'price', symbol, direction: body.direction, targetPrice: body.targetPrice }
        : { kind: 'drop', symbol: symbol ?? null, window: body.window, thresholdPct: body.thresholdPct };
    res.status(201).json(await store.addRule(userId, fields));
  });

  api.put('/rules/:id', async (req, res) => {
    const userId = req.session.user.id;
    const id = parseId(req.params.id);
    const body = parse(ruleUpdateSchema, req.body);
    const existing = await store.getRule(userId, id);
    if (!existing) throw new HttpError(404, 'not found');
    // Only the level that belongs to this kind of rule can change; the other is ignored.
    const level = existing.kind === 'price' ? { targetPrice: body.targetPrice } : { thresholdPct: body.thresholdPct };
    const updated = await store.updateRule(userId, id, { ...level, enabled: body.enabled });
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
