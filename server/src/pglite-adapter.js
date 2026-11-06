import { PGlite } from '@electric-sql/pglite';

/**
 * Adapts an in-process Postgres (PGlite) to the same { query, exec, tx, close } interface as the
 * `pg` pool. Used by tests and the local dev server only; never imported by the production entry.
 */
export async function createPgliteDb(dataDir) {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const wrap = (c) => ({
    query: async (sql, params = []) => {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: (sql) => c.exec(sql),
  });
  return {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}
