import nodemailer from 'nodemailer';

/**
 * Email delivery for alerts. SMTP credentials come from env (never stored per user);
 * each user opts in and receives alerts at the address on their Google account.
 */
export function createNotifier(config) {
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

  return {
    emailEnabled: enabled,
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
