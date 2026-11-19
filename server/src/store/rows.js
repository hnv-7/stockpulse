/** Row mappers and small helpers shared by the store modules. */

export const n = (v) => (v == null ? null : Number(v));
export const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Thrown inside a transaction to roll it back while still returning a normal result to the caller. */
export class Rejected extends Error {
  constructor(result) {
    super(result.status);
    this.result = result;
  }
}

export const user = (r) =>
  r && {
    id: n(r.id),
    googleSub: r.google_sub,
    email: r.email,
    name: r.name,
    alertEmail: r.alert_email,
    weeklyDigest: !!r.weekly_digest,
    telegramChatId: r.telegram_chat_id ?? null,
    createdAt: n(r.created_at),
  };

// purchase_date is formatted in SQL so it is always a plain YYYY-MM-DD string (never a timezone-shifted Date).
export const HOLDING_COLS = `id, user_id, portfolio_id, symbol, name, quantity, invested,
  to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, created_at`;

export const holding = (r) =>
  r && {
    id: n(r.id),
    portfolioId: n(r.portfolio_id),
    symbol: r.symbol,
    name: r.name,
    quantity: n(r.quantity),
    invested: n(r.invested),
    purchase_date: r.purchase_date ?? null,
    created_at: n(r.created_at),
  };

export const LOT_COLS = `id, holding_id, quantity, invested, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, created_at`;
export const lot = (r) => ({
  id: n(r.id),
  quantity: n(r.quantity),
  invested: n(r.invested),
  purchase_date: r.purchase_date ?? null,
  created_at: n(r.created_at),
});

export const WATCH_COLS = 'id, user_id, symbol, name, note, added_price, created_at';
export const watch = (r) =>
  r && {
    id: n(r.id),
    symbol: r.symbol,
    name: r.name,
    note: r.note,
    added_price: n(r.added_price),
    created_at: n(r.created_at),
  };

export const SALE_COLS = `id, portfolio_id, symbol, name, quantity, sale_price, charges, cost_basis,
  to_char(sale_date, 'YYYY-MM-DD') AS sale_date, created_at, split_factor`;
export const sale = (r) => {
  const quantity = n(r.quantity);
  const salePrice = n(r.sale_price);
  const charges = n(r.charges);
  const costBasis = n(r.cost_basis);
  const proceeds = round(quantity * salePrice, 2);
  const realised = round(proceeds - charges - costBasis, 2);
  return {
    id: n(r.id),
    portfolioId: n(r.portfolio_id),
    symbol: r.symbol,
    name: r.name,
    quantity,
    salePrice,
    charges,
    proceeds,
    costBasis,
    realised,
    realisedPct: costBasis > 0 ? (realised / costBasis) * 100 : null,
    saleDate: r.sale_date,
    // > 1 when a later split or bonus was confirmed: quantity and price are then in today's shares.
    splitFactor: r.split_factor == null ? 1 : n(r.split_factor),
  };
};

export const rule = (r) =>
  r && {
    id: n(r.id),
    user_id: n(r.user_id),
    kind: r.kind,
    symbol: r.symbol,
    window: r.win,
    threshold_pct: n(r.threshold_pct),
    direction: r.direction,
    target_price: n(r.target_price),
    enabled: r.enabled,
  };

/** Make a holding's totals and earliest date match its purchases. `q` is db.query or a transaction's query. */
export const resync = (q, holdingId) =>
  q(
    `UPDATE holdings h SET quantity = s.q, invested = s.i, purchase_date = s.d
     FROM (SELECT ROUND(SUM(quantity)::numeric, 4)::double precision AS q,
                  ROUND(SUM(invested)::numeric, 2)::double precision AS i,
                  MIN(purchase_date) AS d
           FROM holding_lots WHERE holding_id = $1) s
     WHERE h.id = $1`,
    [holdingId],
  );

/**
 * After a user stops holding or watching `symbol`: their alerts and notifications for it go once they neither hold
 * nor watch it, and shared prices go once nobody does. Daily closes are kept while any sale of it exists, so the
 * value-over-time chart can still show a sold stock for the time it was held. `t` is a transaction.
 */
export async function released(t, userId, symbol) {
  const mine = await t.query(
    'SELECT 1 FROM holdings WHERE user_id = $1 AND symbol = $2 UNION ALL SELECT 1 FROM watchlist WHERE user_id = $1 AND symbol = $2 LIMIT 1',
    [userId, symbol],
  );
  if (!mine.rows.length) {
    await t.query('DELETE FROM alert_rules WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
    await t.query('DELETE FROM notifications WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
  }
  const anyone = await t.query(
    'SELECT 1 FROM holdings WHERE symbol = $1 UNION ALL SELECT 1 FROM watchlist WHERE symbol = $1 LIMIT 1',
    [symbol],
  );
  if (!anyone.rows.length) {
    const sold = await t.query('SELECT 1 FROM sales WHERE symbol = $1 LIMIT 1', [symbol]);
    if (!sold.rows.length) await t.query('DELETE FROM daily_prices WHERE symbol = $1', [symbol]);
    await t.query('DELETE FROM snapshots WHERE symbol = $1', [symbol]);
  }
}
