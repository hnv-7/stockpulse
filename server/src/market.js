import YahooFinance from 'yahoo-finance2';
import { istDate } from './dates.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/** Latest quote for one symbol, or null when Yahoo has nothing usable. */
export async function getQuote(symbol) {
  const q = await yf.quote(symbol);
  if (!q || typeof q.regularMarketPrice !== 'number') return null;
  return {
    symbol,
    price: q.regularMarketPrice,
    name: q.longName || q.shortName || symbol,
  };
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

/** Daily closes, oldest first, as [{date, close}] (dates in IST). */
export async function getDailyHistory(symbol, days = 400) {
  const period1 = new Date(Date.now() - days * 86_400_000);
  const res = await yf.chart(symbol, { period1, interval: '1d' });
  return (res.quotes || [])
    .filter((q) => typeof q.close === 'number')
    .map((q) => ({ date: istDate(q.date.getTime()), close: q.close }));
}

/** Search NSE/BSE equities by company name or ticker. */
export async function searchSymbols(query) {
  const res = await yf.search(query, { quotesCount: 12, newsCount: 0 });
  return (res.quotes || [])
    .filter((q) => q.quoteType === 'EQUITY' && ['NSI', 'BSE'].includes(q.exchange))
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchange === 'NSI' ? 'NSE' : 'BSE',
    }));
}
