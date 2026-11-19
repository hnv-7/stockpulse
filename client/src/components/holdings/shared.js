// Latest allowed purchase date (today in India, matching the server's rule).
export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const niceDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const shares = (q) => Number(q.toFixed(4)).toLocaleString('en-IN', { maximumFractionDigits: 4 });
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
