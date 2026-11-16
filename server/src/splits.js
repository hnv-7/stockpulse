/**
 * Pure helpers for splits and bonus issues. A ratio {numerator, denominator} means every `denominator` shares became
 * `numerator`, so quantities are multiplied by numerator / denominator and per-share prices divided by it.
 */

/**
 * How far apart two ratios may be and still count as the same split. The price evidence compares a last traded price
 * with an official close, so allow a little slack.
 */
export const RATIO_TOLERANCE = 0.03;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * The simplest ratio of whole numbers (up to `maxTerm` on each side) within tolerance of `x`, or null.
 * Something within tolerance of 1 is not a split.
 */
export function snapRatio(x, maxTerm = 20) {
  if (!(x > 0) || Math.abs(x - 1) < RATIO_TOLERANCE) return null;
  let best = null;
  for (let denominator = 1; denominator <= maxTerm; denominator++) {
    for (let numerator = 1; numerator <= maxTerm; numerator++) {
      if (numerator === denominator || gcd(numerator, denominator) !== 1) continue;
      const err = Math.abs(numerator / denominator / x - 1);
      if (err < RATIO_TOLERANCE && (!best || err < best.err - 1e-9)) best = { numerator, denominator, err };
    }
  }
  return best && { numerator: best.numerator, denominator: best.denominator };
}

/**
 * The ratio to offer the user: what Yahoo reports, unless the price itself moved by a clearly different ratio
 * (Yahoo has reported Bajaj Finance's 4:1 bonus plus 1:2 split, ten times the shares, as just "2:1").
 * `mismatch` says the two disagreed, so the user should check with their broker.
 */
export function suggestRatio(reported, priceRatio) {
  const ratio = reported.numerator / reported.denominator;
  if (priceRatio == null || Math.abs(priceRatio / ratio - 1) < RATIO_TOLERANCE) return { ...reported, mismatch: false };
  const fromPrice = snapRatio(priceRatio);
  return fromPrice ? { ...fromPrice, mismatch: true } : { ...reported, mismatch: true };
}

const num = (x) => String(Number(x.toFixed(4)));

/** "every 1 share became 2" */
export function describeRatio({ numerator, denominator }) {
  return `every ${num(denominator)} ${denominator === 1 ? 'share' : 'shares'} became ${num(numerator)}`;
}

/** "3 Dec 2026" */
export function formatDay(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The notification a user gets when a split may have changed their shares. */
export function splitMessage({ symbol, exDate, reported, priceRatio }) {
  const s = suggestRatio(reported, priceRatio);
  let text = `${symbol} had a split or bonus issue on ${formatDay(exDate)}: ${describeRatio(s)}.`;
  if (s.mismatch) {
    text += ` Yahoo reports ${describeRatio(reported)}, but the price moved by about ${priceRatio.toFixed(1)}x, so check the ratio with your broker.`;
  }
  return `${text} Your shares haven't been changed yet: confirm it on the Holdings tab.`;
}
