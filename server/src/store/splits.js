import { istDayStart } from '../dates.js';
import { n, round, resync } from './rows.js';

/** Splits and bonus issues (shared), and each user's review of the ones that may change their shares. */
export function splitQueries(db, { one, many }) {
  return {
    /** symbol -> IST date (YYYY-MM-DD) it was last checked for splits. */
    async splitCheckDates(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many(
        `SELECT symbol, to_char(checked_on, 'YYYY-MM-DD') AS d FROM split_checks WHERE symbol = ANY($1::text[])`,
        [symbols],
      );
      return new Map(rows.map((r) => [r.symbol, r.d]));
    },
    async markSplitChecked(symbol, date) {
      await db.query(
        `INSERT INTO split_checks (symbol, checked_on) VALUES ($1, $2::date)
         ON CONFLICT (symbol) DO UPDATE SET checked_on = EXCLUDED.checked_on`,
        [symbol, date],
      );
    },
    async hasSplit(symbol, exDate) {
      return !!(await one('SELECT 1 FROM stock_splits WHERE symbol = $1 AND ex_date = $2::date', [symbol, exDate]));
    },
    /** Returns whether it was new (false when another run recorded it first). */
    async recordSplit({ symbol, exDate, numerator, denominator, priceRatio = null, foundAt }) {
      const r = await db.query(
        `INSERT INTO stock_splits (symbol, ex_date, numerator, denominator, price_ratio, found_at)
         VALUES ($1, $2::date, $3, $4, $5, $6) ON CONFLICT (symbol, ex_date) DO NOTHING`,
        [symbol, exDate, numerator, denominator, priceRatio, foundAt],
      );
      return r.rowCount > 0;
    },
    /**
     * Open a review for every user whose purchases, sales or watchlist entry for `symbol` were entered before the split
     * took effect (anything entered later was presumably entered in the new shares). Returns the new ones as [{id, userId}].
     */
    async createSplitReviews(symbol, exDate, exStartTs, now) {
      const rows = await many(
        `INSERT INTO split_reviews (user_id, symbol, ex_date, created_at)
         SELECT DISTINCT user_id, $1, $2::date, $4::bigint FROM (
           SELECT l.user_id FROM holding_lots l JOIN holdings h ON h.id = l.holding_id
            WHERE h.symbol = $1 AND l.created_at < $3
           UNION
           SELECT user_id FROM sales WHERE symbol = $1 AND created_at < $3
           UNION
           SELECT user_id FROM watchlist WHERE symbol = $1 AND created_at < $3
         ) affected
         ON CONFLICT (user_id, symbol, ex_date) DO NOTHING
         RETURNING id, user_id`,
        [symbol, exDate, exStartTs, now],
      );
      return rows.map((r) => ({ id: n(r.id), userId: n(r.user_id) }));
    },
    /** Pending reviews as [{id, user_id, symbol}], for every user (alerts skip price targets of these). */
    async listPendingSplitReviews() {
      return (await many(`SELECT id, user_id, symbol FROM split_reviews WHERE status = 'pending'`)).map((r) => ({
        id: n(r.id),
        user_id: n(r.user_id),
        symbol: r.symbol,
      }));
    },
    /** A user's pending reviews in short, as [{id, symbol, exDate}]. */
    async pendingSplits(userId) {
      return (
        await many(
          `SELECT id, symbol, to_char(ex_date, 'YYYY-MM-DD') AS ex_date FROM split_reviews
            WHERE user_id = $1 AND status = 'pending' ORDER BY ex_date, id`,
          [userId],
        )
      ).map((r) => ({ id: n(r.id), symbol: r.symbol, exDate: r.ex_date }));
    },
    /**
     * A user's pending reviews with what confirming them would change. Purchases, sales and price targets entered
     * before the ex-date began (IST) are the ones in the old shares. Covers every portfolio of the user.
     */
    async listSplitReviews(userId) {
      const reviews = await many(
        `SELECT r.id, r.symbol, to_char(r.ex_date, 'YYYY-MM-DD') AS ex_date, s.numerator, s.denominator, s.price_ratio
           FROM split_reviews r JOIN stock_splits s ON s.symbol = r.symbol AND s.ex_date = r.ex_date
          WHERE r.user_id = $1 AND r.status = 'pending' ORDER BY r.ex_date, r.id`,
        [userId],
      );
      const out = [];
      for (const r of reviews) {
        const exStart = istDayStart(r.ex_date);
        const lots = await one(
          `SELECT COUNT(*) AS c, COALESCE(SUM(l.quantity), 0) AS q, COALESCE(SUM(l.invested), 0) AS i, MAX(h.name) AS name
             FROM holding_lots l JOIN holdings h ON h.id = l.holding_id
            WHERE h.user_id = $1 AND h.symbol = $2 AND l.created_at < $3`,
          [userId, r.symbol, exStart],
        );
        const sales = await one(
          'SELECT COUNT(*) AS c, MAX(name) AS name FROM sales WHERE user_id = $1 AND symbol = $2 AND created_at < $3',
          [userId, r.symbol, exStart],
        );
        const targets = await one(
          `SELECT COUNT(*) AS c FROM alert_rules WHERE user_id = $1 AND symbol = $2 AND kind = 'price'
             AND (created_at IS NULL OR created_at < $3)`,
          [userId, r.symbol, exStart],
        );
        const watched = await one(
          'SELECT name FROM watchlist WHERE user_id = $1 AND symbol = $2 AND created_at < $3',
          [userId, r.symbol, exStart],
        );
        out.push({
          id: n(r.id),
          symbol: r.symbol,
          name: lots.name ?? sales.name ?? watched?.name ?? r.symbol,
          exDate: r.ex_date,
          reported: { numerator: n(r.numerator), denominator: n(r.denominator) },
          priceRatio: n(r.price_ratio),
          lots: { count: n(lots.c), quantity: round(n(lots.q), 4), invested: round(n(lots.i), 2) },
          sales: n(sales.c),
          priceTargets: n(targets.c),
          watching: !!watched,
        });
      }
      return out;
    },
    /**
     * Confirm a split: purchases and sales of the stock entered before `exStartTs` are restated in today's shares
     * (quantity x ratio; amounts invested and received unchanged, so sale prices / ratio), and price targets set
     * before it are divided by the ratio. ratio = numerator / denominator.
     */
    async applySplitReview(userId, id, { numerator, denominator }, now = Date.now()) {
      return db.tx(async (t) => {
        const r = (
          await t.query(
            `SELECT symbol, to_char(ex_date, 'YYYY-MM-DD') AS ex_date, status FROM split_reviews WHERE user_id = $1 AND id = $2`,
            [userId, id],
          )
        ).rows[0];
        if (!r) return { status: 'missing' };
        if (r.status !== 'pending') return { status: 'resolved' };
        const ratio = numerator / denominator;
        const exStart = istDayStart(r.ex_date);
        const lots = (
          await t.query(
            `UPDATE holding_lots l SET quantity = GREATEST(0.0001, ROUND((l.quantity * $4)::numeric, 4)::double precision)
               FROM holdings h
              WHERE l.holding_id = h.id AND h.user_id = $1 AND h.symbol = $2 AND l.created_at < $3
              RETURNING l.holding_id`,
            [userId, r.symbol, exStart, ratio],
          )
        ).rows;
        for (const holdingId of new Set(lots.map((x) => n(x.holding_id)))) await resync(t.query, holdingId);
        const sales = (
          await t.query(
            `UPDATE sales SET quantity = GREATEST(0.0001, ROUND((quantity * $4)::numeric, 4)::double precision),
                              sale_price = sale_price / $4, split_factor = split_factor * $4
              WHERE user_id = $1 AND symbol = $2 AND created_at < $3 RETURNING id`,
            [userId, r.symbol, exStart, ratio],
          )
        ).rows.map((x) => x.id);
        if (sales.length) {
          await t.query(
            `UPDATE sale_lots SET quantity = GREATEST(0.0001, ROUND((quantity * $2)::numeric, 4)::double precision)
              WHERE sale_id = ANY($1::bigint[])`,
            [sales, ratio],
          );
        }
        const targets = await t.query(
          `UPDATE alert_rules SET target_price = target_price / $4
            WHERE user_id = $1 AND symbol = $2 AND kind = 'price' AND (created_at IS NULL OR created_at < $3)`,
          [userId, r.symbol, exStart, ratio],
        );
        const watching = await t.query(
          'UPDATE watchlist SET added_price = added_price / $4 WHERE user_id = $1 AND symbol = $2 AND created_at < $3',
          [userId, r.symbol, exStart, ratio],
        );
        await t.query(
          `UPDATE split_reviews SET status = 'applied', numerator = $3, denominator = $4, resolved_at = $5
            WHERE user_id = $1 AND id = $2`,
          [userId, id, numerator, denominator, now],
        );
        return {
          status: 'ok', symbol: r.symbol, lots: lots.length, sales: sales.length, priceTargets: targets.rowCount, watching: watching.rowCount > 0,
        };
      });
    },
    async dismissSplitReview(userId, id, now = Date.now()) {
      const r = await db.query(
        `UPDATE split_reviews SET status = 'dismissed', resolved_at = $3 WHERE user_id = $1 AND id = $2 AND status = 'pending'`,
        [userId, id, now],
      );
      return r.rowCount > 0;
    },
  };
}
