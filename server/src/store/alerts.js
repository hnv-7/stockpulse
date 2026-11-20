import { n, rule } from './rows.js';

/** Alert rules and the notifications they (and other events) create. */
export function alertQueries(db, { one, many }) {
  return {
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
    async addRule(userId, { kind = 'drop', symbol, window = null, thresholdPct = null, direction = null, targetPrice = null }) {
      return rule(
        await one(
          `INSERT INTO alert_rules (user_id, kind, symbol, win, threshold_pct, direction, target_price, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [userId, kind, symbol, window, thresholdPct, direction, targetPrice, Date.now()],
        ),
      );
    },
    /** Change a rule's level (percent for drop rules, price for price rules) and/or switch it on or off. */
    async updateRule(userId, id, { thresholdPct = null, targetPrice = null, enabled }) {
      return rule(
        await one(
          `UPDATE alert_rules
              SET threshold_pct = COALESCE($3, threshold_pct), target_price = COALESCE($4, target_price), enabled = $5
            WHERE user_id = $1 AND id = $2 RETURNING *`,
          [userId, id, thresholdPct, targetPrice, enabled],
        ),
      );
    },
    /** Switch a rule off (used after a one-shot price alert has fired). */
    async disableRule(userId, id) {
      await db.query('UPDATE alert_rules SET enabled = FALSE WHERE user_id = $1 AND id = $2', [userId, id]);
    },
    async removeRule(userId, id) {
      return (await db.query('DELETE FROM alert_rules WHERE user_id = $1 AND id = $2', [userId, id])).rowCount > 0;
    },

    // ---------- notifications ----------
    async addNotification({ userId, ts, symbol, message }) {
      await db.query('INSERT INTO notifications (user_id, ts, symbol, message) VALUES ($1, $2, $3, $4)', [
        userId, ts, symbol, message,
      ]);
    },
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
      return (
        await many('SELECT * FROM notifications WHERE user_id = $1 AND cleared = FALSE ORDER BY ts DESC, id DESC LIMIT $2', [userId, limit])
      ).map((r) => ({
        id: n(r.id),
        ts: n(r.ts),
        rule_id: n(r.rule_id),
        symbol: r.symbol,
        message: r.message,
        read: r.read,
      }));
    },
    /** How many alerts from rules reached the user since `sinceTs` (for the weekly summary). */
    async countAlertsSince(userId, sinceTs) {
      return n((await one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND rule_id IS NOT NULL AND ts >= $2', [userId, sinceTs])).c);
    },
    async unreadCount(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read = FALSE AND cleared = FALSE', [userId])).c);
    },
    async markAllRead(userId) {
      await db.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE', [userId]);
    },
    /** Hide the given notifications (or all of them when `ids` is null) from the user's list. Returns how many. */
    async clearNotifications(userId, ids = null) {
      const r = ids
        ? await db.query('UPDATE notifications SET cleared = TRUE, read = TRUE WHERE user_id = $1 AND cleared = FALSE AND id = ANY($2::bigint[])', [
            userId, ids,
          ])
        : await db.query('UPDATE notifications SET cleared = TRUE, read = TRUE WHERE user_id = $1 AND cleared = FALSE', [userId]);
      return r.rowCount;
    },
    async pruneNotifications(beforeTs) {
      await db.query('DELETE FROM notifications WHERE ts < $1', [beforeTs]);
    },

    // ---------- allocation targets ----------
    /** Target percentage per sector for a scope (a portfolio id, or 0 for all portfolios together). */
    async allocationTargets(userId, scope) {
      return (
        await many('SELECT sector, target_pct FROM allocation_targets WHERE user_id = $1 AND scope = $2 ORDER BY target_pct DESC, sector', [
          userId, scope,
        ])
      ).map((r) => ({ sector: r.sector, pct: n(r.target_pct) }));
    },
    /** Replace the scope's targets. */
    async setAllocationTargets(userId, scope, targets) {
      await db.tx(async (t) => {
        await t.query('DELETE FROM allocation_targets WHERE user_id = $1 AND scope = $2', [userId, scope]);
        for (const { sector, pct } of targets) {
          await t.query('INSERT INTO allocation_targets (user_id, scope, sector, target_pct) VALUES ($1, $2, $3, $4)', [
            userId, scope, sector, pct,
          ]);
        }
      });
    },
  };
}
