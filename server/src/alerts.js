import { pctChange, referencePrice, high52 } from './analytics.js';

export const WINDOW_LABEL = {
  '1d': "since yesterday's close",
  '1w': 'over the last week',
  '1m': 'over the last month',
  high52: 'from its 52-week high',
};

/** Don't re-send the same rule/stock alert more often than this. */
export const COOLDOWN_MS = 24 * 3600 * 1000;

/**
 * Pure: which rules fire right now?
 * rules: [{id, symbol|null, window, threshold_pct, enabled}]
 * Returns [{rule, holding, price, dropPct, message}]
 */
export function evaluateRules({ rules, holdings, seriesBySymbol, latestBySymbol, today }) {
  const hits = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const threshold = rule.threshold_pct;
    const targets = rule.symbol ? holdings.filter((h) => h.symbol === rule.symbol) : holdings;
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
