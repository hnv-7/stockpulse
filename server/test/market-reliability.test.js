import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, createTtlCache } from '../src/market.js';
import { readFileSync } from 'node:fs';
import { isStale, lastDueRefresh, REFRESH_TIMES } from '../src/dates.js';

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

// 2026-11-13 is a Friday, 2026-11-16 a Monday.
test('a price is current until a scheduled refresh has had its whole window, and never when unknown', () => {
  const now = ist('2026-11-13T12:00:00'); // the 09:30 refresh is due by 10:45, the 12:30 one not yet
  assert.equal(isStale(ist('2026-11-13T09:41:00'), now), false, 'from the open refresh');
  assert.equal(isStale(ist('2026-11-12T15:50:00'), now), true, 'the open refresh was missed');
  assert.equal(isStale(ist('2026-11-12T15:50:00'), ist('2026-11-13T10:30:00')), false, 'open refresh still within its hour');
  assert.equal(isStale(ist('2026-11-13T09:41:00'), ist('2026-11-13T13:40:00')), false, 'midday refresh still within its hour');
  assert.equal(isStale(ist('2026-11-13T09:41:00'), ist('2026-11-13T13:50:00')), true, 'the midday refresh was missed');
  assert.equal(isStale(null, now), true);
});

test('between the close refresh and the next open, the close price is current', () => {
  const close = ist('2026-11-13T15:50:00');
  assert.equal(isStale(close, ist('2026-11-13T20:00:00')), false, 'Friday evening');
  assert.equal(isStale(close, ist('2026-11-15T10:00:00')), false, 'Sunday');
  assert.equal(isStale(close, ist('2026-11-16T09:20:00')), false, 'Monday at the open');
  assert.equal(isStale(close, ist('2026-11-16T10:40:00')), false, 'Monday, open refresh still within its hour');
});

test('a missed refresh makes the price stale, even out of hours', () => {
  assert.equal(isStale(ist('2026-11-13T13:00:00'), ist('2026-11-13T20:00:00')), true, 'Friday close refresh missed');
  assert.equal(isStale(ist('2026-11-12T15:50:00'), ist('2026-11-15T10:00:00')), true, 'Thursday price on Sunday');
  assert.equal(isStale(ist('2026-11-13T15:50:00'), ist('2026-11-16T11:00:00')), true, 'Friday price late on Monday morning');
});

test('lastDueRefresh steps back over the weekend to Friday\'s close refresh', () => {
  assert.equal(lastDueRefresh(ist('2026-11-16T08:00:00')), ist('2026-11-13T15:30:00'));
  assert.equal(lastDueRefresh(ist('2026-11-16T10:45:00')), ist('2026-11-16T09:30:00'));
});

test('the poll crons in vercel.json run at the refresh times, once each weekday', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const polls = vercel.crons.filter((c) => c.path === '/api/cron/poll');
  const istMinutes = polls.map((c) => {
    const [min, hour, dom, mon, dow] = c.schedule.split(' ');
    assert.deepEqual([dom, mon, dow], ['*', '*', '1-5'], c.schedule);
    return (Number(hour) * 60 + Number(min) + 330) % 1440; // UTC to IST
  });
  assert.deepEqual(istMinutes.sort((a, b) => a - b), REFRESH_TIMES);
  // Vercel's free plan fires anywhere in the hour, so the open refresh must not be able to run before 09:15.
  assert.ok(REFRESH_TIMES[0] >= 9 * 60 + 15);
});
