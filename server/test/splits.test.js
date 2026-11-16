import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays, istDayStart } from '../src/dates.js';
import { snapRatio, suggestRatio, splitMessage } from '../src/splits.js';
import { parseSplits } from '../src/market.js';

const today = istDate();
const d = (n) => addDays(today, n);
const DAY = 86_400_000;

// ---------- pure helpers ----------

test('snapRatio finds the simplest whole-number ratio and ignores non-splits', () => {
  assert.deepEqual(snapRatio(10.02), { numerator: 10, denominator: 1 });
  assert.deepEqual(snapRatio(1.49), { numerator: 3, denominator: 2 });
  assert.deepEqual(snapRatio(0.5), { numerator: 1, denominator: 2 }, 'a consolidation');
  assert.deepEqual(snapRatio(1.1), { numerator: 11, denominator: 10 }, 'a 1:10 bonus');
  assert.equal(snapRatio(1.01), null, 'an ordinary price move is not a split');
  assert.equal(snapRatio(0), null);
});

test('suggestRatio trusts Yahoo unless the price moved by a clearly different ratio', () => {
  const twoForOne = { numerator: 2, denominator: 1 };
  assert.deepEqual(suggestRatio(twoForOne, null), { ...twoForOne, mismatch: false });
  assert.deepEqual(suggestRatio(twoForOne, 2.02), { ...twoForOne, mismatch: false });
  // Bajaj Finance, June 2025: Yahoo said 2:1, the price fell tenfold (4:1 bonus plus 1:2 split).
  assert.deepEqual(suggestRatio(twoForOne, 9.97), { numerator: 10, denominator: 1, mismatch: true });
  assert.match(splitMessage({ symbol: 'X.NS', exDate: '2026-06-16', reported: twoForOne, priceRatio: 9.97 }), /about 10\.0x/);
});

test('parseSplits reads Yahoo split events as IST dates, oldest first', () => {
  const events = [
    { date: new Date('2025-06-16T03:45:00Z'), numerator: 2, denominator: 1, splitRatio: '2:1' },
    { date: new Date('2024-12-03T03:45:00Z'), numerator: 2, denominator: 1, splitRatio: '2:1' },
    { date: new Date('2024-01-01T03:45:00Z'), numerator: 1, denominator: 1, splitRatio: '1:1' }, // not a split
  ];
  assert.deepEqual(parseSplits(events), [
    { date: '2024-12-03', numerator: 2, denominator: 1 },
    { date: '2025-06-16', numerator: 2, denominator: 1 },
  ]);
  assert.deepEqual(parseSplits(undefined), []);
});

// ---------- end to end, through the scheduled poll ----------

/** A fake Yahoo whose history and split events the test changes, counting split lookups. */
function fakeMarket() {
  const m = {
    history: [
      { date: d(-40), close: 300 },
      { date: d(-8), close: 260 },
      { date: d(-1), close: 220 },
    ],
    splits: [],
    splitLookups: 0,
    failHistory: false,
  };
  m.deps = {
    getDailyHistory: async () => {
      if (m.failHistory) throw new Error('Yahoo unavailable');
      return m.history;
    },
    getSplits: async () => {
      m.splitLookups++;
      return { points: m.history, splits: m.splits };
    },
  };
  /** The split happens: Yahoo now reports it and restates past closes in the new shares. */
  m.split = (numerator, denominator, factor = numerator / denominator) => {
    m.history = m.history.map((p) => ({ ...p, close: p.close / factor }));
    m.splits = [{ date: today, numerator, denominator }];
  };
  return m;
}

const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
const count = async (t, sql, params) => Number((await t.db.query(sql, params)).rows[0].c);

/** Make everything a user entered look entered three days ago, i.e. before today's ex-date. */
async function enteredEarlier(t, userId) {
  for (const table of ['holding_lots', 'sales', 'alert_rules']) {
    await t.db.query(`UPDATE ${table} SET created_at = created_at - $2 WHERE user_id = $1`, [userId, 3 * DAY]);
  }
}

/** The last price fetched the day before the split, in the old shares (what the hourly poll would have stored). */
const lastPriceYesterday = (t, symbol, price) =>
  t.store.saveSnapshots([{ symbol, ts: istDayStart(d(-1)) + 15.75 * 3600_000, price }]);

test('a split is found and prices corrected at once, but a user\'s shares only change when they confirm', async () => {
  const m = fakeMarket();
  const t = await setup({ prices: { 'AAA.NS': 220 }, deps: m.deps });
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 2000, purchaseDate: d(-30) });
    const id = (await alice.call('GET', '/api/holdings')).body[0].id;
    await alice.call('POST', `/api/holdings/${id}/sell`, { quantity: 4, salePrice: 230, saleDate: d(-2) });
    await alice.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'below', targetPrice: 200 });
    await alice.call('POST', '/api/rules', { symbol: 'AAA.NS', window: '1d', thresholdPct: 5 });
    await enteredEarlier(t, alice.user.id);
    // Bob entered his shares after the split, so they are already in the new shares.
    await bob.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 550 });
    await lastPriceYesterday(t, 'AAA.NS', 220);

    // 1:1 bonus today: the price halves.
    m.split(2, 1);
    t.prices['AAA.NS'] = 112;
    assert.equal((await poll(t)).status, 200);

    // Shared prices are restated right away, so nothing compares 112 with yesterday's 220.
    assert.equal((await t.store.getSeriesMany(['AAA.NS'], d(-1))).get('AAA.NS')[0].close, 110);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM snapshots WHERE symbol = $1 AND ts < $2', ['AAA.NS', istDayStart(today)]), 0);
    const recorded = (await t.db.query('SELECT numerator, denominator, price_ratio FROM stock_splits')).rows;
    assert.equal(recorded.length, 1);
    assert.equal(Number(recorded[0].price_ratio), 2, 'the price evidence agrees with Yahoo');

    // Alice is asked; her figures are untouched, and neither the 1-day drop nor the old price target fired.
    const notes = (await alice.call('GET', '/api/notifications')).body;
    const messages = (notes.items ?? notes).map((x) => x.message);
    assert.equal(messages.length, 1, messages.join(' | '));
    assert.match(messages[0], /AAA\.NS had a split or bonus issue .*every 1 share became 2/);
    const [review] = (await alice.call('GET', '/api/splits')).body;
    assert.deepEqual(
      { lots: review.lots, sales: review.sales, priceTargets: review.priceTargets, suggested: review.suggested },
      { lots: { count: 1, quantity: 6, invested: 1200 }, sales: 1, priceTargets: 1, suggested: { numerator: 2, denominator: 1, mismatch: false } },
    );
    assert.equal((await alice.call('GET', '/api/holdings')).body[0].quantity, 6);
    const report = (await alice.call('GET', '/api/report?period=1w')).body;
    assert.deepEqual(report.pendingSplits.map((p) => p.symbol), ['AAA.NS']);
    assert.equal(report.holdings[0].splitPending, true);
    // Bob entered his shares after the split: nothing to ask him.
    assert.deepEqual((await bob.call('GET', '/api/splits')).body, []);

    // Alice confirms.
    const applied = await alice.call('POST', `/api/splits/${review.id}/apply`, { numerator: 2, denominator: 1 });
    assert.equal(applied.status, 200);
    assert.deepEqual([applied.body.lots, applied.body.sales, applied.body.priceTargets], [1, 1, 1]);
    const h = (await alice.call('GET', '/api/holdings')).body[0];
    assert.deepEqual([h.quantity, h.invested], [12, 1200], 'twice the shares, same money invested');
    const sale = (await alice.call('GET', '/api/sales')).body.items[0];
    assert.deepEqual([sale.quantity, sale.salePrice, sale.splitFactor, sale.proceeds], [8, 115, 2, 920], 'restated, same proceeds');
    const target = (await alice.call('GET', '/api/rules')).body.find((r) => r.kind === 'price');
    assert.equal(target.target_price, 100);
    assert.deepEqual((await alice.call('GET', '/api/splits')).body, []);
    assert.equal((await alice.call('POST', `/api/splits/${review.id}/apply`, { numerator: 2, denominator: 1 })).status, 409);
    assert.equal((await bob.call('GET', '/api/holdings')).body[0].quantity, 5, "bob's shares untouched");

    // Undoing the earlier sale gives back its shares in the new terms.
    assert.equal((await alice.call('DELETE', `/api/sales/${sale.id}`)).status, 200);
    assert.equal((await alice.call('GET', '/api/holdings')).body[0].quantity, 20);

    // Polling again finds nothing new.
    await poll(t);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM split_reviews'), 1);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1', [alice.user.id]), 1);
  } finally {
    await t.close();
  }
});

test('when the price move disagrees with Yahoo\'s ratio, the price move is suggested; a review can also be dismissed', async () => {
  const m = fakeMarket();
  const t = await setup({ prices: { 'AAA.NS': 220 }, deps: m.deps });
  try {
    const alice = await t.login('alice@example.test');
    const carol = await t.login('carol@example.test');
    for (const u of [alice, carol]) {
      await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 2000 });
      await enteredEarlier(t, u.user.id);
    }
    await lastPriceYesterday(t, 'AAA.NS', 220);

    // Yahoo says 2:1, but restates prices tenfold (as it did for Bajaj Finance).
    m.split(2, 1, 10);
    t.prices['AAA.NS'] = 22.4;
    await poll(t);

    const [review] = (await alice.call('GET', '/api/splits')).body;
    assert.deepEqual(review.suggested, { numerator: 10, denominator: 1, mismatch: true });
    assert.deepEqual(review.reported, { numerator: 2, denominator: 1 });
    assert.ok(Math.abs(review.priceRatio - 10) < 0.01);
    assert.equal((await alice.call('POST', `/api/splits/${review.id}/apply`, { numerator: 1, denominator: 1 })).status, 400, 'must change the shares');
    assert.equal((await alice.call('POST', `/api/splits/${review.id}/apply`, { numerator: 10, denominator: 1 })).status, 200);
    assert.equal((await alice.call('GET', '/api/holdings')).body[0].quantity, 100);

    // Carol already fixed her quantity by hand: she dismisses it and nothing changes.
    const [hers] = (await carol.call('GET', '/api/splits')).body;
    assert.equal((await alice.call('POST', `/api/splits/${hers.id}/dismiss`)).status, 404, "alice can't touch carol's review");
    assert.equal((await carol.call('POST', `/api/splits/${hers.id}/dismiss`)).status, 204);
    assert.deepEqual((await carol.call('GET', '/api/splits')).body, []);
    assert.equal((await carol.call('GET', '/api/holdings')).body[0].quantity, 10);
    assert.equal((await carol.call('POST', `/api/splits/${hers.id}/apply`, { numerator: 10, denominator: 1 })).status, 409);
  } finally {
    await t.close();
  }
});

test('if corrected prices cannot be fetched, the split waits for the next run and the stock sits out alerts', async () => {
  const m = fakeMarket();
  const t = await setup({ prices: { 'AAA.NS': 220 }, deps: m.deps });
  try {
    const alice = await t.login('alice@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 2000 });
    await alice.call('POST', '/api/rules', { symbol: 'AAA.NS', window: '1d', thresholdPct: 5 });
    await enteredEarlier(t, alice.user.id);

    m.split(2, 1);
    m.failHistory = true;
    t.prices['AAA.NS'] = 112;
    await poll(t);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM stock_splits'), 0, 'not recorded, so it is retried');
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM notifications'), 0, 'no false "fell 49%" alert');

    m.failHistory = false;
    await poll(t);
    assert.equal(await count(t, 'SELECT COUNT(*) AS c FROM stock_splits'), 1);
    assert.equal((await alice.call('GET', '/api/splits')).body.length, 1);
    const messages = (await t.db.query('SELECT message FROM notifications')).rows.map((r) => r.message);
    assert.equal(messages.length, 1, messages.join(' | '));
  } finally {
    await t.close();
  }
});

test('each stock is checked for splits once a day, or again at once after a big move', async () => {
  const m = fakeMarket();
  const t = await setup({ prices: { 'AAA.NS': 222 }, deps: m.deps });
  try {
    const alice = await t.login('alice@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 2000 });
    await poll(t);
    await poll(t);
    assert.equal(m.splitLookups, 1, 'a 1% move: already checked today');
    t.prices['AAA.NS'] = 250; // 13% above yesterday's close
    await poll(t);
    assert.equal(m.splitLookups, 2);
  } finally {
    await t.close();
  }
});
