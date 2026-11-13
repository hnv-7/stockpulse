const n = (v) => (v == null ? null : Number(v));

const user = (r) =>
  r && {
    id: n(r.id),
    googleSub: r.google_sub,
    email: r.email,
    name: r.name,
    alertEmail: r.alert_email,
    createdAt: n(r.created_at),
  };

// purchase_date is formatted in SQL so it is always a plain YYYY-MM-DD string (never a timezone-shifted Date).
const HOLDING_COLS = `id, user_id, symbol, name, quantity, invested,
  to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, created_at`;

const holding = (r) =>
  r && {
    id: n(r.id),
    symbol: r.symbol,
    name: r.name,
    quantity: n(r.quantity),
    invested: n(r.invested),
    purchase_date: r.purchase_date ?? null,
    created_at: n(r.created_at),
  };

const LOT_COLS = `id, holding_id, quantity, invested, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, created_at`;
const lot = (r) => ({
  id: n(r.id),
  quantity: n(r.quantity),
  invested: n(r.invested),
  purchase_date: r.purchase_date ?? null,
  created_at: n(r.created_at),
});

const rule = (r) =>
  r && {
    id: n(r.id),
    user_id: n(r.user_id),
    symbol: r.symbol,
    window: r.win,
    threshold_pct: n(r.threshold_pct),
    enabled: r.enabled,
  };

/**
 * Data access. Every query touching user-owned data takes the user id and filters on it,
 * so one user can never read or change another user's rows. All queries are parameterised.
 */
export function createStore(db) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  const many = async (sql, params) => (await db.query(sql, params)).rows;

  /** Attach each holding's purchases (oldest first, undated last). `q` is db.query or a transaction's query. */
  async function attachLots(q, holdings, userId) {
    const rows = (
      await q(`SELECT ${LOT_COLS} FROM holding_lots WHERE user_id = $1 ORDER BY purchase_date ASC NULLS LAST, id`, [userId])
    ).rows;
    const byHolding = new Map();
    for (const r of rows) {
      const k = n(r.holding_id);
      if (!byHolding.has(k)) byHolding.set(k, []);
      byHolding.get(k).push(lot(r));
    }
    return holdings.map((h) => ({ ...h, lots: byHolding.get(h.id) ?? [] }));
  }
  async function loadHolding(q, userId, id) {
    const row = (await q(`SELECT ${HOLDING_COLS} FROM holdings WHERE user_id = $1 AND id = $2`, [userId, id])).rows[0];
    return row ? (await attachLots(q, [holding(row)], userId))[0] : null;
  }
  /** Make the holding's totals and earliest date match its purchases. */
  const resync = (q, holdingId) =>
    q(
      `UPDATE holdings h SET quantity = s.q, invested = s.i, purchase_date = s.d
       FROM (SELECT ROUND(SUM(quantity)::numeric, 4)::double precision AS q,
                    ROUND(SUM(invested)::numeric, 2)::double precision AS i,
                    MIN(purchase_date) AS d
             FROM holding_lots WHERE holding_id = $1) s
       WHERE h.id = $1`,
      [holdingId],
    );

  return {
    // ---------- users & sessions ----------
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
    async updateUserSettings(id, { alertEmail }) {
      return user(await one('UPDATE users SET alert_email = $2 WHERE id = $1 RETURNING *', [id, alertEmail]));
    },
    /** Deletes the user and, via ON DELETE CASCADE, all of their data. Orphaned shared prices are pruned. */
    async deleteUser(id) {
      await db.tx(async (t) => {
        await t.query('DELETE FROM users WHERE id = $1', [id]);
        await t.query(
          'DELETE FROM daily_prices WHERE symbol NOT IN (SELECT symbol FROM holdings)',
        );
        await t.query('DELETE FROM snapshots WHERE symbol NOT IN (SELECT symbol FROM holdings)');
      });
    },
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

    // ---------- holdings ----------
    // A holding is the total of its purchases (lots). holdings.quantity / invested / purchase_date always hold
    // the lots' sum and earliest date, so reports keep reading the holding row.
    async listHoldings(userId) {
      return attachLots(db.query, (await many(`SELECT ${HOLDING_COLS} FROM holdings WHERE user_id = $1 ORDER BY symbol`, [userId])).map(holding), userId);
    },
    async countHoldings(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM holdings WHERE user_id = $1', [userId])).c);
    },
    async getHolding(userId, id) {
      return loadHolding(db.query, userId, id);
    },
    async addHolding(userId, { symbol, name, quantity, invested, purchaseDate = null }) {
      return db.tx(async (t) => {
        const h = (
          await t.query(
            `INSERT INTO holdings (user_id, symbol, name, quantity, invested, purchase_date, created_at)
             VALUES ($1,$2,$3,$4,$5,$6::date,$7) RETURNING id`,
            [userId, symbol, name, quantity, invested, purchaseDate, Date.now()],
          )
        ).rows[0];
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [h.id, userId, quantity, invested, purchaseDate, Date.now()],
        );
        return loadHolding(t.query, userId, h.id);
      });
    },
    /**
     * Overwrite the holding's totals; its purchases collapse into one. purchaseDate: undefined keeps the stored
     * (earliest) date, null clears it, a YYYY-MM-DD string sets it. Used by the single-purchase edit and imports.
     */
    async updateHolding(userId, id, { quantity, invested, purchaseDate }) {
      return db.tx(async (t) => {
        const row = (
          await t.query(
            `UPDATE holdings SET quantity = $3, invested = $4,
               purchase_date = CASE WHEN $5::boolean THEN $6::date ELSE purchase_date END
             WHERE user_id = $1 AND id = $2 RETURNING to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date`,
            [userId, id, quantity, invested, purchaseDate !== undefined, purchaseDate ?? null],
          )
        ).rows[0];
        if (!row) return null;
        await t.query('DELETE FROM holding_lots WHERE holding_id = $1', [id]);
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [id, userId, quantity, invested, row.purchase_date, Date.now()],
        );
        return loadHolding(t.query, userId, id);
      });
    },
    /** Record another purchase of a stock already held. */
    async addLot(userId, holdingId, { quantity, invested, purchaseDate = null }) {
      return db.tx(async (t) => {
        if (!(await t.query('SELECT 1 FROM holdings WHERE id = $1 AND user_id = $2', [holdingId, userId])).rows.length) return null;
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [holdingId, userId, quantity, invested, purchaseDate, Date.now()],
        );
        await resync(t.query, holdingId);
        return loadHolding(t.query, userId, holdingId);
      });
    },
    /** purchaseDate: undefined keeps the lot's date, null clears it. Returns the updated holding, or null. */
    async updateLot(userId, holdingId, lotId, { quantity, invested, purchaseDate }) {
      return db.tx(async (t) => {
        const r = await t.query(
          `UPDATE holding_lots SET quantity = $4, invested = $5,
             purchase_date = CASE WHEN $6::boolean THEN $7::date ELSE purchase_date END
           WHERE id = $1 AND holding_id = $2 AND user_id = $3`,
          [lotId, holdingId, userId, quantity, invested, purchaseDate !== undefined, purchaseDate ?? null],
        );
        if (!r.rowCount) return null;
        await resync(t.query, holdingId);
        return loadHolding(t.query, userId, holdingId);
      });
    },
    /** Remove one purchase. The last remaining purchase cannot be removed (remove the stock instead). */
    async removeLot(userId, holdingId, lotId) {
      return db.tx(async (t) => {
        const lots = (await t.query('SELECT id FROM holding_lots WHERE holding_id = $1 AND user_id = $2', [holdingId, userId])).rows;
        if (!lots.some((l) => n(l.id) === lotId)) return { status: 'missing' };
        if (lots.length < 2) return { status: 'last' };
        await t.query('DELETE FROM holding_lots WHERE id = $1', [lotId]);
        await resync(t.query, holdingId);
        return { status: 'ok', holding: await loadHolding(t.query, userId, holdingId) };
      });
    },
    async removeHolding(userId, id) {
      return db.tx(async (t) => {
        const h = (await t.query('DELETE FROM holdings WHERE user_id = $1 AND id = $2 RETURNING symbol', [userId, id])).rows[0];
        if (!h) return false;
        await t.query('DELETE FROM alert_rules WHERE user_id = $1 AND symbol = $2', [userId, h.symbol]);
        await t.query('DELETE FROM notifications WHERE user_id = $1 AND symbol = $2', [userId, h.symbol]);
        // Shared market data is only dropped once nobody holds the symbol any more.
        const stillUsed = await t.query('SELECT 1 FROM holdings WHERE symbol = $1 LIMIT 1', [h.symbol]);
        if (!stillUsed.rows.length) {
          await t.query('DELETE FROM daily_prices WHERE symbol = $1', [h.symbol]);
          await t.query('DELETE FROM snapshots WHERE symbol = $1', [h.symbol]);
        }
        return true;
      });
    },
    /** Distinct symbols held by anyone: the set the poller needs to fetch. */
    async allSymbols() {
      return (await many('SELECT DISTINCT symbol FROM holdings ORDER BY symbol')).map((r) => r.symbol);
    },
    async listAllHoldings() {
      return (await many(`SELECT ${HOLDING_COLS} FROM holdings`)).map((r) => ({ ...holding(r), userId: n(r.user_id) }));
    },

    // ---------- shared market data ----------
    async saveDailyPrices(symbol, points) {
      if (!points.length) return;
      await db.query(
        `INSERT INTO daily_prices (symbol, date, close)
         SELECT $1, d, c FROM unnest($2::date[], $3::float8[]) AS t(d, c)
         ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
        [symbol, points.map((p) => p.date), points.map((p) => p.close)],
      );
    },
    /** rows: [{symbol, date, close}] - each symbol's close for its own market date. */
    async saveDailyCloses(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO daily_prices (symbol, date, close)
         SELECT s, d, c FROM unnest($1::text[], $2::date[], $3::float8[]) AS t(s, d, c)
         ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
        [rows.map((r) => r.symbol), rows.map((r) => r.date), rows.map((r) => r.close)],
      );
    },
    async getSeriesMany(symbols, fromDate = '1900-01-01') {
      const out = new Map(symbols.map((s) => [s, []]));
      if (!symbols.length) return out;
      const rows = await many(
        `SELECT symbol, to_char(date, 'YYYY-MM-DD') AS date, close FROM daily_prices
         WHERE symbol = ANY($1::text[]) AND date >= $2::date ORDER BY symbol, date`,
        [symbols, fromDate],
      );
      for (const r of rows) out.get(r.symbol).push({ date: r.date, close: Number(r.close) });
      return out;
    },
    async saveSnapshots(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO snapshots (symbol, ts, price)
         SELECT s, t, p FROM unnest($1::text[], $2::bigint[], $3::float8[]) AS x(s, t, p)
         ON CONFLICT DO NOTHING`,
        [rows.map((r) => r.symbol), rows.map((r) => r.ts), rows.map((r) => r.price)],
      );
    },
    async getSnapshots(symbol, sinceTs) {
      return (await many('SELECT ts, price FROM snapshots WHERE symbol = $1 AND ts >= $2 ORDER BY ts', [symbol, sinceTs])).map(
        (r) => ({ ts: n(r.ts), price: Number(r.price) }),
      );
    },
    async lastSnapshotTs(symbols) {
      if (!symbols.length) return null;
      return n((await one('SELECT MAX(ts) AS ts FROM snapshots WHERE symbol = ANY($1::text[])', [symbols])).ts);
    },
    async pruneSnapshots(beforeTs) {
      await db.query('DELETE FROM snapshots WHERE ts < $1', [beforeTs]);
    },

    // ---------- alert rules ----------
    async listRules(userId) {
      return (await many('SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY id', [userId])).map(rule);
    },
    async listEnabledRules() {
      return (await many('SELECT * FROM alert_rules WHERE enabled = TRUE')).map(rule);
    },
    async countRules(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM alert_rules WHERE user_id = $1', [userId])).c);
    },
    async getRule(userId, id) {
      return rule(await one('SELECT * FROM alert_rules WHERE user_id = $1 AND id = $2', [userId, id]));
    },
    async addRule(userId, { symbol, window, thresholdPct }) {
      return rule(
        await one(
          'INSERT INTO alert_rules (user_id, symbol, win, threshold_pct) VALUES ($1,$2,$3,$4) RETURNING *',
          [userId, symbol, window, thresholdPct],
        ),
      );
    },
    async updateRule(userId, id, { thresholdPct, enabled }) {
      return rule(
        await one(
          'UPDATE alert_rules SET threshold_pct = $3, enabled = $4 WHERE user_id = $1 AND id = $2 RETURNING *',
          [userId, id, thresholdPct, enabled],
        ),
      );
    },
    async removeRule(userId, id) {
      return (await db.query('DELETE FROM alert_rules WHERE user_id = $1 AND id = $2', [userId, id])).rowCount > 0;
    },

    // ---------- notifications ----------
    /** Inserts unless the same rule+symbol already notified this user inside the cooldown. Returns whether it inserted. */
    async addNotificationWithCooldown({ userId, ts, ruleId, symbol, message, cooldownMs }) {
      const r = await db.query(
        `INSERT INTO notifications (user_id, ts, rule_id, symbol, message)
         SELECT $1::bigint, $2::bigint, $3::bigint, $4::text, $5::text
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE user_id = $1 AND rule_id = $3 AND symbol = $4 AND ts > $6::bigint
         )`,
        [userId, ts, ruleId, symbol, message, ts - cooldownMs],
      );
      return r.rowCount > 0;
    },
    async listNotifications(userId, limit = 50) {
      return (await many('SELECT * FROM notifications WHERE user_id = $1 ORDER BY ts DESC LIMIT $2', [userId, limit])).map((r) => ({
        id: n(r.id),
        ts: n(r.ts),
        rule_id: n(r.rule_id),
        symbol: r.symbol,
        message: r.message,
        read: r.read,
      }));
    },
    async unreadCount(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read = FALSE', [userId])).c);
    },
    async markAllRead(userId) {
      await db.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE', [userId]);
    },
    async pruneNotifications(beforeTs) {
      await db.query('DELETE FROM notifications WHERE ts < $1', [beforeTs]);
    },
  };
}
