import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays, marketStatus } from '../src/dates.js';
import { allocation, dividendsReceived, dividendStart } from '../src/income.js';

const today = istDate();
const d = (n) => addDays(today, n);
const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
/** An instant on an IST date and time. */
const ist = (date, hh, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);

// ---------- market open / closed ----------

test('marketStatus: open in hours, closed at weekends, and a holiday once a weekday has gone till 11:00 without prices', () => {
  // Tue 17 Nov 2026
  assert.deepEqual(marketStatus('2026-11-17', ist('2026-11-17', 12)), { open: true, closedToday: false, holiday: false, lastSession: '2026-11-17' });
  assert.deepEqual(marketStatus('2026-11-16', ist('2026-11-17', 12)), { open: false, closedToday: true, holiday: true, lastSession: '2026-11-16' });
  assert.equal(marketStatus('2026-11-16', ist('2026-11-17', 10)).holiday, false, 'too early to tell: a poll may just be late');
  assert.equal(marketStatus('2026-11-17', ist('2026-11-17', 16)).open, false, 'after 15:30');
  // Sat 21 Nov 2026
  assert.deepEqual(marketStatus('2026-11-20', ist('2026-11-21', 12)), { open: false, closedToday: true, holiday: false, lastSession: '2026-11-20' });
});

test("a poll stores each price as the close of the day it traded, so a holiday doesn't get a made-up close", async () => {
  const lastSession = d(-1);
  const t = await setup({
    deps: {
      getQuotes: async (symbols) =>
        new Map(symbols.map((s) => [s, { symbol: s, price: 105, name: s, marketTime: Date.parse(`${lastSession}T15:29:00+05:30`) }])),
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await poll(t);
    const rows = (await t.db.query("SELECT to_char(date, 'YYYY-MM-DD') AS date, close FROM daily_prices WHERE symbol = 'AAA.NS' AND date >= $1::date", [lastSession])).rows;
    assert.deepEqual(rows.map((r) => [r.date, Number(r.close)]), [[lastSession, 105]], 'no row for today');
    const report = (await u.call('GET', '/api/report?period=1d')).body;
    assert.equal(report.market.lastSession, lastSession, 'from Nifty 50, polled alongside');
  } finally {
    await t.close();
  }
});

// ---------- sectors ----------

test('allocation groups value by sector, unknown last, and reports the largest stocks', () => {
  const rows = [
    { symbol: 'A', name: 'A', value: 500 },
    { symbol: 'B', name: 'B', value: 300 },
    { symbol: 'C', name: 'C', value: 150 },
    { symbol: 'D', name: 'D', value: 50 },
    { symbol: 'E', name: 'E', value: null }, // no price: left out
  ];
  const info = new Map([['A', { sector: 'Technology' }], ['B', { sector: 'Financial Services' }], ['D', { sector: 'Technology' }]]);
  const r = allocation(rows, info);
  const round = (x) => Math.round(x * 1e6) / 1e6;
  assert.deepEqual(r.sectors.map((s) => [s.sector, s.value, round(s.weightPct), s.stocks]), [
    ['Technology', 550, 55, ['A', 'D']],
    ['Financial Services', 300, 30, ['B']],
    [null, 150, 15, ['C']],
  ]);
  assert.deepEqual(r.top.map((t) => [t.symbol, round(t.weightPct)]), [['A', 50], ['B', 30], ['C', 15]]);
  assert.equal(round(r.topPct), 95);
  assert.deepEqual(allocation([], info).sectors, []);
});

test('sectors are looked up once per stock and kept; a failed lookup is tried again', async () => {
  const calls = [];
  let failBbb = true;
  const t = await setup({
    deps: {
      getProfile: async (s) => {
        calls.push(s);
        if (s === 'BBB.NS' && failBbb) throw new Error('Yahoo unavailable');
        return s === 'AAA.NS' ? { sector: 'Technology', industry: 'IT Services' } : null;
      },
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 3, invested: 300 });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 50 });
    let r = (await u.call('GET', '/api/allocation')).body;
    assert.deepEqual(r.sectors.map((s) => s.sector), ['Technology', null]);
    failBbb = false;
    r = (await u.call('GET', '/api/allocation')).body;
    assert.deepEqual(calls.sort(), ['AAA.NS', 'BBB.NS', 'BBB.NS'], 'AAA kept; BBB retried after failing, then kept as "no sector"');
    await u.call('GET', '/api/allocation');
    assert.equal(calls.length, 3);
  } finally {
    await t.close();
  }
});

// ---------- dividends ----------

test('dividendsReceived counts the shares held going into each ex-date', () => {
  const holdings = [{
    symbol: 'X', name: 'X Ltd', invested: 1200, lots: [
      { quantity: 10, invested: 1000, purchase_date: '2025-01-10' },
      { quantity: 2, invested: 200, purchase_date: null, created_at: Date.parse('2025-06-01T12:00:00+05:30') }, // entered 1 Jun
    ],
  }];
  const saleLots = [
    { symbol: 'X', name: 'X Ltd', quantity: 5, purchaseDate: '2024-06-01', saleDate: '2025-03-01' },
    { symbol: 'X', name: 'X Ltd', quantity: 7, purchaseDate: null, saleDate: '2025-03-01' }, // undated and sold: unknown
  ];
  const dividendsBySymbol = new Map([['X', [
    { date: '2024-05-01', amount: 1 }, // before any purchase
    { date: '2024-08-01', amount: 2 }, // the 5 later sold
    { date: '2025-02-01', amount: 3 }, // 5 + 10
    { date: '2025-03-01', amount: 4 }, // ex-date = sale date: the 5 still count
    { date: '2025-07-01', amount: 5 }, // 10 + 2
    { date: '2025-12-01', amount: 6 }, // after "today"
  ]]]);
  const r = dividendsReceived({ holdings, saleLots, dividendsBySymbol, today: '2025-11-01' });
  assert.deepEqual(r.payments.map((p) => [p.exDate, p.shares, p.amount]), [
    ['2025-07-01', 12, 60],
    ['2025-03-01', 15, 60],
    ['2025-02-01', 15, 45],
    ['2024-08-01', 5, 10],
  ]);
  assert.equal(r.total, 175);
  assert.equal(r.last12m, 165, 'ex-dates after 1 Nov 2024');
  // Yield on cost: 12 a share paid in the last 12 months (3 + 4 + 5), on the 12 shares held now, which cost 1,200.
  assert.deepEqual(r.byStock.map((s) => [s.symbol, s.total, s.last12m, s.held, s.yieldOnCostPct]), [['X', 175, 165, true, ((12 * 12) / 1200) * 100]]);
  assert.deepEqual([...dividendStart({ holdings, saleLots })], [['X', '2024-06-01']]);
});

test('dividends are fetched back to the first purchase once, then only refreshed weekly', async () => {
  const calls = [];
  const t = await setup({
    deps: {
      getDividends: async (symbol, from) => {
        calls.push({ symbol, from });
        return [{ date: d(-20), amount: 2.5 }, { date: d(-200), amount: 1 }];
      },
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: d(-100) });
    let r = (await u.call('GET', '/api/dividends')).body;
    assert.deepEqual(calls, [{ symbol: 'AAA.NS', from: d(-105) }]);
    assert.deepEqual(r.payments.map((p) => [p.exDate, p.amount]), [[d(-20), 25]], 'the older dividend was before the purchase');
    assert.equal(r.last12m, 25);
    await u.call('GET', '/api/dividends');
    assert.equal(calls.length, 1, 'already fetched');

    // An older purchase: fetched again from further back.
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 4, invested: 300, purchaseDate: d(-300), merge: true });
    r = (await u.call('GET', '/api/dividends')).body;
    assert.deepEqual(calls[1], { symbol: 'AAA.NS', from: d(-305) });
    assert.deepEqual(r.payments.map((p) => [p.exDate, p.shares]), [[d(-20), 14], [d(-200), 4]]);

    const bob = await t.login('b@example.test');
    assert.deepEqual((await bob.call('GET', '/api/dividends')).body.payments, [], 'only your own');
  } finally {
    await t.close();
  }
});
