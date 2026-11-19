import { n, round, Rejected, HOLDING_COLS, holding, LOT_COLS, lot, SALE_COLS, sale, resync, released } from './rows.js';

/** The name of the portfolio every user starts with. */
export const DEFAULT_PORTFOLIO = 'Main';

/**
 * Portfolios, holdings (each the total of its purchases, or lots) and sales. A user has one or more portfolios, and
 * every holding and sale belongs to one of them. holdings.quantity / invested / purchase_date always hold the lots'
 * sum and earliest date, so reports keep reading the holding row.
 */
export function holdingQueries(db, { one, many }) {
  /** The user's first portfolio, created if they have none yet. `q` is db.query or a transaction's query. */
  async function defaultPortfolio(q, userId) {
    const found = (await q('SELECT id FROM portfolios WHERE user_id = $1 ORDER BY id LIMIT 1', [userId])).rows[0];
    if (found) return n(found.id);
    await q(
      'INSERT INTO portfolios (user_id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO NOTHING',
      [userId, DEFAULT_PORTFOLIO, Date.now()],
    );
    return n((await q('SELECT id FROM portfolios WHERE user_id = $1 ORDER BY id LIMIT 1', [userId])).rows[0].id);
  }

  /** Attach each holding's purchases (oldest first, undated last). */
  async function attachLots(q, holdings, userId) {
    const rows = (
      await q(`SELECT ${LOT_COLS} FROM holding_lots WHERE user_id = $1 ORDER BY purchase_date ASC NULLS LAST, id`, [userId])
    ).rows;
    const byHolding = new Map();
    for (const r of rows) {
      const k = n(r.holding_id);
      if (!byHolding.has(k)) byHolding.set(k, []);
      byHolding.get(k).push(lot(r));
    }
    return holdings.map((h) => ({ ...h, lots: byHolding.get(h.id) ?? [] }));
  }
  async function loadHolding(q, userId, id) {
    const row = (await q(`SELECT ${HOLDING_COLS} FROM holdings WHERE user_id = $1 AND id = $2`, [userId, id])).rows[0];
    return row ? (await attachLots(q, [holding(row)], userId))[0] : null;
  }

  /** Delete a holding, then tidy up what nobody needs any more (see `released`). `t` is a transaction. */
  async function dropHolding(t, userId, id) {
    const h = (await t.query('DELETE FROM holdings WHERE user_id = $1 AND id = $2 RETURNING symbol', [userId, id])).rows[0];
    if (!h) return false;
    await released(t, userId, h.symbol);
    return true;
  }

  /** Sell inside a transaction `t`. See sellShares. */
  async function sellInTx(t, userId, holdingId, { quantity, salePrice, charges = 0, saleDate }) {
    const h = (await t.query('SELECT symbol, name, portfolio_id FROM holdings WHERE id = $1 AND user_id = $2', [holdingId, userId])).rows[0];
    if (!h) return { status: 'missing' };
    const lots = (
      await t.query(
        `SELECT ${LOT_COLS} FROM holding_lots WHERE holding_id = $1 AND user_id = $2
         ORDER BY purchase_date ASC NULLS LAST, id`,
        [holdingId, userId],
      )
    ).rows.map(lot);
    const held = round(lots.reduce((s, l) => s + l.quantity, 0), 4);
    if (round(quantity, 4) > held) return { status: 'too_many', held };

    // Plan first and write afterwards: a rejected sale must leave every purchase untouched.
    let left = round(quantity, 4);
    let costBasis = 0;
    const plan = [];
    for (const l of lots) {
      if (left <= 0) break;
      if (l.purchase_date && saleDate < l.purchase_date) return { status: 'before_purchase', date: l.purchase_date };
      const take = Math.min(l.quantity, left);
      left = round(left - take, 4);
      if (take >= l.quantity) {
        costBasis += l.invested;
        plan.push({ id: l.id, remove: true, used: { quantity: l.quantity, invested: l.invested, date: l.purchase_date } });
      } else {
        const cost = round((l.invested * take) / l.quantity, 2);
        costBasis += cost;
        plan.push({
          id: l.id,
          quantity: round(l.quantity - take, 4),
          invested: Math.max(0.01, round(l.invested - cost, 2)),
          used: { quantity: take, invested: cost, date: l.purchase_date },
        });
      }
    }
    for (const p of plan) {
      if (p.remove) await t.query('DELETE FROM holding_lots WHERE id = $1', [p.id]);
      else await t.query('UPDATE holding_lots SET quantity = $2, invested = $3 WHERE id = $1', [p.id, p.quantity, p.invested]);
    }
    const saleRow = await t.query(
      `INSERT INTO sales (user_id, portfolio_id, symbol, name, quantity, sale_price, charges, cost_basis, sale_date, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10) RETURNING ${SALE_COLS}`,
      [userId, h.portfolio_id, h.symbol, h.name, round(quantity, 4), salePrice, charges, round(costBasis, 2), saleDate, Date.now()],
    );
    const saleId = saleRow.rows[0].id;
    for (const p of plan) {
      await t.query('INSERT INTO sale_lots (sale_id, quantity, invested, purchase_date) VALUES ($1,$2,$3,$4::date)', [
        saleId, p.used.quantity, p.used.invested, p.used.date,
      ]);
    }
    let remaining = null;
    if (round(held - quantity, 4) <= 0) {
      await dropHolding(t, userId, holdingId);
    } else {
      await resync(t.query, holdingId);
      remaining = await loadHolding(t.query, userId, holdingId);
    }
    return { status: 'ok', sale: sale(saleRow.rows[0]), holding: remaining };
  }

  /**
   * Give a sale's purchases back to the holding in the sale's portfolio (recreating the holding if the stock was fully
   * sold) and delete the sale. Purchases with the same date are merged, so selling and un-selling leaves the lots as
   * they were.
   */
  async function undoSaleInTx(t, userId, saleId, maxHoldings) {
    const s = (
      await t.query('SELECT id, portfolio_id, symbol, name, created_at FROM sales WHERE id = $1 AND user_id = $2', [saleId, userId])
    ).rows[0];
    if (!s) return { status: 'missing' };
    const portfolioId = s.portfolio_id ?? (await defaultPortfolio(t.query, userId));
    const used = (
      await t.query(
        `SELECT quantity, invested, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date
         FROM sale_lots WHERE sale_id = $1 ORDER BY id`,
        [saleId],
      )
    ).rows.map((r) => ({ quantity: n(r.quantity), invested: n(r.invested), date: r.purchase_date ?? null }));
    // A sale with no recorded purchases still gives its shares back, as one undated purchase.
    if (!used.length) {
      const whole = (await t.query('SELECT quantity, cost_basis FROM sales WHERE id = $1', [saleId])).rows[0];
      used.push({ quantity: n(whole.quantity), invested: Math.max(0.01, n(whole.cost_basis)), date: null });
    }

    let holdingId = (
      await t.query('SELECT id FROM holdings WHERE user_id = $1 AND portfolio_id = $2 AND symbol = $3', [userId, portfolioId, s.symbol])
    ).rows[0]?.id;
    const reopened = holdingId == null;
    if (reopened) {
      if (maxHoldings && n((await t.query('SELECT COUNT(*) AS c FROM holdings WHERE user_id = $1', [userId])).rows[0].c) >= maxHoldings) {
        return { status: 'cap' };
      }
      holdingId = (
        await t.query(
          `INSERT INTO holdings (user_id, portfolio_id, symbol, name, quantity, invested, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            userId, portfolioId, s.symbol, s.name,
            used.reduce((a, u) => a + u.quantity, 0),
            Math.max(0.01, used.reduce((a, u) => a + u.invested, 0)),
            Date.now(),
          ],
        )
      ).rows[0].id;
    }
    for (const u of used) {
      const same = (
        await t.query('SELECT id FROM holding_lots WHERE holding_id = $1 AND purchase_date IS NOT DISTINCT FROM $2::date ORDER BY id LIMIT 1', [
          holdingId, u.date,
        ])
      ).rows[0];
      if (same) {
        await t.query('UPDATE holding_lots SET quantity = quantity + $2, invested = invested + $3 WHERE id = $1', [same.id, u.quantity, u.invested]);
      } else {
        // Dated as when the sale was recorded: its quantities are in the shares of that time, so a split confirmed
        // later still treats them as from before it.
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [holdingId, userId, u.quantity, u.invested, u.date, n(s.created_at)],
        );
      }
    }
    await resync(t.query, holdingId);
    await t.query('DELETE FROM sales WHERE id = $1', [saleId]);
    return { status: 'ok', holdingId: n(holdingId), reopened };
  }

  /** "AND portfolio_id = $k" when a portfolio is chosen, else nothing (every portfolio). */
  const inPortfolio = (portfolioId, k, col = 'portfolio_id') => (portfolioId == null ? '' : ` AND ${col} = $${k}`);
  const withPortfolio = (params, portfolioId) => (portfolioId == null ? params : [...params, portfolioId]);

  return {
    // ---------- portfolios ----------
    async listPortfolios(userId) {
      await defaultPortfolio(db.query, userId);
      return (
        await many(
          `SELECT p.id, p.name, p.created_at, COUNT(h.id) AS holdings
             FROM portfolios p LEFT JOIN holdings h ON h.portfolio_id = p.id
            WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.id`,
          [userId],
        )
      ).map((r) => ({ id: n(r.id), name: r.name, holdings: n(r.holdings) }));
    },
    async defaultPortfolioId(userId) {
      return defaultPortfolio(db.query, userId);
    },
    async ownsPortfolio(userId, id) {
      return !!(await one('SELECT 1 FROM portfolios WHERE user_id = $1 AND id = $2', [userId, id]));
    },
    async countPortfolios(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM portfolios WHERE user_id = $1', [userId])).c);
    },
    /** Returns the new portfolio, or null when the user already has one with this name. */
    async addPortfolio(userId, name) {
      await defaultPortfolio(db.query, userId);
      const r = await one(
        'INSERT INTO portfolios (user_id, name, created_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, name) DO NOTHING RETURNING id, name',
        [userId, name, Date.now()],
      );
      return r && { id: n(r.id), name: r.name, holdings: 0 };
    },
    /** Returns 'ok', 'missing' or 'taken' (another portfolio has the name). */
    async renamePortfolio(userId, id, name) {
      const clash = await one('SELECT id FROM portfolios WHERE user_id = $1 AND name = $2 AND id <> $3', [userId, name, id]);
      if (clash) return 'taken';
      const r = await db.query('UPDATE portfolios SET name = $3 WHERE user_id = $1 AND id = $2', [userId, id, name]);
      return r.rowCount ? 'ok' : 'missing';
    },
    /**
     * Delete a portfolio with its holdings and sales. The last one can't go. Returns 'ok', 'missing' or 'last'.
     * Allocation targets set for it go too.
     */
    async removePortfolio(userId, id) {
      return db.tx(async (t) => {
        const all = (await t.query('SELECT id FROM portfolios WHERE user_id = $1', [userId])).rows.map((r) => n(r.id));
        if (!all.includes(id)) return 'missing';
        if (all.length < 2) return 'last';
        const symbols = (await t.query('SELECT DISTINCT symbol FROM holdings WHERE portfolio_id = $1', [id])).rows.map((r) => r.symbol);
        await t.query('DELETE FROM portfolios WHERE id = $1', [id]);
        await t.query('DELETE FROM allocation_targets WHERE user_id = $1 AND scope = $2', [userId, id]);
        for (const s of symbols) await released(t, userId, s);
        return 'ok';
      });
    },

    // ---------- holdings ----------
    /** The user's holdings in one portfolio, or in all of them when portfolioId is null. */
    async listHoldings(userId, portfolioId = null) {
      const rows = await many(
        `SELECT ${HOLDING_COLS} FROM holdings WHERE user_id = $1${inPortfolio(portfolioId, 2)} ORDER BY symbol, portfolio_id`,
        withPortfolio([userId], portfolioId),
      );
      return attachLots(db.query, rows.map(holding), userId);
    },
    async countHoldings(userId) {
      return n((await one('SELECT COUNT(*) AS c FROM holdings WHERE user_id = $1', [userId])).c);
    },
    async getHolding(userId, id) {
      return loadHolding(db.query, userId, id);
    },
    /** First purchase of a stock in a portfolio (the user's first portfolio when none is given). */
    async addHolding(userId, { symbol, name, quantity, invested, purchaseDate = null, portfolioId = null }) {
      return db.tx(async (t) => {
        const pid = portfolioId ?? (await defaultPortfolio(t.query, userId));
        const h = (
          await t.query(
            `INSERT INTO holdings (user_id, portfolio_id, symbol, name, quantity, invested, purchase_date, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8) RETURNING id`,
            [userId, pid, symbol, name, quantity, invested, purchaseDate, Date.now()],
          )
        ).rows[0];
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [h.id, userId, quantity, invested, purchaseDate, Date.now()],
        );
        return loadHolding(t.query, userId, h.id);
      });
    },
    /**
     * Overwrite the holding's totals; its purchases collapse into one. purchaseDate: undefined keeps the stored
     * (earliest) date, null clears it, a YYYY-MM-DD string sets it. Used by the single-purchase edit and imports.
     */
    async updateHolding(userId, id, { quantity, invested, purchaseDate }) {
      return db.tx(async (t) => {
        const row = (
          await t.query(
            `UPDATE holdings SET quantity = $3, invested = $4,
               purchase_date = CASE WHEN $5::boolean THEN $6::date ELSE purchase_date END
             WHERE user_id = $1 AND id = $2 RETURNING to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date`,
            [userId, id, quantity, invested, purchaseDate !== undefined, purchaseDate ?? null],
          )
        ).rows[0];
        if (!row) return null;
        await t.query('DELETE FROM holding_lots WHERE holding_id = $1', [id]);
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [id, userId, quantity, invested, row.purchase_date, Date.now()],
        );
        return loadHolding(t.query, userId, id);
      });
    },
    /**
     * Move a holding to another of the user's portfolios. If that portfolio already holds the stock, the purchases are
     * added to it. Returns {status: 'ok', holding} or {status: 'missing'}.
     */
    async moveHolding(userId, id, portfolioId) {
      return db.tx(async (t) => {
        const h = (await t.query('SELECT id, symbol, portfolio_id FROM holdings WHERE user_id = $1 AND id = $2', [userId, id])).rows[0];
        const target = (await t.query('SELECT id FROM portfolios WHERE user_id = $1 AND id = $2', [userId, portfolioId])).rows[0];
        if (!h || !target) return { status: 'missing' };
        if (n(h.portfolio_id) === portfolioId) return { status: 'ok', holding: await loadHolding(t.query, userId, id) };
        const there = (
          await t.query('SELECT id FROM holdings WHERE user_id = $1 AND portfolio_id = $2 AND symbol = $3', [userId, portfolioId, h.symbol])
        ).rows[0];
        if (!there) {
          await t.query('UPDATE holdings SET portfolio_id = $2 WHERE id = $1', [id, portfolioId]);
          return { status: 'ok', holding: await loadHolding(t.query, userId, id) };
        }
        await t.query('UPDATE holding_lots SET holding_id = $2 WHERE holding_id = $1', [id, there.id]);
        await t.query('DELETE FROM holdings WHERE id = $1', [id]);
        await resync(t.query, there.id);
        return { status: 'ok', holding: await loadHolding(t.query, userId, n(there.id)) };
      });
    },
    /** Record another purchase of a stock already held. */
    async addLot(userId, holdingId, { quantity, invested, purchaseDate = null }) {
      return db.tx(async (t) => {
        if (!(await t.query('SELECT 1 FROM holdings WHERE id = $1 AND user_id = $2', [holdingId, userId])).rows.length) return null;
        await t.query(
          `INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
           VALUES ($1,$2,$3,$4,$5::date,$6)`,
          [holdingId, userId, quantity, invested, purchaseDate, Date.now()],
        );
        await resync(t.query, holdingId);
        return loadHolding(t.query, userId, holdingId);
      });
    },
    /** purchaseDate: undefined keeps the lot's date, null clears it. Returns the updated holding, or null. */
    async updateLot(userId, holdingId, lotId, { quantity, invested, purchaseDate }) {
      return db.tx(async (t) => {
        const r = await t.query(
          `UPDATE holding_lots SET quantity = $4, invested = $5,
             purchase_date = CASE WHEN $6::boolean THEN $7::date ELSE purchase_date END
           WHERE id = $1 AND holding_id = $2 AND user_id = $3`,
          [lotId, holdingId, userId, quantity, invested, purchaseDate !== undefined, purchaseDate ?? null],
        );
        if (!r.rowCount) return null;
        await resync(t.query, holdingId);
        return loadHolding(t.query, userId, holdingId);
      });
    },
    /** Remove one purchase. The last remaining purchase cannot be removed (remove the stock instead). */
    async removeLot(userId, holdingId, lotId) {
      return db.tx(async (t) => {
        const lots = (await t.query('SELECT id FROM holding_lots WHERE holding_id = $1 AND user_id = $2', [holdingId, userId])).rows;
        if (!lots.some((l) => n(l.id) === lotId)) return { status: 'missing' };
        if (lots.length < 2) return { status: 'last' };
        await t.query('DELETE FROM holding_lots WHERE id = $1', [lotId]);
        await resync(t.query, holdingId);
        return { status: 'ok', holding: await loadHolding(t.query, userId, holdingId) };
      });
    },
    async removeHolding(userId, id) {
      return db.tx((t) => dropHolding(t, userId, id));
    },
    async listAllHoldings() {
      return (await many(`SELECT ${HOLDING_COLS} FROM holdings`)).map((r) => ({ ...holding(r), userId: n(r.user_id) }));
    },
    /** Distinct symbols anyone holds or watches: the set the poller needs to fetch. */
    async allSymbols() {
      return (await many('SELECT symbol FROM holdings UNION SELECT symbol FROM watchlist ORDER BY symbol')).map((r) => r.symbol);
    },

    // ---------- sales ----------
    /**
     * Sell shares of a holding, oldest purchases first (FIFO). The sold purchases shrink or disappear, the sale is
     * recorded with the cost of exactly those shares, and a fully sold stock leaves the holdings.
     * Returns { status: 'missing' | 'too_many' | 'before_purchase' } or { status: 'ok', sale, holding|null }.
     */
    async sellShares(userId, holdingId, params) {
      return db.tx((t) => sellInTx(t, userId, holdingId, params));
    },
    /**
     * Take a sale back: the purchases it used up return with their original cost and dates, and the sale is deleted.
     * A stock that was fully sold comes back to the holdings (maxHoldings is respected).
     * Returns { status: 'missing' | 'cap' } or { status: 'ok', holding, reopened }.
     */
    async removeSale(userId, saleId, { maxHoldings } = {}) {
      return db.tx(async (t) => {
        const back = await undoSaleInTx(t, userId, saleId, maxHoldings);
        if (back.status !== 'ok') return back;
        return { status: 'ok', holding: await loadHolding(t.query, userId, back.holdingId), reopened: back.reopened };
      });
    },
    /**
     * Change a sale: undo it, then sell again with the new figures, all in one transaction. If the new figures do
     * not fit (more shares than held, a date before the purchases) nothing at all changes.
     * Returns { status: 'missing' | 'cap' | 'too_many' | 'before_purchase' } or { status: 'ok', sale, holding|null, reopened }.
     */
    async updateSale(userId, saleId, params, { maxHoldings } = {}) {
      try {
        return await db.tx(async (t) => {
          const back = await undoSaleInTx(t, userId, saleId, maxHoldings);
          if (back.status !== 'ok') return back;
          const out = await sellInTx(t, userId, back.holdingId, params);
          if (out.status !== 'ok') throw new Rejected(out); // roll the undo back too
          return { ...out, reopened: back.reopened && out.holding !== null };
        });
      } catch (e) {
        if (e instanceof Rejected) return e.result;
        throw e;
      }
    },
    async listSales(userId, limit = 200, portfolioId = null) {
      return (
        await many(
          `SELECT ${SALE_COLS} FROM sales WHERE user_id = $1${inPortfolio(portfolioId, 3)} ORDER BY sale_date DESC, id DESC LIMIT $2`,
          withPortfolio([userId, limit], portfolioId),
        )
      ).map(sale);
    },
    /**
     * The purchases used up by the user's sales dated after `afterDate`, each with its sale date. A sale with no
     * recorded purchases counts as one undated purchase of everything it sold.
     */
    async listSoldLots(userId, afterDate, portfolioId = null) {
      const rows = await many(
        `SELECT s.symbol, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date,
                COALESCE(sl.quantity, s.quantity) AS quantity,
                COALESCE(sl.invested, s.cost_basis) AS invested,
                to_char(sl.purchase_date, 'YYYY-MM-DD') AS purchase_date
         FROM sales s LEFT JOIN sale_lots sl ON sl.sale_id = s.id
         WHERE s.user_id = $1 AND s.sale_date > $2::date${inPortfolio(portfolioId, 3, 's.portfolio_id')}
         ORDER BY s.sale_date, s.id, sl.id`,
        withPortfolio([userId, afterDate], portfolioId),
      );
      return rows.map((r) => ({
        symbol: r.symbol,
        quantity: n(r.quantity),
        invested: n(r.invested),
        purchase_date: r.purchase_date ?? null,
        sale_date: r.sale_date,
      }));
    },
    /**
     * Every purchase the user's sales used up, with its sale: one row per purchase per sale, for capital gains.
     * A sale with no recorded purchases counts as one undated purchase of everything it sold.
     */
    async listSaleLotsForGains(userId, portfolioId = null) {
      const rows = await many(
        `SELECT s.id AS sale_id, s.symbol, s.name, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date, s.sale_price,
                s.quantity AS sale_quantity, s.charges,
                COALESCE(sl.quantity, s.quantity) AS quantity, COALESCE(sl.invested, s.cost_basis) AS cost,
                to_char(sl.purchase_date, 'YYYY-MM-DD') AS purchase_date
           FROM sales s LEFT JOIN sale_lots sl ON sl.sale_id = s.id
          WHERE s.user_id = $1${inPortfolio(portfolioId, 2, 's.portfolio_id')}
          ORDER BY s.sale_date DESC, s.id DESC, sl.id`,
        withPortfolio([userId], portfolioId),
      );
      return rows.map((r) => ({
        saleId: n(r.sale_id),
        symbol: r.symbol,
        name: r.name,
        saleDate: r.sale_date,
        salePrice: n(r.sale_price),
        saleQuantity: n(r.sale_quantity),
        charges: n(r.charges),
        quantity: n(r.quantity),
        cost: n(r.cost),
        purchaseDate: r.purchase_date ?? null,
      }));
    },
    /** Totals over every sale the user has made (in one portfolio, or all). */
    async salesTotals(userId, portfolioId = null) {
      const r = await one(
        `SELECT COUNT(*) AS c,
                COALESCE(SUM(quantity * sale_price), 0) AS proceeds,
                COALESCE(SUM(charges), 0) AS charges,
                COALESCE(SUM(cost_basis), 0) AS cost_basis
         FROM sales WHERE user_id = $1${inPortfolio(portfolioId, 2)}`,
        withPortfolio([userId], portfolioId),
      );
      const proceeds = round(n(r.proceeds), 2);
      const charges = round(n(r.charges), 2);
      const costBasis = round(n(r.cost_basis), 2);
      return { count: n(r.c), proceeds, charges, costBasis, realised: round(proceeds - charges - costBasis, 2) };
    },
  };
}
