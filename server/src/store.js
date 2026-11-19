import { userQueries } from './store/users.js';
import { holdingQueries } from './store/holdings.js';
import { watchlistQueries } from './store/watchlist.js';
import { marketDataQueries } from './store/market-data.js';
import { alertQueries } from './store/alerts.js';
import { splitQueries } from './store/splits.js';

export { DEFAULT_PORTFOLIO } from './store/holdings.js';

/**
 * Data access. Every query touching user-owned data takes the user id and filters on it,
 * so one user can never read or change another user's rows. All queries are parameterised.
 * The queries live in ./store/, one file per area; this joins them into one object.
 */
export function createStore(db) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  const many = async (sql, params) => (await db.query(sql, params)).rows;
  const helpers = { one, many };
  return {
    ...userQueries(db, helpers),
    ...holdingQueries(db, helpers),
    ...watchlistQueries(db, helpers),
    ...marketDataQueries(db, helpers),
    ...alertQueries(db, helpers),
    ...splitQueries(db, helpers),
  };
}
