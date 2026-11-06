import { getQuotes, getDailyHistory } from './market.js';
import { istDate, addDays } from './dates.js';
import { evaluateRules, COOLDOWN_MS } from './alerts.js';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

/** Users may trigger a manual refresh at most this often (protects the shared price source). */
export const MANUAL_REFRESH_MIN_MS = 5 * 60 * 1000;

export function createTracker(store, { notifier, getQuotes: gq, getDailyHistory: gh } = {}) {
  const fetchQuotes = gq ?? getQuotes;
  const fetchHistory = gh ?? getDailyHistory;

  /** ~13 months of daily closes for one symbol (used when a stock is first added, and nightly). */
  async function backfill(symbol) {
    const points = await fetchHistory(symbol, 400);
    await store.saveDailyPrices(symbol, points);
    return points.length;
  }

  /**
   * Evaluate alert rules and deliver notifications.
   * holdings: all holdings in scope; rules: enabled rules in scope; latest: Map(symbol -> price)
   */
  async function runAlerts({ holdings, rules, latest, now }) {
    if (!rules.length) return 0;
    const today = istDate(now);
    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const seriesBySymbol = await store.getSeriesMany(symbols, addDays(today, -400));

    const byUser = new Map();
    for (const h of holdings) (byUser.get(h.userId) ?? byUser.set(h.userId, []).get(h.userId)).push(h);

    let fired = 0;
    for (const [userId, userHoldings] of byUser) {
      const userRules = rules.filter((r) => r.user_id === userId);
      const hits = evaluateRules({
        rules: userRules,
        holdings: userHoldings,
        seriesBySymbol,
        latestBySymbol: latest,
        today,
      });
      if (!hits.length) continue;
      const user = await store.getUser(userId);
      for (const hit of hits) {
        const created = await store.addNotificationWithCooldown({
          userId,
          ts: now,
          ruleId: hit.rule.id,
          symbol: hit.holding.symbol,
          message: hit.message,
          cooldownMs: COOLDOWN_MS,
        });
        if (!created) continue;
        fired++;
        if (user?.alertEmail && notifier) {
          await notifier.sendEmail(user.email, `StockPulse alert: ${hit.holding.symbol}`, hit.message);
        }
      }
    }
    return fired;
  }

  /**
   * One polling cycle. With no options it covers every user's symbols (scheduled run);
   * with { userId } it covers only that user's holdings and rules (manual refresh).
   */
  async function pollOnce({ now = Date.now(), userId = null } = {}) {
    try {
      const holdings = (await store.listAllHoldings()).filter((h) => userId == null || h.userId === userId);
      const symbols = [...new Set(holdings.map((h) => h.symbol))];
      if (!symbols.length) return { polled: 0, alerts: 0 };

      const quotes = await fetchQuotes(symbols);
      const latest = new Map();
      const today = istDate(now);
      for (const [symbol, q] of quotes) latest.set(symbol, q.price);
      await store.saveSnapshots([...latest].map(([symbol, price]) => ({ symbol, ts: now, price })));
      await store.saveDailyCloses([...latest].map(([symbol, price]) => ({ symbol, date: today, close: price })));

      const rules = (await store.listEnabledRules()).filter((r) => userId == null || r.user_id === userId);
      const alerts = await runAlerts({ holdings, rules, latest, now });

      if (userId == null) {
        await store.pruneSnapshots(now - 60 * 86_400_000);
        await store.pruneNotifications(now - 180 * 86_400_000);
        await store.deleteExpiredSessions(now);
      }
      log('info', 'poll complete', { polled: latest.size, alerts, scope: userId == null ? 'all' : 'user' });
      return { polled: latest.size, alerts };
    } catch (err) {
      log('error', 'poll failed', { error: err?.message });
      return { error: true };
    }
  }

  /** Manual "refresh prices" from a signed-in user, throttled so it can't hammer the price source. */
  async function refreshForUser(userId, now = Date.now()) {
    const symbols = (await store.listHoldings(userId)).map((h) => h.symbol);
    const last = await store.lastSnapshotTs(symbols);
    if (last != null && now - last < MANUAL_REFRESH_MIN_MS) return { throttled: true, polled: 0, alerts: 0 };
    return pollOnce({ now, userId });
  }

  /** Replace provisional closes with official ones. Bounded concurrency keeps it inside serverless time limits. */
  async function refreshHistory() {
    const symbols = await store.allSymbols();
    let ok = 0;
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = symbols.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map((s) => backfill(s)));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') ok++;
        else log('error', 'history refresh failed', { symbol: batch[j], error: r.reason?.message });
      });
    }
    return { symbols: symbols.length, refreshed: ok };
  }

  return { backfill, pollOnce, refreshForUser, refreshHistory };
}
