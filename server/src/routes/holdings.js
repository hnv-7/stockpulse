import express from 'express';
import { z } from 'zod';
import { istDate, addDays } from '../dates.js';
import { toCsv, importHoldings, MAX_IMPORT_ROWS } from '../portfolio-io.js';
import { previewImport } from '../import-mapping.js';
import { ImportError, MAX_FILE_BYTES } from '../import-formats.js';
import { suggestRatio } from '../splits.js';
import { HttpError, parse, parseId } from '../http.js';
import { holdingSchema, holdingUpdateSchema, moveSchema, sellSchema, splitRatioSchema } from '../schemas.js';

/** Search, holdings and their purchases, import/export, sales, and splits waiting to be confirmed. Needs a session. */
export function holdingRoutes(api, { store, tracker, config, limiter, lookups, data }) {
  /** The portfolio new holdings go to: ?portfolio=<id> or the body's portfolioId (one the user owns), else their first. */
  async function targetPortfolio(req, bodyId) {
    const userId = req.session.user.id;
    if (bodyId != null) {
      if (!(await store.ownsPortfolio(userId, bodyId))) throw new HttpError(404, 'portfolio not found');
      return bodyId;
    }
    return (await data.scopeOf(req)) ?? (await store.defaultPortfolioId(userId));
  }

  api.get('/search', limiter('search', 60_000, 30), async (req, res) => {
    const q = parse(z.string().trim().min(1).max(40), req.query.q);
    res.json(await lookups.search(q));
  });

  // ---------- holdings ----------
  api.get('/holdings', async (req, res) => res.json(await store.listHoldings(req.session.user.id, await data.scopeOf(req))));

  // Download the portfolio as CSV. The same columns are accepted by the import below. Across several portfolios each
  // row also says which one it is in.
  api.get('/holdings/export', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    const holdings = await store.listHoldings(userId, scope);
    const portfolios = await store.listPortfolios(userId);
    const named = scope == null && portfolios.length > 1;
    const nameOf = new Map(portfolios.map((p) => [p.id, p.name]));
    const csv = toCsv(
      ['Symbol', 'Name', 'Quantity', 'Invested', 'Purchase Date', ...(named ? ['Portfolio'] : [])],
      holdings.map((h) => [h.symbol, h.name, h.quantity, h.invested, h.purchase_date, ...(named ? [nameOf.get(h.portfolioId)] : [])]),
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="stockbeat-portfolio-${istDate()}.csv"`);
    res.send(csv);
  });

  // Step 1 of an import: upload a broker statement (xlsx / csv / json / pdf) and get back what would change.
  // Nothing is saved here.
  api.post(
    '/holdings/import/preview',
    limiter('import-preview', 60_000, 10),
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'choose a file to import');
      const userId = req.session.user.id;
      const portfolioId = await targetPortfolio(req);
      try {
        res.json(
          await previewImport({
            buf: req.body,
            existing: await store.listHoldings(userId, portfolioId),
            heldCount: await store.countHoldings(userId),
            lookupQuote: lookups.quote,
            search: lookups.search,
            fundByIsin: lookups.fundByIsin,
            maxHoldings: config.maxHoldingsPerUser,
          }),
        );
      } catch (e) {
        if (e instanceof ImportError) throw new HttpError(400, e.message);
        throw e;
      }
    },
  );

  // Step 2: save the (possibly edited) preview. New symbols are added, existing ones updated; nothing is deleted.
  api.post('/holdings/import', limiter('import', 60_000, 10), express.json({ limit: '200kb' }), async (req, res) => {
    const { items } = parse(
      z.object({ items: z.array(holdingSchema).min(1, 'nothing to import').max(MAX_IMPORT_ROWS, `too many rows (max ${MAX_IMPORT_ROWS})`) }),
      req.body,
    );
    const result = await importHoldings({
      store,
      tracker,
      lookupQuote: lookups.quote,
      maxHoldings: config.maxHoldingsPerUser,
      userId: req.session.user.id,
      portfolioId: await targetPortfolio(req),
      rows: items.map((it, i) => ({ line: i + 1, ...it })),
    });
    res.json(result);
  });

  api.post('/holdings', limiter('add-holding', 60_000, 20), async (req, res) => {
    const userId = req.session.user.id;
    const { symbol, quantity: qtyIn, invested: investedIn, purchaseDate, merge, portfolioId: bodyPortfolio } = parse(holdingSchema, req.body);
    if (!qtyIn && !investedIn) throw new HttpError(400, 'enter the quantity, the amount invested, or both');
    const portfolioId = await targetPortfolio(req, bodyPortfolio);
    const current = (await store.listHoldings(userId, portfolioId)).find((h) => h.symbol === symbol);
    if (current && !merge) {
      throw new HttpError(409, 'stock already in portfolio — confirm to add this purchase to the existing holding');
    }
    if (!current && (await store.countHoldings(userId)) >= config.maxHoldingsPerUser) {
      throw new HttpError(400, `you can track up to ${config.maxHoldingsPerUser} stocks`);
    }
    const quote = await lookups.quote(symbol).catch(() => null);
    if (!quote) throw new HttpError(404, 'symbol not found (use NSE/BSE format, e.g. INFY.NS)');

    let quantity = qtyIn;
    let invested = investedIn;
    let priceOn = null;
    if (!quantity || !invested) {
      if (!purchaseDate) throw new HttpError(400, 'enter both quantity and amount invested, or add a purchase date so one can be worked out');
      priceOn = await lookups.closeOn(symbol, purchaseDate).catch(() => null);
      if (!priceOn) throw new HttpError(404, 'no price found for that purchase date — enter both quantity and amount invested');
      if (!quantity) quantity = Math.round((invested / priceOn.close) * 10_000) / 10_000;
      else invested = Math.round(quantity * priceOn.close * 100) / 100;
      if (!(quantity > 0) || !(invested > 0)) throw new HttpError(400, 'amount is too small to buy any shares on that date');
    }

    if (current) {
      // Another buy of a stock already held: record it as its own purchase (with its own date).
      const merged = await store.addLot(userId, current.id, { quantity, invested, purchaseDate: purchaseDate ?? null });
      if (!merged) throw new HttpError(404, 'not found');
      return res.json({ ...merged, merged: true, ...(priceOn ? { priceOn } : {}) });
    }
    // First purchase of this stock in this portfolio: create the holding.
    const holding = await store.addHolding(userId, { symbol, name: quote.name, quantity, invested, purchaseDate: purchaseDate ?? null, portfolioId });
    // History is shared between users, so only fetch it if nobody holds this symbol yet.
    const have = (await store.getSeriesMany([symbol], addDays(istDate(), -60))).get(symbol);
    if (have.length < 20) await tracker.backfill(symbol).catch(() => 0);
    await store.saveSnapshots([{ symbol, ts: Date.now(), price: quote.price }]);
    res.status(201).json(priceOn ? { ...holding, priceOn } : holding);
  });

  api.put('/holdings/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const body = parse(holdingUpdateSchema, req.body);
    const updated = await store.updateHolding(req.session.user.id, id, body);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  // Move a stock to another portfolio (its purchases join that portfolio's holding of it, if there is one).
  api.post('/holdings/:id/move', async (req, res) => {
    const { portfolioId } = parse(moveSchema, req.body);
    const out = await store.moveHolding(req.session.user.id, parseId(req.params.id), portfolioId);
    if (out.status === 'missing') throw new HttpError(404, 'not found');
    res.json(out.holding);
  });

  // Edit or remove one purchase of a stock; the stock's totals follow.
  api.put('/holdings/:id/lots/:lotId', async (req, res) => {
    const body = parse(holdingUpdateSchema, req.body);
    const updated = await store.updateLot(req.session.user.id, parseId(req.params.id), parseId(req.params.lotId), body);
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/holdings/:id/lots/:lotId', async (req, res) => {
    const out = await store.removeLot(req.session.user.id, parseId(req.params.id), parseId(req.params.lotId));
    if (out.status === 'missing') throw new HttpError(404, 'not found');
    if (out.status === 'last') throw new HttpError(400, 'this is the only purchase — remove the stock instead');
    res.json(out.holding);
  });

  api.delete('/holdings/:id', async (req, res) => {
    if (!(await store.removeHolding(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  // ---------- sales ----------
  // Sell some or all shares of a stock. Purchases are used oldest first; a fully sold stock leaves the holdings
  // and its sale stays in the history.
  const saleFailure = (out) => {
    if (out.status === 'missing') throw new HttpError(404, 'not found');
    if (out.status === 'cap') throw new HttpError(400, `you can track up to ${config.maxHoldingsPerUser} stocks, so this stock cannot come back to your holdings`);
    if (out.status === 'too_many') throw new HttpError(400, `you only hold ${out.held} shares`);
    if (out.status === 'before_purchase') {
      throw new HttpError(400, `the sale date is before a purchase made on ${out.date} (shares are sold oldest first)`);
    }
  };

  api.post('/holdings/:id/sell', limiter('sell', 60_000, 30), async (req, res) => {
    const body = parse(sellSchema, req.body);
    const out = await store.sellShares(req.session.user.id, parseId(req.params.id), body);
    saleFailure(out);
    res.json({ sale: out.sale, holding: out.holding, closed: out.holding === null });
  });

  // Fix a mistake in a sale: the shares go back to your holding and are sold again with the new figures.
  // Either all of it happens or none of it.
  api.put('/sales/:id', limiter('sale-edit', 60_000, 30), async (req, res) => {
    const body = parse(sellSchema, req.body);
    const out = await store.updateSale(req.session.user.id, parseId(req.params.id), body, { maxHoldings: config.maxHoldingsPerUser });
    saleFailure(out);
    res.json({ sale: out.sale, holding: out.holding, closed: out.holding === null });
  });

  // Delete a sale: the shares it sold return to your holding with their original cost and purchase dates.
  api.delete('/sales/:id', limiter('sale-remove', 60_000, 30), async (req, res) => {
    const out = await store.removeSale(req.session.user.id, parseId(req.params.id), { maxHoldings: config.maxHoldingsPerUser });
    saleFailure(out);
    res.json({ holding: out.holding, reopened: out.reopened });
  });

  api.get('/sales', async (req, res) => {
    const userId = req.session.user.id;
    const scope = await data.scopeOf(req);
    res.json({ totals: await store.salesTotals(userId, scope), items: await store.listSales(userId, 200, scope) });
  });

  // ---------- splits and bonus issues ----------
  // Found by the poller; a user's shares only change when they confirm (with a ratio they can correct).
  api.get('/splits', async (req, res) => {
    const reviews = await store.listSplitReviews(req.session.user.id);
    res.json(reviews.map((r) => ({ ...r, suggested: suggestRatio(r.reported, r.priceRatio) })));
  });

  api.post('/splits/:id/apply', limiter('split-apply', 60_000, 30), async (req, res) => {
    const ratio = parse(splitRatioSchema, req.body);
    const r = await store.applySplitReview(req.session.user.id, parseId(req.params.id), ratio);
    if (r.status === 'missing') throw new HttpError(404, 'not found');
    if (r.status === 'resolved') throw new HttpError(409, 'this split was already confirmed or dismissed');
    res.json(r);
  });

  api.post('/splits/:id/dismiss', limiter('split-dismiss', 60_000, 30), async (req, res) => {
    if (!(await store.dismissSplitReview(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });
}
