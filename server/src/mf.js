import { istDate } from './dates.js';

/**
 * Indian mutual funds. A fund is stored under the symbol "MF:<AMFI scheme code>", e.g. MF:122639.
 * Latest NAVs, names, categories and ISINs come from AMFI's daily NAV file (the official source, one download covers
 * every scheme); past NAVs from mfapi.in, a free service that republishes AMFI's history.
 */
export const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
export const MFAPI_URL = 'https://api.mfapi.in/mf';

export const isFund = (symbol) => /^MF:\d{3,8}$/.test(symbol);
const codeOf = (symbol) => symbol.slice(3);

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** "18-Nov-2026" (AMFI) or "18-11-2026" (mfapi) -> "2026-11-18"; null if it isn't a date. */
export function fundDate(s) {
  const m = /^(\d{2})-([A-Za-z]{3}|\d{2})-(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const mm = MONTHS[m[2]] ?? (/^\d{2}$/.test(m[2]) ? m[2] : null);
  return mm ? `${m[3]}-${mm}-${m[1]}` : null;
}

/**
 * Parse AMFI's NAVAll.txt: section lines like "Open Ended Schemes(Equity Scheme - Large Cap Fund)" give the category of
 * the rows under them; rows are "code;ISIN growth;ISIN reinvestment;name;[plan;option;]NAV;date".
 * Returns Map(code -> {code, name, category, nav, date, isins}).
 */
export function parseNavAll(text) {
  const out = new Map();
  let category = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const section = /^(?:Open Ended|Close Ended|Interval Fund)\s+Schemes\s*\((.+)\)$/i.exec(line);
    if (section) {
      category = section[1].trim();
      continue;
    }
    const f = line.split(';').map((x) => x.trim());
    if (f.length < 6 || !/^\d{3,8}$/.test(f[0])) continue;
    const nav = Number(f[f.length - 2]);
    const date = fundDate(f[f.length - 1]);
    if (!(nav > 0) || !date) continue;
    const name = f.slice(3, f.length - 2).filter((x) => x && x !== '-').join(' - ');
    const isins = [f[1], f[2]].filter((x) => /^INF[A-Z0-9]{9}$/.test(x));
    out.set(f[0], { code: f[0], name, category, nav, date, isins });
  }
  return out;
}

const UA = 'StockBeat/2 (portfolio tracker)';
async function getText(url, fetchImpl, ms = 20_000) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** A NAV for the poller: priced as of 15:30 IST on its date, like a market close. */
const navQuote = (symbol, s) => ({
  symbol,
  price: s.nav,
  name: s.name,
  marketTime: Date.parse(`${s.date}T15:30:00+05:30`),
});

/** Fund data sources. `fetch` and the clock can be replaced in tests. */
export function createFunds({ fetch: fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 60 * 60_000 } = {}) {
  let table = null; // { at, byCode, byIsin }
  let loading = null;

  /** AMFI's whole NAV file, fetched at most once an hour per server instance. */
  async function navTable() {
    if (table && now() - table.at < ttlMs) return table;
    loading ??= (async () => {
      try {
        const byCode = parseNavAll(await getText(AMFI_NAV_URL, fetchImpl, 30_000));
        if (!byCode.size) throw new Error('empty NAV file');
        const byIsin = new Map();
        for (const s of byCode.values()) for (const i of s.isins) byIsin.set(i, s);
        table = { at: now(), byCode, byIsin };
        return table;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /** The scheme's history from mfapi.in: {meta, points: [{date, close}] oldest first}. */
  async function schemeHistory(code) {
    const body = JSON.parse(await getText(`${MFAPI_URL}/${code}`, fetchImpl));
    const points = (Array.isArray(body?.data) ? body.data : [])
      .map((d) => ({ date: fundDate(d.date), close: Number(d.nav) }))
      .filter((p) => p.date && p.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { meta: body?.meta ?? {}, points };
  }

  return {
    /** Latest NAV as a quote, or null for an unknown scheme. Falls back to mfapi.in when AMFI can't be reached. */
    async quote(symbol) {
      const code = codeOf(symbol);
      const t = await navTable().catch(() => null);
      const s = t?.byCode.get(code);
      if (s) return navQuote(symbol, s);
      if (t) return null; // AMFI answered and doesn't list it
      const { meta, points } = await schemeHistory(code);
      const last = points.at(-1);
      return last ? navQuote(symbol, { nav: last.close, date: last.date, name: meta.scheme_name || symbol }) : null;
    },
    /** NAVs for the last `days` days, oldest first, as [{date, close}]. */
    async history(symbol, days = 400) {
      const from = istDate(now() - days * 86_400_000);
      return (await schemeHistory(codeOf(symbol))).points.filter((p) => p.date >= from);
    },
    /** The NAV on `date`, or on the last day before it with one; {date, close} or null. */
    async closeOn(symbol, date) {
      const before = (await schemeHistory(codeOf(symbol))).points.filter((p) => p.date <= date);
      const last = before.at(-1);
      // A NAV more than ten days older than the date isn't that day's price (the fund may not have existed yet).
      return last && Date.parse(date) - Date.parse(last.date) <= 10 * 86_400_000 ? last : null;
    },
    /** For sectors and tax: every fund is under "Mutual funds", with its AMFI category as the industry. */
    async profile(symbol) {
      const code = codeOf(symbol);
      const t = await navTable().catch(() => null);
      let category = t?.byCode.get(code)?.category ?? null;
      if (!category) category = (await schemeHistory(code)).meta.scheme_category ?? null;
      return { sector: 'Mutual funds', industry: category, kind: 'mf' };
    },
    /** Funds whose name contains every word of the query; direct growth plans first. */
    async search(query, limit = 8) {
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      if (!words.length) return [];
      const t = await navTable();
      const hits = [];
      for (const s of t.byCode.values()) {
        const name = s.name.toLowerCase();
        if (words.every((w) => name.includes(w))) hits.push(s);
      }
      const rank = (s) => {
        const n = s.name.toLowerCase();
        return (n.includes('direct') ? 0 : 2) + (n.includes('growth') ? 0 : 1);
      };
      hits.sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));
      return hits.slice(0, limit).map((s) => ({ symbol: `MF:${s.code}`, name: s.name, exchange: 'MF' }));
    },
    /** The fund with this ISIN (statements list funds by ISIN), or null. */
    async byIsin(isin) {
      const s = (await navTable()).byIsin.get(isin);
      return s ? { symbol: `MF:${s.code}`, name: s.name } : null;
    },
  };
}
