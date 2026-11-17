import { priceOnOrBefore, pctChange, referencePrice, daysBetween, xirrFlows, heldPositions, activeOn } from './analytics.js';

/** The index everything is compared with. Index symbols start with "^" and are never held, watched or split. */
export const BENCHMARK = { symbol: '^NSEI', name: 'Nifty 50' };
export const isIndex = (symbol) => symbol.startsWith('^');

/** A purchase is only compared if the index has a close this close to (on or before) its date. */
const MAX_GAP_DAYS = 10;

/** The index's own change over a report period ('1d', '1w', ...), as a percentage, or null. */
export function indexChange({ indexSeries, indexNow, today, period }) {
  const ref = referencePrice(indexSeries, today, period);
  return ref ? pctChange(indexNow, ref.close) : null;
}

/**
 * The same money on the same days in the index: each purchase buys index units at that day's close (or the last close
 * before it). Units bought for purchases still held are valued at `indexNow`; units bought for purchases since sold
 * are sold on the same sale date, so the index is held for exactly the same days as the shares.
 * lots: [{invested, purchase_date}] still held; sales: [{saleDate, lots: [{invested, purchase_date}]}]; all dated.
 * Returns {invested, value, received, xirrPct}, or null when there is nothing to compare or the index has no price near
 * some date (e.g. before the index history starts).
 */
export function sameMoneyInIndex({ lots, sales = [], indexSeries, indexNow, today }) {
  if ((!lots.length && !sales.length) || !(indexNow > 0)) return null;
  const closeNear = (date) => {
    const p = priceOnOrBefore(indexSeries, date);
    return p && daysBetween(p.date, date) <= MAX_GAP_DAYS ? p.close : null;
  };
  const flows = [];
  let invested = 0;
  let value = 0;
  let received = 0;
  for (const l of lots) {
    const entry = closeNear(l.purchase_date);
    if (entry == null) return null;
    invested += l.invested;
    value += (l.invested / entry) * indexNow;
    flows.push({ amount: -l.invested, days: daysBetween(l.purchase_date, today) });
  }
  for (const s of sales) {
    const exit = closeNear(s.saleDate);
    if (exit == null) return null;
    let out = 0;
    for (const l of s.lots) {
      const entry = closeNear(l.purchase_date);
      if (entry == null) return null;
      invested += l.invested;
      out += (l.invested / entry) * exit;
      flows.push({ amount: -l.invested, days: daysBetween(l.purchase_date, today) });
    }
    received += out;
    flows.push({ amount: out, days: daysBetween(s.saleDate, today) });
  }
  flows.push({ amount: value, days: 0 });
  const rate = xirrFlows(flows);
  return { invested, value, received, xirrPct: rate == null ? null : rate * 100 };
}

/**
 * Your stocks against the index since `fromDate`, as cumulative % changes on each index trading day:
 * [{date, yoursPct, indexPct}], both 0 on the first day.
 *
 * "Yours" is time-weighted: each day's return is that of the shares held through the whole day (bought before it and
 * not sold on it), so money going in or out doesn't count as a gain or loss. Before anything is held it stays flat.
 */
export function relativePerformance({ holdings, soldLots = [], seriesBySymbol, indexSeries, fromDate }) {
  const positions = heldPositions({ holdings, soldLots, fromDate }).filter((p) => seriesBySymbol.get(p.symbol)?.length);
  const days = indexSeries.filter((p) => p.date >= fromDate);
  if (days.length < 2) return [];

  const symbols = [...new Set(positions.map((p) => p.symbol))];
  const cursor = new Map(symbols.map((s) => [s, 0]));
  const close = new Map(); // symbol -> last close on or before the current day
  const moveTo = (date) => {
    for (const s of symbols) {
      const series = seriesBySymbol.get(s);
      let i = cursor.get(s);
      while (i < series.length && series[i].date <= date) close.set(s, series[i++].close);
      cursor.set(s, i);
    }
  };

  moveTo(days[0].date);
  const base = days[0].close;
  let growth = 1;
  const out = [{ date: days[0].date, yoursPct: 0, indexPct: 0 }];
  for (let k = 1; k < days.length; k++) {
    const prev = days[k - 1].date;
    const date = days[k].date;
    const before = new Map(close);
    moveTo(date);
    let start = 0;
    let end = 0;
    for (const p of positions) {
      if (!activeOn(p, prev) || !activeOn(p, date)) continue;
      const c0 = before.get(p.symbol);
      const c1 = close.get(p.symbol);
      if (c0 == null || c1 == null) continue;
      start += p.quantity * c0;
      end += p.quantity * c1;
    }
    if (start > 0) growth *= end / start;
    out.push({ date, yoursPct: (growth - 1) * 100, indexPct: (days[k].close / base - 1) * 100 });
  }
  return out;
}
