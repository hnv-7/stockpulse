import { n, user } from './rows.js';

/** Users, sessions, settings and Telegram links. */
export function userQueries(db, { one }) {
  return {
    async upsertUser({ sub, email, name }) {
      return user(
        await one(
          `INSERT INTO users (google_sub, email, name, created_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
           RETURNING *`,
          [sub, email, name ?? null, Date.now()],
        ),
      );
    },
    async getUser(id) {
      return user(await one('SELECT * FROM users WHERE id = $1', [id]));
    },
    /** Change any of the user's settings; a setting left undefined keeps its stored value. */
    async updateUserSettings(id, { alertEmail, weeklyDigest }) {
      return user(
        await one(
          `UPDATE users SET alert_email = COALESCE($2, alert_email), weekly_digest = COALESCE($3, weekly_digest)
            WHERE id = $1 RETURNING *`,
          [id, alertEmail ?? null, weeklyDigest ?? null],
        ),
      );
    },
    /** Users who asked for the weekly summary and haven't had one on `date` (YYYY-MM-DD) yet. */
    async listDigestUsers(date) {
      return (
        await db.query(
          'SELECT * FROM users WHERE weekly_digest = TRUE AND (digest_sent_on IS NULL OR digest_sent_on < $1::date) ORDER BY id',
          [date],
        )
      ).rows.map(user);
    },
    async markDigestSent(id, date) {
      await db.query('UPDATE users SET digest_sent_on = $2::date WHERE id = $1', [id, date]);
    },

    // ---------- Telegram ----------
    /** Remember a (hashed) one-time code that links a Telegram chat to this user until `expiresAt`. */
    async setTelegramLinkCode(id, codeHash, expiresAt) {
      await db.query('UPDATE users SET telegram_link_code = $2, telegram_link_expires = $3 WHERE id = $1', [id, codeHash, expiresAt]);
    },
    /** Link the chat to whoever holds this unexpired code (used once). Returns that user, or null. */
    async linkTelegram(codeHash, chatId, now = Date.now()) {
      return user(
        await one(
          `UPDATE users SET telegram_chat_id = $2, telegram_link_code = NULL, telegram_link_expires = NULL
            WHERE telegram_link_code = $1 AND telegram_link_expires > $3 RETURNING *`,
          [codeHash, chatId, now],
        ),
      );
    },
    async unlinkTelegram(id) {
      await db.query(
        'UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL, telegram_link_expires = NULL WHERE id = $1',
        [id],
      );
    },
    /** Forget a chat for every user it is linked to (after /stop, or when Telegram says the bot was blocked). */
    async unlinkTelegramChat(chatId) {
      return (await db.query('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = $1', [chatId])).rowCount;
    },
    /** Deletes the user and, via ON DELETE CASCADE, all of their data. Orphaned shared prices are pruned. */
    async deleteUser(id) {
      await db.tx(async (t) => {
        await t.query('DELETE FROM users WHERE id = $1', [id]);
        await t.query(
          `DELETE FROM daily_prices WHERE symbol NOT IN (SELECT symbol FROM holdings)
             AND symbol NOT IN (SELECT symbol FROM watchlist) AND symbol NOT IN (SELECT symbol FROM sales)
             AND symbol NOT LIKE '^%'`,
        );
        // Index prices ("^...") are shared by everyone and kept.
        await t.query(
          `DELETE FROM snapshots WHERE symbol NOT IN (SELECT symbol FROM holdings) AND symbol NOT IN (SELECT symbol FROM watchlist)
             AND symbol NOT LIKE '^%'`,
        );
      });
    },

    // ---------- sessions ----------
    async createSession({ tokenHash, userId, csrfToken, expiresAt }) {
      await db.query(
        'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4)',
        [tokenHash, userId, csrfToken, expiresAt],
      );
    },
    async getSession(tokenHash, now = Date.now()) {
      const r = await one(
        `SELECT s.csrf_token, s.expires_at, u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [tokenHash, now],
      );
      return r && { csrfToken: r.csrf_token, expiresAt: n(r.expires_at), user: user(r) };
    },
    async deleteSession(tokenHash) {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },
    async deleteExpiredSessions(now = Date.now()) {
      await db.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    },

    // ---------- rate limits (shared by every server instance) ----------
    /**
     * Count one hit for `key` in a fixed window of `windowMs`. A key whose window has ended starts a new one.
     * Returns {hits, resetAt}.
     */
    async rateLimitHit(key, windowMs, now = Date.now()) {
      const r = await one(
        `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN rate_limits.reset_at <= $3 THEN 1 ELSE rate_limits.hits + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at <= $3 THEN $2 ELSE rate_limits.reset_at END
         RETURNING hits, reset_at`,
        [key, now + windowMs, now],
      );
      return { hits: n(r.hits), resetAt: n(r.reset_at) };
    },
    async rateLimitUndo(key) {
      await db.query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [key]);
    },
    async rateLimitReset(key) {
      await db.query('DELETE FROM rate_limits WHERE key = $1', [key]);
    },
    async pruneRateLimits(now = Date.now()) {
      await db.query('DELETE FROM rate_limits WHERE reset_at <= $1', [now]);
    },
  };
}
