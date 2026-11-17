let csrfToken = '';
export const setCsrfToken = (t) => { csrfToken = t || ''; };

async function request(method, path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Upload a broker statement (xlsx / csv / json / pdf) as-is; the server reads it and returns what would change. */
async function previewImport(file) {
  const res = await fetch('/api/holdings/import/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken },
    credentials: 'same-origin',
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not read the file (${res.status})`);
  return data;
}

export const api = {
  previewImport,
  importHoldings: (items) => request('POST', '/holdings/import', { items }),
  me: () => request('GET', '/me'),
  updateSettings: (s) => request('PUT', '/me/settings', s),
  logout: () => request('POST', '/auth/logout'),
  deleteAccount: () => request('DELETE', '/me'),
  report: (period) => request('GET', `/report?period=${period}`),
  portfolioHistory: (range) => request('GET', `/portfolio/history?range=${range}`),
  benchmark: (period) => request('GET', `/benchmark?period=${period}`),
  benchmarkHistory: (range) => request('GET', `/benchmark/history?range=${range}`),
  stockHistory: (symbol, range) =>
    request('GET', `/stocks/${encodeURIComponent(symbol)}/history?range=${range}`),
  search: (q) => request('GET', `/search?q=${encodeURIComponent(q)}`),
  holdings: () => request('GET', '/holdings'),
  addHolding: (h) => request('POST', '/holdings', h),
  updateHolding: (id, h) => request('PUT', `/holdings/${id}`, h),
  updateLot: (id, lotId, l) => request('PUT', `/holdings/${id}/lots/${lotId}`, l),
  removeLot: (id, lotId) => request('DELETE', `/holdings/${id}/lots/${lotId}`),
  removeHolding: (id) => request('DELETE', `/holdings/${id}`),
  sell: (id, s) => request('POST', `/holdings/${id}/sell`, s),
  sales: () => request('GET', '/sales'),
  updateSale: (id, s) => request('PUT', `/sales/${id}`, s),
  removeSale: (id) => request('DELETE', `/sales/${id}`),
  watchlist: () => request('GET', '/watchlist'),
  addWatch: (w) => request('POST', '/watchlist', w),
  updateWatch: (id, w) => request('PUT', `/watchlist/${id}`, w),
  removeWatch: (id) => request('DELETE', `/watchlist/${id}`),
  splits: () => request('GET', '/splits'),
  applySplit: (id, ratio) => request('POST', `/splits/${id}/apply`, ratio),
  dismissSplit: (id) => request('POST', `/splits/${id}/dismiss`),
  rules: () => request('GET', '/rules'),
  addRule: (r) => request('POST', '/rules', r),
  updateRule: (id, r) => request('PUT', `/rules/${id}`, r),
  removeRule: (id) => request('DELETE', `/rules/${id}`),
  notifications: () => request('GET', '/notifications'),
  markRead: () => request('POST', '/notifications/read'),
  refresh: () => request('POST', '/refresh'),
};
