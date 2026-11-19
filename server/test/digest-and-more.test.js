import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { composeDigest } from '../src/digest.js';
import { upcomingEvents } from '../src/events.js';
import { rebalance } from '../src/income.js';
import { dbRateLimitStore } from '../src/http.js';
import { parseBhavcopy, unzipFirst } from '../src/nse.js';

const cron = (t, path) => t.anon('GET', path, { headers: { authorization: 'Bearer test-cron-secret-value' } });

test('upcoming events: results and ex-dividend dates inside the window, soonest first', () => {
  const today = '2026-11-19';
  const items = upcomingEvents({
    eventsBySymbol: new Map([
      ['A.NS', { earningsDate: '2027-01-13', earningsEstimate: true, exDividendDate: '2026-11-03' }],
      ['B.NS', { earningsDate: '2026-11-25', earningsEstimate: false, exDividendDate: '2026-11-21' }],
      ['C.NS', { earningsDate: '2026-11-19', earningsEstimate: false, exDividendDate: null }],
    ]),
    names: new Map([['A.NS', 'A Ltd'], ['B.NS', 'B Ltd']]),
    held: new Set(['B.NS']),
    watched: new Set(['C.NS']),
    today,
    days: 10,
  });
  assert.deepEqual(items.map((e) => [e.symbol, e.type, e.date]), [
    ['C.NS', 'results', '2026-11-19'],
    ['B.NS', 'exDividend', '2026-11-21'],
    ['B.NS', 'results', '2026-11-25'],
  ]);
  assert.deepEqual([items[0].held, items[0].watching, items[1].held], [false, true, true]);
});

test('the weekly summary text', () => {
  const holdings = [
    { symbol: 'A.NS', periodChangePct: 4.2 },
    { symbol: 'B.NS', periodChangePct: -2.5 },
    { symbol: 'MF:122639', periodChangePct: 1 },
    { symbol: 'C.NS', periodChangePct: null },
  ];
  const report = { holdings, totals: { value: 123_456, changeValue: 1_234, changePct: 1.01, pnl: 23_456, pnlPct: 23.46, invested: 100_000 } };
  const d = composeDigest({
    report,
    indexPct: 0.5,
    alerts: 2,
    events: [{ symbol: 'A.NS', type: 'results', date: '2026-11-25', estimate: true }],
    today: '2026-11-20',
  });
  assert.equal(d.subject, 'Stock Beat weekly: +1.01% this week');
  assert.match(d.text, /Portfolio ₹1,23,456: \+₹1,234 \(\+1\.01%\) this week\./);
  assert.match(d.text, /Nifty 50 \+0\.50%, so you were 0\.51 points ahead\./);
  assert.match(d.text, /Up most: A \+4\.20%, MF:122639 \+1\.00%/);
  assert.match(d.text, /Down most: B −2\.50%/);
  assert.match(d.text, /2 alerts fired this week\./);
  assert.match(d.text, /• A results \(expected\) 25 Nov/);
  assert.equal(composeDigest({ report: { holdings: [], totals: {} }, today: '2026-11-20' }), null);
});

test('the digest goes once a day to users who turned it on, in the app and by their alert channels', async () => {
  const t = await setup({
    deps: { getEvents: async () => ({ earningsDate: addDays(istDate(), 3), earningsEstimate: false, exDividendDate: null }) },
  });
  try {
    const u = await t.login('a@example.test');
    const quiet = await t.login('b@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1_000 });
    await quiet.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await cron(t, '/api/cron/poll');

    const on = await u.call('PUT', '/api/me/settings', { weeklyDigest: true, alertEmail: true });
    assert.deepEqual([on.body.weeklyDigest, on.body.alertEmail], [true, true]);
    assert.equal((await u.call('PUT', '/api/me/settings', {})).status, 400);
    assert.equal((await u.call('GET', '/api/me')).body.user.weeklyDigest, true);

    assert.equal((await t.anon('GET', '/api/cron/digest')).status, 401);
    const first = await cron(t, '/api/cron/digest');
    assert.deepEqual(first.body, { users: 1, sent: 1 });
    const mail = t.sent.find((m) => m.subject?.startsWith('Stock Beat weekly'));
    assert.equal(mail.to, 'a@example.test');
    assert.match(mail.text, /AAA results/);
    assert.ok((await u.call('GET', '/api/notifications')).body.items.some((n) => n.message.startsWith('Your week')));
    assert.equal((await quiet.call('GET', '/api/notifications')).body.items.length, 0, 'not for users who did not ask');
    assert.deepEqual((await cron(t, '/api/cron/digest')).body, { users: 0, sent: 0 }, 'not twice on the same day');
  } finally {
    await t.close();
  }
});

test('the events endpoint covers holdings and the watchlist, and skips funds', async () => {
  const asked = [];
  const t = await setup({
    prices: { 'AAA.NS': 100, 'BBB.NS': 50 },
    deps: {
      getEvents: async (s) => {
        asked.push(s);
        return { earningsDate: addDays(istDate(), 5), earningsEstimate: true, exDividendDate: null };
      },
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await u.call('POST', '/api/watchlist', { symbol: 'BBB.NS' });
    const r = (await u.call('GET', '/api/events')).body;
    assert.deepEqual(r.items.map((e) => [e.symbol, e.type, e.held, e.watching]), [['AAA.NS', 'results', true, false], ['BBB.NS', 'results', false, true]]);
    assert.equal(r.pending, 0);
    await u.call('GET', '/api/events');
    assert.equal(asked.length, 2, 'looked up once, then read from the database');
  } finally {
    await t.close();
  }
});

test('rebalancing: how far each sector is from target, and buy/sell amounts', () => {
  const alloc = {
    total: 100_000,
    sectors: [
      { sector: 'Technology', value: 60_000, weightPct: 60 },
      { sector: null, value: 40_000, weightPct: 40 },
    ],
  };
  const r = rebalance(alloc, [{ sector: 'Technology', pct: 50 }, { sector: 'Healthcare', pct: 30 }, { sector: 'Sector not known', pct: 20 }]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.rows.map((x) => [x.sector, Math.round(x.amount)]), [['Technology', -10_000], ['Healthcare', 30_000], ['Sector not known', -20_000]]);
  assert.equal(rebalance(alloc, [{ sector: 'Technology', pct: 50 }]).complete, false);
});

test('allocation targets are saved per portfolio and validated', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    assert.equal((await u.call('PUT', '/api/allocation/targets', { targets: [{ sector: 'Technology', pct: 70 }, { sector: 'Energy', pct: 40 }] })).status, 400);
    assert.equal((await u.call('PUT', '/api/allocation/targets', { targets: [{ sector: 'Energy', pct: 50 }, { sector: 'Energy', pct: 10 }] })).status, 400);
    const ok = await u.call('PUT', '/api/allocation/targets', { targets: [{ sector: 'Technology', pct: 60 }, { sector: 'Energy', pct: 40 }] });
    assert.deepEqual(ok.body.targets, [{ sector: 'Technology', pct: 60 }, { sector: 'Energy', pct: 40 }]);
    const fam = (await u.call('POST', '/api/portfolios', { name: 'Family' })).body.id;
    assert.deepEqual((await u.call('GET', `/api/allocation?portfolio=${fam}`)).body.targets, [], 'each portfolio has its own');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    const all = (await u.call('GET', '/api/allocation')).body;
    assert.equal(all.targets.length, 2);
    assert.equal(all.rebalance.complete, true);
  } finally {
    await t.close();
  }
});

test('rate limits are counted in the database, so every server instance shares them, and no addresses are stored', async () => {
  const t = await setup();
  try {
    // Two limiter stores with the same name, as on two server instances.
    const a = dbRateLimitStore(t.store, 'search');
    const b = dbRateLimitStore(t.store, 'search');
    a.init({ windowMs: 60_000 });
    b.init({ windowMs: 60_000 });
    assert.equal((await a.increment('203.0.113.9')).totalHits, 1);
    assert.equal((await b.increment('203.0.113.9')).totalHits, 2);
    await b.decrement('203.0.113.9');
    assert.equal((await a.increment('203.0.113.9')).totalHits, 2);
    const keys = (await t.db.query('SELECT key FROM rate_limits')).rows.map((r) => r.key);
    assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k)), 'hashed keys only');

    const u = await t.login('a@example.test');
    let last;
    for (let i = 0; i < 31; i++) last = await u.call('GET', '/api/search?q=aaa');
    assert.equal(last.status, 429);
    await t.store.pruneRateLimits(Date.now() + 16 * 60_000);
    assert.equal((await t.db.query('SELECT COUNT(*)::int AS c FROM rate_limits')).rows[0].c, 0);
  } finally {
    await t.close();
  }
});

/** A one-file zip archive, deflated, as NSE publishes it. */
function zipOf(name, text) {
  const data = Buffer.from(text);
  const packed = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt32LE(0, 42);
  const dirAt = local.length + nameBuf.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + nameBuf.length, 12);
  end.writeUInt32LE(dirAt, 16);
  return Buffer.concat([local, nameBuf, packed, dir, nameBuf, end]);
}

const BHAV = `TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric
2026-11-18,2026-11-18,CM,NSE,STK,1594,INE009A01021,INFY,EQ,,,,,INFOSYS LIMITED,1120.00,1127.80,1106.60,1108.80,1108.80
2026-11-18,2026-11-18,CM,NSE,STK,19078,IN0020200104,SGBJUN28,GB,,,,,2.5%GOLDBONDS2028SR-III,13400.00,13400.00,13179.00,13205.17,13195.00
2026-11-18,2026-11-18,CM,NSE,STK,1,INE000000000,TINY,SM,,,,,TINY LTD,10,10,10,9.95,9.95
`;

test("NSE's end-of-day file: unzipped and read by column name, equity series only", () => {
  const { date, closes } = parseBhavcopy(unzipFirst(zipOf('BhavCopy.csv', BHAV)).toString('utf8'));
  assert.equal(date, '2026-11-18');
  assert.deepEqual([...closes], [['INFY.NS', 1108.8], ['TINY.NS', 9.95]]);
  assert.throws(() => unzipFirst(Buffer.from('not a zip at all, no really')), /not a zip/);
  assert.throws(() => parseBhavcopy('a,b,c\n1,2,3'), /columns/);
});

test("the nightly history job fills today's missing NSE closes from NSE's file", async () => {
  const today = istDate();
  const weekday = ![0, 6].includes(new Date(`${today}T00:00:00Z`).getUTCDay());
  const t = await setup({
    deps: {
      // Yahoo's history stops yesterday; NSE has today's close for AAA only.
      getDailyHistory: async () => [{ date: addDays(today, -1), close: 110 }],
      getNseCloses: async (date) => ({ date, closes: new Map([['AAA.NS', 123.45]]) }),
    },
  });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await t.db.query('DELETE FROM daily_prices WHERE date = $1::date', [today]);
    const r = (await cron(t, '/api/cron/history')).body;
    assert.equal(r.fromNse, weekday ? 1 : 0);
    if (weekday) assert.equal(await t.store.closeOn('AAA.NS', today), 123.45);
  } finally {
    await t.close();
  }
});
