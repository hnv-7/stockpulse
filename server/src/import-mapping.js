import { isPastOrToday, MAX_IMPORT_ROWS } from './portfolio-io.js';
import { ImportError, readTables } from './import-formats.js';

/**
 * Turns the rows of an uploaded broker statement (Groww, Zerodha, Dhan, Upstox, Angel One, ...)
 * into holdings. Brokers name their columns differently, so columns are recognised by name,
 * not by position, and the header row is searched for (statements start with a preamble).
 */

export const MAX_LOOKUP_ROWS = 100;
const HEADER_SEARCH_ROWS = 80;

// Lower-case, drop a "(Rs.)" / "(₹)" / "(INR)" unit marker, keep only letters/digits: "Avg. Buy Price (Rs.)" -> "avgbuyprice".
const norm = (h) =>
  String(h ?? '')
    .toLowerCase()
    .replace(/\(\s*(rs\.?|inr|₹)\s*\)/g, '')
    .replace(/[^a-z0-9]/g, '');

const ALIASES = {
  symbol: ['symbol', 'tradingsymbol', 'tradingsym', 'ticker', 'scripsymbol', 'stocksymbol', 'securitysymbol', 'nsesymbol', 'instrument'],
  name: ['stockname', 'name', 'companyname', 'company', 'scripname', 'securityname', 'security', 'stock', 'scrip', 'instrumentname', 'description'],
  isin: ['isin', 'isincode', 'isinno'],
  exchange: ['exchange', 'exch'],
  qty: ['totalqty', 'totalquantity', 'quantity', 'qty', 'netqty', 'netquantity', 'holdingqty', 'holdingquantity', 'quantityheld', 'qtyheld', 'shares', 'noofshares'],
  avg: ['averageprice', 'averagebuyprice', 'avgprice', 'avgbuyprice', 'avgcostprice', 'avgcost', 'averagecost', 'averagecostprice', 'buyaverage', 'buyavg', 'avgrate', 'costprice', 'buyprice', 'purchaseprice', 'avgpurchaseprice', 'averagepurchaseprice'],
  invested: ['buyvalue', 'invested', 'investedvalue', 'investedamount', 'totalinvested', 'totalbuyvalue', 'totalcost', 'costvalue', 'purchasevalue', 'investment', 'totalinvestment', 'buyamount'],
  date: ['purchasedate', 'dateofpurchase', 'buydate', 'boughton', 'acquisitiondate', 'tradedate', 'date'],
};
// Zerodha's console statement splits the total across several columns (Long Term is a subset, so it is left out).
const QTY_PARTS = new Set(['quantityavailable', 'quantitydiscrepant', 'quantitypledgedmargin', 'quantitypledgedloan']);

function roles(cells) {
  const h = cells.map(norm);
  const pick = (list) => {
    for (const a of list) {
      const i = h.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };
  const r = Object.fromEntries(Object.entries(ALIASES).map(([k, list]) => [k, pick(list)]));
  r.qtyParts = r.qty >= 0 ? [] : h.map((x, i) => (QTY_PARTS.has(x) ? i : -1)).filter((i) => i >= 0);
  return r;
}
const usable = (r) =>
  (r.symbol >= 0 || r.name >= 0 || r.isin >= 0) && (r.qty >= 0 || r.qtyParts.length > 0) && (r.avg >= 0 || r.invested >= 0);

const num = (v) => {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const s = String(v).replace(/[₹,\s]|rs\.?|inr/gi, '');
  return /^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
};
const round2 = (x) => Math.round(x * 100) / 100;
const text = (v) => (v == null ? '' : String(v).trim());

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/** Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, "05 Jan 2024", ISO datetimes and Date objects. */
export function normaliseDate(v) {
  if (v == null || text(v) === '') return { date: null };
  let date = null;
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) date = v.toISOString().slice(0, 10);
  } else {
    const s = text(v);
    let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s))) date = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(s))) date = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    else if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]+(\d{4})$/.exec(s)) && MONTHS[m[2].toLowerCase()]) {
      date = `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
    }
  }
  return date && isPastOrToday(date) ? { date } : { date: null, bad: true };
}

/** Pick the table + header row with the most data rows beneath it. */
function findTable(tables) {
  let best = null;
  for (const records of tables) {
    for (let i = 0; i < Math.min(records.length, HEADER_SEARCH_ROWS); i++) {
      const r = roles(records[i].cells);
      if (!usable(r)) continue;
      const size = records.length - i - 1;
      if (!best || size > best.size) best = { roles: r, rows: records.slice(i + 1), size };
      break; // first matching header in this table
    }
  }
  return best;
}

const SUMMARY_ROW = /^(total|grand total|sub ?total|summary|disclaimer|note)\b/i;

/**
 * Read holdings rows from the tables of an uploaded file.
 * Returns { rows: [{line, symbolRaw, name, isin, exchange, quantity, invested, purchaseDate, notes}], errors: [{line, name, error}] }.
 */
export function extractHoldings(tables) {
  const found = findTable(tables);
  if (!found) {
    throw new ImportError(
      'could not find a holdings table - it needs columns like Stock Name or Symbol, Quantity, and Average price or Invested value',
    );
  }
  const { roles: c, rows: records } = found;
  if (records.length > MAX_IMPORT_ROWS) throw new ImportError(`too many rows (max ${MAX_IMPORT_ROWS})`);
  const rows = [];
  const errors = [];

  for (const { line, cells } of records) {
    const first = cells.find((x) => text(x) !== '');
    if (first === undefined || SUMMARY_ROW.test(text(first))) continue;
    const at = (i) => (i >= 0 ? cells[i] : undefined);

    let quantity = c.qty >= 0 ? num(at(c.qty)) : NaN;
    if (c.qty < 0) {
      const parts = c.qtyParts.map((i) => num(cells[i])).filter((x) => !Number.isNaN(x));
      if (parts.length) quantity = parts.reduce((a, b) => a + b, 0);
    }
    const avg = num(at(c.avg));
    let invested = num(at(c.invested));
    if (!(invested > 0) && avg > 0 && quantity > 0) invested = round2(quantity * avg);

    // Lines with no figures at all are headings, notes or page furniture, not holdings.
    if (Number.isNaN(quantity) && Number.isNaN(invested)) continue;
    const name = text(at(c.name));
    const symbolRaw = text(at(c.symbol));
    const label = name || symbolRaw || text(at(c.isin));
    if (quantity === 0) continue; // fully sold, still listed by some brokers
    if (!(quantity > 0)) { errors.push({ line, name: label, error: 'quantity is missing or not a positive number' }); continue; }
    if (!(invested > 0)) { errors.push({ line, name: label, error: 'invested amount / average price is missing' }); continue; }

    const notes = [];
    const d = normaliseDate(at(c.date));
    if (d.bad) notes.push('purchase date ignored (not a valid past date)');
    rows.push({
      line,
      symbolRaw,
      name,
      isin: text(at(c.isin)).toUpperCase(),
      exchange: text(at(c.exchange)).toUpperCase(),
      quantity,
      invested,
      purchaseDate: d.date,
      notes,
    });
  }
  if (!rows.length && !errors.length) throw new ImportError('the file has no holdings rows');
  return { rows, errors };
}

// ---------- symbol resolution ----------
const SERIES_SUFFIX = /-(EQ|BE|BZ|SM|ST|T0|X1|XT|IL)$/;
const TICKER = /^[A-Z0-9&-]{1,20}$/;
const WITH_EXCHANGE = /^[A-Z0-9&-]{1,20}\.(NS|BO)$/;
const ISIN = /^IN[A-Z0-9]{10}$/;

/**
 * Work out the Yahoo symbol (SYMBOL.NS / SYMBOL.BO) for each row.
 *  1. a ticker with .NS/.BO is used as is;
 *  2. a bare ticker (Zerodha, Dhan) is tried on NSE then BSE (BSE first when the file says so);
 *  3. otherwise the ISIN, then the company name, are searched (NSE listing preferred).
 * Rows matched by name are flagged so the user can double-check them in the preview.
 */
export async function resolveSymbols(rows, { lookupQuote, search, fundByIsin = null, concurrency = 4 }) {
  const cache = new Map();
  let lookups = 0;

  async function resolve(r) {
    const raw = r.symbolRaw.toUpperCase().replace(/\s+/g, '').replace(SERIES_SUFFIX, '');
    if (WITH_EXCHANGE.test(raw)) return { symbol: raw, name: r.name, match: 'symbol' };

    const key = `${raw}|${r.isin}|${r.name}|${r.exchange}`;
    if (cache.has(key)) return cache.get(key);
    if (++lookups > MAX_LOOKUP_ROWS) return { error: `too many stocks to look up at once (max ${MAX_LOOKUP_ROWS})` };

    const p = (async () => {
      try {
        if (TICKER.test(raw)) {
          const suffixes = /^\d+$/.test(raw) ? ['.BO'] : r.exchange.includes('BSE') ? ['.BO', '.NS'] : ['.NS', '.BO'];
          for (const s of suffixes) {
            const q = await lookupQuote(raw + s).catch(() => null);
            if (q) return { symbol: raw + s, name: q.name || r.name, match: 'symbol' };
          }
        }
        if (ISIN.test(r.isin)) {
          const hits = await search(r.isin);
          if (hits.length) {
            const onNse = hits.find((h) => h.exchange === 'NSE');
            if (onNse) return { symbol: onNse.symbol, name: onNse.name, match: 'isin' };
            // Yahoo may only list the BSE line for an ISIN; the NSE listing normally shares the ticker.
            const nse = `${hits[0].symbol.split('.')[0]}.NS`;
            const q = await lookupQuote(nse).catch(() => null);
            if (q) return { symbol: nse, name: q.name, match: 'isin' };
            return { symbol: hits[0].symbol, name: hits[0].name, match: 'isin' };
          }
          // Mutual fund ISINs start INF; AMFI's list maps them to scheme codes.
          if (fundByIsin && r.isin.startsWith('INF')) {
            const fund = await fundByIsin(r.isin).catch(() => null);
            if (fund) return { symbol: fund.symbol, name: fund.name, match: 'isin' };
          }
        }
        if (r.name) {
          const hits = await search(r.name);
          const pick = hits.find((h) => h.exchange === 'NSE') ?? hits[0];
          if (pick) return { symbol: pick.symbol, name: pick.name, match: 'name', note: 'matched by company name - please check' };
        }
        return { error: `could not match "${r.name || raw || r.isin}" to an NSE/BSE symbol or mutual fund` };
      } catch {
        return { error: 'the price source did not respond - try again in a minute' };
      }
    })();
    cache.set(key, p);
    return p;
  }

  const out = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (next < rows.length) {
        const i = next++;
        out[i] = await resolve(rows[i]);
      }
    }),
  );
  return out;
}

/** Combine rows that resolved to the same symbol (e.g. one stock listed in several lots). */
export function mergeBySymbol(items) {
  const map = new Map();
  for (const it of items) {
    const prev = map.get(it.symbol);
    if (!prev) { map.set(it.symbol, { ...it, notes: [...it.notes] }); continue; }
    prev.quantity += it.quantity;
    prev.invested = round2(prev.invested + it.invested);
    if (it.purchaseDate && (!prev.purchaseDate || it.purchaseDate < prev.purchaseDate)) prev.purchaseDate = it.purchaseDate;
    prev.notes.push(`merged with row ${it.line}`);
  }
  return [...map.values()];
}

/**
 * Read an uploaded statement and describe what importing it would do, without changing anything.
 * existing: the user's current holdings in the portfolio being imported into; heldCount: how many holdings they have in
 * all portfolios (the cap counts every one). Returns { format, items, errors }.
 */
export async function previewImport({ buf, existing, heldCount = existing.length, lookupQuote, search, fundByIsin = null, maxHoldings }) {
  const { format, tables } = await readTables(buf);
  const { rows, errors } = extractHoldings(tables);
  const resolved = await resolveSymbols(rows, { lookupQuote, search, fundByIsin });

  const matched = [];
  rows.forEach((r, i) => {
    const m = resolved[i];
    if (m.error) errors.push({ line: r.line, name: r.name || r.symbolRaw || r.isin, error: m.error });
    else {
      const notes = [...r.notes];
      if (m.note) notes.push(m.note);
      matched.push({ ...r, symbol: m.symbol, name: m.name || r.name, match: m.match, notes });
    }
  });

  const have = new Map(existing.map((h) => [h.symbol, h]));
  let count = heldCount;
  const items = [];
  for (const it of mergeBySymbol(matched)) {
    const cur = have.get(it.symbol);
    if (!cur) {
      if (count >= maxHoldings) {
        errors.push({ line: it.line, name: it.symbol, error: `you can track up to ${maxHoldings} stocks` });
        continue;
      }
      count++;
    }
    items.push({
      line: it.line,
      symbol: it.symbol,
      name: it.name,
      quantity: it.quantity,
      invested: round2(it.invested),
      purchaseDate: it.purchaseDate,
      match: it.match,
      notes: it.notes,
      action: cur ? 'update' : 'add',
      current: cur ? { quantity: cur.quantity, invested: cur.invested, purchaseDate: cur.purchase_date } : null,
    });
  }
  errors.sort((a, b) => a.line - b.line);
  return { format, items, errors };
}
