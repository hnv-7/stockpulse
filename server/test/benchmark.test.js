import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { xirr, daysBetween } from '../src/analytics.js';
import { BENCHMARK, sameMoneyInIndex, indexChange, relativePerformance } from '../src/benchmark.js';

const series = (pairs) => pairs.map(([date, close]) => ({ date, close }));
const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

// ---------- pure ----------

test('sameMoneyInIndex buys the index on each purchase day (or the last close before it)', () => {
  const indexSeries = series([['2025-01-01', 100], ['2025-12-31', 120]]);
  const lots = [
    { invested: 1000, purchase_date: '2025-01-01' },
    { invested: 2000, purchase_date: '2026-01-03' }, // a Saturday: uses 31 Dec's close
  ];
  const r = sameMoneyInIndex({ lots, indexSeries, indexNow: 150, today: '2026-06-30' });
  assert.equal(r.invested, 3000);
  assert.equal(r.value, (1000 / 100) * 150 + (2000 / 120) * 150);
  const expected = xirr(lots.map((l) => ({ invested: l.invested, days: daysBetween(l.purchase_date, '2026-06-30') })), r.value);
  assert.equal(r.xirrPct, expected * 100);

  assert.equal(sameMoneyInIndex({ lots: [{ invested: 1, purchase_date: '2020-01-01' }], indexSeries, indexNow: 150, today: '2026-06-30' }), null,
    'before the index history starts');
  assert.equal(sameMoneyInIndex({ lots: [], indexSeries, indexNow: 150, today: '2026-06-30' }), null);
});

test('indexChange measures the index over a report period', () => {
  const indexSeries = series([['2026-10-30', 200], ['2026-11-04', 210], ['2026-11-05', 205]]);
  assert.equal(round(indexChange({ indexSeries, indexNow: 220, today: '2026-11-06', period: '1d' })), round((220 / 205 - 1) * 100));
  assert.equal(indexChange({ indexSeries, indexNow: 220, today: '2026-11-06', period: '1y' }), null, 'no close a year back');
});

test('relativePerformance: buying or selling is not a gain or loss; only held shares move the line', () => {
  const indexSeries = series([['2026-11-02', 1000], ['2026-11-03', 1000], ['2026-11-04', 1100]]);
  const seriesBySymbol = new Map([
    ['A', series([['2026-11-02', 100], ['2026-11-03', 100], ['2026-11-04', 100]])],
    ['B', series([['2026-11-02', 40], ['2026-11-03', 50], ['2026-11-04', 55]])], // rose 25% the day it was bought
    ['C', series([['2026-11-02', 10], ['2026-11-03', 5], ['2026-11-04', 5]])],
  ]);
  const holdings = [
    { symbol: 'A', quantity: 1, invested: 90 }, // held all along, flat
    { symbol: 'B', quantity: 10, invested: 500, lots: [{ quantity: 10, invested: 500, purchase_date: '2026-11-03' }] }, // bought on the 3rd
  ];
  // C halved on the 3rd, the day it was sold: it was not held through that day, so the fall doesn't count.
  const soldLots = [{ symbol: 'C', quantity: 100, invested: 1000, purchase_date: null, sale_date: '2026-11-03' }];
  const out = relativePerformance({ holdings, soldLots, seriesBySymbol, indexSeries, fromDate: '2026-11-01' });
  assert.deepEqual(out.map((p) => [p.date, round(p.yoursPct), round(p.indexPct)]), [
    ['2026-11-02', 0, 0],
    ['2026-11-03', 0, 0], // A flat; B only bought at that day's close; C sold that day
    ['2026-11-04', round(((100 + 550) / (100 + 500) - 1) * 100), 10],
  ]);

  const none = relativePerformance({ holdings: [], seriesBySymbol, indexSeries, fromDate: '2026-11-01' });
  assert.deepEqual(none.map((p) => p.yoursPct), [0, 0, 0], 'nothing held: flat');
});

// ---------- end to end ----------

const today = istDate();
const d = (n) => addDays(today, n);

/** Fake market where the index has its own history, recording which history requests were made. */
function market({ indexFrom = -40 } = {}) {
  const calls = [];
  const stock = [
    { date: d(-40), close: 150 },
    { date: d(-8), close: 130 },
    { date: d(-1), close: 110 },
  ];
  const index = [
    { date: d(indexFrom), close: 20000 },
    { date: d(-8), close: 21000 },
    { date: d(-1), close: 22000 },
  ];
  return {
    calls,
    deps: {
      getDailyHistory: async (symbol, days) => {
        calls.push({ symbol, days });
        if (symbol !== BENCHMARK.symbol) return stock;
        return index.filter((p) => p.date >= addDays(today, -days));
      },
    },
  };
}
const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });

test('the dashboard comparison: this period, since you bought, and over time', async () => {
  const m = market();
  const t = await setup({ prices: { 'AAA.NS': 100, [BENCHMARK.symbol]: 22220 }, deps: m.deps });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1500, purchaseDate: d(-40) });
    await poll(t); // today's AAA and Nifty prices
    assert.equal(Number((await t.db.query('SELECT COUNT(*) AS c FROM snapshots WHERE symbol = $1', [BENCHMARK.symbol])).rows[0].c), 1);

    const r = (await u.call('GET', '/api/benchmark?period=1w')).body;
    assert.equal(r.available, true);
    assert.equal(r.name, 'Nifty 50');
    assert.equal(round(r.period.yoursPct), round((100 / 130 - 1) * 100));
    assert.equal(round(r.period.indexPct), round((22220 / 21000 - 1) * 100));
    const sp = r.sincePurchase;
    assert.equal(sp.invested, 1500);
    assert.equal(sp.yourValue, 1000);
    assert.equal(round(sp.indexValue), round((1500 / 20000) * 22220));
    assert.ok(sp.yourXirrPct < 0 && sp.indexXirrPct > 0, `${sp.yourXirrPct} vs ${sp.indexXirrPct}`);
    assert.deepEqual(sp.coverage, { holdings: 1, of: 1, investedPct: 100 });

    const h = (await u.call('GET', '/api/benchmark/history?range=1m')).body;
    assert.deepEqual(h.points.map((p) => [p.date, round(p.yoursPct), round(p.indexPct)]), [
      [d(-8), 0, 0],
      [d(-1), round((110 / 130 - 1) * 100), round((22000 / 21000 - 1) * 100)],
      [today, round((100 / 130 - 1) * 100), round((22220 / 21000 - 1) * 100)],
    ]);

    // Index prices are shared and outlive any one account.
    assert.equal((await u.call('DELETE', '/api/me')).status, 204);
    assert.ok(Number((await t.db.query('SELECT COUNT(*) AS c FROM daily_prices WHERE symbol = $1', [BENCHMARK.symbol])).rows[0].c) > 0);
  } finally {
    await t.close();
  }
});

test('older purchases fetch older index history once; undated holdings skip the since-bought comparison', async () => {
  const m = market({ indexFrom: -1000 });
  const t = await setup({ prices: { 'AAA.NS': 100, 'BBB.NS': 50, [BENCHMARK.symbol]: 22220 }, deps: m.deps });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 50 }); // undated
    await poll(t);
    let r = (await u.call('GET', '/api/benchmark?period=1w')).body;
    assert.equal(r.sincePurchase, null, 'nothing dated to compare');
    assert.notEqual(r.period.indexPct, null);

    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1500, purchaseDate: d(-1000) });
    m.calls.length = 0;
    r = (await u.call('GET', '/api/benchmark?period=1w')).body;
    const fetched = m.calls.filter((c) => c.symbol === BENCHMARK.symbol);
    assert.equal(fetched.length, 1);
    assert.ok(fetched[0].days >= 1000, `asked for ${fetched[0].days} days`);
    assert.equal(r.sincePurchase.invested, 1500);
    assert.deepEqual(r.sincePurchase.coverage.holdings, 1);
    assert.equal(r.sincePurchase.coverage.of, 2);

    m.calls.length = 0;
    await u.call('GET', '/api/benchmark?period=1w');
    assert.equal(m.calls.filter((c) => c.symbol === BENCHMARK.symbol).length, 0, 'already stored');
  } finally {
    await t.close();
  }
});

test('without any index prices the comparison says so', async () => {
  const t = await setup({
    deps: {
      getDailyHistory: async (symbol) => {
        if (symbol === BENCHMARK.symbol) throw new Error('Yahoo unavailable');
        return [{ date: d(-1), close: 110 }];
      },
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    const r = await u.call('GET', '/api/benchmark?period=1w');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ...BENCHMARK, available: false });
    assert.deepEqual((await u.call('GET', '/api/benchmark/history?range=1m')).body.points, []);
  } finally {
    await t.close();
  }
});
