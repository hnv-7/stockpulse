import { z } from 'zod';
import { istDate, addDays, isStale } from '../dates.js';
import { buildWatchlist } from '../analytics.js';
import { HttpError, parse, parseId } from '../http.js';
import { watchSchema, watchUpdateSchema } from '../schemas.js';

/** Stocks a user follows without holding them, and the shared market overview. Needs a session. */
export function watchlistRoutes(api, { store, tracker, config, limiter, lookups, markets }) {
  // Prices are polled like held stocks', and alerts can be set on them.
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

  api.post('/watchlist', limiter('watch-add', 60_000, 30), async (req, res) => {
    const userId = req.session.user.id;
    const { symbol, note } = parse(watchSchema, req.body);
    if ((await store.countWatchlist(userId)) >= config.maxWatchlistPerUser) {
      throw new HttpError(400, `you can watch up to ${config.maxWatchlistPerUser} stocks`);
    }
    if (await store.isWatched(userId, symbol)) throw new HttpError(409, `${symbol} is already on your watchlist`);
    const quote = await lookups.quote(symbol).catch(() => null);
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

  // ---------- markets: indices, sectors and their popular stocks ----------
  // The same for everyone and cached in `markets`; only the "you hold" / "watching" marks are per user.
  const MARKETS_DOWN = "Market data isn't available right now. Please try again in a few minutes.";
  async function marksFor(userId) {
    const [holdings, watched] = await Promise.all([store.listHoldings(userId), store.listWatchlist(userId)]);
    const heldSet = new Set(holdings.map((h) => h.symbol));
    const watching = new Set(watched.map((w) => w.symbol));
    return (r) => ({ ...r, held: heldSet.has(r.symbol), watching: watching.has(r.symbol) });
  }

  api.get('/markets', async (req, res) => {
    const data = await markets.overview().catch(() => null);
    if (!data) throw new HttpError(503, MARKETS_DOWN);
    const mark = await marksFor(req.session.user.id);
    res.json({ ...data, movers: { gainers: data.movers.gainers.map(mark), losers: data.movers.losers.map(mark) } });
  });

  api.get('/markets/sectors/:key', async (req, res) => {
    const key = parse(z.string().regex(/^[a-z-]{1,30}$/, 'invalid sector'), req.params.key);
    const data = await markets.sector(key).catch(() => null);
    if (data === undefined) throw new HttpError(404, 'not found');
    if (!data) throw new HttpError(503, MARKETS_DOWN);
    const mark = await marksFor(req.session.user.id);
    res.json({ ...data, stocks: data.stocks.map(mark) });
  });
}
