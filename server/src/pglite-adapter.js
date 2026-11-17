import { PGlite } from '@electric-sql/pglite';

/**
 * Start PGlite with Node's event loop held open until it is ready.
 *
 * PGlite's startup awaits WebAssembly compiles (pglite.wasm, initdb.wasm). These run on V8
 * background threads and hold no libuv handle, so while PGlite waits on one, the event loop can
 * have nothing else to wait on. Node then blocks the main thread in NodePlatform::DrainTasks until
 * every V8 background task finishes. If one of them is a Maglev JIT compile that needs a garbage
 * collection, it waits for the main thread to collect, and the main thread waits for it: the
 * process deadlocks, idle and silent, forever (nodejs/node#54918). Since the main thread is stuck
 * in native code, no JS timeout can fire to recover. An active timer keeps the loop running
 * instead, so Node never enters that wait and the GC request is served as usual.
 */
async function startPglite(dataDir) {
  const keepLoopRunning = setInterval(() => {}, 60_000);
  try {
    const pg = new PGlite(dataDir);
    await pg.waitReady;
    return pg;
  } finally {
    clearInterval(keepLoopRunning);
  }
}

/**
 * Adapts an in-process Postgres (PGlite) to the same { query, exec, tx, close } interface as the
 * `pg` pool. Used by tests and the local dev server only; never imported by the production entry.
 */
export async function createPgliteDb(dataDir) {
  const pg = await startPglite(dataDir);
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
