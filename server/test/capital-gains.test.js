import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { fyOf, fyBounds, longTermFrom, termOf, rulesOn, capitalGains, openPositions } from '../src/capital-gains.js';

const round = (x) => Math.round(x * 100) / 100;

/** One sale of one purchase, with a gain of `gain` (sale value 100,000 + gain, cost 100,000). */
const lot = (saleDate, purchaseDate, gain, extra = {}) => ({
  saleId: Math.floor(Math.random() * 1e9),
  symbol: 'X.NS',
  name: 'X',
  saleDate,
  salePrice: (100_000 + gain) / 10,
  saleQuantity: 10,
  charges: 0,
  quantity: 10,
  cost: 100_000,
  purchaseDate,
  ...extra,
});

test('financial years run April to March', () => {
  assert.equal(fyOf('2026-03-31'), 2025);
  assert.equal(fyOf('2026-04-01'), 2026);
  assert.deepEqual(fyBounds(2026), { fy: 2026, from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' });
});

test('long-term means held more than 12 months', () => {
  assert.equal(longTermFrom('2025-01-10'), '2026-01-11');
  assert.equal(termOf('2025-01-10', '2026-01-10'), 'short', 'exactly 12 months is still short-term');
  assert.equal(termOf('2025-01-10', '2026-01-11'), 'long');
  assert.equal(longTermFrom('2024-02-29'), '2025-03-02');
  assert.equal(termOf(null, '2026-01-11'), 'unknown');
});

test('the rules follow the sale date', () => {
  assert.deepEqual([rulesOn('2024-07-22').stcgRate, rulesOn('2024-07-22').ltcgRate, rulesOn('2024-07-22').ltcgExemption], [15, 10, 100_000]);
  assert.deepEqual([rulesOn('2024-07-23').stcgRate, rulesOn('2024-07-23').ltcgRate, rulesOn('2024-07-23').ltcgExemption], [20, 12.5, 125_000]);
});

test('gains are split by holding period and taxed after the long-term exemption', () => {
  const lots = [
    lot('2025-06-01', '2025-01-01', 50_000), // short-term gain
    lot('2025-07-01', '2025-02-01', -10_000), // short-term loss
    lot('2025-08-01', '2023-01-01', 200_000), // long-term gain
    lot('2025-09-01', '2022-01-01', -20_000), // long-term loss
    lot('2026-04-01', '2025-01-01', 999_999), // next financial year: left out
  ];
  const r = capitalGains({ lots, fy: 2025 });
  assert.equal(r.rows.length, 4);
  assert.deepEqual([r.shortTerm.net, r.longTerm.net], [40_000, 180_000]);
  assert.deepEqual(r.exemption, { limit: 125_000, used: 125_000, left: 0 });
  assert.deepEqual(r.taxable, { shortTerm: 40_000, longTerm: 55_000 });
  assert.equal(r.tax.shortTerm, 8_000);
  assert.equal(r.tax.longTerm, 6_875);
  assert.equal(round(r.tax.cess), round((8_000 + 6_875) * 0.04));
  assert.equal(round(r.tax.total), round(14_875 * 1.04));
  assert.deepEqual(r.carriedForward, { shortTerm: 0, longTerm: 0 });
});

test('short-term losses reduce long-term gains; long-term losses only carry forward', () => {
  let r = capitalGains({ lots: [lot('2025-06-01', '2025-01-01', -30_000), lot('2025-08-01', '2023-01-01', 100_000)], fy: 2025 });
  assert.equal(r.setOff.shortTermLossAgainstLongTerm, 30_000);
  assert.deepEqual(r.exemption, { limit: 125_000, used: 70_000, left: 55_000 });
  assert.equal(r.tax.total, 0);

  r = capitalGains({ lots: [lot('2025-06-01', '2025-01-01', 10_000), lot('2025-08-01', '2023-01-01', -25_000)], fy: 2025 });
  assert.deepEqual(r.carriedForward, { shortTerm: 0, longTerm: 25_000 });
  assert.equal(r.taxable.shortTerm, 10_000, "long-term losses can't reduce short-term gains");
  assert.equal(r.tax.shortTerm, 2_000);
});

test('a year where the rates changed uses the rate on each sale date', () => {
  const r = capitalGains({ lots: [lot('2024-06-01', '2024-01-01', 10_000), lot('2024-09-01', '2024-01-01', 10_000)], fy: 2024 });
  assert.equal(r.rates.changedMidYear, true);
  assert.equal(r.rates.shortTerm, 17.5);
  assert.equal(r.tax.shortTerm, 3_500);
  assert.equal(r.exemption.limit, 125_000, 'the higher exemption applied to all of FY 2024-25');
});

test('undated purchases are listed but left out of the estimate; charges are shared by quantity', () => {
  const r = capitalGains({
    lots: [
      lot('2025-06-01', null, 5_000),
      { ...lot('2025-07-01', '2025-01-01', 0), salePrice: 1_000, saleQuantity: 30, quantity: 10, cost: 9_000, charges: 30 },
    ],
    fy: 2025,
  });
  assert.equal(r.unknown.count, 1);
  assert.equal(r.unknown.net, 5_000);
  const st = r.rows.find((x) => x.term === 'short');
  assert.equal(st.charges, 10, 'a third of the sale, a third of the charges');
  assert.equal(st.gain, 10_000 - 10 - 9_000);
  assert.equal(r.taxable.shortTerm, 990);
});

test('openPositions splits unrealised gains and lists purchases turning long-term soon', () => {
  const today = '2026-11-17';
  const holdings = [
    { symbol: 'A', name: 'A', lots: [
      { quantity: 10, invested: 1_000, purchase_date: '2025-01-01' }, // long-term already
      { quantity: 10, invested: 1_000, purchase_date: '2025-12-01' }, // long-term from 2026-12-02: in 15 days
    ] },
    { symbol: 'B', name: 'B', quantity: 5, invested: 500, purchase_date: null }, // undated
    { symbol: 'C', name: 'C', lots: [{ quantity: 1, invested: 100, purchase_date: '2026-10-01' }] }, // a year away
  ];
  const r = openPositions({ holdings, latestBySymbol: new Map([['A', 150], ['B', 90], ['C', 120]]), today });
  assert.equal(r.unrealised.longTerm.net, 500);
  assert.equal(r.unrealised.shortTerm.net, 500 + 20);
  assert.equal(r.unrealised.unknown.net, -50);
  assert.deepEqual(r.turningLongTerm.map((l) => [l.symbol, l.longTermOn, l.daysToLongTerm, l.gain]), [['A', '2026-12-02', 15, 500]]);
});

// ---------- end to end ----------

test('the capital gains endpoint: this year\'s sales, the estimate, and what is still held', async () => {
  const t = await setup({ prices: { 'AAA.NS': 200, 'BBB.NS': 50 } });
  try {
    const today = istDate();
    const d = (n) => addDays(today, n);
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1_000, purchaseDate: d(-400) });
    const id = (await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1_200, purchaseDate: d(-100), merge: true })).body.id;
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 2, invested: 80, purchaseDate: longTermStart(d, 20) });
    // Sell 15: all 10 of the older purchase (long-term) and 5 of the newer one (short-term); charges split 2:1.
    assert.equal((await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 15, salePrice: 200, charges: 30, saleDate: d(-1) })).status, 200);

    // Today's prices (AAA 200, BBB 50) are stored by the poll.
    await t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });

    const fy = fyOf(d(-1));
    const r = (await u.call('GET', `/api/capital-gains?fy=${fy}`)).body;
    assert.equal(r.fy, fy);
    assert.ok(r.years.includes(fy));
    const long = r.rows.find((x) => x.term === 'long');
    const short = r.rows.find((x) => x.term === 'short');
    assert.deepEqual([long.quantity, round(long.charges), round(long.gain)], [10, 20, 2_000 - 20 - 1_000]);
    assert.deepEqual([short.quantity, round(short.charges), round(short.gain)], [5, 10, 1_000 - 10 - 600]);
    assert.equal(round(r.exemption.used), 980);
    assert.equal(round(r.tax.total), round(390 * 0.2 * 1.04));

    if (r.current) {
      // Still held: 5 short-term AAA shares, and BBB, which turns long-term in 20 days.
      assert.equal(round(r.open.unrealised.shortTerm.net), round(5 * 200 - 600 + (2 * 50 - 80)));
      assert.deepEqual(r.open.turningLongTerm.map((l) => [l.symbol, l.daysToLongTerm]), [['BBB.NS', 20]]);
    }

    assert.equal((await u.call('GET', `/api/capital-gains?fy=${fy - 1}`)).body.rows.length, 0);
    assert.equal((await u.call('GET', '/api/capital-gains?fy=1999')).status, 400);
    assert.equal((await u.call('GET', `/api/capital-gains?fy=${fyOf(today) + 1}`)).status, 400, 'not a future year');

    const bob = await t.login('b@example.test');
    assert.deepEqual((await bob.call('GET', `/api/capital-gains?fy=${fy}`)).body.rows, [], "only your own sales");
  } finally {
    await t.close();
  }
});

/** A purchase date that turns long-term `days` from today. */
function longTermStart(d, days) {
  // Long-term starts a year and a day after purchase, so buy a year (and a day) before the target date.
  const target = d(days);
  const [y, m, day] = target.split('-').map(Number);
  return addDays(new Date(Date.UTC(y - 1, m - 1, day)).toISOString().slice(0, 10), -1);
}
