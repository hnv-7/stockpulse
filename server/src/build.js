import { getConfig } from './config.js';
import { createPgDb, migrate } from './db.js';
import { createStore } from './store.js';
import { createTracker } from './tracker.js';
import { createNotifier } from './notifier.js';
import { createAuth } from './auth.js';
import { createApp } from './app.js';

/**
 * Wire everything together. `db` is injectable so tests can pass an in-process Postgres.
 * Returns the Express app plus the pieces tests need.
 */
export async function buildApp({ db, config = getConfig(), deps = {}, oidcLib } = {}) {
  const database = db ?? createPgDb(config.databaseUrl);
  await migrate(database);
  const store = createStore(database);
  const notifier = deps.notifier ?? createNotifier(config);
  const tracker = createTracker(store, {
    notifier,
    getQuotes: deps.getQuotes,
    getDailyHistory: deps.getDailyHistory,
    getSplits: deps.getSplits,
    getNseCloses: deps.getNseCloses,
  });
  const auth = createAuth({ store, config, oidcLib });
  const app = createApp({ store, tracker, auth, config, notifier, deps });
  return { app, store, tracker, auth, config, db: database };
}
