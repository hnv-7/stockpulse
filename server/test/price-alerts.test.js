import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/alerts.js';
import { setup } from './helpers.js';

const holdings = [{ symbol: 'A', quantity: 1, invested: 100 }];
const run = (rules, price) =>
  evaluateRules({ rules, holdings, seriesBySymbol: new Map(), latestBySymbol: new Map([['A', price]]), today: '2026-11-13' });
const rule = (direction, target_price, extra = {}) => ({ id: 1, kind: 'price', symbol: 'A', direction, target_price, enabled: true, ...extra });

test('an "above" price target fires at or over the price, not under it', () => {
  assert.equal(run([rule('above', 3000)], 2999.99).length, 0);
  assert.equal(run([rule('above', 3000)], 3000).length, 1, 'exactly at the target counts');
  assert.equal(run([rule('above', 3000)], 3100).length, 1);
});

test('a "below" price target fires at or under the price, not over it', () => {
  assert.equal(run([rule('below', 2400)], 2400.01).length, 0);
  assert.equal(run([rule('below', 2400)], 2400).length, 1);
  assert.equal(run([rule('below', 2400)], 2300).length, 1);
});

test('a paused price target never fires, and neither does one with no price', () => {
  assert.equal(run([rule('above', 100, { enabled: false })], 500).length, 0);
  assert.equal(run([rule('above', 100)], undefined).length, 0);
});

test('a price target for a stock you no longer hold is ignored', () => {
  assert.equal(run([rule('above', 100, { symbol: 'GONE' })], 500).length, 0);
});

test('the price alert message names the stock, the target and the price', () => {
  const [hit] = run([rule('above', 3000)], 3012.4);
  assert.match(hit.message, /A reached your target: it is now above ₹3,000\.00 \(price ₹3,012\.40\)/);
  assert.equal(hit.dropPct, null);
});

test('price and drop rules can be evaluated together', () => {
  const series = new Map([['A', [{ date: '2026-11-12', close: 100 }]]]);
  const hits = evaluateRules({
    rules: [
      rule('below', 95),
      { id: 2, symbol: 'A', window: '1d', threshold_pct: 5, enabled: true }, // kind omitted: a drop rule, like older ones
    ],
    holdings,
    seriesBySymbol: series,
    latestBySymbol: new Map([['A', 90]]),
    today: '2026-11-13',
  });
  assert.deepEqual(hits.map((h) => h.rule.id), [1, 2]);
});

test('price targets: create, validate, edit, and keep drop rules working', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });

    const made = await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 150 });
    assert.equal(made.status, 201);
    assert.equal(made.body.kind, 'price');
    assert.equal(made.body.target_price, 150);
    assert.equal(made.body.direction, 'above');
    assert.equal(made.body.window, null);

    // Bad input is refused.
    const bad = (body) => u.call('POST', '/api/rules', body).then((r) => r.status);
    assert.equal(await bad({ kind: 'price', symbol: 'AAA.NS', direction: 'sideways', targetPrice: 150 }), 400);
    assert.equal(await bad({ kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 0 }), 400);
    assert.equal(await bad({ kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: -5 }), 400);
    assert.equal(await bad({ kind: 'price', direction: 'above', targetPrice: 150 }), 400, 'needs a stock');
    assert.equal(await bad({ kind: 'price', symbol: 'NOPE.NS', direction: 'above', targetPrice: 150 }), 404, 'not in portfolio');

    // Change the target; the percent field is ignored for this kind of rule.
    const edited = await u.call('PUT', `/api/rules/${made.body.id}`, { targetPrice: 175, thresholdPct: 9, enabled: true });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.target_price, 175);
    assert.equal(edited.body.threshold_pct, null);

    // A drop rule still works, with or without the new "kind" field.
    const drop = await u.call('POST', '/api/rules', { symbol: 'AAA.NS', window: '1d', thresholdPct: 5 });
    assert.equal(drop.status, 201);
    assert.equal(drop.body.kind, 'drop');
    assert.equal(drop.body.threshold_pct, 5);
    const dropEdit = await u.call('PUT', `/api/rules/${drop.body.id}`, { thresholdPct: 8, enabled: true, targetPrice: 1 });
    assert.equal(dropEdit.body.threshold_pct, 8);
    assert.equal(dropEdit.body.target_price, null);
  } finally {
    await t.close();
  }
});

test('a price target fires once, notifies, emails, then pauses itself', async () => {
  const t = await setup({ prices: { 'AAA.NS': 100 } });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    await u.call('PUT', '/api/me/settings', { alertEmail: true });
    const made = (await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 120 })).body;

    // Below the target: nothing happens.
    assert.equal((await t.tracker.pollOnce()).alerts, 0);

    // The price crosses the target.
    t.prices['AAA.NS'] = 125;
    assert.equal((await t.tracker.pollOnce()).alerts, 1);
    const notes = (await u.call('GET', '/api/notifications')).body;
    assert.equal(notes.items.length, 1);
    assert.match(notes.items[0].message, /AAA\.NS reached your target/);
    assert.equal(t.sent.length, 1);

    // It switched itself off, so it will not repeat.
    const rules = (await u.call('GET', '/api/rules')).body;
    assert.equal(rules.find((r) => r.id === made.id).enabled, false);
    assert.equal((await t.tracker.pollOnce()).alerts, 0);
    assert.equal((await u.call('GET', '/api/notifications')).body.items.length, 1);
  } finally {
    await t.close();
  }
});

test('selling a whole stock removes its price targets', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const h = (await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 })).body;
    await u.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'below', targetPrice: 80 });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    assert.equal((await u.call('POST', `/api/holdings/${h.id}/sell`, { quantity: 10, salePrice: 100, saleDate: today })).status, 200);
    assert.equal((await u.call('GET', '/api/rules')).body.length, 0);
  } finally {
    await t.close();
  }
});

test("another user's price targets are not visible or editable", async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    const r = (await alice.call('POST', '/api/rules', { kind: 'price', symbol: 'AAA.NS', direction: 'above', targetPrice: 200 })).body;
    assert.equal((await bob.call('GET', '/api/rules')).body.length, 0);
    assert.equal((await bob.call('PUT', `/api/rules/${r.id}`, { targetPrice: 1, enabled: true })).status, 404);
    assert.equal((await bob.call('DELETE', `/api/rules/${r.id}`)).status, 404);
  } finally {
    await t.close();
  }
});
