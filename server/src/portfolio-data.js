import { istDate, addDays } from './dates.js';
import { groupSales, mergeBySymbol } from './analytics.js';
import { HttpError, parseId } from './http.js';

/** Sold stocks whose daily closes are missing are fetched again, at most this many per request... */
const SOLD_BACKFILL_PER_REQUEST = 5;
/** ...and a symbol is not retried more often than this (a delisted or merged stock may never come back). */
export const SOLD_BACKFILL_RETRY_MS = 6 * 3600 * 1000;

/**
 * Loading what a user holds (in one portfolio, or all of them) with the prices the reports need. Shared by the report
 * routes and the weekly summary.
 */
export function createPortfolioData({ store, tracker }) {
  // symbol -> when its history was last fetched for the chart because it was missing (per server instance).
  const soldBackfillTried = new Map();

  /** The portfolio a request is about: ?portfolio=<id> of one the user owns, or null (absent or "all") for all of them. */
  async function scopeOf(req) {
    const raw = req.query.portfolio;
    if (raw == null || raw === '' || raw === 'all') return null;
    const id = parseId(raw);
    if (!(await store.ownsPortfolio(req.session.user.id, id))) throw new HttpError(404, 'portfolio not found');
    return id;
  }

  /** Holdings in one portfolio, or across all of them with each stock once (see mergeBySymbol). */
  async function holdingsFor(userId, portfolioId = null) {
    const holdings = await store.listHoldings(userId, portfolioId);
    return portfolioId == null ? mergeBySymbol(holdings) : holdings;
  }

  /** Holdings with ~13 months of closes, the latest price of each, and past sales (for XIRR). */
  async function loadAll(userId, period, portfolioId = null) {
    const holdings = await holdingsFor(userId, portfolioId);
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
    // Past sales count in the portfolio XIRR as money taken out.
    const sales = groupSales(await store.listSaleLotsForGains(userId, portfolioId));
    return { holdings, today, seriesBySymbol, latestBySymbol, period, sales };
  }

  /**
   * What a user held at any point since `fromDate` (holdings plus the purchases sales used up) and their closes from a
   * couple of weeks before it, so the first day can carry forward a close over holidays.
   */
  async function loadHeld(userId, fromDate, portfolioId = null) {
    const holdings = await holdingsFor(userId, portfolioId);
    // Stocks sold inside the range were still held for part of it, so they count up to their sale.
    const soldLots = await store.listSoldLots(userId, fromDate, portfolioId);
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

  return { scopeOf, holdingsFor, loadAll, loadHeld };
}
