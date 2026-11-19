import { randomBytes } from 'node:crypto';
import { sha256 } from '../auth.js';
import { HttpError, parse, parseId } from '../http.js';
import { settingsSchema, portfolioNameSchema } from '../schemas.js';

/** How long a "connect Telegram" link works. */
const TELEGRAM_LINK_MS = 15 * 60_000;
/** Most portfolios one user can keep. */
export const MAX_PORTFOLIOS = 10;

const publicUser = (u) => ({
  email: u.email,
  name: u.name,
  alertEmail: u.alertEmail,
  weeklyDigest: u.weeklyDigest,
  telegramConnected: !!u.telegramChatId,
});

/** The signed-in user's settings, Telegram link, portfolios and account deletion. Needs a session. */
export function accountRoutes(api, { store, config, notifier, limiter, auth }) {
  api.post('/auth/logout', (req, res) => auth.logout(req, res));

  api.put('/me/settings', async (req, res) => {
    const { alertEmail, weeklyDigest } = parse(settingsSchema, req.body);
    if (alertEmail && !notifier.emailEnabled) throw new HttpError(400, 'email alerts are not enabled on this server');
    const u = await store.updateUserSettings(req.session.user.id, { alertEmail, weeklyDigest });
    res.json(publicUser(u));
  });

  // Connect Telegram: a one-time link that opens the bot with "/start <code>"; the webhook does the rest.
  api.post('/me/telegram/link', limiter('telegram-link', 60_000, 10), async (req, res) => {
    if (!config.telegram.enabled) throw new HttpError(404, 'Telegram alerts are not set up on this server');
    const code = randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + TELEGRAM_LINK_MS;
    await store.setTelegramLinkCode(req.session.user.id, sha256(code), expiresAt);
    res.json({ url: `https://t.me/${config.telegram.botUsername}?start=${code}`, expiresAt });
  });

  api.post('/me/telegram/test', limiter('telegram-test', 60_000, 5), async (req, res) => {
    const user = await store.getUser(req.session.user.id);
    if (!user?.telegramChatId) throw new HttpError(400, 'Telegram is not connected');
    const r = await notifier.sendTelegram(user.telegramChatId, 'Test from Stock Beat: your alerts will arrive here.');
    if (!r.ok) {
      if (r.blocked) await store.unlinkTelegram(user.id);
      throw new HttpError(502, r.blocked ? 'Telegram says the bot was blocked; connect it again' : "Telegram didn't accept the message; try again later");
    }
    res.status(204).end();
  });

  api.delete('/me/telegram', async (req, res) => {
    await store.unlinkTelegram(req.session.user.id);
    res.status(204).end();
  });

  api.delete('/me', async (req, res) => {
    await store.deleteUser(req.session.user.id);
    res.set('Set-Cookie', 'sp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.status(204).end();
  });

  // ---------- portfolios ----------
  // Every user has at least one. Holdings and sales belong to one; reports can show one or all of them together.
  api.get('/portfolios', async (req, res) => res.json(await store.listPortfolios(req.session.user.id)));

  api.post('/portfolios', limiter('portfolios', 60_000, 20), async (req, res) => {
    const userId = req.session.user.id;
    const { name } = parse(portfolioNameSchema, req.body);
    if ((await store.countPortfolios(userId)) >= MAX_PORTFOLIOS) throw new HttpError(400, `you can keep up to ${MAX_PORTFOLIOS} portfolios`);
    const p = await store.addPortfolio(userId, name);
    if (!p) throw new HttpError(409, `you already have a portfolio called ${name}`);
    res.status(201).json(p);
  });

  api.put('/portfolios/:id', async (req, res) => {
    const { name } = parse(portfolioNameSchema, req.body);
    const r = await store.renamePortfolio(req.session.user.id, parseId(req.params.id), name);
    if (r === 'missing') throw new HttpError(404, 'not found');
    if (r === 'taken') throw new HttpError(409, `you already have a portfolio called ${name}`);
    res.status(204).end();
  });

  api.delete('/portfolios/:id', async (req, res) => {
    const r = await store.removePortfolio(req.session.user.id, parseId(req.params.id));
    if (r === 'missing') throw new HttpError(404, 'not found');
    if (r === 'last') throw new HttpError(400, "you can't remove your only portfolio");
    res.status(204).end();
  });
}

export { publicUser };
