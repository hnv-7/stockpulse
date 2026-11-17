import { pctChange, referencePrice, high52 } from './analytics.js';

export const WINDOW_LABEL = {
  '1d': "since yesterday's close",
  '1w': 'over the last week',
  '1m': 'over the last month',
  high52: 'from its 52-week high',
};

/** Don't re-send the same rule/stock alert more often than this. */
export const COOLDOWN_MS = 24 * 3600 * 1000;

const rupees = (x) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Pure: which rules fire right now?
 * holdings: what the user holds, plus stocks they only watch marked {watchOnly: true}
 * rules: drop rules {id, kind?: 'drop', symbol|null, window, threshold_pct, enabled}
 *        price rules {id, kind: 'price', symbol, direction: 'above'|'below', target_price, enabled}
 * Returns [{rule, holding, price, dropPct, message}]  (dropPct is null for price rules)
 */
export function evaluateRules({ rules, holdings, seriesBySymbol, latestBySymbol, today }) {
  const hits = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.kind === 'price') {
      const h = holdings.find((x) => x.symbol === rule.symbol);
      const price = h && latestBySymbol.get(h.symbol);
      if (price == null) continue;
      const above = rule.direction === 'above';
      if (above ? price < rule.target_price : price > rule.target_price) continue;
      hits.push({
        rule,
        holding: h,
        price,
        dropPct: null,
        message: `${h.symbol} reached your target: it is now ${above ? 'above' : 'below'} ${rupees(rule.target_price)} (price ${rupees(price)}).`,
      });
      continue;
    }
    const threshold = rule.threshold_pct;
    // "Any stock" means any stock in the portfolio: stocks that are only watched need a rule of their own.
    const targets = rule.symbol ? holdings.filter((h) => h.symbol === rule.symbol) : holdings.filter((h) => !h.watchOnly);
    for (const h of targets) {
      const price = latestBySymbol.get(h.symbol);
      if (price == null) continue;
      const series = seriesBySymbol.get(h.symbol) ?? [];
      const base =
        rule.window === 'high52'
          ? high52(series, today, price)
          : referencePrice(series, today, rule.window)?.close;
      const change = pctChange(price, base);
      if (change == null || change > -threshold) continue;
      const dropPct = Math.abs(change);
      hits.push({
        rule,
        holding: h,
        price,
        dropPct,
        message:
          `${h.symbol} is down ${dropPct.toFixed(2)}% ${WINDOW_LABEL[rule.window]} ` +
          `(₹${price.toFixed(2)} vs ₹${base.toFixed(2)}). Alert level: ${threshold}%.`,
      });
    }
  }
  return hits;
}
