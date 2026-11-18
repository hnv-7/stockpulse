import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { summarize, basket, breadth, createMarkets, SECTORS, INDICES } from '../src/markets.js';

const series = (pairs) => pairs.map(([date, close]) => ({ date, close }));
const round = (x, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
const SESSION = '2026-11-18';

// ---------- pure ----------

test('summarize: today against the previous close, longer periods against the close that many days back', () => {
  const closes = series([['2026-08-19', 80], ['2026-10-17', 90], ['2026-11-10', 95], ['2026-11-11', 96], ['2026-11-17', 99], ['2026-11-18', 1]]);
  const s = summarize({ price: 100, prevClose: 98 }, closes, SESSION);
  assert.equal(round(s.changes['1d']), round((100 / 98 - 1) * 100), 'the quote\'s previous close, not the series');
  assert.equal(round(s.changes['1w']), round((100 / 96 - 1) * 100), '11 Nov is exactly a week back');
  assert.equal(round(s.changes['1m']), round((100 / 90 - 1) * 100), 'no close on 19 Oct: the last one before it');
  assert.equal(round(s.changes['3m']), round((100 / 80 - 1) * 100));
  assert.deepEqual(s.since, { '1w': '2026-11-11', '1m': '2026-10-17', '3m': '2026-08-19' });
  assert.deepEqual(s.points.at(-1), { date: SESSION, close: 100 }, "today's bar is replaced by the live price");
  assert.equal(s.points.length, 6, 'the 1 placeholder for today is gone; the 3-month reference close is kept');
});

test('summarize: periods the history does not reach are null, and a missing previous close falls back to the series', () => {
  const s = summarize({ price: 110, prevClose: null }, series([['2026-11-14', 100], ['2026-11-17', 100]]), SESSION);
  assert.equal(round(s.changes['1d']), 10);
  assert.equal(s.changes['1w'], null);
  assert.equal(s.changes['3m'], null);
  assert.equal(summarize({ price: 1, prevClose: null }, [], SESSION).changes['1d'], null);
});

test('basket: an equal-weighted average of the stocks, each against its own first close', () => {
  const b = basket(
    [{ price: 220 }, { price: 45 }, undefined],
    [series([['2026-11-13', 200], ['2026-11-17', 210]]), series([['2026-11-12', 60], ['2026-11-13', 50], ['2026-11-17', 40]]), series([['2026-11-13', 1], ['2026-11-17', 2]])],
    SESSION,
  );
  // Starts on 13 Nov, the first day both quoted stocks have a close; the unquoted third is left out.
  assert.deepEqual(b.series.map((p) => [p.date, round(p.close)]), [['2026-11-13', 100], ['2026-11-17', round(((210 / 200 + 40 / 50) / 2) * 100)]]);
  assert.equal(round(b.quote.price), round(((220 / 200 + 45 / 50) / 2) * 100));
  assert.equal(basket([{ price: 1 }], [[]], SESSION), null, 'no history at all');
});

test('breadth counts moves against the previous close', () => {
  assert.deepEqual(breadth([{ price: 2, prevClose: 1 }, { price: 1, prevClose: 2 }, { price: 1, prevClose: 1 }, { price: 1, prevClose: null }, null]), { up: 1, down: 1, flat: 1 });
});

// ---------- fake market ----------

const DAYS = Array.from({ length: 100 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 18) - (99 - i) * 86_400_000);
  return d.toISOString().slice(0, 10);
});
const NOW = Date.UTC(2026, 10, 18, 6, 0); // 11:30 IST
/** Every symbol at 100 today; each one's history rises steadily to 90 yesterday from `start`, unless set otherwise. */
function fakeMarket({ quotes = {}, noHistory = [], failQuotes = false } = {}) {
  const calls = { quote: 0, history: [] };
  return {
    calls,
    quoteBatch: async (symbols) => {
      calls.quote++;
      if (failQuotes) throw new Error('yahoo down');
      return new Map(symbols.map((s) => [s, { symbol: s, price: 100, prevClose: 98, high52: 125, marketTime: NOW, ...quotes[s] }]));
    },
    dailyHistory: async (symbol) => {
      calls.history.push(symbol);
      if (noHistory.includes(symbol)) return [{ date: '2026-11-18', close: 100 }];
      return DAYS.slice(0, -1).map((date, i) => ({ date, close: 50 + (40 * i) / 98 }));
    },
  };
}

test('overview: indices, sectors and today\'s biggest movers from one quote request, cached', async () => {
  const fake = fakeMarket({ quotes: { 'CIPLA.NS': { price: 110, prevClose: 100 }, 'TITAN.NS': { price: 90, prevClose: 100 } } });
  let now = NOW;
  const m = createMarkets({ quoteBatch: fake.quoteBatch, dailyHistory: fake.dailyHistory, now: () => now });
  const o = await m.overview();
  assert.equal(o.session, '2026-11-18');
  assert.deepEqual(o.indices.map((i) => i.name), INDICES.map((i) => i.name));
  assert.equal(o.sectors.length, SECTORS.length);
  assert.ok(o.sectors.every((s) => s.basis === 'index' && s.points.length > 50));
  assert.equal(o.movers.gainers[0].symbol, 'CIPLA.NS');
  assert.equal(o.movers.gainers[0].sector, 'Pharma');
  assert.equal(o.movers.losers[0].symbol, 'TITAN.NS');
  assert.equal(o.movers.gainers.length, 5);
  assert.equal(o.breadth.of, new Set(SECTORS.flatMap((s) => s.stocks.map((x) => x.symbol))).size);
  assert.equal(fake.calls.quote, 1);
  const histories = fake.calls.history.length;

  now += 30_000;
  await m.overview();
  assert.equal(fake.calls.quote, 1, 'quotes are cached for a minute');
  now += 60_000;
  await m.overview();
  assert.equal(fake.calls.quote, 2);
  assert.equal(fake.calls.history.length, histories, 'histories are cached for longer');
});

test('overview: a sector index without history at Yahoo is measured by its popular stocks instead', async () => {
  const media = SECTORS.find((s) => s.key === 'media');
  const fake = fakeMarket({ noHistory: [media.index] });
  const m = createMarkets({ quoteBatch: fake.quoteBatch, dailyHistory: fake.dailyHistory, now: () => NOW });
  const o = await m.overview();
  const row = o.sectors.find((s) => s.key === 'media');
  assert.equal(row.basis, 'stocks');
  assert.equal(round(row.changes['1d']), round((100 / 98 - 1) * 100), "today is still the index's own move");
  assert.ok(row.changes['1w'] > 0 && row.points.length > 50);
  assert.ok(media.stocks.every((s) => fake.calls.history.includes(s.symbol)));
  assert.equal(o.sectors.find((s) => s.key === 'it').basis, 'index');
});

test('sector: popular stocks with their changes, distance from the 52-week high, and unknown sectors', async () => {
  const fake = fakeMarket({ quotes: { 'INFY.NS': { high52: 99 } } });
  const m = createMarkets({ quoteBatch: fake.quoteBatch, dailyHistory: fake.dailyHistory, now: () => NOW });
  const it = await m.sector('it');
  assert.equal(it.indexName, 'Nifty IT');
  assert.equal(it.stocks.length, 6);
  assert.equal(it.stocks.find((s) => s.symbol === 'TCS.NS').fromHighPct, -20);
  assert.equal(it.stocks.find((s) => s.symbol === 'INFY.NS').fromHighPct, 0, 'a stale 52-week high below the price counts as at the high');
  assert.equal(await m.sector('nope'), undefined);
});

// ---------- API ----------

test('markets API: signed-in only, marks stocks you hold or watch, 404 for an unknown sector, 503 when Yahoo is down', async () => {
  const fake = fakeMarket({ quotes: { 'CIPLA.NS': { price: 110, prevClose: 100 }, 'SUNTV.NS': { price: 108, prevClose: 100 } } });
  const t = await setup({ prices: { 'CIPLA.NS': 110, 'SUNTV.NS': 108 }, deps: { getQuoteBatch: fake.quoteBatch, getMarketHistory: fake.dailyHistory } });
  try {
    assert.equal((await t.anon('GET', '/api/markets')).status, 401);
    const u = await t.login('m@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'CIPLA.NS', quantity: 1, invested: 100 });
    await u.call('POST', '/api/watchlist', { symbol: 'SUNTV.NS' });

    const r = await u.call('GET', '/api/markets');
    assert.equal(r.status, 200);
    const [first, second] = r.body.movers.gainers;
    assert.deepEqual([first.symbol, first.held, first.watching], ['CIPLA.NS', true, false]);
    assert.deepEqual([second.symbol, second.held, second.watching], ['SUNTV.NS', false, true]);

    const s = await u.call('GET', '/api/markets/sectors/pharma');
    assert.equal(s.status, 200);
    assert.equal(s.body.stocks.find((x) => x.symbol === 'CIPLA.NS').held, true);
    assert.equal((await u.call('GET', '/api/markets/sectors/nope')).status, 404);
    assert.equal((await u.call('GET', '/api/markets/sectors/..%2Fx')).status, 400);
  } finally {
    await t.close();
  }

  const down = fakeMarket({ failQuotes: true });
  const t2 = await setup({ deps: { getQuoteBatch: down.quoteBatch, getMarketHistory: down.dailyHistory } });
  try {
    const u = await t2.login('d@example.test');
    const r = await u.call('GET', '/api/markets');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /isn't available/);
    assert.equal((await u.call('GET', '/api/markets/sectors/it')).status, 503);
  } finally {
    await t2.close();
  }
});
