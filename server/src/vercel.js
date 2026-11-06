import express from 'express';
import { buildApp } from './build.js';

/**
 * Vercel entrypoint for the `server` service. Vercel needs an Express app as the default export;
 * the real app (database pool, migrations, routes) is built lazily on the first request and then
 * reused while this instance stays warm. Not used when self-hosting (see index.js).
 */
let ready;
const outer = express();

outer.use(async (req, res, next) => {
  try {
    ready ??= buildApp().catch((e) => {
      ready = undefined; // retry on the next request instead of caching the failure
      throw e;
    });
    const { app } = await ready;
    app(req, res, next);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: e?.message }));
    res.status(503).json({ error: 'service unavailable' });
  }
});

export default outer;
