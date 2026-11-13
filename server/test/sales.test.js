import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';

const today = istDate();
const d = (n) => addDays(today, n);

/** Two purchases of AAA.NS: 10 @ 1000 (older) and 20 @ 3000 (newer). */
async function twoLots(u) {
  await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: d(-300) });
  const r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 20, invested: 3000, purchaseDate: d(-100), merge: true });
  assert.equal(r.body.quantity, 30);
  return r.body.id;
}

test('partial sale uses the oldest purchase first and records the realised profit', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);

    // Sell 15: all of the first lot (cost 1000) and 5 of the second (5/20 of 3000 = 750).
    const r = await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 15, salePrice: 200, charges: 50, saleDate: d(-1) });
    assert.equal(r.status, 200);
    assert.equal(r.body.closed, false);
    assert.equal(r.body.sale.costBasis, 1750);
    assert.equal(r.body.sale.proceeds, 3000);
    assert.equal(r.body.sale.realised, 3000 - 50 - 1750);

    // What is left: 15 shares costing 2250, as a single purchase dated -100.
    assert.equal(r.body.holding.quantity, 15);
    assert.equal(r.body.holding.invested, 2250);
    assert.equal(r.body.holding.lots.length, 1);
    assert.equal(r.body.holding.purchase_date, d(-100));

    const sales = await u.call('GET', '/api/sales');
    assert.equal(sales.body.items.length, 1);
    assert.equal(sales.body.totals.realised, 1200);
    assert.equal(sales.body.totals.count, 1);

    const report = await u.call('GET', '/api/report?period=1w');
    assert.equal(report.body.realised.realised, 1200);
  } finally {
    await t.close();
  }
});

test('selling everything closes the holding but keeps the sale', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    const id = (await u.call('GET', '/api/holdings')).body[0].id;
    await u.call('POST', '/api/rules', { symbol: 'AAA.NS', window: '1d', thresholdPct: 5 });

    const r = await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 10, salePrice: 80, saleDate: today });
    assert.equal(r.status, 200);
    assert.equal(r.body.closed, true);
    assert.equal(r.body.holding, null);
    assert.equal(r.body.sale.realised, -200, 'a loss is a negative realised profit');

    assert.deepEqual((await u.call('GET', '/api/holdings')).body, []);
    assert.equal((await u.call('GET', '/api/rules')).body.length, 0, 'alerts for a sold stock are removed');
    assert.equal((await u.call('GET', '/api/sales')).body.items[0].symbol, 'AAA.NS');
  } finally {
    await t.close();
  }
});

test('a sale is rejected cleanly and changes nothing', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);
    const sell = (body) => u.call('POST', `/api/holdings/${id}/sell`, { salePrice: 100, saleDate: today, ...body });

    assert.equal((await sell({ quantity: 31 })).status, 400, 'more than held');
    assert.equal((await sell({ quantity: 0 })).status, 400);
    assert.equal((await sell({ quantity: -1 })).status, 400);
    assert.equal((await sell({ quantity: 1, salePrice: 0 })).status, 400);
    assert.equal((await sell({ quantity: 1, charges: -5 })).status, 400);
    assert.equal((await sell({ quantity: 1, saleDate: d(3) })).status, 400, 'future date');
    assert.equal((await sell({ quantity: 1, saleDate: '2024-02-30' })).status, 400, 'not a real date');
    const early = await sell({ quantity: 1, saleDate: d(-400) });
    assert.equal(early.status, 400, 'before the first purchase');
    assert.match(early.body.error, /before a purchase/);
    assert.equal((await u.call('POST', '/api/holdings/99999/sell', { quantity: 1, salePrice: 1, saleDate: today })).status, 404);

    const h = (await u.call('GET', '/api/holdings')).body[0];
    assert.equal(h.quantity, 30);
    assert.equal(h.invested, 4000);
    assert.equal((await u.call('GET', '/api/sales')).body.items.length, 0);
  } finally {
    await t.close();
  }
});

test('sales are private to their owner and need the CSRF token', async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    await alice.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    const id = (await alice.call('GET', '/api/holdings')).body[0].id;
    const body = { quantity: 5, salePrice: 150, saleDate: today };

    assert.equal((await bob.call('POST', `/api/holdings/${id}/sell`, body)).status, 404, "cannot sell someone else's shares");
    assert.equal((await alice.call('POST', `/api/holdings/${id}/sell`, body, { 'x-csrf-token': 'nope' })).status, 403);
    assert.equal((await t.anon('POST', `/api/holdings/${id}/sell`)).status, 401);

    assert.equal((await alice.call('POST', `/api/holdings/${id}/sell`, body)).status, 200);
    assert.equal((await bob.call('GET', '/api/sales')).body.items.length, 0, "bob sees none of alice's sales");
    assert.equal((await alice.call('GET', '/api/sales')).body.items.length, 1);

    // Deleting the account removes the sales too.
    assert.equal((await alice.call('DELETE', '/api/me')).status, 204);
    const left = await t.db.query('SELECT COUNT(*) AS c FROM sales');
    assert.equal(Number(left.rows[0].c), 0);
  } finally {
    await t.close();
  }
});

const lotsOf = async (u, symbol = 'AAA.NS') => {
  const h = (await u.call('GET', '/api/holdings')).body.find((x) => x.symbol === symbol);
  return h && { quantity: h.quantity, invested: h.invested, lots: h.lots.map((l) => [l.quantity, l.invested, l.purchase_date]) };
};

test('removing a sale gives the exact purchases back', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);
    const before = await lotsOf(u);

    const sale = (await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 15, salePrice: 200, saleDate: today })).body.sale;
    assert.notDeepEqual(await lotsOf(u), before);

    const r = await u.call('DELETE', `/api/sales/${sale.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.reopened, false);
    assert.deepEqual(await lotsOf(u), before, 'quantities, cost and purchase dates are exactly as before the sale');
    assert.equal((await u.call('GET', '/api/sales')).body.items.length, 0);
    assert.equal((await u.call('DELETE', `/api/sales/${sale.id}`)).status, 404, 'already gone');
  } finally {
    await t.close();
  }
});

test('removing the sale of a fully sold stock brings the stock back', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);
    const before = await lotsOf(u);
    const sale = (await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 30, salePrice: 90, saleDate: today })).body.sale;
    assert.equal(await lotsOf(u), undefined, 'stock is gone from holdings');

    const r = await u.call('DELETE', `/api/sales/${sale.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.reopened, true);
    assert.deepEqual(await lotsOf(u), before);
  } finally {
    await t.close();
  }
});

test('a stock cannot come back past the holdings cap', async () => {
  const t = await setup({ env: { MAX_HOLDINGS_PER_USER: '1' } });
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    const id = (await u.call('GET', '/api/holdings')).body[0].id;
    const sale = (await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 10, salePrice: 100, saleDate: today })).body.sale;
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 4, invested: 200 }); // takes the only slot

    const r = await u.call('DELETE', `/api/sales/${sale.id}`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /up to 1 stocks/);
    assert.equal((await u.call('GET', '/api/sales')).body.items.length, 1, 'sale is untouched');
  } finally {
    await t.close();
  }
});

test('editing a sale re-sells with the new figures', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);
    const sale = (await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 15, salePrice: 200, saleDate: d(-1) })).body.sale;

    // Fix a typo: it was 20 shares at 210 with 40 charges. Cost of 20 = 1000 + 10/20*3000 = 2500.
    const r = await u.call('PUT', `/api/sales/${sale.id}`, { quantity: 20, salePrice: 210, charges: 40, saleDate: d(-2) });
    assert.equal(r.status, 200);
    assert.equal(r.body.sale.costBasis, 2500);
    assert.equal(r.body.sale.realised, 20 * 210 - 40 - 2500);
    assert.equal(r.body.holding.quantity, 10);
    assert.equal(r.body.holding.invested, 1500);

    const sales = (await u.call('GET', '/api/sales')).body;
    assert.equal(sales.items.length, 1, 'edited, not duplicated');
    assert.equal(sales.items[0].quantity, 20);
    assert.equal(sales.totals.realised, 1660);

    // Edit it into a full sale and back again.
    assert.equal((await u.call('PUT', `/api/sales/${sales.items[0].id}`, { quantity: 30, salePrice: 100, saleDate: today })).body.closed, true);
    assert.equal(await lotsOf(u), undefined);
    const again = (await u.call('GET', '/api/sales')).body.items[0];
    const back = await u.call('PUT', `/api/sales/${again.id}`, { quantity: 5, salePrice: 100, saleDate: today });
    assert.equal(back.status, 200);
    assert.equal(back.body.holding.quantity, 25, 'the closed stock reopened with the shares that are no longer sold');
  } finally {
    await t.close();
  }
});

test('a rejected edit leaves everything exactly as it was', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    const id = await twoLots(u);
    const sale = (await u.call('POST', `/api/holdings/${id}/sell`, { quantity: 15, salePrice: 200, saleDate: today })).body.sale;
    const holdingBefore = await lotsOf(u);
    const salesBefore = (await u.call('GET', '/api/sales')).body;
    const put = (body) => u.call('PUT', `/api/sales/${sale.id}`, { salePrice: 200, saleDate: today, quantity: 15, ...body });

    assert.equal((await put({ quantity: 31 })).status, 400, 'more than the 30 that exist');
    assert.equal((await put({ saleDate: d(-400) })).status, 400, 'before the first purchase');
    assert.equal((await put({ quantity: 0 })).status, 400);
    assert.equal((await put({ saleDate: d(5) })).status, 400);
    assert.equal((await u.call('PUT', '/api/sales/99999', { quantity: 1, salePrice: 1, saleDate: today })).status, 404);

    assert.deepEqual(await lotsOf(u), holdingBefore);
    assert.deepEqual((await u.call('GET', '/api/sales')).body, salesBefore);
  } finally {
    await t.close();
  }
});

test('sales of other users cannot be edited or removed', async () => {
  const t = await setup();
  try {
    const alice = await t.login('alice@example.test');
    const bob = await t.login('bob@example.test');
    const id = await twoLots(alice);
    const sale = (await alice.call('POST', `/api/holdings/${id}/sell`, { quantity: 5, salePrice: 150, saleDate: today })).body.sale;
    const body = { quantity: 1, salePrice: 1, saleDate: today };

    assert.equal((await bob.call('PUT', `/api/sales/${sale.id}`, body)).status, 404);
    assert.equal((await bob.call('DELETE', `/api/sales/${sale.id}`)).status, 404);
    assert.equal((await alice.call('DELETE', `/api/sales/${sale.id}`, null, { 'x-csrf-token': 'nope' })).status, 403);
    assert.equal((await t.anon('DELETE', `/api/sales/${sale.id}`)).status, 401);
    assert.equal((await alice.call('GET', '/api/sales')).body.items.length, 1);
  } finally {
    await t.close();
  }
});
