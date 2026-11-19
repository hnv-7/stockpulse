import { z } from 'zod';
import { istDate, addDays, isStale, marketStatus } from '../dates.js';
import { buildReport, portfolioHistory, datedSales, mergeBySymbol } from '../analytics.js';
import { BENCHMARK, indexChange, sameMoneyInIndex, relativePerformance } from '../benchmark.js';
import { capitalGains, openPositions, harvesting, fyOf, TAX_RULES } from '../capital-gains.js';
import { classifier } from '../assets.js';
import { allocation, rebalance, dividendStart, dividendsReceived } from '../income.js';
import { HttpError, parse } from '../http.js';
import { periodSchema, rangeSchema, symbolSchema, targetsSchema } from '../schemas.js';
import { SOLD_BACKFILL_RETRY_MS } from '../portfolio-data.js';
import { upcomingEvents, refreshEvents, EVENTS_AHEAD_DAYS } from '../events.js';

export const RANGE_DAYS = { '1m': 30, '3m': 90, '6m': 182, '1y': 365 };
/** Company sectors are looked up again after this long... */
const SECTOR_REFRESH_MS = 90 * 86_400_000;
/** ...and a symbol's dividends after this long, so new ones show up within a week. */
const DIVIDEND_REFRESH_MS = 7 * 86_400_000;
/** Yahoo lookups (sectors, dividends) per request, so a big portfolio fills in over a few page loads. */
export const LOOKUPS_PER_REQUEST = 5;

/**
 * Reports over one portfolio (?portfolio=<id>) or all of them: the dashboard report, value over time, capital gains,
 * sectors, dividends, the Nifty 50 comparison and per-stock history. Needs a session.
 */
export function reportRoutes(api, { store, tracker, lookups, data }) {
  /**
   * Stored company details (sector, kind, a fund's category) for `symbols`, looking up a few that are missing or old.
   * A failed lookup isn't saved, so it is tried again next time; "Yahoo has no sector" is saved and kept.
   */
  async function stockInfoFor(symbols) {
    const now = Date.now();
    let info = await store.stockInfo(symbols);
    const due = symbols.filter((s) => !info.has(s) || now - info.get(s).fetchedAt > SECTOR_REFRESH_MS).slice(0, LOOKUPS_PER_REQUEST);
    if (due.length) {
      await Promise.allSettled(due.map(async (s) => store.saveStockInfo(s, await lookups.profile(s), now)));
      info = await store.stockInfo(symbols);
    }
    return info;
  }

  api.get('/report', async (req, res) => {
    const userId = req.session.user.id;
    const period = parse(periodSchema, req.query.period);
    const scope = await data.scopeOf(req);
    const ctx = await data.loadAll(userId, period, scope);
    const report = buildReport(ctx);
    const symbols = ctx.holdings.map((h) => h.symbol);
    const asOf = await store.lastSnapshotTs(symbols);
    // Per stock: when its price was last fetched, and whether that is too old to call "current".
    const fetchedAt = await store.lastSnapshotTsBySymbol(symbols);
    const now = Date.now();
    // Until a split is confirmed, the stock's quantity is in the old shares and its value is off.
    const pendingSplits = await store.pendingSplits(userId);
    const splitPending = new Set(pendingSplits.map((p) => p.symbol));
    const rows = report.holdings.map((r) => {
      const priceAsOf = fetchedAt.get(r.symbol) ?? null;
      return { ...r, priceAsOf, stale: r.price != null && isStale(priceAsOf, now), splitPending: splitPending.has(r.symbol) };
    });
    // Whether NSE is trading, from the latest day Nifty 50 has a price.
    const market = marketStatus((await store.seriesBounds(BENCHMARK.symbol))?.last, now);
    res.json({ ...report, holdings: rows, asOf, pendingSplits, market, realised: await store.salesTotals(userId, scope) });
  });

  api.get('/portfolio/history', async (req, res) => {
    const range = parse(rangeSchema, req.query.range);
    const fromDate = addDays(istDate(), -RANGE_DAYS[range]);
    const { holdings, soldLots, seriesBySymbol } = await data.loadHeld(req.session.user.id, fromDate, await data.scopeOf(req));
    res.json(portfolioHistory({ holdings, soldLots, seriesBySymbol, fromDate }));
  });

  // ---------- capital gains ----------
  // Realised gains for a financial year split into short- and long-term, an estimate of the tax, and (for the current
  // year) what is still held: unrealised gains by term and purchases about to turn long-term.
  api.get('/capital-gains', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    const today = istDate();
    const current = fyOf(today);
    const fy = parse(z.coerce.number().int().min(2000).max(current).default(current), req.query.fy);
    const lots = await store.listSaleLotsForGains(userId, scope);
    const years = [...new Set([current, ...lots.map((l) => fyOf(l.saleDate))])].sort((a, b) => b - a);
    const ctx = fy === current ? await data.loadAll(userId, '1d', scope) : null;
    // How each holding is taxed: shares and equity funds go in the estimate, debt/gold/international funds don't.
    const named = [...lots.map((l) => [l.symbol, l.name]), ...(ctx?.holdings ?? []).map((h) => [h.symbol, h.name])];
    const symbols = [...new Set(named.map(([s]) => s))];
    const classOf = classifier(await stockInfoFor(symbols), new Map(named));
    const result = capitalGains({ lots, fy, classOf });
    let open = null;
    let harvest = null;
    if (ctx) {
      const { lots: openLots, ...rest } = openPositions({ holdings: ctx.holdings, latestBySymbol: ctx.latestBySymbol, today, classOf });
      open = rest;
      harvest = harvesting({ realised: result.rows, lots: openLots, fy, today });
    }
    const notEquity = symbols.filter((s) => classOf(s) === 'other');
    res.json({ ...result, years, current: fy === current, open, harvest, notEquity, rules: TAX_RULES });
  });

  // ---------- sectors and concentration ----------
  // Targets are kept per portfolio, and separately for all portfolios together (scope 0).
  api.get('/allocation', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    const ctx = await data.loadAll(userId, '1d', scope);
    const report = buildReport(ctx);
    const info = await stockInfoFor(ctx.holdings.map((h) => h.symbol));
    const alloc = allocation(report.holdings, info);
    const targets = await store.allocationTargets(userId, scope ?? 0);
    res.json({ ...alloc, targets, rebalance: targets.length ? rebalance(alloc, targets) : null });
  });

  api.put('/allocation/targets', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    const { targets } = parse(targetsSchema, req.body);
    await store.setAllocationTargets(userId, scope ?? 0, targets);
    res.json({ targets: await store.allocationTargets(userId, scope ?? 0) });
  });

  // ---------- dividends ----------
  // symbol -> when a dividend lookup last failed (per server instance), so it isn't retried on every page load.
  const dividendFailedAt = new Map();

  api.get('/dividends', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    const holdings = await data.holdingsFor(userId, scope);
    const saleLots = await store.listSaleLotsForGains(userId, scope);
    const start = dividendStart({ holdings, saleLots });
    const symbols = [...start.keys()];
    const now = Date.now();
    const checks = await store.dividendChecks(symbols);
    const due = symbols
      .filter((s) => {
        const c = checks.get(s);
        const stale = !c || c.from > start.get(s) || now - c.checkedAt > DIVIDEND_REFRESH_MS;
        return stale && now - (dividendFailedAt.get(s) ?? 0) > SOLD_BACKFILL_RETRY_MS;
      })
      .slice(0, LOOKUPS_PER_REQUEST);
    await Promise.allSettled(
      due.map(async (s) => {
        const c = checks.get(s);
        const from = addDays(c && c.from < start.get(s) ? c.from : start.get(s), -5);
        try {
          await store.saveDividends(s, await lookups.dividends(s, from));
          await store.markDividendsChecked(s, from, now);
        } catch (err) {
          dividendFailedAt.set(s, now);
          throw err;
        }
      }),
    );
    const dividendsBySymbol = await store.dividendsFor(symbols);
    res.json({
      ...dividendsReceived({ holdings, saleLots, dividendsBySymbol, today: istDate() }),
      // Stocks whose dividends haven't been fetched yet (more are fetched on each load).
      pending: symbols.length - (await store.dividendChecks(symbols)).size,
    });
  });

  // ---------- coming up: results and ex-dividend dates ----------
  // symbol -> when its dates last failed to load (per server instance).
  const eventsFailedAt = new Map();

  api.get('/events', async (req, res) => {
    const userId = req.session.user.id;
    const holdings = await data.holdingsFor(userId, await data.scopeOf(req));
    const watched = await store.listWatchlist(userId);
    const names = new Map([...watched, ...holdings].map((x) => [x.symbol, x.name]));
    const symbols = [...names.keys()];
    const eventsBySymbol = await refreshEvents({
      store, lookup: lookups.events, symbols, failedAt: eventsFailedAt, limit: LOOKUPS_PER_REQUEST, retryMs: SOLD_BACKFILL_RETRY_MS,
    });
    const known = [...eventsBySymbol.keys()].length;
    res.json({
      days: EVENTS_AHEAD_DAYS,
      items: upcomingEvents({
        eventsBySymbol,
        names,
        held: new Set(holdings.map((h) => h.symbol)),
        watched: new Set(watched.map((w) => w.symbol)),
        today: istDate(),
      }),
      // Shares still waiting for their first lookup (a few are looked up on each load). Funds have no such dates.
      pending: symbols.filter((s) => !s.startsWith('MF:')).length - known,
    });
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
    const ctx = await data.loadAll(req.session.user.id, period, await data.scopeOf(req));
    const report = buildReport(ctx);
    const { today } = ctx;
    // The XIRR comparison uses what the portfolio XIRR uses: holdings with every purchase dated and a price known,
    // and sales with every purchase they used up dated.
    const rows = new Map(report.holdings.map((r) => [r.symbol, r]));
    const lotsOf = (h) => (h.lots?.length ? h.lots : [{ invested: h.invested, purchase_date: h.purchase_date }]);
    const dated = ctx.holdings.filter((h) => lotsOf(h).every((l) => l.purchase_date) && rows.get(h.symbol)?.value != null);
    const lots = dated.flatMap(lotsOf);
    const sales = datedSales(ctx.sales, today);
    const earliest = [...lots, ...sales.flatMap((s) => s.lots)].map((l) => l.purchase_date).sort()[0];
    const yearAgo = addDays(today, -400);
    const indexSeries = await indexSeriesFrom(earliest && earliest < yearAgo ? earliest : yearAgo);
    if (!indexSeries.length) return res.json({ ...BENCHMARK, available: false });

    const indexNow = indexSeries[indexSeries.length - 1].close;
    const same = sameMoneyInIndex({ lots, sales, indexSeries, indexNow, today });
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
        yourReceived: sales.reduce((sum, s) => sum + s.received, 0),
        indexValue: same.value,
        indexReceived: same.received,
        coverage: report.totals.xirrCoverage,
      },
    });
  });

  api.get('/benchmark/history', async (req, res) => {
    const range = parse(rangeSchema, req.query.range);
    const fromDate = addDays(istDate(), -RANGE_DAYS[range]);
    const { holdings, soldLots, seriesBySymbol } = await data.loadHeld(req.session.user.id, fromDate, await data.scopeOf(req));
    const indexSeries = await indexSeriesFrom(fromDate);
    res.json({ ...BENCHMARK, points: relativePerformance({ holdings, soldLots, seriesBySymbol, indexSeries, fromDate }) });
  });

  api.get('/stocks/:symbol/history', async (req, res) => {
    const userId = req.session.user.id;
    const symbol = parse(symbolSchema, req.params.symbol);
    const holding = mergeBySymbol(await store.listHoldings(userId, await data.scopeOf(req))).find((h) => h.symbol === symbol);
    if (!holding && !(await store.isWatched(userId, symbol))) throw new HttpError(404, 'not found');
    const range = parse(z.enum(['1d', '1m', '3m', '6m', '1y']).default('3m'), req.query.range);
    const avgCost = holding ? holding.invested / holding.quantity : null;
    if (range === '1d') {
      return res.json({ symbol, avgCost, points: await store.getSnapshots(symbol, Date.now() - 3 * 86_400_000) });
    }
    const series = (await store.getSeriesMany([symbol], addDays(istDate(), -RANGE_DAYS[range]))).get(symbol);
    res.json({ symbol, avgCost, points: series.map((p) => ({ date: p.date, price: p.close })) });
  });
}
