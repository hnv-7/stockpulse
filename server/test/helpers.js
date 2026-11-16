import { createPgliteDb } from '../src/pglite-adapter.js';
import { buildApp } from '../src/build.js';
import { getConfig } from '../src/config.js';
import { istDate, addDays } from '../src/dates.js';

/** Spin up the full app on an in-memory Postgres with a fake market. */
export async function setup({ prices = { 'AAA.NS': 100, 'BBB.NS': 50 }, env = {}, oidcLib, deps: extraDeps = {} } = {}) {
  const db = await createPgliteDb();
  const sent = [];
  const today = istDate();
  const history = [
    { date: addDays(today, -40), close: 150 },
    { date: addDays(today, -8), close: 130 },
    { date: addDays(today, -1), close: 110 },
  ];
  const config = getConfig({
    APP_BASE_URL: 'http://localhost:4000',
    CRON_SECRET: 'test-cron-secret-value',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    ...env,
  });
  const built = await buildApp({
    db,
    config,
    oidcLib,
    deps: {
      notifier: { emailEnabled: true, sendEmail: async (to, subject, text) => (sent.push({ to, subject, text }), true) },
      getQuotes: async (symbols) =>
        new Map(symbols.filter((s) => prices[s]).map((s) => [s, { symbol: s, price: prices[s], name: s }])),
      getDailyHistory: async () => history,
      getSplits: async () => ({ points: history, splits: [] }),
      getQuote: async (s) => (prices[s] ? { symbol: s, price: prices[s], name: `${s} Ltd` } : null),
      searchSymbols: async () => [{ symbol: 'AAA.NS', name: 'Triple A Ltd', exchange: 'NSE' }],
      ...extraDeps,
    },
  });
  const server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A signed-in test client. */
  async function login(email) {
    const user = await built.store.upsertUser({ sub: `sub-${email}`, email, name: email.split('@')[0] });
    const s = await built.auth.createSessionFor(user.id);
    const call = async (method, path, body, extra = {}) => {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          cookie: s.cookie,
          'x-csrf-token': s.csrfToken,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return { status: res.status, body: json, headers: res.headers };
    };
    return { call, user, session: s };
  }

  const anon = async (method, path, init = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', ...init });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  };

  return {
    ...built,
    base,
    sent,
    prices,
    login,
    anon,
    close: async () => {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}
