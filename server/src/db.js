import pg from 'pg';
import { SCHEMA } from './schema.js';

/**
 * Minimal async DB interface used by the store:
 *   query(sql, params) -> { rows, rowCount }
 *   exec(sql)          -> run multi-statement SQL
 *   tx(fn)             -> fn receives { query, exec } bound to one transaction
 *   close()
 * Production uses `pg`; tests use an in-process Postgres (PGlite) behind the same interface.
 */
export function createPgDb(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Serverless functions each open their own pool, so keep it tiny.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  pool.on('error', () => {
    // Idle client errors must not crash the process.
    console.error(JSON.stringify({ level: 'error', msg: 'database pool error' }));
  });

  return {
    query: (sql, params = []) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: (sql, params = []) => client.query(sql, params),
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Create tables once; an advisory lock stops concurrent cold starts from racing. */
export async function migrate(db) {
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(727274)');
    await t.exec(SCHEMA);
  });
}
