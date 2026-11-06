import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('unauthenticated requests are rejected, /me reports signed-out', async () => {
  const t = await setup();
  try {
    for (const path of ['/api/holdings', '/api/report', '/api/rules', '/api/notifications']) {
      assert.equal((await t.anon('GET', path)).status, 401, path);
    }
    const me = await t.anon('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null);
    assert.equal(me.body.authConfigured, true);
    assert.equal((await t.anon('GET', '/api/nothing')).status, 401);
  } finally {
    await t.close();
  }
});

test('state-changing calls require the CSRF token and a same-origin Origin', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const body = { symbol: 'AAA.NS', quantity: 1, invested: 100 };
    const noToken = await t.anon('POST', '/api/holdings', {
      headers: { cookie: u.session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(noToken.status, 403);
    const badOrigin = await u.call('POST', '/api/holdings', body, { origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
    const wrongToken = await u.call('POST', '/api/holdings', body, { 'x-csrf-token': 'nope' });
    assert.equal(wrongToken.status, 403);
    const ok = await u.call('POST', '/api/holdings', body, { origin: 'http://localhost:4000' });
    assert.equal(ok.status, 201);
  } finally {
    await t.close();
  }
});

test('holdings CRUD, validation, report, per-user caps', async () => {
  const t = await setup({ env: { MAX_HOLDINGS_PER_USER: '2', MAX_RULES_PER_USER: '1' } });
  try {
    const u = await t.login('a@example.test');
    let r = await u.call('POST', '/api/holdings', { symbol: 'aaa.ns', quantity: 10, invested: 1000 });
    assert.equal(r.status, 201);
    assert.equal(r.body.symbol, 'AAA.NS');
    assert.equal(r.body.name, 'AAA.NS Ltd');

    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 1 })).status, 409);
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'NOPE.NS', quantity: 1, invested: 1 })).status, 404);
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'A; DROP TABLE users', quantity: 1, invested: 1 })).status, 400);
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: -5, invested: 1 })).status, 400);
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 1e15 })).status, 400);

    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 4, invested: 200 })).status, 201);
    t.prices['CCC.NS'] = 10;
    r = await u.call('POST', '/api/holdings', { symbol: 'CCC.NS', quantity: 1, invested: 10 });
    assert.equal(r.status, 400, 'cap of 2 stocks');

    await t.tracker.pollOnce();
    r = await u.call('GET', '/api/report?period=1w');
    assert.equal(r.status, 200);
    const row = r.body.holdings.find((h) => h.symbol === 'AAA.NS');
    assert.equal(row.price, 100);
    assert.equal(row.value, 1000);
    assert.equal(row.refPrice, 130);
    assert.equal(Math.round(row.periodChangePct), -23);
    assert.equal(r.body.dips.length, 0, 'pnl is 0, so not "in profit"');

    const holdingId = (await u.call('GET', '/api/holdings')).body.find((h) => h.symbol === 'AAA.NS').id;
    r = await u.call('PUT', `/api/holdings/${holdingId}`, { quantity: 10, invested: 500 });
    assert.equal(r.body.invested, 500);
    r = await u.call('GET', '/api/report?period=1w');
    assert.ok(r.body.dips.some((d) => d.symbol === 'AAA.NS'));
    assert.equal((await u.call('GET', '/api/report?period=bogus')).status, 400);

    assert.equal((await u.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 5 })).status, 201);
    assert.equal((await u.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 5 })).status, 400, 'rule cap');
    assert.equal((await u.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 100 })).status, 400);
    assert.equal((await u.call('POST', '/api/rules', { symbol: 'MISSING.NS', window: '1d', thresholdPct: 5 })).status, 400, 'cap hit first');
  } finally {
    await t.close();
  }
});

test('users cannot see or modify each other\'s data', async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');

    const aH = (await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 })).body;
    const aR = (await alice.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 5 })).body;
    await t.tracker.pollOnce();
    assert.equal((await alice.call('GET', '/api/notifications')).body.unread, 1);

    // Bob sees nothing of Alice's.
    assert.deepEqual((await bob.call('GET', '/api/holdings')).body, []);
    assert.deepEqual((await bob.call('GET', '/api/rules')).body, []);
    assert.deepEqual((await bob.call('GET', '/api/notifications')).body, { unread: 0, items: [] });
    assert.equal((await bob.call('GET', '/api/report')).body.holdings.length, 0);
    assert.equal((await bob.call('GET', '/api/stocks/AAA.NS/history')).status, 404);

    // Bob cannot touch Alice's rows by id.
    assert.equal((await bob.call('PUT', `/api/holdings/${aH.id}`, { quantity: 1, invested: 1 })).status, 404);
    assert.equal((await bob.call('DELETE', `/api/holdings/${aH.id}`)).status, 404);
    assert.equal((await bob.call('PUT', `/api/rules/${aR.id}`, { thresholdPct: 1, enabled: false })).status, 404);
    assert.equal((await bob.call('DELETE', `/api/rules/${aR.id}`)).status, 404);

    // ...and Alice's data is intact.
    assert.equal((await alice.call('GET', '/api/holdings')).body[0].quantity, 10);
    assert.equal((await alice.call('GET', '/api/rules')).body[0].threshold_pct, 5);

    // Bob holding the same stock doesn't leak or duplicate anything for Alice, and shares price history.
    await bob.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 50 });
    assert.equal((await alice.call('GET', '/api/holdings')).body.length, 1);
    // Removing Bob's holding must not delete the shared prices Alice still needs.
    const bobId = (await bob.call('GET', '/api/holdings')).body[0].id;
    assert.equal((await bob.call('DELETE', `/api/holdings/${bobId}`)).status, 204);
    const report = (await alice.call('GET', '/api/report?period=1w')).body;
    assert.equal(report.holdings[0].refPrice, 130);
  } finally {
    await t.close();
  }
});

test('alerts: fire per user once per cooldown, email only for opted-in users', async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    for (const u of [alice, bob]) {
      await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
      await u.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 5 });
    }
    assert.equal((await alice.call('PUT', '/api/me/settings', { alertEmail: true })).body.alertEmail, true);

    // yesterday 110 -> 100 is a 9.09% fall
    const first = await t.tracker.pollOnce();
    assert.equal(first.alerts, 2);
    assert.equal((await t.tracker.pollOnce()).alerts, 0, 'cooldown suppresses duplicates');
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].to, 'alice@example.test');

    const n = await alice.call('GET', '/api/notifications');
    assert.match(n.body.items[0].message, /AAA\.NS is down 9\.09%/);
    await alice.call('POST', '/api/notifications/read');
    assert.equal((await alice.call('GET', '/api/notifications')).body.unread, 0);
    assert.equal((await bob.call('GET', '/api/notifications')).body.unread, 1, 'bob unaffected');

    const rid = (await alice.call('GET', '/api/rules')).body[0].id;
    assert.equal((await alice.call('PUT', `/api/rules/${rid}`, { thresholdPct: 20, enabled: true })).body.threshold_pct, 20);
    assert.equal((await alice.call('DELETE', `/api/rules/${rid}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('manual refresh is throttled and scoped to the caller', async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 10 });
    await bob.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 10 });
    // Adding a stock stores a fresh snapshot, so an immediate refresh is throttled.
    assert.equal((await alice.call('POST', '/api/refresh')).body.throttled, true);
    const later = await t.tracker.refreshForUser(alice.user.id, Date.now() + 10 * 60_000);
    assert.equal(later.polled, 1, 'only the caller\'s one symbol is polled');
  } finally {
    await t.close();
  }
});

test('history endpoints', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    let r = await u.call('GET', '/api/stocks/AAA.NS/history?range=3m');
    assert.equal(r.status, 200);
    assert.equal(r.body.avgCost, 100);
    assert.equal(r.body.points.length, 3);
    r = await u.call('GET', '/api/stocks/AAA.NS/history?range=1d');
    assert.equal(r.body.points.length, 1);
    r = await u.call('GET', '/api/portfolio/history?range=1m');
    assert.ok(r.body.length >= 2);
    assert.equal((await u.call('GET', '/api/search?q=triple')).body[0].symbol, 'AAA.NS');
  } finally {
    await t.close();
  }
});

test('settings, logout and account deletion', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const other = await t.login('b@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 10 });
    await other.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 10 });

    const me = await t.anon('GET', '/api/me', { headers: { cookie: u.session.cookie } });
    assert.equal(me.body.user.email, 'a@example.test');
    assert.equal(me.body.csrfToken, u.session.csrfToken);

    assert.equal((await u.call('DELETE', '/api/me')).status, 204);
    assert.equal((await u.call('GET', '/api/holdings')).status, 401, 'session gone with the account');
    assert.equal((await t.db.query('SELECT COUNT(*) AS c FROM holdings WHERE user_id = $1', [u.user.id])).rows[0].c.toString(), '0');
    assert.equal((await t.db.query("SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = 'AAA.NS'")).rows[0].c.toString(), '0', 'orphaned prices pruned');
    assert.equal((await other.call('GET', '/api/holdings')).body.length, 1, 'other users untouched');

    assert.equal((await other.call('POST', '/api/auth/logout')).status, 204);
    assert.equal((await other.call('GET', '/api/holdings')).status, 401);
  } finally {
    await t.close();
  }
});

test('cron endpoints need the shared secret', async () => {
  const t = await setup();
  try {
    assert.equal((await t.anon('GET', '/api/cron/poll')).status, 401);
    assert.equal((await t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
    assert.equal(ok.status, 200);
    assert.equal((await t.anon('GET', '/api/cron/history', { headers: { authorization: 'Bearer test-cron-secret-value' } })).status, 200);
  } finally {
    await t.close();
  }
  const unset = await setup({ env: { CRON_SECRET: '' } });
  try {
    assert.equal((await unset.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer ' } })).status, 503);
  } finally {
    await unset.close();
  }
});

test('Google sign-in: state/nonce/PKCE are enforced and a session is created', async () => {
  const calls = [];
  const fakeOidc = {
    discovery: async () => ({ fake: true }),
    randomState: () => 'STATE123',
    randomNonce: () => 'NONCE123',
    randomPKCECodeVerifier: () => 'VERIFIER123',
    calculatePKCECodeChallenge: async () => 'CHALLENGE123',
    buildAuthorizationUrl: (_cfg, params) => new URL(`https://accounts.google.com/auth?${new URLSearchParams(params)}`),
    authorizationCodeGrant: async (_cfg, url, checks) => {
      calls.push({ url: url.href, checks });
      if (checks.expectedState !== url.searchParams.get('state')) throw new Error('state mismatch');
      return { claims: () => ({ sub: 'google-sub-1', email: 'new@example.test', email_verified: true, name: 'New User' }) };
    },
  };
  const t = await setup({ oidcLib: fakeOidc });
  try {
    const login = await t.anon('GET', '/api/auth/login');
    assert.equal(login.status, 302);
    const loc = new URL(login.headers.get('location'));
    assert.equal(loc.searchParams.get('state'), 'STATE123');
    assert.equal(loc.searchParams.get('nonce'), 'NONCE123');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:4000/api/auth/callback');
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const loginCookie = setCookie.split(';')[0];

    // Callback with no login cookie -> rejected.
    const noCookie = await t.anon('GET', '/api/auth/callback?code=x&state=STATE123');
    assert.match(noCookie.headers.get('location'), /login_error=expired/);

    // Callback with a tampered state -> rejected, no session.
    const bad = await t.anon('GET', '/api/auth/callback?code=x&state=WRONG', { headers: { cookie: loginCookie } });
    assert.match(bad.headers.get('location'), /login_error=failed/);

    const good = await t.anon('GET', '/api/auth/callback?code=x&state=STATE123', { headers: { cookie: loginCookie } });
    assert.equal(good.status, 302);
    assert.equal(good.headers.get('location'), '/');
    const cookies = good.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('sp_session='));
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Lax/);
    assert.equal(calls.at(-1).checks.pkceCodeVerifier, 'VERIFIER123');
    assert.equal(calls.at(-1).checks.expectedNonce, 'NONCE123');

    const me = await t.anon('GET', '/api/me', { headers: { cookie: session.split(';')[0] } });
    assert.equal(me.body.user.email, 'new@example.test');
    // The raw token is never stored, only its hash.
    const stored = await t.db.query('SELECT token_hash FROM sessions');
    assert.ok(!stored.rows.some((r) => session.includes(r.token_hash)));
  } finally {
    await t.close();
  }
});

test('unverified Google emails are refused', async () => {
  const fakeOidc = {
    discovery: async () => ({}),
    randomState: () => 'S', randomNonce: () => 'N', randomPKCECodeVerifier: () => 'V',
    calculatePKCECodeChallenge: async () => 'C',
    buildAuthorizationUrl: () => new URL('https://accounts.google.com/x'),
    authorizationCodeGrant: async () => ({ claims: () => ({ sub: 's', email: 'x@example.test', email_verified: false }) }),
  };
  const t = await setup({ oidcLib: fakeOidc });
  try {
    const login = await t.anon('GET', '/api/auth/login');
    const c = login.headers.get('set-cookie').split(';')[0];
    const cb = await t.anon('GET', '/api/auth/callback?code=x&state=S', { headers: { cookie: c } });
    assert.match(cb.headers.get('location'), /login_error=unverified/);
    assert.equal((await t.db.query('SELECT COUNT(*) AS c FROM users')).rows[0].c.toString(), '0');
  } finally {
    await t.close();
  }
});

test('sign-in reports unavailable when Google credentials are missing', async () => {
  const t = await setup({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  try {
    assert.equal((await t.anon('GET', '/api/auth/login')).status, 503);
    assert.equal((await t.anon('GET', '/api/me')).body.authConfigured, false);
  } finally {
    await t.close();
  }
});
