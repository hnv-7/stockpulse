import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, portfolioHistory, pctChange, referencePrice, xirr, xirrFlows, daysBetween } from '../src/analytics.js';
import { addDays } from '../src/dates.js';
import { evaluateRules } from '../src/alerts.js';

const TODAY = '2026-11-06';
const series = (pairs) => pairs.map(([date, close]) => ({ date, close }));

test('pctChange handles bad bases', () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(90, 100), -10);
  assert.equal(pctChange(100, 0), null);
  assert.equal(pctChange(null, 100), null);
});

test('referencePrice: 1d uses previous trading day, 1w uses close on/before 7d ago', () => {
  const s = series([
    ['2026-10-29', 100], // Thursday a week back
    ['2026-10-30', 101],
    ['2026-11-04', 110],
    ['2026-11-05', 120],
    ['2026-11-06', 118],
  ]);
  assert.equal(referencePrice(s, TODAY, '1d').close, 120);
  assert.equal(referencePrice(s, TODAY, '1w').close, 101); // exact match on 10-30
  assert.equal(referencePrice(s, '2026-11-05', '1w').close, 100); // target 10-29
  // target date with no trading day falls back to the earlier close
  assert.equal(referencePrice(s, '2026-11-08', '1w').close, 101);
});

test('buildReport flags draggers, laggards and buy-the-dip candidates', () => {
  const holdings = [
    { symbol: 'WIN', name: 'Winner', quantity: 10, invested: 1000 }, // now 2000, up on month
    { symbol: 'DIP', name: 'Dipper', quantity: 10, invested: 1000 }, // now 1200, was 1500 a month ago
    { symbol: 'BAD', name: 'Bad', quantity: 10, invested: 1000 }, // now 800, in loss
  ];
  const seriesBySymbol = new Map([
    ['WIN', series([['2026-10-06', 180], ['2026-11-06', 200]])],
    ['DIP', series([['2026-10-06', 150], ['2026-11-06', 120]])],
    ['BAD', series([['2026-10-06', 90], ['2026-11-06', 80]])],
  ]);
  const latestBySymbol = new Map([['WIN', 200], ['DIP', 120], ['BAD', 80]]);
  const r = buildReport({ holdings, seriesBySymbol, latestBySymbol, today: TODAY, period: '1m' });

  assert.equal(r.totals.invested, 3000);
  assert.equal(r.totals.value, 4000);
  assert.equal(r.totals.pnl, 1000);
  // month ago total: 1800 + 1500 + 900 = 4200 -> now 4000
  assert.equal(r.totals.changeValue, -200);

  assert.deepEqual(r.draggers.map((x) => x.symbol), ['DIP', 'BAD']);
  // DIP still profitable (+20%) but fell 20% in the month -> opportunity; BAD is a loss -> not a "dip"
  assert.deepEqual(r.dips.map((x) => x.symbol), ['DIP']);
  // portfolio pnl% = 33.3%; DIP (20%) and BAD (-20%) trail it
  assert.deepEqual(r.laggards.map((x) => x.symbol), ['BAD', 'DIP']);
  const dip = r.holdings.find((x) => x.symbol === 'DIP');
  assert.ok(dip.contributionPct < 0);
  assert.equal(Math.round(dip.periodChangePct), -20);
});

test('buildReport tolerates a stock with no data', () => {
  const holdings = [{ symbol: 'X', name: 'X', quantity: 1, invested: 100 }];
  const r = buildReport({
    holdings,
    seriesBySymbol: new Map([['X', []]]),
    latestBySymbol: new Map(),
    today: TODAY,
    period: '1w',
  });
  assert.equal(r.holdings[0].price, null);
  assert.equal(r.totals.changePct, null);
  assert.deepEqual(r.draggers, []);
});

test('xirr matches hand-computed annualised rates', () => {
  const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
  near(xirr([{ invested: 1000, days: 365 }], 2000), 1);          // doubled in a year = 100%
  near(xirr([{ invested: 1000, days: 730 }], 1210), 0.1);        // 10% a year for two years
  near(xirr([{ invested: 1000, days: 365 }, { invested: 1000, days: 0 }], 2100), 0.1); // two lots
  near(xirr([{ invested: 1000, days: 365 }], 800), -0.2);        // a loss gives a negative rate
  near(xirr([{ invested: 1000, days: 100 }], 1000), 0);          // flat = 0%
  assert.equal(xirr([{ invested: 1000, days: 0 }], 1100), null, 'bought today: no rate yet');
  assert.equal(xirr([{ invested: 1000, days: 10 }], 0), null);
  assert.equal(xirr([{ invested: 0, days: 10 }], 5), null);
  assert.equal(xirr([], 5), null);
});

test('daysBetween counts calendar days', () => {
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2); // leap year
  assert.equal(daysBetween('2025-11-06', '2026-11-06'), 365);
  assert.equal(daysBetween('2026-11-06', '2026-11-06'), 0);
});

test('buildReport: per-stock and portfolio XIRR use purchase dates, undated holdings are left out and counted', () => {
  const holdings = [
    { symbol: 'A', name: 'A', quantity: 10, invested: 1000, purchase_date: '2025-11-06' }, // 365 days, worth 2000
    { symbol: 'B', name: 'B', quantity: 10, invested: 1000, purchase_date: '2026-11-06' }, // bought today
    { symbol: 'C', name: 'C', quantity: 10, invested: 3000, purchase_date: null },         // undated
  ];
  const r = buildReport({
    holdings,
    seriesBySymbol: new Map([['A', []], ['B', []], ['C', []]]),
    latestBySymbol: new Map([['A', 200], ['B', 100], ['C', 300]]),
    today: TODAY,
    period: '1w',
  });
  const by = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));
  assert.ok(Math.abs(by.A.xirrPct - 100) < 1e-4);
  assert.equal(by.A.daysHeld, 365);
  assert.equal(by.B.xirrPct, null);
  assert.equal(by.C.xirrPct, null);
  assert.equal(by.C.daysHeld, null);
  // Dated holdings only: 1000 for 365 days + 1000 today, now worth 2000 + 1000 -> 1000(1+r)+1000 = 3000 -> r = 100%
  assert.ok(Math.abs(r.totals.xirrPct - 100) < 1e-4);
  assert.equal(r.totals.xirrCoverage.holdings, 2);
  assert.equal(r.totals.xirrCoverage.of, 3);
  assert.ok(Math.abs(r.totals.xirrCoverage.investedPct - 40) < 1e-9);
});


test('buildReport: XIRR uses one cash flow per purchase, and any undated purchase leaves the stock out', () => {
  const run = (lots) =>
    buildReport({
      holdings: [{ symbol: 'A', name: 'A', quantity: 20, invested: 2000, purchase_date: '2025-11-06', lots }],
      seriesBySymbol: new Map([['A', []]]),
      latestBySymbol: new Map([['A', 150]]), // worth 3000
      today: TODAY,
      period: '1w',
    });
  // 1000 held 365 days + 1000 held 0 days, now 3000: 1000(1+r)+1000 = 3000 -> r = 100% (a single flow of 2000 would be 50%)
  const two = run([
    { invested: 1000, purchase_date: '2025-11-06' },
    { invested: 1000, purchase_date: TODAY },
  ]);
  assert.ok(Math.abs(two.holdings[0].xirrPct - 100) < 1e-4);
  assert.equal(two.holdings[0].purchases, 2);
  assert.ok(Math.abs(two.totals.xirrPct - 100) < 1e-4);

  const undated = run([{ invested: 1000, purchase_date: '2025-11-06' }, { invested: 1000, purchase_date: null }]);
  assert.equal(undated.holdings[0].xirrPct, null);
  assert.equal(undated.holdings[0].daysHeld, null);
  assert.equal(undated.totals.xirrCoverage.holdings, 0);
});

test('buildReport: no dated holdings means no XIRR rather than a made-up number', () => {
  const r = buildReport({
    holdings: [{ symbol: 'A', name: 'A', quantity: 1, invested: 100 }],
    seriesBySymbol: new Map([['A', []]]),
    latestBySymbol: new Map([['A', 150]]),
    today: TODAY,
    period: '1w',
  });
  assert.equal(r.totals.xirrPct, null);
  assert.equal(r.totals.xirrCoverage.holdings, 0);
});

test('xirrFlows handles money taken out along the way', () => {
  // 1000 in two years ago, 600 out a year ago, 750 worth today: 1000x^2 - 600x - 750 = 0 with x = 1 + r.
  const x = (600 + Math.sqrt(600 ** 2 + 4 * 1000 * 750)) / 2000;
  const r = xirrFlows([{ amount: -1000, days: 730 }, { amount: 600, days: 365 }, { amount: 750, days: 0 }]);
  assert.ok(Math.abs(r - (x - 1)) < 1e-9, `${r} vs ${x - 1}`);
  assert.equal(xirrFlows([{ amount: -1000, days: 365 }]), null, 'nothing came back');
  assert.equal(xirrFlows([{ amount: 1000, days: 365 }]), null, 'nothing went in');
  assert.equal(xirrFlows([{ amount: -1000, days: 0 }, { amount: 1100, days: 0 }]), null, 'no time has passed');
});

test('portfolio XIRR counts sales, so selling a winner no longer pulls it down', () => {
  const d = (n) => addDays(TODAY, n);
  // 10 shares at 100 two years ago, 10 more at 200 a year ago; the first 10 sold at 210 six months ago; 220 now.
  const holdings = [{ symbol: 'A', name: 'A', quantity: 10, invested: 2000, lots: [{ quantity: 10, invested: 2000, purchase_date: d(-365) }] }];
  const sales = [
    { saleId: 1, symbol: 'A', saleDate: d(-182), received: 2100, lots: [{ invested: 1000, purchase_date: d(-730) }] },
    { saleId: 2, symbol: 'A', saleDate: d(-100), received: 500, lots: [{ invested: 400, purchase_date: null }] }, // undated: left out
  ];
  const args = { holdings, seriesBySymbol: new Map([['A', []]]), latestBySymbol: new Map([['A', 220]]), today: TODAY, period: '1w' };
  const before = buildReport(args).totals.xirrPct; // what it used to be: the shares still held only
  const r = buildReport({ ...args, sales });
  const expected = xirrFlows([
    { amount: -2000, days: 365 },
    { amount: -1000, days: 730 },
    { amount: 2100, days: 182 },
    { amount: 2200, days: 0 },
  ]) * 100;
  assert.ok(Math.abs(r.totals.xirrPct - expected) < 1e-9);
  assert.ok(Math.abs(before - 10) < 1e-6, 'held shares alone: 2000 to 2200 in a year');
  assert.ok(r.totals.xirrPct > before, `${r.totals.xirrPct} should beat ${before}`);
  assert.deepEqual(r.totals.xirrCoverage, { holdings: 1, of: 1, investedPct: 100, sales: 1, salesOf: 2 });

  // Everything sold: the rate still comes from the sales.
  const sold = buildReport({ ...args, holdings: [], sales: sales.slice(0, 1) });
  const soldExpected = xirrFlows([{ amount: -1000, days: 730 }, { amount: 2100, days: 182 }]) * 100;
  assert.ok(Math.abs(sold.totals.xirrPct - soldExpected) < 1e-9);
});

test('portfolioHistory forward-fills and skips days before all stocks have data', () => {
  const holdings = [
    { symbol: 'A', quantity: 1, invested: 10 },
    { symbol: 'B', quantity: 2, invested: 10 },
  ];
  const seriesBySymbol = new Map([
    ['A', series([['2026-11-01', 10], ['2026-11-02', 11], ['2026-11-03', 12]])],
    ['B', series([['2026-11-02', 5], ['2026-11-03', 6]])],
  ]);
  const h = portfolioHistory({ holdings, seriesBySymbol, fromDate: '2026-11-01' });
  assert.deepEqual(h.map((p) => [p.date, p.value]), [['2026-11-02', 21], ['2026-11-03', 24]]);
});

test('portfolioHistory counts each purchase from its date and sold shares until their sale date', () => {
  const seriesBySymbol = new Map([
    ['A', series([['2026-11-01', 10], ['2026-11-02', 11], ['2026-11-03', 12], ['2026-11-04', 13]])],
    ['B', series([['2026-11-01', 5], ['2026-11-03', 6]])], // no close on the 2nd or 4th: carried forward
  ]);
  const holdings = [
    // A: one purchase before the range and one inside it.
    { symbol: 'A', quantity: 3, invested: 33, lots: [
      { quantity: 1, invested: 9, purchase_date: '2026-10-20' },
      { quantity: 2, invested: 24, purchase_date: '2026-11-03' },
    ] },
  ];
  // B was held from before the range and fully sold on the 3rd.
  const soldLots = [
    { symbol: 'B', quantity: 4, invested: 16, purchase_date: '2026-10-01', sale_date: '2026-11-03' },
    { symbol: 'B', quantity: 9, invested: 99, purchase_date: '2026-10-01', sale_date: '2026-10-31' }, // before the range
  ];
  const h = portfolioHistory({ holdings, soldLots, seriesBySymbol, fromDate: '2026-11-01' });
  assert.deepEqual(h, [
    { date: '2026-11-01', value: 1 * 10 + 4 * 5, invested: 9 + 16 },
    { date: '2026-11-02', value: 1 * 11 + 4 * 5, invested: 9 + 16 },
    { date: '2026-11-03', value: 3 * 12, invested: 33 }, // bought 2 more A, sold all of B
    { date: '2026-11-04', value: 3 * 13, invested: 33 },
  ]);
});

test('portfolioHistory starts at the first purchase in the range and shows zero once everything is sold', () => {
  const seriesBySymbol = new Map([['A', series([['2026-11-01', 10], ['2026-11-02', 11], ['2026-11-03', 12]])]]);
  const soldLots = [{ symbol: 'A', quantity: 2, invested: 20, purchase_date: '2026-11-02', sale_date: '2026-11-03' }];
  const h = portfolioHistory({ holdings: [], soldLots, seriesBySymbol, fromDate: '2026-11-01' });
  assert.deepEqual(h, [
    { date: '2026-11-02', value: 22, invested: 20 },
    { date: '2026-11-03', value: 0, invested: 0 },
  ]);
});

test('portfolioHistory leaves out a stock with no prices instead of blanking the chart', () => {
  const seriesBySymbol = new Map([['A', series([['2026-11-01', 10], ['2026-11-02', 11]])], ['GONE', []]]);
  const holdings = [{ symbol: 'A', quantity: 1, invested: 10 }];
  const soldLots = [{ symbol: 'GONE', quantity: 5, invested: 50, purchase_date: null, sale_date: '2026-11-05' }];
  const h = portfolioHistory({ holdings, soldLots, seriesBySymbol, fromDate: '2026-11-01' });
  assert.deepEqual(h.map((p) => [p.date, p.value, p.invested]), [['2026-11-01', 10, 10], ['2026-11-02', 11, 10]]);
});

test('evaluateRules fires only when the drop meets the threshold', () => {
  const holdings = [
    { symbol: 'A', quantity: 1, invested: 100 },
    { symbol: 'B', quantity: 1, invested: 100 },
  ];
  const seriesBySymbol = new Map([
    ['A', series([['2026-10-30', 100], ['2026-11-05', 100]])],
    ['B', series([['2026-10-30', 100], ['2026-11-05', 100]])],
  ]);
  const latestBySymbol = new Map([['A', 94], ['B', 98]]);
  const rules = [
    { id: 1, symbol: null, window: '1d', threshold_pct: 5, enabled: true },
    { id: 2, symbol: 'B', window: '1w', threshold_pct: 1, enabled: true },
    { id: 3, symbol: 'A', window: '1d', threshold_pct: 1, enabled: false },
  ];
  const hits = evaluateRules({ rules, holdings, seriesBySymbol, latestBySymbol, today: TODAY });
  assert.deepEqual(
    hits.map((h) => [h.rule.id, h.holding.symbol]),
    [[1, 'A'], [2, 'B']],
  );
  assert.match(hits[0].message, /A is down 6\.00%/);
});

test('high52 rule measures drop from the trailing-year high', () => {
  const holdings = [{ symbol: 'A', quantity: 1, invested: 100 }];
  const seriesBySymbol = new Map([['A', series([['2026-03-01', 200], ['2026-11-05', 150]])]]);
  const hits = evaluateRules({
    rules: [{ id: 1, symbol: 'A', window: 'high52', threshold_pct: 20, enabled: true }],
    holdings,
    seriesBySymbol,
    latestBySymbol: new Map([['A', 150]]),
    today: TODAY,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].dropPct, 25);
});
