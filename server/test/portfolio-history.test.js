import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';

// The fake market's daily closes (see helpers.js): 150 forty days ago, 130 eight days ago, 110 yesterday.
const today = istDate();
const d = (n) => addDays(today, n);
const at = (points, day) => points.find((p) => p.date === day);
const pricesOf = async (t, symbol) =>
  Number((await t.db.query('SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = $1', [symbol])).rows[0].c);

test('the value chart follows purchases and sales instead of today\'s holdings', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: d(-30) });
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 600, purchaseDate: d(-5), merge: true });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 4, invested: 400 }); // undated: held all along
    const id = (await u.call('GET', '/api/holdings')).body.find((h) => h.symbol === 'AAA.NS').id;
    // Sells the whole first purchase and 2 of the second (cost 2/5 of 600 = 240); 3 shares costing 360 are left.
    assert.equal((await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 12, salePrice: 120, saleDate: d(-3) })).status, 200);

    const r = await u.call('GET', '/api/portfolio/history?range=1m');
    assert.equal(r.status, 200);
    // Eight days ago: the first purchase of AAA (since sold) and BBB were held; the second purchase wasn't made yet.
    assert.deepEqual(at(r.body, d(-8)), { date: d(-8), value: 10 * 130 + 4 * 130, invested: 1000 + 400 });
    // Yesterday: only what is left of the second purchase, plus BBB.
    assert.deepEqual(at(r.body, d(-1)), { date: d(-1), value: 3 * 110 + 4 * 110, invested: 360 + 400 });
  } finally {
    await t.close();
  }
});

test('a fully sold stock stays on the chart for the time it was held, and its prices are kept', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: d(-30) });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 100 });
    const id = (await u.call('GET', '/api/holdings')).body.find((h) => h.symbol === 'AAA.NS').id;
    assert.equal((await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 10, salePrice: 120, saleDate: d(-3) })).status, 200);
    assert.ok((await pricesOf(t, 'AAA.NS')) > 0, 'closes of a sold stock are kept');

    const r = await u.call('GET', '/api/portfolio/history?range=1m');
    assert.deepEqual(at(r.body, d(-8)), { date: d(-8), value: 10 * 130 + 130, invested: 1100 });
    assert.deepEqual(at(r.body, d(-1)), { date: d(-1), value: 110, invested: 100 });

    // Once no sale or holding refers to it any more, the shared prices go.
    assert.equal((await u.call('DELETE', '/api/me')).status, 204);
    assert.equal(await pricesOf(t, 'AAA.NS'), 0);
  } finally {
    await t.close();
  }
});

test('a sold stock whose prices were removed earlier is fetched again, and a failing one is not retried at once', async () => {
  const history = [
    { date: d(-40), close: 150 },
    { date: d(-8), close: 130 },
    { date: d(-1), close: 110 },
  ];
  const fetched = [];
  let failFor = null;
  const t = await setup({
    deps: {
      getDailyHistory: async (symbol) => {
        fetched.push(symbol);
        if (symbol === failFor) throw new Error('no data');
        return history;
      },
    },
  });
  try {
    const u = await t.login('a@example.test');
    for (const symbol of ['AAA.NS', 'BBB.NS']) {
      await u.call('POST', '/api/holdings', { symbol, quantity: 10, invested: 1000, purchaseDate: d(-30) });
      const id = (await u.call('GET', '/api/holdings')).body.find((h) => h.symbol === symbol).id;
      await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 10, salePrice: 120, saleDate: d(-3) });
    }
    // As happened to stocks sold before this change: their closes were deleted with the holding.
    await t.db.query("DELETE FROM daily_prices WHERE symbol IN ('AAA.NS', 'BBB.NS')");
    fetched.length = 0;
    failFor = 'BBB.NS';

    let r = await u.call('GET', '/api/portfolio/history?range=1m');
    assert.deepEqual(fetched.sort(), ['AAA.NS', 'BBB.NS']);
    // AAA is back on the chart; BBB couldn't be fetched, so it is left out rather than blanking the chart.
    assert.deepEqual(at(r.body, d(-8)), { date: d(-8), value: 10 * 130, invested: 1000 });

    fetched.length = 0;
    r = await u.call('GET', '/api/portfolio/history?range=1m');
    assert.deepEqual(fetched, [], 'neither is fetched again: AAA has prices now, BBB was tried moments ago');
    assert.deepEqual(at(r.body, d(-8)), { date: d(-8), value: 10 * 130, invested: 1000 });
  } finally {
    await t.close();
  }
});
