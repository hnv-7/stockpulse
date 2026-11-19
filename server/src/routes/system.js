import { safeEqual, sha256 } from '../auth.js';

/**
 * Scheduled jobs (called by Vercel Cron with a shared secret; see the crons in vercel.json) and the Telegram webhook.
 * Both are reached without a user session.
 */
export function systemRoutes(api, { store, tracker, config, notifier, limiter, digest }) {
  const cronOnly = (req, res, next) => {
    if (!config.cronSecret) return res.status(503).json({ error: 'scheduler is not configured' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.cronSecret)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  api.all('/cron/poll', cronOnly, async (_req, res) => res.json(await tracker.pollOnce()));
  api.all('/cron/history', cronOnly, async (_req, res) => res.json(await tracker.refreshHistory()));
  api.all('/cron/digest', cronOnly, async (_req, res) => res.json(await digest.sendAll()));

  // "/start <code>" from the link in the Account tab connects the chat; "/stop" disconnects it. Always answers 200,
  // since Telegram keeps retrying anything else.
  api.post('/telegram/webhook', limiter('telegram-webhook', 60_000, 120), async (req, res) => {
    if (!config.telegram.enabled) return res.status(404).json({ error: 'not found' });
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof secret !== 'string' || !safeEqual(secret, config.telegram.webhookSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    if (chatId == null || msg.chat.type !== 'private') return res.json({ ok: true });
    const chat = String(chatId);
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    const reply = (t) => notifier.sendTelegram(chat, t);
    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(text);
    if (start) {
      const linked = await store.linkTelegram(sha256(start[1]), chat);
      await reply(
        linked
          ? 'Connected. Your Stock Beat alerts will arrive here. Send /stop to turn them off.'
          : 'That link has expired or was already used. In Stock Beat, open Account and connect Telegram again.',
      );
    } else if (/^\/stop\b/.test(text)) {
      const n = await store.unlinkTelegramChat(chat);
      await reply(n ? "Stopped. Stock Beat won't send alerts here any more." : "This chat isn't connected to Stock Beat.");
    } else if (/^\/start\b/.test(text)) {
      await reply('To connect, open Stock Beat, go to Account and choose Connect Telegram.');
    }
    res.json({ ok: true });
  });
}
