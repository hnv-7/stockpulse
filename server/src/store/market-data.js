import { n } from './rows.js';

/** Shared market data: daily closes, intraday snapshots, company details, dividends and upcoming events. */
export function marketDataQueries(db, { one, many }) {
  return {
    async saveDailyPrices(symbol, points) {
      if (!points.length) return;
      await db.query(
        `INSERT INTO daily_prices (symbol, date, close)
         SELECT $1, d, c FROM unnest($2::date[], $3::float8[]) AS t(d, c)
         ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
        [symbol, points.map((p) => p.date), points.map((p) => p.close)],
      );
    },
    /** rows: [{symbol, date, close}] - each symbol's close for its own market date. */
    async saveDailyCloses(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO daily_prices (symbol, date, close)
         SELECT s, d, c FROM unnest($1::text[], $2::date[], $3::float8[]) AS t(s, d, c)
         ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
        [rows.map((r) => r.symbol), rows.map((r) => r.date), rows.map((r) => r.close)],
      );
    },
    /** First and last stored close dates of `symbol` as {first, last}, or null when there are none. */
    async seriesBounds(symbol) {
      const r = await one(
        `SELECT to_char(MIN(date), 'YYYY-MM-DD') AS first, to_char(MAX(date), 'YYYY-MM-DD') AS last
           FROM daily_prices WHERE symbol = $1`,
        [symbol],
      );
      return r?.first ? { first: r.first, last: r.last } : null;
    },
    /** Map(symbol -> YYYY-MM-DD of its latest stored close). Symbols with none are absent. */
    async lastCloseDates(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many(
        `SELECT symbol, to_char(MAX(date), 'YYYY-MM-DD') AS d FROM daily_prices WHERE symbol = ANY($1::text[]) GROUP BY symbol`,
        [symbols],
      );
      return new Map(rows.map((r) => [r.symbol, r.d]));
    },
    async getSeriesMany(symbols, fromDate = '1900-01-01') {
      const out = new Map(symbols.map((s) => [s, []]));
      if (!symbols.length) return out;
      const rows = await many(
        `SELECT symbol, to_char(date, 'YYYY-MM-DD') AS date, close FROM daily_prices
         WHERE symbol = ANY($1::text[]) AND date >= $2::date ORDER BY symbol, date`,
        [symbols, fromDate],
      );
      for (const r of rows) out.get(r.symbol).push({ date: r.date, close: Number(r.close) });
      return out;
    },
    /** Stored close of `symbol` on `date`, or null. */
    async closeOn(symbol, date) {
      const r = await one('SELECT close FROM daily_prices WHERE symbol = $1 AND date = $2::date', [symbol, date]);
      return r ? n(r.close) : null;
    },

    // ---------- intraday snapshots ----------
    async saveSnapshots(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO snapshots (symbol, ts, price)
         SELECT s, t, p FROM unnest($1::text[], $2::bigint[], $3::float8[]) AS x(s, t, p)
         ON CONFLICT DO NOTHING`,
        [rows.map((r) => r.symbol), rows.map((r) => r.ts), rows.map((r) => r.price)],
      );
    },
    async getSnapshots(symbol, sinceTs) {
      return (await many('SELECT ts, price FROM snapshots WHERE symbol = $1 AND ts >= $2 ORDER BY ts', [symbol, sinceTs])).map(
        (r) => ({ ts: n(r.ts), price: Number(r.price) }),
      );
    },
    async lastSnapshotTs(symbols) {
      if (!symbols.length) return null;
      return n((await one('SELECT MAX(ts) AS ts FROM snapshots WHERE symbol = ANY($1::text[])', [symbols])).ts);
    },
    /** Map(symbol -> timestamp of its newest snapshot). Symbols with no snapshot are absent. */
    async lastSnapshotTsBySymbol(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many('SELECT symbol, MAX(ts) AS ts FROM snapshots WHERE symbol = ANY($1::text[]) GROUP BY symbol', [symbols]);
      return new Map(rows.map((r) => [r.symbol, n(r.ts)]));
    },
    /** Last fetched price of `symbol` in [fromTs, beforeTs), or null. */
    async lastSnapshotBetween(symbol, fromTs, beforeTs) {
      const r = await one(
        'SELECT price FROM snapshots WHERE symbol = $1 AND ts >= $2 AND ts < $3 ORDER BY ts DESC LIMIT 1',
        [symbol, fromTs, beforeTs],
      );
      return r ? n(r.price) : null;
    },
    /** Intraday prices from before a split are in the old shares; they are only used for the 1-day chart. */
    async deleteSnapshotsBefore(symbol, beforeTs) {
      await db.query('DELETE FROM snapshots WHERE symbol = $1 AND ts < $2', [symbol, beforeTs]);
    },
    async pruneSnapshots(beforeTs) {
      await db.query('DELETE FROM snapshots WHERE ts < $1', [beforeTs]);
    },

    // ---------- company details (shared) ----------
    /** symbol -> {sector, industry, kind, fetchedAt} for the symbols that have been looked up. */
    async stockInfo(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many('SELECT symbol, sector, industry, kind, fetched_at FROM stock_info WHERE symbol = ANY($1::text[])', [symbols]);
      return new Map(
        rows.map((r) => [r.symbol, { sector: r.sector, industry: r.industry, kind: r.kind ?? null, fetchedAt: n(r.fetched_at) }]),
      );
    },
    async saveStockInfo(symbol, profile, fetchedAt) {
      await db.query(
        `INSERT INTO stock_info (symbol, sector, industry, kind, fetched_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (symbol) DO UPDATE SET sector = EXCLUDED.sector, industry = EXCLUDED.industry, kind = EXCLUDED.kind,
           fetched_at = EXCLUDED.fetched_at`,
        [symbol, profile?.sector ?? null, profile?.industry ?? null, profile?.kind ?? null, fetchedAt],
      );
    },

    // ---------- dividends (shared) ----------
    async saveDividends(symbol, items) {
      if (!items.length) return;
      await db.query(
        `INSERT INTO dividends (symbol, ex_date, amount)
         SELECT $1, d, a FROM unnest($2::date[], $3::float8[]) AS t(d, a)
         ON CONFLICT (symbol, ex_date) DO UPDATE SET amount = EXCLUDED.amount`,
        [symbol, items.map((d) => d.date), items.map((d) => d.amount)],
      );
    },
    /** symbol -> [{date, amount}] oldest first. */
    async dividendsFor(symbols) {
      const out = new Map(symbols.map((s) => [s, []]));
      if (!symbols.length) return out;
      const rows = await many(
        `SELECT symbol, to_char(ex_date, 'YYYY-MM-DD') AS date, amount FROM dividends
          WHERE symbol = ANY($1::text[]) ORDER BY symbol, ex_date`,
        [symbols],
      );
      for (const r of rows) out.get(r.symbol).push({ date: r.date, amount: n(r.amount) });
      return out;
    },
    /** symbol -> {from, checkedAt}: how far back its dividends have been fetched, and when. */
    async dividendChecks(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many(
        `SELECT symbol, to_char(from_date, 'YYYY-MM-DD') AS from_date, checked_at FROM dividend_checks WHERE symbol = ANY($1::text[])`,
        [symbols],
      );
      return new Map(rows.map((r) => [r.symbol, { from: r.from_date, checkedAt: n(r.checked_at) }]));
    },
    async markDividendsChecked(symbol, fromDate, at) {
      await db.query(
        `INSERT INTO dividend_checks (symbol, from_date, checked_at) VALUES ($1, $2::date, $3)
         ON CONFLICT (symbol) DO UPDATE SET from_date = LEAST(dividend_checks.from_date, EXCLUDED.from_date), checked_at = EXCLUDED.checked_at`,
        [symbol, fromDate, at],
      );
    },

    // ---------- upcoming events (shared): results dates and ex-dividend dates ----------
    /** symbol -> {earningsDate, earningsEstimate, exDividendDate, fetchedAt}. */
    async stockEvents(symbols) {
      if (!symbols.length) return new Map();
      const rows = await many(
        `SELECT symbol, to_char(earnings_date, 'YYYY-MM-DD') AS earnings_date, earnings_estimate,
                to_char(ex_dividend_date, 'YYYY-MM-DD') AS ex_dividend_date, fetched_at
           FROM stock_events WHERE symbol = ANY($1::text[])`,
        [symbols],
      );
      return new Map(
        rows.map((r) => [
          r.symbol,
          { earningsDate: r.earnings_date, earningsEstimate: !!r.earnings_estimate, exDividendDate: r.ex_dividend_date, fetchedAt: n(r.fetched_at) },
        ]),
      );
    },
    async saveStockEvents(symbol, ev, fetchedAt) {
      await db.query(
        `INSERT INTO stock_events (symbol, earnings_date, earnings_estimate, ex_dividend_date, fetched_at)
         VALUES ($1, $2::date, $3, $4::date, $5)
         ON CONFLICT (symbol) DO UPDATE SET earnings_date = EXCLUDED.earnings_date, earnings_estimate = EXCLUDED.earnings_estimate,
           ex_dividend_date = EXCLUDED.ex_dividend_date, fetched_at = EXCLUDED.fetched_at`,
        [symbol, ev?.earningsDate ?? null, !!ev?.earningsEstimate, ev?.exDividendDate ?? null, fetchedAt],
      );
    },
  };
}
