import { buildApp } from '../server/src/build.js';

// Vercel serverless entry. The app (and its DB pool) is created once per warm instance.
let ready;
export default async function handler(req, res) {
  ready ??= buildApp().catch((e) => {
    ready = undefined; // allow a retry on the next request instead of caching the failure
    throw e;
  });
  const { app } = await ready;
  return app(req, res);
}
