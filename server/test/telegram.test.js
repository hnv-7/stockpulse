import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const env = {
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_BOT_USERNAME: '@StockBeatTestBot',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
};
const SECRET = { 'x-telegram-bot-api-secret-token': 'test-webhook-secret', 'content-type': 'application/json' };
/** Telegram calling the webhook with a private message from `chatId`. */
const fromTelegram = (t, chatId, text, { headers = SECRET, type = 'private' } = {}) =>
  t.anon('POST', '/api/telegram/webhook', {
    headers,
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: chatId, type }, text } }),
  });
const poll = (t) => t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
const toChat = (t, chatId) => t.sent.filter((m) => m.telegram === String(chatId)).map((m) => m.text);

test('connect Telegram with a one-time link, get alerts there, and stop them', async () => {
  const t = await setup({ env });
  try {
    const u = await t.login('a@example.test');
    const me = (await u.call('GET', '/api/me')).body;
    assert.equal(me.telegramAvailable, true);
    assert.equal(me.user.telegramConnected, false);

    const link = (await u.call('POST', '/api/me/telegram/link')).body;
    const code = new URL(link.url).searchParams.get('start');
    assert.match(link.url, /^https:\/\/t\.me\/StockBeatTestBot\?start=[A-Za-z0-9_-]{16}$/);
    assert.ok(link.expiresAt > Date.now());

    // Only Telegram (which knows the secret) can call the webhook.
    assert.equal((await fromTelegram(t, 555, `/start ${code}`, { headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await fromTelegram(t, 555, `/start ${code}`, { headers: { ...SECRET, 'x-telegram-bot-api-secret-token': 'nope' } })).status, 401);
    assert.equal((await fromTelegram(t, 777, `/start ${code}`, { type: 'group' })).status, 200, 'groups are ignored');

    assert.equal((await fromTelegram(t, 555, `/start ${code}`)).status, 200);
    assert.match(toChat(t, 555).at(-1), /^Connected/);
    assert.equal((await u.call('GET', '/api/me')).body.user.telegramConnected, true);
    assert.deepEqual(toChat(t, 777), [], 'nothing was linked from the group');

    // The code works once.
    await fromTelegram(t, 556, `/start ${code}`);
    assert.match(toChat(t, 556).at(-1), /expired or was already used/);

    // An alert reaches Telegram (AAA.NS: 100 now against 110 yesterday).
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 100 });
    await u.call('POST', '/api/rules', { symbol: 'AAA.NS', window: '1d', thresholdPct: 5 });
    await poll(t);
    assert.match(toChat(t, 555).at(-1), /^Stock Beat alert: AAA\.NS\n\nAAA\.NS is down/);

    assert.equal((await u.call('POST', '/api/me/telegram/test')).status, 204);
    assert.match(toChat(t, 555).at(-1), /^Test from Stock Beat/);

    // /stop from Telegram disconnects.
    await fromTelegram(t, 555, '/stop');
    assert.match(toChat(t, 555).at(-1), /^Stopped/);
    assert.equal((await u.call('GET', '/api/me')).body.user.telegramConnected, false);
    assert.equal((await u.call('POST', '/api/me/telegram/test')).status, 400);
  } finally {
    await t.close();
  }
});

test('an expired link fails; a blocked bot or Disconnect forgets the chat; links need the CSRF token', async () => {
  const t = await setup({ env });
  try {
    const u = await t.login('a@example.test');
    let code = new URL((await u.call('POST', '/api/me/telegram/link')).body.url).searchParams.get('start');
    await t.db.query('UPDATE users SET telegram_link_expires = $1', [Date.now() - 1]);
    await fromTelegram(t, 555, `/start ${code}`);
    assert.match(toChat(t, 555).at(-1), /expired/);
    assert.equal((await u.call('POST', '/api/me/telegram/link', null, { 'x-csrf-token': 'nope' })).status, 403);

    // Linked to a chat that has since blocked the bot: the next delivery forgets it.
    code = new URL((await u.call('POST', '/api/me/telegram/link')).body.url).searchParams.get('start');
    await fromTelegram(t, 'blocked-1', `/start ${code}`);
    assert.equal((await u.call('GET', '/api/me')).body.user.telegramConnected, true);
    assert.equal((await u.call('POST', '/api/me/telegram/test')).status, 502);
    assert.equal((await u.call('GET', '/api/me')).body.user.telegramConnected, false);

    code = new URL((await u.call('POST', '/api/me/telegram/link')).body.url).searchParams.get('start');
    await fromTelegram(t, 555, `/start ${code}`);
    assert.equal((await u.call('DELETE', '/api/me/telegram')).status, 204);
    assert.equal((await u.call('GET', '/api/me')).body.user.telegramConnected, false);
  } finally {
    await t.close();
  }
});

test('without a bot configured, Telegram is hidden and its routes are off', async () => {
  const t = await setup();
  try {
    const u = await t.login('a@example.test');
    assert.equal((await u.call('GET', '/api/me')).body.telegramAvailable, false);
    assert.equal((await u.call('POST', '/api/me/telegram/link')).status, 404);
    assert.equal((await fromTelegram(t, 555, '/start abcdefgh')).status, 404);
  } finally {
    await t.close();
  }
});
