import { addDays } from './dates.js';

export const PERIOD_DAYS = { '1d': 1, '1w': 7, '1m': 30, '3m': 90, '1y': 365 };

/**
 * Close on `date`, or the most recent earlier close.
 * `series` must be sorted ascending by date: [{date, close}].
 */
export function priceOnOrBefore(series, date) {
  let lo = 0;
  let hi = series.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      found = series[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Percentage change helper; null when the base is unusable. */
export function pctChange(now, then) {
  if (typeof now !== 'number' || typeof then !== 'number' || then <= 0) return null;
  return ((now - then) / then) * 100;
}

/**
 * Price reference for a period: for "1d" the previous trading day's close, otherwise
 * the close on/before (today - N days). `today` is YYYY-MM-DD in IST.
 */
export function referencePrice(series, today, period) {
  if (period === '1d') {
    const prior = series.filter((p) => p.date < today);
    return prior.length ? prior[prior.length - 1] : null;
  }
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  return priceOnOrBefore(series, addDays(today, -days));
}

/** Highest close in the trailing 52 weeks (including the current price). */
export function high52(series, today, currentPrice) {
  const from = addDays(today, -365);
  let high = currentPrice ?? 0;
  for (const p of series) if (p.date >= from && p.close > high) high = p.close;
  return high || null;
}

/**
 * Build the per-stock + portfolio report for a period.
 *
 * holdings: [{symbol, name, quantity, invested}]
 * seriesBySymbol: Map<symbol, [{date, close}]> ascending
 * latestBySymbol: Map<symbol, price>
 */
export function buildReport({ holdings, seriesBySymbol, latestBySymbol, today, period }) {
  const rows = holdings.map((h) => {
    const series = seriesBySymbol.get(h.symbol) ?? [];
    const price =
      latestBySymbol.get(h.symbol) ?? (series.length ? series[series.length - 1].close : null);
    const value = price == null ? null : price * h.quantity;
    const pnl = value == null ? null : value - h.invested;
    const ref = price == null ? null : referencePrice(series, today, period);
    const refValue = ref ? ref.close * h.quantity : null;
    const periodChangeValue = value != null && refValue != null ? value - refValue : null;
    const hi = price == null ? null : high52(series, today, price);

    return {
      symbol: h.symbol,
      name: h.name,
      quantity: h.quantity,
      invested: h.invested,
      avgCost: h.invested / h.quantity,
      price,
      value,
      pnl,
      pnlPct: pctChange(value, h.invested),
      refPrice: ref ? ref.close : null,
      refDate: ref ? ref.date : null,
      refValue,
      periodChangePct: ref && price != null ? pctChange(price, ref.close) : null,
      periodChangeValue,
      high52: hi,
      fromHighPct: hi && price != null ? pctChange(price, hi) : null,
    };
  });

  const priced = rows.filter((r) => r.value != null);
  const invested = rows.reduce((s, r) => s + r.invested, 0);
  const value = priced.reduce((s, r) => s + r.value, 0);
  const withRef = priced.filter((r) => r.refValue != null);
  const refTotal = withRef.reduce((s, r) => s + r.refValue, 0);
  const nowTotalForRef = withRef.reduce((s, r) => s + r.value, 0);
  const changeValue = withRef.length ? nowTotalForRef - refTotal : null;
  const changePct = withRef.length ? pctChange(nowTotalForRef, refTotal) : null;
  const pnl = value - invested;
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : null;

  for (const r of rows) {
    r.weightPct = value > 0 && r.value != null ? (r.value / value) * 100 : null;
    // Share of the portfolio's rupee movement this stock explains (negative = dragging).
    r.contributionPct =
      r.periodChangeValue != null && refTotal > 0 ? (r.periodChangeValue / refTotal) * 100 : null;
    // Lagging: earning clearly less than the portfolio as a whole.
    r.lagging = r.pnlPct != null && pnlPct != null && r.pnlPct < pnlPct;
    // Buy-the-dip candidate: price fell over the period while the position is still in profit.
    r.dipOpportunity =
      r.periodChangePct != null && r.periodChangePct < 0 && r.pnl != null && r.pnl > 0;
  }

  const draggers = rows
    .filter((r) => r.periodChangeValue != null && r.periodChangeValue < 0)
    .sort((a, b) => a.periodChangeValue - b.periodChangeValue);
  const laggards = rows
    .filter((r) => r.lagging && r.pnlPct != null)
    .sort((a, b) => a.pnlPct - b.pnlPct);
  const dips = rows
    .filter((r) => r.dipOpportunity)
    .sort((a, b) => a.periodChangePct - b.periodChangePct);

  return {
    period,
    totals: { invested, value, pnl, pnlPct, changeValue, changePct },
    holdings: rows,
    draggers,
    laggards,
    dips,
  };
}

/**
 * Portfolio value per date, forward-filling each stock's last known close.
 * Returns [{date, value, invested}] for dates >= fromDate.
 */
export function portfolioHistory({ holdings, seriesBySymbol, fromDate }) {
  const dates = new Set();
  for (const h of holdings) {
    for (const p of seriesBySymbol.get(h.symbol) ?? []) if (p.date >= fromDate) dates.add(p.date);
  }
  const sorted = [...dates].sort();
  const invested = holdings.reduce((s, h) => s + h.invested, 0);
  const cursor = new Map(holdings.map((h) => [h.symbol, 0]));
  const lastClose = new Map();
  const out = [];

  for (const date of sorted) {
    let value = 0;
    let complete = true;
    for (const h of holdings) {
      const series = seriesBySymbol.get(h.symbol) ?? [];
      let i = cursor.get(h.symbol);
      while (i < series.length && series[i].date <= date) {
        lastClose.set(h.symbol, series[i].close);
        i++;
      }
      cursor.set(h.symbol, i);
      const c = lastClose.get(h.symbol);
      if (c == null) complete = false;
      else value += c * h.quantity;
    }
    // Skip leading days before every stock has a price, otherwise the curve starts artificially low.
    if (complete) out.push({ date, value, invested });
  }
  return out;
}
