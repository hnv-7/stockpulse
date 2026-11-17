const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

/** Read lazily so tests (and Vercel) can set env vars before first use. */
export function getConfig(env = process.env) {
  const baseUrl = (env.APP_BASE_URL || `http://localhost:${int(env.PORT, 4000)}`).replace(/\/+$/, '');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 4000),
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    databaseUrl: env.DATABASE_URL || '',
    cronSecret: env.CRON_SECRET || '',
    timezone: 'Asia/Kolkata',
    maxHoldingsPerUser: int(env.MAX_HOLDINGS_PER_USER, 50),
    maxWatchlistPerUser: int(env.MAX_WATCHLIST_PER_USER, 50),
    maxRulesPerUser: int(env.MAX_RULES_PER_USER, 20),
    sessionDays: 30,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || env.SMTP_USER || '',
    },
  };
}
