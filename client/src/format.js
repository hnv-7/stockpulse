const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n) => (n == null ? '—' : `₹${inr.format(Math.round(n))}`);
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
export const compactMoney = (n) => (n == null ? '—' : `₹${compact.format(n)}`);
export const price = (n) => (n == null ? '—' : `₹${inr2.format(n)}`);
export const signedMoney = (n) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
export const pct = (n) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
export const tone = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');

export const PERIOD_LABEL = {
  '1d': 'Today',
  '1w': 'This week',
  '1m': 'This month',
  '3m': '3 months',
  '1y': '1 year',
};
export const PERIOD_VS = {
  '1d': "yesterday's close",
  '1w': 'a week ago',
  '1m': 'a month ago',
  '3m': '3 months ago',
  '1y': 'a year ago',
};

export const shortDate = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
export const timeAgo = (ts) => {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
