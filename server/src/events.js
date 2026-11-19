import { addDays } from './dates.js';

/** How far ahead "coming up" looks. */
export const EVENTS_AHEAD_DAYS = 60;
/** A symbol's dates are looked up again after this long (results dates firm up as they get close). */
export const EVENTS_REFRESH_MS = 3 * 86_400_000;

/**
 * Results and ex-dividend dates from `today` to `today + days`, soonest first, as
 * [{symbol, name, type: 'results' | 'exDividend', date, estimate, held, watching}].
 * eventsBySymbol: Map(symbol -> {earningsDate, earningsEstimate, exDividendDate}) (store.stockEvents);
 * names: Map(symbol -> name); held / watched: Sets of symbols.
 */
export function upcomingEvents({ eventsBySymbol, names, held = new Set(), watched = new Set(), today, days = EVENTS_AHEAD_DAYS }) {
  const until = addDays(today, days);
  const out = [];
  const add = (symbol, type, date, estimate = false) => {
    if (date && date >= today && date <= until) {
      out.push({ symbol, name: names.get(symbol) ?? symbol, type, date, estimate, held: held.has(symbol), watching: watched.has(symbol) });
    }
  };
  for (const [symbol, ev] of eventsBySymbol) {
    add(symbol, 'results', ev.earningsDate, ev.earningsEstimate);
    add(symbol, 'exDividend', ev.exDividendDate);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.symbol.localeCompare(b.symbol)));
}

/**
 * Make sure the stored dates for `symbols` are recent, looking up at most `limit` of the oldest (Yahoo is slow and
 * shared). A failed lookup is remembered in `failedAt` (per server instance) so it isn't retried on every page load.
 */
export async function refreshEvents({ store, lookup, symbols, now = Date.now(), limit = 5, failedAt = new Map(), retryMs = 6 * 3600_000 }) {
  const known = await store.stockEvents(symbols);
  const due = symbols
    .filter((s) => !s.startsWith('MF:'))
    .filter((s) => !known.has(s) || now - known.get(s).fetchedAt > EVENTS_REFRESH_MS)
    .filter((s) => now - (failedAt.get(s) ?? 0) > retryMs)
    .slice(0, limit);
  if (!due.length) return known;
  await Promise.allSettled(
    due.map(async (s) => {
      try {
        await store.saveStockEvents(s, await lookup(s), now);
      } catch (err) {
        failedAt.set(s, now);
        throw err;
      }
    }),
  );
  return store.stockEvents(symbols);
}
