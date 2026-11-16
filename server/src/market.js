import YahooFinance from 'yahoo-finance2';
import { istDate } from './dates.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/** Errors that will fail the same way next time: a bad request or an unknown symbol is not worth retrying. */
const PERMANENT = new Set(['BadRequestError', 'InvalidOptionsError', 'FailedYahooValidationError']);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying temporary failures (network errors, 429, 5xx) with a growing pause.
 * Permanent errors are thrown at once. After the last attempt the final error is thrown.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 300, sleep = sleepMs } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || PERMANENT.has(err?.name)) throw err;
      await sleep(baseMs * 3 ** (i - 1)); // 300ms, 900ms, ...
    }
  }
}

/** Small in-memory cache: the same key within `ttlMs` is answered without calling `load` again. */
export function createTtlCache(ttlMs, { now = Date.now, maxEntries = 500 } = {}) {
  const entries = new Map();
  return async function cached(key, load) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    if (value != null) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), value });
    }
    return value;
  };
}

// Several pages and the poller ask for the same symbols within moments of each other.
// On serverless hosting each instance has its own cache, so this trims repeat calls, not all of them.
const quoteCache = createTtlCache(45_000);

/** Latest quote for one symbol, or null when Yahoo has nothing usable. */
export function getQuote(symbol) {
  return quoteCache(symbol, async () => {
    const q = await withRetry(() => yf.quote(symbol));
    if (!q || typeof q.regularMarketPrice !== 'number') return null;
    return {
      symbol,
      price: q.regularMarketPrice,
      name: q.longName || q.shortName || symbol,
    };
  });
}

/** Quotes for many symbols; failures are skipped so one bad ticker cannot block the rest. */
export async function getQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map((s) => getQuote(s)));
  const out = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) out.set(symbols[i], r.value);
    else console.warn(JSON.stringify({ level: 'warn', msg: 'quote failed', symbol: symbols[i] }));
  });
  return out;
}

/**
 * Splits from a chart response, as [{date, numerator, denominator}] with IST dates: on `date` every `denominator`
 * shares became `numerator`. Yahoo records NSE/BSE bonus issues as splits too (a 1:1 bonus is "2:1").
 */
export function parseSplits(events) {
  return (Array.isArray(events) ? events : [])
    .filter((s) => s?.date instanceof Date && s.numerator > 0 && s.denominator > 0 && s.numerator !== s.denominator)
    .map((s) => ({ date: istDate(s.date.getTime()), numerator: s.numerator, denominator: s.denominator }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Daily closes (oldest first, as [{date, close}], dates in IST) and the splits in the same period.
 * Yahoo's closes are already adjusted for those splits, i.e. expressed in today's shares.
 */
export async function getDailyHistoryWithSplits(symbol, days = 400) {
  const period1 = new Date(Date.now() - days * 86_400_000);
  const res = await withRetry(() => yf.chart(symbol, { period1, interval: '1d', events: 'split' }));
  const points = (res.quotes || [])
    .filter((q) => typeof q.close === 'number')
    .map((q) => ({ date: istDate(q.date.getTime()), close: q.close }));
  return { points, splits: parseSplits(res.events?.splits) };
}

/** Daily closes, oldest first, as [{date, close}] (dates in IST). */
export async function getDailyHistory(symbol, days = 400) {
  return (await getDailyHistoryWithSplits(symbol, days)).points;
}

/**
 * Closing price on `date` (YYYY-MM-DD), or on the last trading day before it when the market was
 * closed that day (weekend/holiday). Returns {date, close} or null when Yahoo has nothing.
 */
export async function getCloseOn(symbol, date) {
  const start = new Date(`${date}T00:00:00Z`);
  const res = await withRetry(() =>
    yf.chart(symbol, {
      period1: new Date(start.getTime() - 10 * 86_400_000),
      period2: new Date(start.getTime() + 2 * 86_400_000),
      interval: '1d',
    }),
  );
  const days = (res.quotes || [])
    .filter((q) => typeof q.close === 'number')
    .map((q) => ({ date: istDate(q.date.getTime()), close: q.close }))
    .filter((d) => d.date <= date);
  return days.length ? days[days.length - 1] : null;
}

/** Search NSE/BSE equities by company name or ticker. */
export async function searchSymbols(query) {
  const res = await withRetry(() => yf.search(query, { quotesCount: 12, newsCount: 0 }));
  return (res.quotes || [])
    .filter((q) => q.quoteType === 'EQUITY' && ['NSI', 'BSE'].includes(q.exchange))
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchange === 'NSI' ? 'NSE' : 'BSE',
    }));
}
