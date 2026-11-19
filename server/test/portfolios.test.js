import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { mergeBySymbol } from '../src/analytics.js';

const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });

test('every user starts with one portfolio; more can be added, renamed and (except the last) removed', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    let list = (await u.call('GET', '/api/portfolios')).body;
    assert.deepEqual(list.map((p) => p.name), ['Main']);
    const main = list[0].id;

    const fam = await u.call('POST', '/api/portfolios', { name: '  Family ' });
    assert.equal(fam.status, 201);
    assert.equal(fam.body.name, 'Family');
    assert.equal((await u.call('POST', '/api/portfolios', { name: 'Family' })).status, 409, 'names are unique per user');
    assert.equal((await u.call('POST', '/api/portfolios', { name: '' })).status, 400);
    assert.equal((await u.call('PUT', `/api/portfolios/${fam.body.id}`, { name: 'Main' })).status, 409);
    assert.equal((await u.call('PUT', `/api/portfolios/${fam.body.id}`, { name: 'Amma' })).status, 204);

    // Another user's portfolio is invisible.
    const b = await t.login('b@example.test');
    assert.equal((await b.call('PUT', `/api/portfolios/${fam.body.id}`, { name: 'Mine' })).status, 404);
    assert.equal((await b.call('GET', `/api/report?portfolio=${fam.body.id}`)).status, 404);
    assert.equal((await b.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100, portfolioId: fam.body.id })).status, 404);

    assert.equal((await u.call('DELETE', `/api/portfolios/${fam.body.id}`)).status, 204);
    list = (await u.call('GET', '/api/portfolios')).body;
    assert.deepEqual(list.map((p) => p.id), [main]);
    assert.equal((await u.call('DELETE', `/api/portfolios/${main}`)).status, 400, "the only portfolio can't go");
  } finally {
    await t.close();
  }
});

test('the same stock in two portfolios: each has its own holding, reports can show one or both', async () => {
  const t = await setup();
  try {
    const today = istDate();
    const u = await t.login('a@example.test');
    const main = (await u.call('GET', '/api/portfolios')).body[0].id;
    const fam = (await u.call('POST', '/api/portfolios', { name: 'Family' })).body.id;

    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1_000, purchaseDate: addDays(today, -30) })).status, 201);
    // Not a duplicate: it is a different portfolio.
    const inFam = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 400, purchaseDate: addDays(today, -10), portfolioId: fam });
    assert.equal(inFam.status, 201);
    assert.equal(inFam.body.portfolioId, fam);
    // ...but a second purchase in the same portfolio still asks first.
    assert.equal((await u.call('POST', `/api/holdings?portfolio=${fam}`, { symbol: 'AAA.NS', quantity: 1, invested: 1 })).status, 409);
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 2, invested: 100, portfolioId: fam });
    await poll(t);

    const all = (await u.call('GET', '/api/report?period=1w')).body;
    assert.deepEqual(all.holdings.map((h) => [h.symbol, h.quantity, h.invested]), [['AAA.NS', 15, 1_400], ['BBB.NS', 2, 100]]);
    assert.equal(all.holdings.find((h) => h.symbol === 'AAA.NS').purchases, 2);
    const one = (await u.call('GET', `/api/report?period=1w&portfolio=${fam}`)).body;
    assert.deepEqual(one.holdings.map((h) => [h.symbol, h.quantity]), [['AAA.NS', 5], ['BBB.NS', 2]]);
    assert.deepEqual((await u.call('GET', `/api/holdings?portfolio=${main}`)).body.map((h) => h.symbol), ['AAA.NS']);
    assert.equal((await u.call('GET', '/api/holdings')).body.length, 3);
    assert.equal((await u.call('GET', '/api/report?portfolio=abc')).status, 400);

    // A sale belongs to its portfolio, and undoing it gives the shares back there.
    const sale = await u.call('POST', `/api/holdings/${inFam.body.id}/sell`, { quantity: 5, salePrice: 120, saleDate: today });
    assert.equal(sale.body.closed, true);
    assert.equal((await u.call('GET', `/api/sales?portfolio=${main}`)).body.items.length, 0);
    assert.equal((await u.call('GET', `/api/sales?portfolio=${fam}`)).body.items.length, 1);
    assert.equal((await u.call('GET', '/api/sales')).body.totals.count, 1);
    const back = await u.call('DELETE', `/api/sales/${sale.body.sale.id}`);
    assert.equal(back.body.reopened, true);
    assert.equal(back.body.holding.portfolioId, fam);
    assert.deepEqual((await u.call('GET', `/api/holdings?portfolio=${main}`)).body.map((h) => h.quantity), [10], 'Main untouched');

    // Capital gains per portfolio: each family member is a separate taxpayer.
    await u.call('POST', `/api/holdings/${back.body.holding.id}/sell`, { quantity: 5, salePrice: 120, saleDate: today });
    assert.equal((await u.call('GET', `/api/capital-gains?portfolio=${main}`)).body.rows.length, 0);
    assert.equal((await u.call('GET', `/api/capital-gains?portfolio=${fam}`)).body.rows.length, 1);
    assert.equal((await u.call('GET', '/api/capital-gains')).body.rows.length, 1);
  } finally {
    await t.close();
  }
});

test('moving a holding joins the purchases to the other portfolio; removing a portfolio removes its holdings and sales', async () => {
  const t = await setup();
  try {
    const today = istDate();
    const u = await t.login('a@example.test');
    const main = (await u.call('GET', '/api/portfolios')).body[0].id;
    const fam = (await u.call('POST', '/api/portfolios', { name: 'Family' })).body.id;
    const a = (await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1_000, purchaseDate: addDays(today, -30) })).body;
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 400, portfolioId: fam });
    const moved = await u.call('POST', `/api/holdings/${a.id}/move`, { portfolioId: fam });
    assert.equal(moved.status, 200);
    assert.deepEqual([moved.body.portfolioId, moved.body.quantity, moved.body.invested, moved.body.lots.length], [fam, 15, 1_400, 2]);
    assert.equal((await u.call('GET', `/api/holdings?portfolio=${main}`)).body.length, 0);

    const b = (await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 2, invested: 100 })).body;
    assert.equal((await u.call('POST', `/api/holdings/${b.id}/move`, { portfolioId: fam })).body.portfolioId, fam);
    const other = await t.login('b@example.test');
    assert.equal((await other.call('POST', `/api/holdings/${b.id}/move`, { portfolioId: main })).status, 404);

    await u.call('POST', `/api/holdings/${b.id}/sell`, { quantity: 1, salePrice: 60, saleDate: today });
    await u.call('PUT', '/api/allocation/targets?portfolio=' + fam, { targets: [{ sector: 'Technology', pct: 100 }] });
    assert.equal((await u.call('DELETE', `/api/portfolios/${fam}`)).status, 204);
    assert.equal((await u.call('GET', '/api/holdings')).body.length, 0);
    assert.equal((await u.call('GET', '/api/sales')).body.totals.count, 0);
    assert.equal((await u.call('GET', '/api/allocation')).body.targets.length, 0);
  } finally {
    await t.close();
  }
});

test('mergeBySymbol joins a stock held in several portfolios into one holding', () => {
  const merged = mergeBySymbol([
    { id: 1, portfolioId: 1, symbol: 'A', name: 'A', quantity: 10, invested: 100, purchase_date: '2025-05-01', created_at: 5, lots: [{ id: 1, quantity: 10, invested: 100, purchase_date: '2025-05-01' }] },
    { id: 2, portfolioId: 2, symbol: 'A', name: 'A', quantity: 2.5, invested: 30.555, purchase_date: null, created_at: 3, lots: [{ id: 2, quantity: 2.5, invested: 30.555, purchase_date: null }] },
    { id: 3, portfolioId: 2, symbol: 'B', name: 'B', quantity: 1, invested: 1, purchase_date: '2024-01-01', created_at: 1, lots: [] },
  ]);
  assert.equal(merged.length, 2);
  const a = merged.find((h) => h.symbol === 'A');
  assert.deepEqual([a.quantity, a.invested, a.purchase_date, a.created_at, a.portfolioIds], [12.5, 130.56, '2025-05-01', 3, [1, 2]]);
  assert.deepEqual(a.lots.map((l) => l.id), [1, 2], 'dated purchases first');
  assert.deepEqual(merged.find((h) => h.symbol === 'B').portfolioIds, [2]);
});
