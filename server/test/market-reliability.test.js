import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, createTtlCache } from '../src/market.js';
import { isStale, STALE_IN_SESSION_MS } from '../src/dates.js';

const noSleep = async () => {};
const ist = (s) => Date.parse(`${s}+05:30`);

test('a temporary failure is retried and then succeeds', async () => {
  let calls = 0;
  const pauses = [];
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('socket hang up');
      return 'ok';
    },
    { sleep: async (ms) => pauses.push(ms) },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [300, 900], 'the pause grows between attempts');
});

test('retrying gives up after the last attempt and throws the final error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, { attempts: 3, sleep: noSleep }),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('a permanent error is not retried', async () => {
  let calls = 0;
  const bad = Object.assign(new Error('bad symbol'), { name: 'BadRequestError' });
  await assert.rejects(withRetry(async () => { calls++; throw bad; }, { sleep: noSleep }), /bad symbol/);
  assert.equal(calls, 1);
});

test('the cache answers repeat requests until the entry expires', async () => {
  let clock = 1_000;
  const cached = createTtlCache(45_000, { now: () => clock });
  let loads = 0;
  const load = async () => ({ price: ++loads });

  assert.equal((await cached('AAA.NS', load)).price, 1);
  clock += 44_000;
  assert.equal((await cached('AAA.NS', load)).price, 1, 'still fresh');
  assert.equal((await cached('BBB.NS', load)).price, 2, 'a different key loads separately');
  clock += 2_000;
  assert.equal((await cached('AAA.NS', load)).price, 3, 'expired, loaded again');
});

test('the cache does not remember empty results or failures', async () => {
  const cached = createTtlCache(45_000);
  let loads = 0;
  assert.equal(await cached('X', async () => (loads++, null)), null);
  assert.equal(await cached('X', async () => (loads++, null)), null);
  assert.equal(loads, 2);
  await assert.rejects(cached('Y', async () => { throw new Error('down'); }), /down/);
  assert.equal((await cached('Y', async () => 7)), 7);
});

test('the cache drops its oldest entry when full', async () => {
  const cached = createTtlCache(45_000, { maxEntries: 2 });
  let loads = 0;
  const load = async () => ++loads;
  await cached('a', load);
  await cached('b', load);
  await cached('c', load); // evicts a
  assert.equal(await cached('b', load), 2, 'b still cached');
  assert.equal(await cached('a', load), 4, 'a was evicted and loaded again');
});

test('a price is stale after two hours in trading hours, and never fresh when unknown', () => {
  const now = ist('2026-11-13T12:00:00'); // Friday, market open
  assert.equal(isStale(now - STALE_IN_SESSION_MS + 60_000, now), false);
  assert.equal(isStale(now - STALE_IN_SESSION_MS - 60_000, now), true);
  assert.equal(isStale(null, now), true);
});

test('outside trading hours the last session price is not stale', () => {
  assert.equal(isStale(ist('2026-11-13T15:00:00'), ist('2026-11-13T20:00:00')), false, 'Friday evening');
  assert.equal(isStale(ist('2026-11-13T15:00:00'), ist('2026-11-15T10:00:00')), false, 'Sunday, Friday price');
  assert.equal(isStale(ist('2026-11-13T15:00:00'), ist('2026-11-16T08:00:00')), false, 'Monday before the open');
});

test('a whole missed session makes the price stale', () => {
  assert.equal(isStale(ist('2026-11-12T15:00:00'), ist('2026-11-15T10:00:00')), true, 'Thursday price on Sunday');
  assert.equal(isStale(ist('2026-11-13T15:00:00'), ist('2026-11-16T10:00:00')), true, 'Friday price on Monday in session');
});
