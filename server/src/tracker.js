import { getQuotes, getDailyHistory, getDailyHistoryWithSplits } from './market.js';
import { istDate, addDays, istDayStart } from './dates.js';
import { evaluateRules, COOLDOWN_MS } from './alerts.js';
import { splitMessage, RATIO_TOLERANCE } from './splits.js';
import { BENCHMARK } from './benchmark.js';
import { daysBetween } from './analytics.js';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

/** Users may trigger a manual refresh at most this often (protects the shared price source). */
export const MANUAL_REFRESH_MIN_MS = 5 * 60 * 1000;
/** How far back each check looks for splits and bonus issues. */
export const SPLIT_LOOKBACK_DAYS = 30;
/** A move this large since the last close is checked for a split at once, even if the stock was checked today. */
export const SPLIT_SUSPECT_MOVE = 0.08;

export function createTracker(store, { notifier, getQuotes: gq, getDailyHistory: gh, getSplits: gs } = {}) {
  const fetchQuotes = gq ?? getQuotes;
  const fetchHistory = gh ?? getDailyHistory;
  const fetchSplits = gs ?? getDailyHistoryWithSplits;

  /** Daily closes for one symbol, ~13 months by default (used when a stock is first added, and nightly). */
  async function backfill(symbol, days = 400) {
    const points = await fetchHistory(symbol, days);
    await store.saveDailyPrices(symbol, points);
    return points.length;
  }

  // The last index history fetch (per server instance): when, and from which date.
  let indexTried = null;
  // A fetch under way, which callers arriving meanwhile wait for instead of answering with what is stored so far.
  let indexFetch = null;
  /** A fetch that reached back at least as far is not repeated within this time (Yahoo may simply have no older data). */
  const INDEX_RETRY_MS = 6 * 3600 * 1000;

  /**
   * Make sure the stored index closes reach back to `fromDate` and are recent. Old index closes never change, so
   * they are fetched once and kept; the scheduled price refreshes and nightly history job keep the recent end up to date.
   */
  async function ensureIndexHistory(fromDate, now = Date.now()) {
    while (indexFetch) await indexFetch.catch(() => {});
    const today = istDate(now);
    const bounds = await store.seriesBounds(BENCHMARK.symbol);
    const reaches = bounds && bounds.first <= addDays(fromDate, 5);
    const current = bounds && bounds.last >= addDays(today, -5);
    if (reaches && current) return true;
    // Only as far back as needed: the recent end if older closes are there, else from fromDate.
    const from = reaches ? bounds.last : fromDate;
    if (indexTried && now - indexTried.at < INDEX_RETRY_MS && indexTried.from <= from) return !!bounds;
    indexTried = { at: now, from };
    indexFetch = backfill(BENCHMARK.symbol, daysBetween(from, today) + 15);
    try {
      await indexFetch;
      return true;
    } catch (err) {
      log('error', 'index history fetch failed', { error: err?.message });
      return !!bounds;
    } finally {
      indexFetch = null;
    }
  }

  /**
   * What the price itself did over a split: the last price fetched on the trading day before the ex-date, divided by
   * Yahoo's (split-adjusted) close for that day. Null when unknown, or when the stored price was already adjusted.
   */
  async function priceEvidence(symbol, exDate, points) {
    const before = points.filter((p) => p.date < exDate).at(-1);
    if (!before) return null;
    const raw =
      (await store.lastSnapshotBetween(symbol, istDayStart(before.date), istDayStart(exDate))) ??
      (await store.closeOn(symbol, before.date));
    if (raw == null) return null;
    const ratio = raw / before.close;
    return Math.abs(ratio - 1) < RATIO_TOLERANCE ? null : ratio;
  }

  /** Send an alert by email (if the user opted in) and Telegram (if they linked a chat). */
  async function deliver(user, subject, text) {
    if (!user || !notifier) return;
    if (user.alertEmail) await notifier.sendEmail(user.email, subject, text);
    if (user.telegramChatId && notifier.telegramEnabled) {
      const r = await notifier.sendTelegram(user.telegramChatId, `${subject}\n\n${text}`);
      if (r?.blocked) await store.unlinkTelegramChat(user.telegramChatId);
    }
  }

  /** Ask every user whose shares a new split may change to confirm it (in the app, and by email or Telegram). */
  async function openSplitReviews(symbol, split, priceRatio, now) {
    const reviews = await store.createSplitReviews(symbol, split.date, istDayStart(split.date), now);
    const message = splitMessage({ symbol, exDate: split.date, reported: split, priceRatio });
    for (const { userId } of reviews) {
      await store.addNotification({ userId, ts: now, symbol, message });
      await deliver(await store.getUser(userId), `Stock Beat: ${symbol} split or bonus issue`, message);
    }
    return reviews.length;
  }

  /**
   * Look for new splits and bonus issues of `symbols`: each symbol at most once per IST day, unless it is in `force`.
   * For a new one: store Yahoo's split-adjusted closes in place of the old ones, drop intraday prices from before it,
   * record it, and open a review for each user it may affect (their shares only change once they confirm).
   * Returns the symbols whose stored prices could not be corrected, so alerts can leave them out this round.
   */
  async function checkSplits(symbols, now, force = new Set()) {
    const today = istDate(now);
    const checked = await store.splitCheckDates(symbols);
    const due = symbols.filter((s) => force.has(s) || checked.get(s) !== today);
    const unsettled = new Set();
    for (let i = 0; i < due.length; i += 5) {
      await Promise.all(
        due.slice(i, i + 5).map(async (symbol) => {
          try {
            const { points, splits } = await fetchSplits(symbol, SPLIT_LOOKBACK_DAYS);
            for (const split of splits) {
              if (split.date > today || (await store.hasSplit(symbol, split.date))) continue;
              // Read the evidence before the backfill overwrites the stored closes.
              const priceRatio = await priceEvidence(symbol, split.date, points);
              try {
                await backfill(symbol);
              } catch (err) {
                unsettled.add(symbol); // not recorded, so the next run tries again
                log('error', 'split price refresh failed', { symbol, error: err?.message });
                break;
              }
              await store.deleteSnapshotsBefore(symbol, istDayStart(split.date));
              const fresh = await store.recordSplit({
                symbol, exDate: split.date, numerator: split.numerator, denominator: split.denominator, priceRatio, foundAt: now,
              });
              if (!fresh) continue;
              const reviews = await openSplitReviews(symbol, split, priceRatio, now);
              log('info', 'split found', { symbol, exDate: split.date, ratio: `${split.numerator}:${split.denominator}`, priceRatio, reviews });
            }
            if (!unsettled.has(symbol)) await store.markSplitChecked(symbol, today);
          } catch (err) {
            log('error', 'split check failed', { symbol, error: err?.message });
          }
        }),
      );
    }
    return unsettled;
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
        // A price target is a one-off: pause it so it doesn't repeat every day while the price stays beyond it.
        if (hit.rule.kind === 'price') await store.disableRule(userId, hit.rule.id);
        await deliver(user, `Stock Beat alert: ${hit.holding.symbol}`, hit.message);
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
      const watched = (await store.listAllWatchlist()).filter((w) => userId == null || w.userId === userId);
      // Alerts look at what each user holds, plus what they only watch (which "any stock" rules leave out).
      const heldBy = new Set(holdings.map((h) => `${h.userId}|${h.symbol}`));
      const targets = [
        ...holdings,
        ...watched.filter((w) => !heldBy.has(`${w.userId}|${w.symbol}`)).map((w) => ({ ...w, watchOnly: true })),
      ];
      const symbols = [...new Set(targets.map((h) => h.symbol))];
      if (!symbols.length) return { polled: 0, alerts: 0 };

      // The index rides along so comparisons with it are as fresh as the stocks.
      const quotes = await fetchQuotes([...symbols, BENCHMARK.symbol]);
      const latest = new Map();
      const today = istDate(now);
      // Each price is stored as the close of the day it traded, so a holiday or weekend poll doesn't invent a session.
      const tradedOn = new Map();
      for (const [symbol, q] of quotes) {
        latest.set(symbol, q.price);
        const day = q.marketTime ? istDate(q.marketTime) : today;
        tradedOn.set(symbol, day <= today ? day : today);
      }
      const polled = symbols.filter((s) => latest.has(s)).length;

      // Splits are handled before anything compares today's price with older ones. A big jump from the last close
      // is most likely one, so such a stock is checked now even if it was already checked today.
      const recent = await store.getSeriesMany(symbols, addDays(today, -10));
      const suspect = new Set(
        symbols.filter((s) => {
          const prev = recent.get(s).filter((p) => p.date < today).at(-1);
          const price = latest.get(s);
          return prev && price != null && Math.abs(price / prev.close - 1) > SPLIT_SUSPECT_MOVE;
        }),
      );
      const unsettled = await checkSplits(symbols, now, suspect);

      await store.saveSnapshots([...latest].map(([symbol, price]) => ({ symbol, ts: now, price })));
      await store.saveDailyCloses([...latest].map(([symbol, price]) => ({ symbol, date: tradedOn.get(symbol), close: price })));

      // A price target set in the old shares waits until its owner confirms the split; a stock whose prices couldn't
      // be corrected for a new split is left out of alerts until they are.
      const pending = new Set((await store.listPendingSplitReviews()).map((r) => `${r.user_id}|${r.symbol}`));
      const rules = (await store.listEnabledRules())
        .filter((r) => userId == null || r.user_id === userId)
        .filter((r) => !(r.kind === 'price' && pending.has(`${r.user_id}|${r.symbol}`)));
      const alerts = await runAlerts({ holdings: targets.filter((h) => !unsettled.has(h.symbol)), rules, latest, now });

      if (userId == null) {
        await store.pruneSnapshots(now - 60 * 86_400_000);
        await store.pruneNotifications(now - 180 * 86_400_000);
        await store.deleteExpiredSessions(now);
      }
      log('info', 'poll complete', { polled, alerts, scope: userId == null ? 'all' : 'user' });
      return { polled, alerts };
    } catch (err) {
      log('error', 'poll failed', { error: err?.message });
      return { error: true };
    }
  }

  /** Manual "refresh prices" from a signed-in user, throttled so it can't hammer the price source. */
  async function refreshForUser(userId, now = Date.now()) {
    const symbols = [...(await store.listHoldings(userId)), ...(await store.listWatchlist(userId))].map((x) => x.symbol);
    const last = await store.lastSnapshotTs(symbols);
    if (last != null && now - last < MANUAL_REFRESH_MIN_MS) return { throttled: true, polled: 0, alerts: 0 };
    return pollOnce({ now, userId });
  }

  /** Replace provisional closes with official ones. Bounded concurrency keeps it inside serverless time limits. */
  async function refreshHistory() {
    const symbols = await store.allSymbols();
    // Catches splits on days no price refresh ran. Runs first: it reads stored closes before they're replaced.
    await checkSplits(symbols, Date.now());
    let ok = 0;
    // The index's recent closes too (older ones never change and are kept).
    if (symbols.length) await backfill(BENCHMARK.symbol).catch((err) => log('error', 'index history refresh failed', { error: err?.message }));
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

  return { backfill, checkSplits, ensureIndexHistory, pollOnce, refreshForUser, refreshHistory };
}
