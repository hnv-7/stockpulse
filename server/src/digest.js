import { istDate, addDays } from './dates.js';
import { buildReport } from './analytics.js';
import { BENCHMARK, indexChange } from './benchmark.js';
import { upcomingEvents, refreshEvents } from './events.js';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (n) => `₹${inr.format(Math.round(n))}`;
const signedMoney = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`);
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const ticker = (s) => s.replace(/\.(NS|BO)$/, '');

/**
 * The weekly summary as {subject, text}, from a portfolio report for the week, Nifty 50's move, the number of alerts that
 * fired, and dates coming up in the next week. Returns null when there is nothing held to report on.
 */
export function composeDigest({ report, indexPct = null, alerts = 0, events = [], today }) {
  if (!report.holdings.length) return null;
  const { totals } = report;
  const lines = [`Your week to ${day(today)}`, ''];
  lines.push(
    totals.changeValue == null
      ? `Portfolio ${money(totals.value)}.`
      : `Portfolio ${money(totals.value)}: ${signedMoney(totals.changeValue)} (${pct(totals.changePct)}) this week.`,
  );
  if (indexPct != null && totals.changePct != null) {
    const gap = totals.changePct - indexPct;
    lines.push(`${BENCHMARK.name} ${pct(indexPct)}, so you were ${Math.abs(gap).toFixed(2)} points ${gap >= 0 ? 'ahead' : 'behind'}.`);
  }
  lines.push(`Overall ${signedMoney(totals.pnl)} (${pct(totals.pnlPct)}) on ${money(totals.invested)} invested.`);

  const moved = report.holdings.filter((r) => r.periodChangePct != null);
  const up = moved.filter((r) => r.periodChangePct > 0).sort((a, b) => b.periodChangePct - a.periodChangePct).slice(0, 3);
  const down = moved.filter((r) => r.periodChangePct < 0).sort((a, b) => a.periodChangePct - b.periodChangePct).slice(0, 3);
  const list = (rs) => rs.map((r) => `${ticker(r.symbol)} ${pct(r.periodChangePct)}`).join(', ');
  if (up.length || down.length) lines.push('');
  if (up.length) lines.push(`Up most: ${list(up)}`);
  if (down.length) lines.push(`Down most: ${list(down)}`);
  if (alerts > 0) lines.push(`${alerts} ${alerts === 1 ? 'alert' : 'alerts'} fired this week.`);

  if (events.length) {
    lines.push('', 'Coming up:');
    for (const e of events) {
      lines.push(`• ${ticker(e.symbol)} ${e.type === 'results' ? `results${e.estimate ? ' (expected)' : ''}` : 'ex-dividend'} ${day(e.date)}`);
    }
  }
  const subject =
    totals.changePct == null ? 'Stock Beat weekly summary' : `Stock Beat weekly: ${pct(totals.changePct)} this week`;
  return { subject, text: lines.join('\n') };
}

/** Sends the weekly summary to everyone who asked for it (see the /api/cron/digest cron in vercel.json). */
export function createDigest({ store, tracker, data, lookups }) {
  const failedAt = new Map();

  async function forUser(user, now) {
    const today = istDate(now);
    const ctx = await data.loadAll(user.id, '1w');
    const report = buildReport(ctx);
    if (!report.holdings.length) return null;
    const indexSeries = (await store.getSeriesMany([BENCHMARK.symbol], addDays(today, -30))).get(BENCHMARK.symbol);
    const indexPct = indexSeries.length
      ? indexChange({ indexSeries, indexNow: indexSeries.at(-1).close, today, period: '1w' })
      : null;
    const symbols = ctx.holdings.map((h) => h.symbol);
    const eventsBySymbol = await refreshEvents({ store, lookup: lookups.events, symbols, now, failedAt });
    const events = upcomingEvents({
      eventsBySymbol,
      names: new Map(ctx.holdings.map((h) => [h.symbol, h.name])),
      held: new Set(symbols),
      today: addDays(today, 1),
      days: 7,
    });
    const alerts = await store.countAlertsSince(user.id, now - 7 * 86_400_000);
    return composeDigest({ report, indexPct, alerts, events, today });
  }

  return {
    forUser,
    /** One summary per opted-in user per day, however often the cron calls. Returns {users, sent}. */
    async sendAll(now = Date.now()) {
      const today = istDate(now);
      const users = await store.listDigestUsers(today);
      let sent = 0;
      for (const user of users) {
        try {
          const d = await forUser(user, now);
          if (d) {
            await store.addNotification({ userId: user.id, ts: now, symbol: null, message: d.text });
            await tracker.deliver(user, d.subject, d.text);
            sent++;
          }
          await store.markDigestSent(user.id, today);
        } catch (err) {
          log('error', 'weekly summary failed', { error: err?.message });
        }
      }
      log('info', 'weekly summaries sent', { users: users.length, sent });
      return { users: users.length, sent };
    },
  };
}
