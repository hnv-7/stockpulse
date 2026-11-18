const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD for the given instant, in Indian Standard Time. */
export function istDate(ts = Date.now()) {
  return fmt.format(new Date(ts));
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when `s` is a real calendar date written as YYYY-MM-DD (rejects 2024-02-30 etc.). */
export function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const OPEN_MIN = 9 * 60 + 15; // NSE opens 09:15 IST
const CLOSE_MIN = 15 * 60 + 30; // and closes 15:30 IST

/**
 * When prices are refreshed on weekdays, in IST minutes since midnight: after the open, midday, and at the close.
 * These are the /api/cron/poll crons in vercel.json (04:00, 07:00 and 10:00 UTC); a test keeps the two in step.
 */
export const REFRESH_TIMES = [9 * 60 + 30, 12 * 60 + 30, 15 * 60 + 30];
/** Vercel's free plan runs a daily cron at any minute of its hour, so a refresh can land up to this long after its time. */
export const REFRESH_WINDOW_MS = 75 * 60_000;

/** The instant (ms) a YYYY-MM-DD day starts in IST. */
export function istDayStart(date) {
  return Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
}

/** Minutes since midnight and weekday (0 = Sunday) of an instant, in IST. */
function istParts(ts) {
  const d = new Date(ts + IST_OFFSET_MS);
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
}

/**
 * The scheduled time (ms) of the latest refresh that should have run by `ts`, allowing for its window.
 * Weekdays only; market holidays are not known, and the crons run on them too.
 */
export function lastDueRefresh(ts) {
  const due = ts - REFRESH_WINDOW_MS;
  const dayStart = istDayStart(istDate(due));
  for (let back = 0; back < 8; back++) {
    const start = dayStart - back * DAY_MS;
    const { day } = istParts(start);
    if (day === 0 || day === 6) continue;
    for (const min of [...REFRESH_TIMES].reverse()) {
      const at = start + min * 60_000;
      if (at <= due) return at;
    }
  }
  return due;
}

/**
 * NSE's state for the header. `lastSession` is the latest trading day with a price (YYYY-MM-DD).
 * A weekday that is well into trading hours with no price for today yet means the market is shut for a holiday;
 * the check waits until 11:00, after the open refresh's window (09:30-10:45), so a late refresh isn't mistaken for one.
 */
export function marketStatus(lastSession, now = Date.now()) {
  const { minutes, day } = istParts(now);
  const today = istDate(now);
  const weekday = day !== 0 && day !== 6;
  const holiday = weekday && minutes >= 11 * 60 && lastSession != null && lastSession < today;
  const open = weekday && !holiday && minutes >= OPEN_MIN && minutes <= CLOSE_MIN;
  return { open, closedToday: !weekday || holiday, holiday, lastSession: lastSession ?? null };
}

/**
 * Is a price taken at `asOf` too old to trust as "now"? It is when a scheduled refresh has had its whole window
 * since then (it was missed or failed). So between refreshes, at night and over weekends, the latest refresh's
 * price is current. `asOf` null or missing counts as stale.
 */
export function isStale(asOf, now = Date.now()) {
  if (asOf == null) return true;
  return asOf < lastDueRefresh(now);
}
