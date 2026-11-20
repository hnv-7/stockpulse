import { HttpError, parse, parseId } from '../http.js';
import { notificationIdsSchema, ruleSchema, ruleUpdateSchema } from '../schemas.js';

/** Alert rules, notifications and the manual price refresh. Needs a session. */
export function alertRoutes(api, { store, tracker, config, limiter }) {
  api.get('/rules', async (req, res) => res.json(await store.listRules(req.session.user.id)));

  api.post('/rules', async (req, res) => {
    const userId = req.session.user.id;
    const body = parse(ruleSchema, req.body);
    const { symbol } = body;
    if ((await store.countRules(userId)) >= config.maxRulesPerUser) {
      throw new HttpError(400, `you can have up to ${config.maxRulesPerUser} alerts`);
    }
    if (symbol && !(await store.listHoldings(userId)).some((h) => h.symbol === symbol) && !(await store.isWatched(userId, symbol))) {
      throw new HttpError(404, 'stock not in your portfolio or watchlist');
    }
    const fields =
      body.kind === 'price'
        ? { kind: 'price', symbol, direction: body.direction, targetPrice: body.targetPrice }
        : { kind: 'drop', symbol: symbol ?? null, window: body.window, thresholdPct: body.thresholdPct };
    res.status(201).json(await store.addRule(userId, fields));
  });

  api.put('/rules/:id', async (req, res) => {
    const userId = req.session.user.id;
    const id = parseId(req.params.id);
    const body = parse(ruleUpdateSchema, req.body);
    const existing = await store.getRule(userId, id);
    if (!existing) throw new HttpError(404, 'not found');
    // Only the level that belongs to this kind of rule can change; the other is ignored.
    const level = existing.kind === 'price' ? { targetPrice: body.targetPrice } : { thresholdPct: body.thresholdPct };
    const updated = await store.updateRule(userId, id, { ...level, enabled: body.enabled });
    if (!updated) throw new HttpError(404, 'not found');
    res.json(updated);
  });

  api.delete('/rules/:id', async (req, res) => {
    if (!(await store.removeRule(req.session.user.id, parseId(req.params.id)))) throw new HttpError(404, 'not found');
    res.status(204).end();
  });

  api.get('/notifications', async (req, res) => {
    const userId = req.session.user.id;
    res.json({ unread: await store.unreadCount(userId), items: await store.listNotifications(userId, 50) });
  });
  api.post('/notifications/read', async (req, res) => {
    await store.markAllRead(req.session.user.id);
    res.status(204).end();
  });
  // Clear chosen notifications, or all of them. They disappear from the list but still count for alert cooldowns.
  api.post('/notifications/clear', async (req, res) => {
    const { ids } = parse(notificationIdsSchema, req.body);
    res.json({ cleared: await store.clearNotifications(req.session.user.id, ids) });
  });
  api.delete('/notifications', async (req, res) => {
    res.json({ cleared: await store.clearNotifications(req.session.user.id) });
  });

  api.post('/refresh', limiter('refresh', 60_000, 5), async (req, res) => {
    res.json(await tracker.refreshForUser(req.session.user.id));
  });
}
