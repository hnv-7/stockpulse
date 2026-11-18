import { getQuoteBatch, getDailyHistory, createTtlCache } from './market.js';
import { pctChange, priceOnOrBefore } from './analytics.js';
import { istDate, addDays } from './dates.js';

/** Broad market indices shown at the top of the Markets tab. */
export const INDICES = [
  { symbol: '^NSEI', name: 'Nifty 50' },
  { symbol: '^BSESN', name: 'Sensex' },
  { symbol: '^NSMIDCP', name: 'Nifty Next 50' }, // Yahoo's symbol for Nifty Next 50, despite the name
  // Midcap 150 and Smallcap 250 rather than the 100s: Yahoo has no daily history for those.
  { symbol: 'NIFTYMIDCAP150.NS', name: 'Nifty Midcap 150' },
  { symbol: 'NIFTYSMLCAP250.NS', name: 'Nifty Smallcap 250' },
];

const nse = (ticker, name) => ({ symbol: `${ticker}.NS`, name });

/**
 * NSE sector indices and a handful of well-known, large companies in each (members of that index).
 * The lists are hand-picked and need an occasional look when companies merge, demerge or rename.
 * Yahoo has only today's quote for some of these indices (Healthcare, Oil & Gas, Consumer Durables, Media), not daily
 * history; for those the longer periods come from the popular stocks instead (see `basket`).
 */
export const SECTORS = [
  {
    key: 'banks', name: 'Banks', index: '^NSEBANK', indexName: 'Nifty Bank',
    stocks: [nse('HDFCBANK', 'HDFC Bank'), nse('ICICIBANK', 'ICICI Bank'), nse('SBIN', 'State Bank of India'), nse('KOTAKBANK', 'Kotak Mahindra Bank'), nse('AXISBANK', 'Axis Bank'), nse('INDUSINDBK', 'IndusInd Bank')],
  },
  {
    key: 'psu-banks', name: 'PSU banks', index: '^CNXPSUBANK', indexName: 'Nifty PSU Bank',
    stocks: [nse('SBIN', 'State Bank of India'), nse('BANKBARODA', 'Bank of Baroda'), nse('PNB', 'Punjab National Bank'), nse('CANBK', 'Canara Bank'), nse('UNIONBANK', 'Union Bank of India'), nse('INDIANB', 'Indian Bank')],
  },
  {
    key: 'finance', name: 'Financial services', index: 'NIFTY_FIN_SERVICE.NS', indexName: 'Nifty Financial Services',
    stocks: [nse('BAJFINANCE', 'Bajaj Finance'), nse('BAJAJFINSV', 'Bajaj Finserv'), nse('SHRIRAMFIN', 'Shriram Finance'), nse('JIOFIN', 'Jio Financial Services'), nse('HDFCLIFE', 'HDFC Life'), nse('SBILIFE', 'SBI Life')],
  },
  {
    key: 'it', name: 'IT', index: '^CNXIT', indexName: 'Nifty IT',
    stocks: [nse('TCS', 'Tata Consultancy Services'), nse('INFY', 'Infosys'), nse('HCLTECH', 'HCL Technologies'), nse('WIPRO', 'Wipro'), nse('TECHM', 'Tech Mahindra'), nse('PERSISTENT', 'Persistent Systems')],
  },
  {
    key: 'auto', name: 'Auto', index: '^CNXAUTO', indexName: 'Nifty Auto',
    stocks: [nse('MARUTI', 'Maruti Suzuki'), nse('M&M', 'Mahindra & Mahindra'), nse('BAJAJ-AUTO', 'Bajaj Auto'), nse('EICHERMOT', 'Eicher Motors'), nse('TVSMOTOR', 'TVS Motor'), nse('TMPV', 'Tata Motors Passenger Vehicles')],
  },
  {
    key: 'pharma', name: 'Pharma', index: '^CNXPHARMA', indexName: 'Nifty Pharma',
    stocks: [nse('SUNPHARMA', 'Sun Pharma'), nse('DIVISLAB', "Divi's Laboratories"), nse('CIPLA', 'Cipla'), nse('DRREDDY', "Dr. Reddy's"), nse('LUPIN', 'Lupin'), nse('ZYDUSLIFE', 'Zydus Lifesciences')],
  },
  {
    key: 'healthcare', name: 'Hospitals & diagnostics', index: 'NIFTY_HEALTHCARE.NS', indexName: 'Nifty Healthcare',
    stocks: [nse('APOLLOHOSP', 'Apollo Hospitals'), nse('MAXHEALTH', 'Max Healthcare'), nse('FORTIS', 'Fortis Healthcare'), nse('MEDANTA', 'Global Health (Medanta)'), nse('NH', 'Narayana Hrudayalaya'), nse('LALPATHLAB', 'Dr. Lal PathLabs')],
  },
  {
    key: 'fmcg', name: 'FMCG', index: '^CNXFMCG', indexName: 'Nifty FMCG',
    stocks: [nse('HINDUNILVR', 'Hindustan Unilever'), nse('ITC', 'ITC'), nse('NESTLEIND', 'Nestlé India'), nse('BRITANNIA', 'Britannia'), nse('TATACONSUM', 'Tata Consumer Products'), nse('DABUR', 'Dabur')],
  },
  {
    key: 'metals', name: 'Metals', index: '^CNXMETAL', indexName: 'Nifty Metal',
    stocks: [nse('TATASTEEL', 'Tata Steel'), nse('JSWSTEEL', 'JSW Steel'), nse('HINDALCO', 'Hindalco'), nse('VEDL', 'Vedanta'), nse('COALINDIA', 'Coal India'), nse('JINDALSTEL', 'Jindal Steel')],
  },
  {
    key: 'oil-gas', name: 'Oil & gas', index: 'NIFTY_OIL_AND_GAS.NS', indexName: 'Nifty Oil & Gas',
    stocks: [nse('RELIANCE', 'Reliance Industries'), nse('ONGC', 'ONGC'), nse('IOC', 'Indian Oil'), nse('BPCL', 'Bharat Petroleum'), nse('GAIL', 'GAIL'), nse('HINDPETRO', 'Hindustan Petroleum')],
  },
  {
    key: 'energy', name: 'Power', index: '^CNXENERGY', indexName: 'Nifty Energy',
    stocks: [nse('NTPC', 'NTPC'), nse('POWERGRID', 'Power Grid'), nse('TATAPOWER', 'Tata Power'), nse('ADANIPOWER', 'Adani Power'), nse('ADANIGREEN', 'Adani Green Energy'), nse('NHPC', 'NHPC')],
  },
  {
    key: 'infra', name: 'Infrastructure', index: '^CNXINFRA', indexName: 'Nifty Infrastructure',
    stocks: [nse('LT', 'Larsen & Toubro'), nse('BHARTIARTL', 'Bharti Airtel'), nse('ADANIPORTS', 'Adani Ports'), nse('ULTRACEMCO', 'UltraTech Cement'), nse('GRASIM', 'Grasim'), nse('INDIGO', 'InterGlobe Aviation (IndiGo)')],
  },
  {
    key: 'realty', name: 'Realty', index: '^CNXREALTY', indexName: 'Nifty Realty',
    stocks: [nse('DLF', 'DLF'), nse('LODHA', 'Lodha Developers'), nse('GODREJPROP', 'Godrej Properties'), nse('PHOENIXLTD', 'Phoenix Mills'), nse('PRESTIGE', 'Prestige Estates'), nse('OBEROIRLTY', 'Oberoi Realty')],
  },
  {
    key: 'durables', name: 'Consumer durables', index: 'NIFTY_CONSR_DURBL.NS', indexName: 'Nifty Consumer Durables',
    stocks: [nse('TITAN', 'Titan'), nse('HAVELLS', 'Havells'), nse('DIXON', 'Dixon Technologies'), nse('VOLTAS', 'Voltas'), nse('BLUESTARCO', 'Blue Star'), nse('CROMPTON', 'Crompton Greaves Consumer')],
  },
  {
    key: 'media', name: 'Media', index: '^CNXMEDIA', indexName: 'Nifty Media',
    stocks: [nse('SUNTV', 'Sun TV'), nse('PVRINOX', 'PVR INOX'), nse('ZEEL', 'Zee Entertainment'), nse('NAZARA', 'Nazara Technologies'), nse('SAREGAMA', 'Saregama'), nse('NETWORK18', 'Network18')],
  },
];

/** Each popular stock once, with the first sector it is listed under. */
const STOCKS = [...new Map(SECTORS.flatMap((sec) => sec.stocks.map((s) => [s.symbol, { ...s, sector: sec.name }]))).values()];
const INDEX_SYMBOLS = [...INDICES.map((i) => i.symbol), ...SECTORS.map((s) => s.index)];
/** Every symbol the Markets tab shows, quoted together in one request. */
const ALL_SYMBOLS = [...new Set([...INDEX_SYMBOLS, ...STOCKS.map((s) => s.symbol)])];

/** Periods measured back from the latest session ('1d' is against the previous close). */
const LOOKBACK_DAYS = { '1w': 7, '1m': 30, '3m': 90 };
/** How far back a trend line goes: far enough for the 3-month change's reference close. */
const TREND_DAYS = 95;
const GAINERS_SHOWN = 5;

/**
 * Price, change over each period and trend line for one instrument, from its quote and daily closes.
 * `session` (YYYY-MM-DD, IST) is the trading day the quote's price is from. Closes from that day on are replaced by the
 * quote's price, so the line ends at the price shown. "1d" is against the previous session's close; longer periods are
 * against the close on or before that many days back, null when the history doesn't reach that far.
 * `since` holds those reference dates, so a line for one period starts where its change is measured from.
 */
export function summarize(quote, series, session) {
  const past = (series ?? []).filter((p) => p.date < session);
  const changes = { '1d': pctChange(quote.price, quote.prevClose ?? past.at(-1)?.close) };
  const since = {};
  for (const [period, days] of Object.entries(LOOKBACK_DAYS)) {
    const ref = priceOnOrBefore(past, addDays(session, -days));
    changes[period] = ref ? pctChange(quote.price, ref.close) : null;
    since[period] = ref?.date ?? null;
  }
  const from = addDays(session, -TREND_DAYS);
  return {
    price: quote.price,
    changes,
    since,
    // Rounded: a line needs no more precision, and the overview carries 20 of them.
    points: [...past.filter((p) => p.date >= from), { date: session, close: quote.price }].map((p) => ({
      date: p.date,
      close: Math.round(p.close * 100) / 100,
    })),
  };
}

/**
 * An equal-weighted stand-in for an index Yahoo has no daily history for: each day, the average of the stocks' closes
 * relative to their close on the first day they all have one, times 100; `quote.price` is the same for the live prices.
 * Stocks without a quote or history are left out. Returns {quote, series} for `summarize`, or null.
 */
export function basket(quotes, seriesList, session) {
  const legs = [];
  quotes.forEach((q, i) => {
    const past = (seriesList[i] ?? []).filter((p) => p.date < session);
    if (q && past.length >= 2) legs.push({ q, past });
  });
  if (!legs.length) return null;
  const start = legs.map((l) => l.past[0].date).sort().at(-1);
  for (const l of legs) l.base = priceOnOrBefore(l.past, start).close;
  const avg = (f) => (legs.reduce((sum, l) => sum + f(l), 0) / legs.length) * 100;
  const dates = [...new Set(legs.flatMap((l) => l.past.map((p) => p.date)))].filter((d) => d >= start).sort();
  return {
    quote: { price: avg((l) => l.q.price / l.base), prevClose: null },
    series: dates.map((date) => ({ date, close: avg((l) => priceOnOrBefore(l.past, date).close / l.base) })),
  };
}

/** How many of these quotes are up, down and unchanged against the previous close. Missing quotes are skipped. */
export function breadth(quotes) {
  const out = { up: 0, down: 0, flat: 0 };
  for (const q of quotes) {
    if (!q || q.prevClose == null) continue;
    if (q.price > q.prevClose) out.up++;
    else if (q.price < q.prevClose) out.down++;
    else out.flat++;
  }
  return out;
}

/** The trading day the quotes are from: the latest quote's day in IST, or today when none says. */
function sessionOf(quotes, now) {
  let latest = 0;
  for (const q of quotes.values()) if (q.marketTime > latest) latest = q.marketTime;
  return istDate(latest || now);
}

/** Run `fn` over `items` with at most `limit` running at once, keeping the order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Market overview and sector detail. The data is the same for every user, so it is cached here and shared:
 * quotes for a minute (one batched request covers every symbol), daily closes for half an hour per symbol.
 */
export function createMarkets({ quoteBatch = getQuoteBatch, dailyHistory = getDailyHistory, now = Date.now } = {}) {
  const quoteCache = createTtlCache(60_000, { now });
  const historyCache = createTtlCache(30 * 60_000, { now });
  // Loads under way, so requests arriving together share one Yahoo call.
  const pending = new Map();
  const shared = (key, load) => {
    if (!pending.has(key)) pending.set(key, load().finally(() => pending.delete(key)));
    return pending.get(key);
  };

  const quotes = () => quoteCache('all', () => shared('quotes', () => quoteBatch(ALL_SYMBOLS)));
  // A failed history is not cached; the instrument just shows without its line until a later request.
  const history = (symbol) =>
    historyCache(symbol, () => shared(`h:${symbol}`, () => dailyHistory(symbol, 400))).catch(() => []);

  /** Indices, sectors (best first is left to the page, which picks the period) and today's biggest moves. */
  async function overview() {
    const [q, series] = await Promise.all([quotes(), mapLimit(INDEX_SYMBOLS, 5, history)]);
    if (!q?.size) return null;
    const seriesOf = new Map(INDEX_SYMBOLS.map((s, i) => [s, series[i]]));
    const session = sessionOf(q, now());
    const item = (symbol, name) => (q.has(symbol) ? { symbol, name, ...summarize(q.get(symbol), seriesOf.get(symbol), session) } : null);

    const indices = INDICES.map((i) => item(i.symbol, i.name)).filter(Boolean);
    const sectors = (
      await mapLimit(SECTORS, 3, async (sec) => {
        const base = item(sec.index, sec.name);
        if (!base) return null;
        const quotes = sec.stocks.map((s) => q.get(s.symbol));
        let basis = 'index';
        // Fewer than two closes before today means Yahoo has no history for the index: use its popular stocks instead.
        if (base.points.length < 3) {
          const b = basket(quotes, await mapLimit(sec.stocks, 6, (s) => history(s.symbol)), session);
          if (b) {
            const avg = summarize(b.quote, b.series, session);
            Object.assign(base, { changes: { ...avg.changes, '1d': base.changes['1d'] }, since: avg.since, points: avg.points });
            basis = 'stocks';
          }
        }
        return { ...base, key: sec.key, indexName: sec.indexName, basis, breadth: breadth(quotes) };
      })
    ).filter(Boolean);

    const moves = STOCKS.map((s) => {
      const quote = q.get(s.symbol);
      return quote && { symbol: s.symbol, name: s.name, sector: s.sector, price: quote.price, changePct: pctChange(quote.price, quote.prevClose) };
    }).filter((m) => m && m.changePct != null);
    const gainers = moves.filter((m) => m.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, GAINERS_SHOWN);
    const losers = moves.filter((m) => m.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, GAINERS_SHOWN);

    return {
      session,
      today: istDate(now()),
      asOf: now(),
      indices,
      sectors,
      movers: { gainers, losers },
      breadth: { ...breadth(STOCKS.map((s) => q.get(s.symbol))), of: STOCKS.length },
    };
  }

  /** One sector's popular stocks with their changes and lines; undefined for an unknown sector. */
  async function sector(key) {
    const sec = SECTORS.find((s) => s.key === key);
    if (!sec) return undefined;
    const [q, series] = await Promise.all([quotes(), mapLimit(sec.stocks, 6, (s) => history(s.symbol))]);
    if (!q?.size) return null;
    const session = sessionOf(q, now());
    const stocks = sec.stocks
      .map((s, i) => {
        const quote = q.get(s.symbol);
        if (!quote) return null;
        const high = quote.high52 == null ? null : Math.max(quote.high52, quote.price);
        return { symbol: s.symbol, name: s.name, ...summarize(quote, series[i], session), fromHighPct: pctChange(quote.price, high) };
      })
      .filter(Boolean);
    return { key: sec.key, name: sec.name, indexName: sec.indexName, symbol: sec.index, session, stocks };
  }

  return { overview, sector };
}
