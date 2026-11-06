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

export const api = {
  me: () => request('GET', '/me'),
  updateSettings: (s) => request('PUT', '/me/settings', s),
  logout: () => request('POST', '/auth/logout'),
  deleteAccount: () => request('DELETE', '/me'),
  report: (period) => request('GET', `/report?period=${period}`),
  portfolioHistory: (range) => request('GET', `/portfolio/history?range=${range}`),
  stockHistory: (symbol, range) =>
    request('GET', `/stocks/${encodeURIComponent(symbol)}/history?range=${range}`),
  search: (q) => request('GET', `/search?q=${encodeURIComponent(q)}`),
  holdings: () => request('GET', '/holdings'),
  addHolding: (h) => request('POST', '/holdings', h),
  updateHolding: (id, h) => request('PUT', `/holdings/${id}`, h),
  removeHolding: (id) => request('DELETE', `/holdings/${id}`),
  rules: () => request('GET', '/rules'),
  addRule: (r) => request('POST', '/rules', r),
  updateRule: (id, r) => request('PUT', `/rules/${id}`, r),
  removeRule: (id) => request('DELETE', `/rules/${id}`),
  notifications: () => request('GET', '/notifications'),
  markRead: () => request('POST', '/notifications/read'),
  refresh: () => request('POST', '/refresh'),
};
