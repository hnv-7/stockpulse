import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';

export const SESSION_COOKIE = 'sp_session';
const LOGIN_COOKIE = 'sp_login';
const GOOGLE_ISSUER = new URL('https://accounts.google.com');

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Cookie attributes shared by every cookie we set: HttpOnly + SameSite=Lax (+ Secure over HTTPS). */
function cookie(name, value, { secure, maxAgeSec }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAgeSec}`,
  ]
    .filter(Boolean)
    .join('; ');
}
const clearCookie = (name, secure) => cookie(name, '', { secure, maxAgeSec: 0 });

const idTokenSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().email().max(320),
  email_verified: z.boolean().optional(),
  name: z.string().max(255).optional(),
});

/**
 * Google sign-in (OpenID Connect, authorization-code flow + PKCE + state + nonce).
 * `oidcConfig` is injectable so tests can run without contacting Google.
 */
export function createAuth({ store, config, oidcLib = oidc, now = () => Date.now() }) {
  let discovered = null;
  const getOidc = async () => {
    if (!config.google.clientId || !config.google.clientSecret) return null;
    discovered ??= oidcLib.discovery(GOOGLE_ISSUER, config.google.clientId, config.google.clientSecret);
    try {
      return await discovered;
    } catch (e) {
      discovered = null; // retry next time rather than caching a transient failure
      throw e;
    }
  };

  const redirectUri = `${config.baseUrl}/api/auth/callback`;
  const secure = config.secureCookies;

  /** Attach req.session = { user, csrfToken } when a valid session cookie is present. */
  async function loadSession(req, _res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) {
        const s = await store.getSession(sha256(token), now());
        if (s) req.session = s;
      }
      next();
    } catch (e) {
      next(e);
    }
  }

  function requireAuth(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'sign in required' });
    next();
  }

  /**
   * CSRF defence for state-changing requests: the Origin header must match our own origin,
   * and the per-session token must be echoed in X-CSRF-Token.
   */
  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== config.baseUrl) return res.status(403).json({ error: 'forbidden' });
    const sent = req.headers['x-csrf-token'];
    if (!req.session || typeof sent !== 'string' || !safeEqual(sent, req.session.csrfToken)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  }

  async function login(_req, res) {
    const cfg = await getOidc();
    if (!cfg) return res.status(503).json({ error: 'sign-in is not configured' });
    const state = oidcLib.randomState();
    const nonce = oidcLib.randomNonce();
    const verifier = oidcLib.randomPKCECodeVerifier();
    const url = oidcLib.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await oidcLib.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.append(
      'Set-Cookie',
      cookie(LOGIN_COOKIE, JSON.stringify({ state, nonce, verifier }), { secure, maxAgeSec: 600 }),
    );
    res.redirect(302, url.href);
  }

  async function callback(req, res) {
    const fail = (code) => {
      res.append('Set-Cookie', clearCookie(LOGIN_COOKIE, secure));
      res.redirect(302, `/?login_error=${code}`);
    };
    let saved;
    try {
      saved = JSON.parse(parseCookies(req.headers.cookie)[LOGIN_COOKIE] || '');
    } catch {
      return fail('expired');
    }
    if (!saved?.state || !saved?.nonce || !saved?.verifier) return fail('expired');

    try {
      const cfg = await getOidc();
      if (!cfg) return fail('unavailable');
      const tokens = await oidcLib.authorizationCodeGrant(
        cfg,
        new URL(`${config.baseUrl}${req.originalUrl}`),
        { pkceCodeVerifier: saved.verifier, expectedState: saved.state, expectedNonce: saved.nonce, idTokenExpected: true },
      );
      const claims = idTokenSchema.safeParse(tokens.claims());
      if (!claims.success || claims.data.email_verified === false) return fail('unverified');

      const user = await store.upsertUser({
        sub: claims.data.sub,
        email: claims.data.email,
        name: claims.data.name,
      });
      const token = newToken();
      const maxAgeSec = config.sessionDays * 86_400;
      await store.createSession({
        tokenHash: sha256(token),
        userId: user.id,
        csrfToken: newToken(),
        expiresAt: now() + maxAgeSec * 1000,
      });
      res.append('Set-Cookie', clearCookie(LOGIN_COOKIE, secure));
      res.append('Set-Cookie', cookie(SESSION_COOKIE, token, { secure, maxAgeSec }));
      res.redirect(302, '/');
    } catch {
      console.error(JSON.stringify({ level: 'error', msg: 'sign-in failed' }));
      fail('failed');
    }
  }

  async function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await store.deleteSession(sha256(token));
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE, secure));
    res.status(204).end();
  }

  /** Test helper: create a session for a user without going through Google. */
  async function createSessionFor(userId) {
    const token = newToken();
    const csrfToken = newToken();
    await store.createSession({
      tokenHash: sha256(token),
      userId,
      csrfToken,
      expiresAt: now() + config.sessionDays * 86_400_000,
    });
    return { cookie: `${SESSION_COOKIE}=${token}`, csrfToken };
  }

  return { loadSession, requireAuth, requireCsrf, login, callback, logout, createSessionFor };
}
