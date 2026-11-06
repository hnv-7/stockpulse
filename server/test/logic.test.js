import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, portfolioHistory, pctChange, referencePrice } from '../src/analytics.js';
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
