import { addDays } from './dates.js';
import { daysBetween } from './analytics.js';

/**
 * Indian tax on listed equity shares where STT was paid (sections 111A and 112A), by sale date. Budgets change these:
 * add a row from the day new rules apply. Rates are percentages. The long-term exemption is per financial year, and the
 * row in force at the end of the year sets it (the ₹1.25 lakh limit applied to the whole of FY 2024-25).
 * Budget 2026 left the July 2024 rules in place for FY 2026-27.
 */
export const TAX_RULES = [
  { from: '2018-04-01', stcgRate: 15, ltcgRate: 10, ltcgExemption: 100_000 },
  { from: '2024-07-23', stcgRate: 20, ltcgRate: 12.5, ltcgExemption: 125_000 },
];
/** Health and education cess, on top of the tax. */
export const CESS_PCT = 4;

/** Financial year (April to March) a date falls in, as its starting year: 2026-03-31 is in 2025, 2026-04-01 in 2026. */
export const fyOf = (date) => {
  const y = Number(date.slice(0, 4));
  return date.slice(5) >= '04-01' ? y : y - 1;
};
export const fyBounds = (fy) => ({ fy, from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `FY ${fy}-${String(fy + 1).slice(2)}` });

/** The rules in force on a date. */
export const rulesOn = (date) => [...TAX_RULES].reverse().find((r) => date >= r.from) ?? TAX_RULES[0];

/**
 * First day a sale counts as long-term: shares must be held for more than 12 months, so bought on 10 Jan 2025 means
 * long-term from 11 Jan 2026. (A 29 Feb purchase rolls to 1 Mar, which errs a day on the short-term side.)
 */
export function longTermFrom(purchaseDate) {
  const [y, m, d] = purchaseDate.split('-').map(Number);
  return addDays(new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10), 1);
}

/** 'short', 'long', or 'unknown' when the purchase has no date. */
export const termOf = (purchaseDate, saleDate) =>
  !purchaseDate ? 'unknown' : saleDate >= longTermFrom(purchaseDate) ? 'long' : 'short';

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
function bucket(rows) {
  const gains = sum(rows, (r) => Math.max(r.gain, 0));
  const losses = sum(rows, (r) => Math.min(r.gain, 0));
  return { gains, losses, net: gains + losses, count: rows.length };
}

/**
 * The year's tax on a set of gains, estimated: short-term losses reduce short-term gains and then long-term gains;
 * long-term losses only reduce long-term gains, and what is left of either is carried forward. The long-term exemption
 * comes off what remains. Rates are those in force on each sale date (weighted by gain in a year where they changed),
 * plus cess. rows: [{gain, term: 'short'|'long', saleDate}]; other terms are ignored.
 */
export function estimateTax(rows, fy) {
  const { from, to } = fyBounds(fy);
  const shortTerm = bucket(rows.filter((r) => r.term === 'short'));
  const longTerm = bucket(rows.filter((r) => r.term === 'long'));
  const shortLoss = Math.max(-shortTerm.net, 0);
  const shortLossUsed = Math.min(shortLoss, Math.max(longTerm.net, 0));
  const longAfterSetOff = longTerm.net - shortLossUsed;
  const yearRules = rulesOn(to);
  const exemptionUsed = Math.min(Math.max(longAfterSetOff, 0), yearRules.ltcgExemption);
  const taxable = { shortTerm: Math.max(shortTerm.net, 0), longTerm: Math.max(longAfterSetOff, 0) - exemptionUsed };

  // The rate for a term: by sale date, weighted by the gains made at each rate.
  const rate = (term, key) => {
    const winners = rows.filter((r) => r.term === term && r.gain > 0);
    const total = sum(winners, (r) => r.gain);
    return total > 0 ? sum(winners, (r) => r.gain * rulesOn(r.saleDate)[key]) / total : yearRules[key];
  };
  const rates = { shortTerm: rate('short', 'stcgRate'), longTerm: rate('long', 'ltcgRate'), cess: CESS_PCT };
  const stTax = (taxable.shortTerm * rates.shortTerm) / 100;
  const ltTax = (taxable.longTerm * rates.longTerm) / 100;
  const cess = ((stTax + ltTax) * CESS_PCT) / 100;
  return {
    shortTerm,
    longTerm,
    setOff: { shortTermLossAgainstLongTerm: shortLossUsed },
    carriedForward: { shortTerm: shortLoss - shortLossUsed, longTerm: Math.max(-longTerm.net, 0) },
    exemption: { limit: yearRules.ltcgExemption, used: exemptionUsed, left: yearRules.ltcgExemption - exemptionUsed },
    taxable,
    rates: { ...rates, changedMidYear: rulesOn(from) !== yearRules },
    tax: { shortTerm: stTax, longTerm: ltTax, cess, total: stTax + ltTax + cess },
  };
}

/**
 * Realised capital gains for a financial year, one row per purchase a sale used up (oldest purchases are sold first).
 * lots: [{saleId, symbol, name, saleDate, salePrice, saleQuantity, charges, quantity, cost, purchaseDate}], quantities
 * and prices as stored (restated in today's shares after a confirmed split, which leaves rupee amounts unchanged).
 * A sale's charges are shared between its purchases by quantity.
 *
 * classOf(symbol) says how a holding is taxed: 'equity' (listed shares, equity ETFs and equity-oriented funds, the
 * default) or 'other' (debt, gold and international funds and the like: slab rates or other holding periods). 'other'
 * rows are listed with term 'other' and left out of the estimate, as are sales of undated purchases.
 */
export function capitalGains({ lots, fy, classOf = () => 'equity' }) {
  const { from, to } = fyBounds(fy);
  const rows = lots
    .filter((l) => l.saleDate >= from && l.saleDate <= to)
    .map((l) => {
      const proceeds = l.salePrice * l.quantity;
      const charges = l.saleQuantity > 0 ? l.charges * (l.quantity / l.saleQuantity) : 0;
      return {
        ...l,
        proceeds,
        charges,
        gain: proceeds - charges - l.cost,
        term: classOf(l.symbol) === 'other' ? 'other' : termOf(l.purchaseDate, l.saleDate),
        holdingDays: l.purchaseDate ? daysBetween(l.purchaseDate, l.saleDate) : null,
      };
    })
    .sort((a, b) => (a.saleDate < b.saleDate ? 1 : a.saleDate > b.saleDate ? -1 : b.saleId - a.saleId));

  return {
    ...fyBounds(fy),
    rows,
    ...estimateTax(rows, fy),
    unknown: bucket(rows.filter((r) => r.term === 'unknown')),
    other: bucket(rows.filter((r) => r.term === 'other')),
  };
}

/**
 * What the shares still held would mean if sold at today's prices: unrealised gains by term, and purchases that turn
 * long-term within `withinDays` (selling those a little later would move their gain to the lower long-term rate).
 * holdings: [{symbol, name, quantity, invested, purchase_date, lots?}]; latestBySymbol: Map(symbol -> price).
 */
export function openPositions({ holdings, latestBySymbol, today, withinDays = 60, classOf = () => 'equity' }) {
  const lots = [];
  for (const h of holdings) {
    const price = latestBySymbol.get(h.symbol) ?? null;
    const hLots = h.lots?.length ? h.lots : [{ quantity: h.quantity, invested: h.invested, purchase_date: h.purchase_date }];
    for (const l of hLots) {
      const value = price == null ? null : price * l.quantity;
      const longOn = l.purchase_date ? longTermFrom(l.purchase_date) : null;
      lots.push({
        symbol: h.symbol,
        name: h.name,
        purchaseDate: l.purchase_date ?? null,
        quantity: l.quantity,
        cost: l.invested,
        value,
        gain: value == null ? null : value - l.invested,
        term: classOf(h.symbol) === 'other' ? 'other' : termOf(l.purchase_date ?? null, today),
        longTermOn: longOn,
        daysToLongTerm: longOn && longOn > today ? daysBetween(today, longOn) : null,
      });
    }
  }
  const priced = lots.filter((l) => l.gain != null);
  return {
    unrealised: {
      shortTerm: bucket(priced.filter((l) => l.term === 'short')),
      longTerm: bucket(priced.filter((l) => l.term === 'long')),
      unknown: bucket(priced.filter((l) => l.term === 'unknown')),
      other: bucket(priced.filter((l) => l.term === 'other')),
    },
    lots: priced,
    turningLongTerm: lots
      .filter((l) => l.term !== 'other' && l.daysToLongTerm != null && l.daysToLongTerm <= withinDays)
      .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm),
  };
}

/** Selling and buying back costs at least this share of the value: STT of 0.1% on each side of a delivery trade. */
export const ROUND_TRIP_COST_PCT = 0.2;

/**
 * Ways to lower this financial year's tax at today's prices, for the current year. Purchases are sold oldest first, so
 * every idea follows that order. Only holdings taxed as equity with every purchase dated are considered.
 *
 * losses: stocks where selling everything held books a net loss. That loss comes off gains already booked this year
 *   (taxSaved: the estimate now less the estimate with that sale), and what can't be used carries forward.
 * exemption: long-term gains that fit in what is left of this year's long-term exemption. Selling and buying back books
 *   them tax-free and raises your cost, so less is taxed when you finally sell (futureTaxSaved, at today's rate).
 *   The shares bought back count as short-term again for a year.
 *
 * realised: the year's capitalGains rows; lots: openPositions().lots; today: YYYY-MM-DD.
 */
export function harvesting({ realised, lots, fy, today }) {
  const counted = realised.filter((r) => r.term === 'short' || r.term === 'long');
  const base = estimateTax(counted, fy);
  const sold = (ls) => ls.map((l) => ({ gain: l.gain, term: l.term, saleDate: today }));
  const forward = (t) => t.carriedForward.shortTerm + t.carriedForward.longTerm;

  const bySymbol = new Map();
  for (const l of lots) {
    if (!bySymbol.has(l.symbol)) bySymbol.set(l.symbol, []);
    bySymbol.get(l.symbol).push(l);
  }
  const usable = (ls) => ls.every((l) => l.term === 'short' || l.term === 'long');

  const losses = [];
  const losing = [];
  for (const [symbol, ls] of bySymbol) {
    if (!usable(ls)) continue;
    const loss = sum(ls, (l) => l.gain);
    if (loss >= 0) continue;
    losing.push(...ls);
    const after = estimateTax([...counted, ...sold(ls)], fy);
    losses.push({
      symbol,
      name: ls[0].name,
      quantity: sum(ls, (l) => l.quantity),
      value: sum(ls, (l) => l.value),
      loss,
      shortTerm: sum(ls.filter((l) => l.term === 'short'), (l) => l.gain),
      longTerm: sum(ls.filter((l) => l.term === 'long'), (l) => l.gain),
      taxSaved: base.tax.total - after.tax.total,
      carriedForward: forward(after) - forward(base),
    });
  }
  losses.sort((a, b) => b.taxSaved - a.taxSaved || a.loss - b.loss);
  const allAfter = estimateTax([...counted, ...sold(losing)], fy);

  // Long-term gains from each stock's oldest purchases, up to the first one that isn't a long-term gain; the stocks
  // with the most gain per rupee sold go first, so the least money changes hands.
  const options = [];
  for (const [symbol, ls] of bySymbol) {
    const run = [];
    for (const l of ls) {
      if (l.term !== 'long' || !(l.gain > 0)) break;
      run.push(l);
    }
    if (run.length) options.push({ symbol, run, ratio: sum(run, (l) => l.gain) / sum(run, (l) => l.value) });
  }
  options.sort((a, b) => b.ratio - a.ratio);
  let room = base.exemption.left;
  const picks = [];
  for (const { symbol, run } of options) {
    if (room < 1) break;
    const fund = symbol.startsWith('MF:');
    let quantity = 0;
    let gain = 0;
    let value = 0;
    for (const l of run) {
      const perUnit = l.gain / l.quantity;
      const fits = Math.min(l.quantity, (room - gain) / perUnit);
      const q = l.quantity <= fits ? l.quantity : fund ? Math.floor(fits * 1000) / 1000 : Math.floor(fits);
      if (q <= 0) break;
      quantity += q;
      gain += perUnit * q;
      value += (l.value / l.quantity) * q;
      if (q < l.quantity) break;
    }
    if (quantity > 0) {
      picks.push({ symbol, name: run[0].name, quantity: Math.round(quantity * 1000) / 1000, gain, value });
      room -= gain;
    }
  }
  const harvested = sum(picks, (p) => p.gain);
  const rules = rulesOn(today);

  return {
    ...fyBounds(fy),
    daysLeft: daysBetween(today, fyBounds(fy).to),
    taxNow: base.tax.total,
    booked: { shortTerm: base.shortTerm.net, longTerm: base.longTerm.net },
    losses,
    allLosses: {
      loss: sum(losses, (l) => l.loss),
      taxSaved: base.tax.total - allAfter.tax.total,
      carriedForward: forward(allAfter) - forward(base),
    },
    exemption: {
      left: base.exemption.left,
      picks,
      gain: harvested,
      value: sum(picks, (p) => p.value),
      futureTaxSaved: (harvested * rules.ltcgRate * (1 + CESS_PCT / 100)) / 100,
    },
    roundTripCostPct: ROUND_TRIP_COST_PCT,
  };
}
