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
 * Realised capital gains for a financial year, one row per purchase a sale used up (oldest purchases are sold first).
 * lots: [{saleId, symbol, name, saleDate, salePrice, saleQuantity, charges, quantity, cost, purchaseDate}], quantities
 * and prices as stored (restated in today's shares after a confirmed split, which leaves rupee amounts unchanged).
 * A sale's charges are shared between its purchases by quantity.
 *
 * Then the year's tax, estimated: short-term losses reduce short-term gains and then long-term gains; long-term losses
 * only reduce long-term gains, and what is left of either is carried forward. The long-term exemption comes off what
 * remains. Rates are those in force on each sale date (weighted by gain in a year where they changed), plus cess.
 * Sales of undated purchases are listed but left out of the estimate.
 */
export function capitalGains({ lots, fy }) {
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
        term: termOf(l.purchaseDate, l.saleDate),
        holdingDays: l.purchaseDate ? daysBetween(l.purchaseDate, l.saleDate) : null,
      };
    })
    .sort((a, b) => (a.saleDate < b.saleDate ? 1 : a.saleDate > b.saleDate ? -1 : b.saleId - a.saleId));

  const shortTerm = bucket(rows.filter((r) => r.term === 'short'));
  const longTerm = bucket(rows.filter((r) => r.term === 'long'));
  const unknown = bucket(rows.filter((r) => r.term === 'unknown'));

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
    ...fyBounds(fy),
    rows,
    shortTerm,
    longTerm,
    unknown,
    setOff: { shortTermLossAgainstLongTerm: shortLossUsed },
    carriedForward: { shortTerm: shortLoss - shortLossUsed, longTerm: Math.max(-longTerm.net, 0) },
    exemption: { limit: yearRules.ltcgExemption, used: exemptionUsed, left: yearRules.ltcgExemption - exemptionUsed },
    taxable,
    rates: { ...rates, changedMidYear: rulesOn(from) !== yearRules },
    tax: { shortTerm: stTax, longTerm: ltTax, cess, total: stTax + ltTax + cess },
  };
}

/**
 * What the shares still held would mean if sold at today's prices: unrealised gains by term, and purchases that turn
 * long-term within `withinDays` (selling those a little later would move their gain to the lower long-term rate).
 * holdings: [{symbol, name, quantity, invested, purchase_date, lots?}]; latestBySymbol: Map(symbol -> price).
 */
export function openPositions({ holdings, latestBySymbol, today, withinDays = 60 }) {
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
        term: termOf(l.purchase_date ?? null, today),
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
    },
    turningLongTerm: lots
      .filter((l) => l.daysToLongTerm != null && l.daysToLongTerm <= withinDays)
      .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm),
  };
}
