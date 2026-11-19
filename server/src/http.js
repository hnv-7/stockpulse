import { rateLimit } from 'express-rate-limit';
import { sha256 } from './auth.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message || 'invalid request');
  return r.data;
};

export const parseId = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  return id;
};

/**
 * An express-rate-limit store kept in Postgres, so every server instance counts against the same limit (on serverless
 * hosting each instance has its own memory, and a cold start would reset an in-memory count). Keys are the limiter's
 * name plus the client's address, hashed so no addresses are stored.
 */
export function dbRateLimitStore(store, name) {
  let windowMs = 60_000;
  const k = (key) => sha256(`${name}|${key}`);
  return {
    prefix: name,
    localKeys: false,
    init(options) {
      windowMs = options.windowMs;
    },
    async increment(key) {
      const r = await store.rateLimitHit(k(key), windowMs);
      return { totalHits: r.hits, resetTime: new Date(r.resetAt) };
    },
    async decrement(key) {
      await store.rateLimitUndo(k(key));
    },
    async resetKey(key) {
      await store.rateLimitReset(k(key));
    },
  };
}

/**
 * Returns limiter(name, windowMs, limit). Each name is its own counter. If the database can't be reached the request
 * is let through rather than refused (the request would most likely fail on the database anyway).
 */
export function createLimiter(store) {
  return (name, windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'too many requests, slow down' },
      passOnStoreError: true,
      ...(store ? { store: dbRateLimitStore(store, name) } : {}),
    });
}
