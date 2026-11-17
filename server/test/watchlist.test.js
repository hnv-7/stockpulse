import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { buildWatchlist } from '../src/analytics.js';

// The fake market (helpers.js): AAA.NS 100 and BBB.NS 50 now; daily closes 150 forty days ago, 130 eight days ago,
// 110 yesterday.
const today = istDate();
const d = (n) => addDays(today, n);
const DAY = 86_400_000;
const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
const count = async (t, sql, params) => Number((await t.db.query(sql, params)).rows[0].c);
const messages = async (t, userId) =>
  (await t.db.query('SELECT message FROM notifications WHERE user_id = $1 ORDER BY id', [userId])).rows.map((r) => r.message);

test('buildWatchlist works without any prices yet', () => {
  const [row] = buildWatchlist({
    items: [{ id: 1, symbol: 'NEW.NS', name: 'New', note: '', added_price: 10, created_at: 0 }],
    seriesBySymbol: new Map(),
    latestBySymbol: new Map(),
    today,
  });
  assert.equal(row.price, null);
  assert.equal(row.dayChangePct, null);
  assert.equal(row.sinceAddedPct, null);
});

test('watch a stock: its moves, the change since added, notes and price alerts', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 50 });
    let r = await u.call('POST', '/api/watchlist', { symbol: 'aaa.ns', note: '  buy under 90  ' });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.symbol, r.body.note, r.body.added_price], ['AAA.NS', 'buy under 90', 100]);
    assert.equal((await u.call('POST', '/api/watchlist', { symbol: 'AAA.NS' })).status, 409, 'already watched');
    assert.equal((await u.call('POST', '/api/watchlist', { symbol: 'NOPE.NS' })).status, 404, 'unknown symbol');
    assert.equal((await u.call('POST', '/api/watchlist', { symbol: 'BBB.NS', note: 'x'.repeat(201) })).status, 400, 'note too long');
    assert.equal((await u.call('POST', '/api/watchlist', { symbol: 'BBB.NS' })).status, 201, 'a held stock can be watched too');

    // An alert can be set on a stock that is only watched.
    r = await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'below', targetPrice: 90 });
    assert.equal(r.status, 201);
    assert.equal((await u.call('POST', '/api/rules', { kind: 'price', symbol: 'CCC.NS', direction: 'below', targetPrice: 1 })).status, 404);

    await poll(t); // today's price for AAA.NS (100) is fetched along with the holdings
    const list = (await u.call('GET', '/api/watchlist')).body;
    const aaa = list.find((x) => x.symbol === 'AAA.NS');
    const round = (x) => Math.round(x * 100) / 100;
    assert.equal(aaa.price, 100);
    assert.equal(round(aaa.dayChangePct), round((100 / 110 - 1) * 100));
    assert.equal(round(aaa.weekChangePct), round((100 / 130 - 1) * 100));
    assert.equal(round(aaa.monthChangePct), round((100 / 150 - 1) * 100));
    assert.equal(round(aaa.fromHighPct), round((100 / 150 - 1) * 100));
    assert.equal(aaa.sinceAddedPct, 0);
    assert.equal(aaa.held, false);
    assert.equal(aaa.stale, false);
    assert.deepEqual(aaa.targets.map((x) => [x.direction, x.targetPrice, x.enabled]), [['below', 90, true]]);
    assert.equal(list.find((x) => x.symbol === 'BBB.NS').held, true);

    const id = aaa.id;
    assert.equal((await u.call('PUT', `/api/watchlist/${id}`, { note: 'wait for results' })).body.note, 'wait for results');
    const hist = await u.call('GET', '/api/stocks/AAA.NS/history?range=3m');
    assert.equal(hist.status, 200);
    assert.equal(hist.body.avgCost, null, 'no average cost for a stock you only watch');
  } finally {
    await t.close();
  }
});

test('watchlists are private, need the CSRF token, and are capped', async () => {
  const t = await setup({ env: { MAX_WATCHLIST_PER_USER: '1' } });
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    const id = (await alice.call('POST', '/api/watchlist', { symbol: 'AAA.NS' })).body.id;
    assert.equal((await alice.call('POST', '/api/watchlist', { symbol: 'BBB.NS' })).status, 400, 'over the cap');
    assert.equal((await alice.call('POST', '/api/watchlist', { symbol: 'BBB.NS' }, { 'x-csrf-token': 'nope' })).status, 403);
    assert.equal((await t.anon('GET', '/api/watchlist')).status, 401);

    assert.deepEqual((await bob.call('GET', '/api/watchlist')).body, []);
    assert.equal((await bob.call('PUT', `/api/watchlist/${id}`, { note: 'mine now' })).status, 404);
    assert.equal((await bob.call('DELETE', `/api/watchlist/${id}`)).status, 404);
    assert.equal((await bob.call('GET', '/api/stocks/AAA.NS/history')).status, 404);
    assert.equal((await bob.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 1 })).status, 404);
    assert.equal((await alice.call('GET', '/api/watchlist')).body[0].note, '');

    assert.equal((await alice.call('DELETE', '/api/me')).status, 204);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM watchlist'), 0);
    assert.equal(await count(t, "SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = 'AAA.NS'"), 0, 'nobody watches it now');
  } finally {
    await t.close();
  }
});

test('alerts on watched stocks fire, but "any stock" alerts stay with the portfolio', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await u.call('POST', '/api/watchlist', { symbol: 'BBB.NS' });
    await u.call('POST', '/api/rules', { symbol: null, window: '1d', thresholdPct: 5 }); // any stock in the portfolio
    await u.call('POST', '/api/rules', { symbol: 'BBB.NS', window: '1d', thresholdPct: 5 });
    await u.call('POST', '/api/rules', { kind: 'price', symbol: 'BBB.NS', direction: 'below', targetPrice: 60 });

    assert.equal((await poll(t)).status, 200);
    // AAA.NS: 100 vs 110 yesterday, from the "any stock" rule. BBB.NS (50 vs 110): its own two rules only.
    const m = await messages(t, u.user.id);
    assert.equal(m.length, 3, m.join(' | '));
    assert.equal(m.filter((x) => x.startsWith('AAA.NS is down')).length, 1);
    assert.equal(m.filter((x) => x.startsWith('BBB.NS is down')).length, 1);
    assert.equal(m.filter((x) => x.startsWith('BBB.NS reached your target')).length, 1);
    assert.equal(await count(t, "SELECT COUNT(*) AS c FROM snapshots WHERE symbol = 'BBB.NS'"), 2, 'watched stocks are polled');
  } finally {
    await t.close();
  }
});

test('alerts and prices stay while a stock is held or watched, and go when it is neither', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    const watchId = (await u.call('POST', '/api/watchlist', { symbol: 'AAA.NS' })).body.id;
    await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 500 });
    const rulesFor = async () => (await u.call('GET', '/api/rules')).body.length;

    // Sell everything: still watched, so the alert and the prices stay.
    const holdingId = (await u.call('GET', '/api/holdings')).body[0].id;
    await u.call('POST', `/api/holdings/${holdingId}/sell`, { quantity: 10, salePrice: 120, saleDate: today });
    assert.equal(await rulesFor(), 1);
    assert.ok((await count(t, "SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = 'AAA.NS'")) > 0);

    // Stop watching: the alert goes; closes stay because of the sale, intraday prices go.
    assert.equal((await u.call('DELETE', `/api/watchlist/${watchId}`)).status, 204);
    assert.equal(await rulesFor(), 0);
    assert.ok((await count(t, "SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = 'AAA.NS'")) > 0);
    assert.equal(await count(t, "SELECT COUNT(*) AS c FROM snapshots WHERE symbol = 'AAA.NS'"), 0);

    // Watched only, never held or sold: everything goes with it.
    const bbb = (await u.call('POST', '/api/watchlist', { symbol: 'BBB.NS' })).body.id;
    await u.call('POST', '/api/rules', { kind: 'price', symbol: 'BBB.NS', direction: 'above', targetPrice: 500 });
    assert.equal((await u.call('DELETE', `/api/watchlist/${bbb}`)).status, 204);
    assert.equal(await rulesFor(), 0);
    assert.equal(await count(t, "SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = 'BBB.NS'"), 0);
  } finally {
    await t.close();
  }
});

test('a split of a watched stock asks to restate its added price and price alerts', async () => {
  let history = [
    { date: d(-40), close: 300 },
    { date: d(-8), close: 260 },
    { date: d(-1), close: 220 },
  ];
  let splits = [];
  const t = await setup({
    prices: { 'AAA.NS': 220 },
    deps: {
      getDailyHistory: async () => history,
      getSplits: async () => ({ points: history, splits }),
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/watchlist', { symbol: 'AAA.NS' });
    await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 300 });
    for (const table of ['watchlist', 'alert_rules']) {
      await t.db.query(`UPDATE ${table} SET created_at = created_at - $2 WHERE user_id = $1`, [u.user.id, 3 * DAY]);
    }

    // 1:1 bonus today.
    history = history.map((p) => ({ ...p, close: p.close / 2 }));
    splits = [{ date: today, numerator: 2, denominator: 1 }];
    t.prices['AAA.NS'] = 112;
    await poll(t);

    const [review] = (await u.call('GET', '/api/splits')).body;
    assert.deepEqual(
      { lots: review.lots.count, sales: review.sales, priceTargets: review.priceTargets, watching: review.watching },
      { lots: 0, sales: 0, priceTargets: 1, watching: true },
    );
    assert.equal((await u.call('GET', '/api/watchlist')).body[0].splitPending, true);

    assert.equal((await u.call('POST', `/api/splits/${review.id}/apply`, { numerator: 2, denominator: 1 })).status, 200);
    const [row] = (await u.call('GET', '/api/watchlist')).body;
    assert.equal(row.addedPrice, 110);
    assert.deepEqual(row.targets.map((x) => x.targetPrice), [150]);
    assert.equal(row.splitPending, false);
  } finally {
    await t.close();
  }
});
