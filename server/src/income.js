import { istDate, addDays } from './dates.js';

const lotsOf = (h) => (h.lots?.length ? h.lots : [{ quantity: h.quantity, invested: h.invested, purchase_date: h.purchase_date, created_at: h.created_at }]);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

/**
 * How the portfolio's current value splits by sector, and how concentrated it is in its largest stocks.
 * rows: report rows [{symbol, name, value}]; infoBySymbol: Map(symbol -> {sector}). Stocks without a known sector are
 * grouped as sector null.
 */
export function allocation(rows, infoBySymbol) {
  const priced = rows.filter((r) => r.value > 0);
  const total = sum(priced, (r) => r.value);
  if (!(total > 0)) return { total: 0, sectors: [], top: [], topPct: null };
  const bySector = new Map();
  for (const r of priced) {
    const sector = infoBySymbol.get(r.symbol)?.sector ?? null;
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(r);
  }
  const sectors = [...bySector]
    .map(([sector, xs]) => ({
      sector,
      value: sum(xs, (r) => r.value),
      weightPct: (sum(xs, (r) => r.value) / total) * 100,
      stocks: xs.sort((a, b) => b.value - a.value).map((r) => r.symbol),
    }))
    // Largest first, with the unknown group last whatever its size.
    .sort((a, b) => (a.sector == null) - (b.sector == null) || b.value - a.value);
  const top = [...priced]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((r) => ({ symbol: r.symbol, name: r.name, weightPct: (r.value / total) * 100 }));
  return { total, sectors, top, topPct: sum(top, (t) => t.weightPct) };
}

/** The name a sector goes by in targets; holdings Yahoo has no sector for are grouped under this. */
export const UNKNOWN_SECTOR = 'Sector not known';

/**
 * How far each sector is from its target share, and what it would take to get there: amount > 0 means buy that much,
 * < 0 sell. Rebalancing only makes sense once the targets add up to 100%, which `complete` says.
 * alloc: from allocation(); targets: [{sector, pct}].
 */
export function rebalance(alloc, targets) {
  const total = alloc.total;
  const targetTotal = sum(targets, (t) => t.pct);
  const target = new Map(targets.map((t) => [t.sector, t.pct]));
  const now = new Map(alloc.sectors.map((s) => [s.sector ?? UNKNOWN_SECTOR, s.value]));
  const rows = [...new Set([...now.keys(), ...target.keys()])].map((sector) => {
    const value = now.get(sector) ?? 0;
    const weightPct = total > 0 ? (value / total) * 100 : 0;
    const targetPct = target.get(sector) ?? 0;
    return { sector, value, weightPct, targetPct, driftPct: weightPct - targetPct, amount: (targetPct / 100) * total - value };
  });
  rows.sort((a, b) => b.targetPct - a.targetPct || b.value - a.value);
  return { complete: Math.abs(targetTotal - 100) < 0.01, targetTotal, rows };
}

/**
 * The earliest day each stock's dividends matter from: its first dated purchase (held or sold), or for an undated
 * purchase the day it was entered in the app. Returns Map(symbol -> YYYY-MM-DD).
 */
export function dividendStart({ holdings, saleLots }) {
  const start = new Map();
  const see = (symbol, date) => {
    if (date && (!start.has(symbol) || date < start.get(symbol))) start.set(symbol, date);
  };
  for (const h of holdings) for (const l of lotsOf(h)) see(h.symbol, l.purchase_date ?? (l.created_at ? istDate(l.created_at) : null));
  for (const l of saleLots) see(l.symbol, l.purchaseDate);
  return start;
}

/**
 * Dividends received: on each ex-date, the shares held going into it (bought before the ex-date and not sold before
 * it) times the dividend per share. A purchase without a date counts from the day it was entered in the app; a sold
 * purchase without a date isn't counted. Amounts are before any tax deducted at source.
 * holdings: [{symbol, name, invested, lots: [{quantity, purchase_date, created_at}]}];
 * saleLots: [{symbol, name, quantity, purchaseDate, saleDate}] (store.listSaleLotsForGains);
 * dividendsBySymbol: Map(symbol -> [{date, amount}]).
 */
export function dividendsReceived({ holdings, saleLots, dividendsBySymbol, today }) {
  const positions = [];
  const names = new Map();
  const invested = new Map();
  const heldQty = new Map();
  for (const h of holdings) {
    names.set(h.symbol, h.name);
    invested.set(h.symbol, h.invested);
    heldQty.set(h.symbol, h.quantity ?? sum(lotsOf(h), (l) => l.quantity));
    for (const l of lotsOf(h)) {
      const from = l.purchase_date ?? (l.created_at ? istDate(l.created_at) : null);
      if (from) positions.push({ symbol: h.symbol, quantity: l.quantity, from, until: null });
    }
  }
  for (const l of saleLots) {
    if (!names.has(l.symbol)) names.set(l.symbol, l.name);
    if (l.purchaseDate) positions.push({ symbol: l.symbol, quantity: l.quantity, from: l.purchaseDate, until: l.saleDate });
  }

  const payments = [];
  for (const [symbol, divs] of dividendsBySymbol) {
    const mine = positions.filter((p) => p.symbol === symbol);
    for (const d of divs) {
      if (d.date > today) continue;
      // Held going into the ex-date: bought before it, and still held on it (selling on the ex-date keeps the dividend).
      const shares = sum(mine.filter((p) => p.from < d.date && (!p.until || p.until >= d.date)), (p) => p.quantity);
      if (shares > 0) payments.push({ symbol, name: names.get(symbol) ?? symbol, exDate: d.date, perShare: d.amount, shares, amount: shares * d.amount });
    }
  }
  payments.sort((a, b) => (a.exDate < b.exDate ? 1 : a.exDate > b.exDate ? -1 : a.symbol.localeCompare(b.symbol)));

  const yearAgo = addDays(today, -365);
  const bySymbol = new Map();
  for (const p of payments) {
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, { symbol: p.symbol, name: p.name, total: 0, last12m: 0 });
    const s = bySymbol.get(p.symbol);
    s.total += p.amount;
    if (p.exDate > yearAgo) s.last12m += p.amount;
  }
  const byStock = [...bySymbol.values()]
    .map((s) => {
      const cost = invested.get(s.symbol);
      // The yield on your own price: the last 12 months' dividends per share, on the shares held now, against what
      // those shares cost. (Not what was received, which also counts shares since sold.)
      const perShare = sum((dividendsBySymbol.get(s.symbol) ?? []).filter((d) => d.date > yearAgo && d.date <= today), (d) => d.amount);
      const yieldOnCostPct = cost > 0 ? ((perShare * heldQty.get(s.symbol)) / cost) * 100 : null;
      return { ...s, held: cost != null, yieldOnCostPct };
    })
    .sort((a, b) => b.total - a.total);
  return {
    total: sum(payments, (p) => p.amount),
    last12m: sum(payments.filter((p) => p.exDate > yearAgo), (p) => p.amount),
    byStock,
    payments,
  };
}
