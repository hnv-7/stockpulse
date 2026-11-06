import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { createPgliteDb } from './pglite-adapter.js';
import { buildApp } from './build.js';

/**
 * Local development server: no Postgres install needed (data lives in server/.devdata).
 * With DEV_DEMO_USER=1 it creates a demo user and prints a session cookie so you can use the
 * UI without Google credentials. This file is not part of the production/Vercel entry points.
 */
const config = getConfig();
if (config.secureCookies) throw new Error('dev server is for http://localhost only');

const dir = fileURLToPath(new URL('../.devdata', import.meta.url));
mkdirSync(dir, { recursive: true });
const db = await createPgliteDb(dir);
const { app, store, auth } = await buildApp({ db, config });

if (process.env.DEV_DEMO_USER === '1') {
  const user = await store.upsertUser({ sub: 'dev-demo', email: 'demo@example.test', name: 'Demo User' });
  const s = await auth.createSessionFor(user.id);
  console.log(`DEV session cookie (paste into browser): ${s.cookie}`);
}

app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'StockPulse dev server', host: config.host, port: config.port }));
});
