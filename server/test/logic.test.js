import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, portfolioHistory, pctChange, referencePrice, xirr, daysBetween } from '../src/analytics.js';
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
