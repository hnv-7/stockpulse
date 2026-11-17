import nodemailer from 'nodemailer';

/**
 * Alert delivery by email and Telegram. SMTP credentials and the bot token come from env (never stored per user).
 * Email goes to the address on the user's Google account if they opt in; Telegram to the chat they linked.
 */
export function createNotifier(config, { fetch: doFetch = globalThis.fetch } = {}) {
  const { host, port, user, pass, from } = config.smtp;
  const enabled = !!(host && user && pass && from);
  let transport = null;
  const get = () =>
    (transport ??= nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user, pass },
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    }));

  const telegramEnabled = !!config.telegram?.enabled;

  return {
    emailEnabled: enabled,
    telegramEnabled,
    /**
     * Send a Telegram message. Returns {ok}, with blocked: true when Telegram refuses because the user blocked the bot
     * or deleted the chat (403), so the caller can forget that chat.
     */
    async sendTelegram(chatId, text) {
      if (!telegramEnabled) return { ok: false };
      try {
        const res = await doFetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        console.error(JSON.stringify({ level: 'error', msg: 'telegram delivery failed', status: res.status }));
        return { ok: false, blocked: res.status === 403 };
      } catch {
        // Never log the token (it is in the URL) or the chat.
        console.error(JSON.stringify({ level: 'error', msg: 'telegram delivery failed' }));
        return { ok: false };
      }
    },
    async sendEmail(to, subject, text) {
      if (!enabled) return false;
      try {
        await get().sendMail({ from, to, subject, text });
        return true;
      } catch {
        // Never log the recipient or SMTP details.
        console.error(JSON.stringify({ level: 'error', msg: 'email delivery failed' }));
        return false;
      }
    },
  };
}
