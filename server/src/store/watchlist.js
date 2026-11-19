import { n, WATCH_COLS, watch, released } from './rows.js';

/** Stocks a user follows without (necessarily) holding them. */
export function watchlistQueries(db, { one, many }) {
  return {
    async listWatchlist(userId) {
      return (await many(`SELECT ${WATCH_COLS} FROM watchlist WHERE user_id = $1 ORDER BY created_at, id`, [userId])).map(watch);
    },
    async listAllWatchlist() {
      return (await many(`SELECT ${WATCH_COLS} FROM watchlist`)).map((r) => ({ ...watch(r), userId: n(r.user_id) }));
    },
    async countWatchlist(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM watchlist WHERE user_id = $1', [userId])).c);
    },
    async isWatched(userId, symbol) {
      return !!(await one('SELECT 1 FROM watchlist WHERE user_id = $1 AND symbol = $2', [userId, symbol]));
    },
    /** Returns the new entry, or null when the stock is already on the user's watchlist. */
    async addWatch(userId, { symbol, name, note = '', addedPrice = null }) {
      return watch(
        await one(
          `INSERT INTO watchlist (user_id, symbol, name, note, added_price, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id, symbol) DO NOTHING RETURNING ${WATCH_COLS}`,
          [userId, symbol, name, note, addedPrice, Date.now()],
        ),
      );
    },
    async updateWatchNote(userId, id, note) {
      return watch(
        await one(`UPDATE watchlist SET note = $3 WHERE user_id = $1 AND id = $2 RETURNING ${WATCH_COLS}`, [userId, id, note]),
      );
    },
    /** Stop watching; the stock's alerts go too unless the user holds it. */
    async removeWatch(userId, id) {
      return db.tx(async (t) => {
        const w = (await t.query('DELETE FROM watchlist WHERE user_id = $1 AND id = $2 RETURNING symbol', [userId, id])).rows[0];
        if (!w) return false;
        await released(t, userId, w.symbol);
        return true;
      });
    },
  };
}
