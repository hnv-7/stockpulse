import YahooFinance from 'yahoo-finance2';
import { istDate } from './dates.js';
import { createFunds, isFund } from './mf.js';

/** Mutual funds ("MF:<scheme code>") come from AMFI and mfapi.in; everything else from Yahoo. */
export const funds = createFunds();

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

/** Latest quote for one symbol, or null when Yahoo (or AMFI, for a fund) has nothing usable. */
export function getQuote(symbol) {
  if (isFund(symbol)) return quoteCache(symbol, () => funds.quote(symbol));
  return quoteCache(symbol, async () => {
    const q = await withRetry(() => yf.quote(symbol));
    if (!q || typeof q.regularMarketPrice !== 'number') return null;
    return {
      symbol,
      price: q.regularMarketPrice,
      name: q.longName || q.shortName || symbol,
      // When that price traded: on a holiday or weekend it is the last session's.
      marketTime: q.regularMarketTime instanceof Date ? q.regularMarketTime.getTime() : null,
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
 * Latest quotes for many symbols in one request, as a Map. Symbols Yahoo doesn't know are simply left out.
 * Fields are checked here rather than by the library, so one odd quote can't fail the whole batch.
 */
export async function getQuoteBatch(symbols) {
  const list = await withRetry(() => yf.quote(symbols, { return: 'array' }, { validateResult: false }));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = new Map();
  for (const q of Array.isArray(list) ? list : []) {
    if (num(q?.regularMarketPrice) == null) continue;
    const t = q.regularMarketTime;
    out.set(q.symbol, {
      symbol: q.symbol,
      price: q.regularMarketPrice,
      prevClose: num(q.regularMarketPreviousClose),
      high52: num(q.fiftyTwoWeekHigh),
      name: q.longName || q.shortName || q.symbol,
      // When that price traded: on a holiday or weekend it is the last session's.
      marketTime: t instanceof Date ? t.getTime() : typeof t === 'number' ? t * 1000 : null,
    });
  }
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
  if (isFund(symbol)) return { points: await funds.history(symbol, days), splits: [] };
  const period1 = new Date(Date.now() - days * 86_400_000);
  const res = await withRetry(() => yf.chart(symbol, { period1, interval: '1d', events: 'split' }));
  const points = (res.quotes || [])
    .filter((q) => typeof q.close === 'number')
    .map((q) => ({ date: istDate(q.date.getTime()), close: q.close }));
  return { points, splits: parseSplits(res.events?.splits) };
}

/** Dividends from a chart response, as [{date, amount}] per share with IST ex-dates, oldest first. */
export function parseDividends(events) {
  return (Array.isArray(events) ? events : [])
    .filter((d) => d?.date instanceof Date && d.amount > 0)
    .map((d) => ({ date: istDate(d.date.getTime()), amount: d.amount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Dividends per share paid since `fromDate` (YYYY-MM-DD), by ex-date. */
export async function getDividends(symbol, fromDate) {
  if (isFund(symbol)) return []; // IDCW payouts aren't tracked; growth plans pay none
  const res = await withRetry(() => yf.chart(symbol, { period1: new Date(`${fromDate}T00:00:00Z`), interval: '1d', events: 'div' }));
  return parseDividends(res.events?.dividends);
}

/**
 * A company's sector and industry, or null when Yahoo has none (common for small companies). ETFs, which Yahoo gives no
 * sector, are grouped as "ETFs"; funds as "Mutual funds" with their AMFI category as the industry. `kind` is 'stock',
 * 'etf' or 'mf'.
 */
export async function getProfile(symbol) {
  if (isFund(symbol)) return funds.profile(symbol);
  const res = await withRetry(() => yf.quoteSummary(symbol, { modules: ['assetProfile', 'quoteType'] }));
  const p = res?.assetProfile;
  const name = res?.quoteType?.longName || res?.quoteType?.shortName || '';
  const etf = res?.quoteType?.quoteType === 'ETF' || /\bETF\b|BEES\b/i.test(name);
  if (etf) return { sector: 'ETFs', industry: null, kind: 'etf' };
  return p?.sector ? { sector: p.sector, industry: p.industry ?? null, kind: 'stock' } : null;
}

/**
 * The next results date and the latest ex-dividend date Yahoo knows, as
 * {earningsDate, earningsEstimate, exDividendDate} with IST dates (null when unknown).
 */
export async function getEvents(symbol) {
  if (isFund(symbol)) return { earningsDate: null, earningsEstimate: false, exDividendDate: null };
  const res = await withRetry(() => yf.quoteSummary(symbol, { modules: ['calendarEvents'] }));
  const c = res?.calendarEvents;
  const day = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? istDate(d.getTime()) : null);
  const earnings = (c?.earnings?.earningsDate ?? []).map(day).filter(Boolean).sort();
  return { earningsDate: earnings[0] ?? null, earningsEstimate: !!c?.earnings?.isEarningsDateEstimate, exDividendDate: day(c?.exDividendDate) };
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
  if (isFund(symbol)) return funds.closeOn(symbol, date);
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

/**
 * Search NSE/BSE shares and ETFs by company name or ticker, and mutual funds by name. Shares come first; either source
 * failing just leaves its results out.
 */
export async function searchSymbols(query) {
  const [stocks, mfs] = await Promise.allSettled([
    withRetry(() => yf.search(query, { quotesCount: 12, newsCount: 0 })),
    query.trim().length >= 3 ? funds.search(query, 6) : Promise.resolve([]),
  ]);
  const listed = (stocks.status === 'fulfilled' ? stocks.value.quotes || [] : [])
    .filter((q) => ['EQUITY', 'ETF'].includes(q.quoteType) && ['NSI', 'BSE'].includes(q.exchange))
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchange === 'NSI' ? 'NSE' : 'BSE',
    }));
  if (stocks.status === 'rejected' && mfs.status === 'rejected') throw stocks.reason;
  return [...listed, ...(mfs.status === 'fulfilled' ? mfs.value : [])];
}
