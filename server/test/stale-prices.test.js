import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('the report marks each stock with when its price was fetched and whether it is stale', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000 });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 5, invested: 250 });

    // Adding a stock saves a fresh price, so start clean: AAA was fetched just now, BBB a long time ago.
    await t.db.query('DELETE FROM snapshots');
    const now = Date.now();
    await t.store.saveSnapshots([
      { symbol: 'AAA.NS', ts: now, price: 100 },
      { symbol: 'BBB.NS', ts: now - 5 * 86_400_000, price: 50 },
    ]);

    const rep = (await u.call('GET', '/api/report?period=1w')).body;
    const aaa = rep.holdings.find((r) => r.symbol === 'AAA.NS');
    const bbb = rep.holdings.find((r) => r.symbol === 'BBB.NS');
    assert.equal(aaa.priceAsOf, now);
    assert.equal(aaa.stale, false);
    assert.equal(bbb.priceAsOf, now - 5 * 86_400_000);
    assert.equal(bbb.stale, true);
  } finally {
    await t.close();
  }
});
