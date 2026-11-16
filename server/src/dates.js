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
const OPEN_MIN = 9 * 60 + 15; // NSE opens 09:15 IST
const CLOSE_MIN = 15 * 60 + 30; // and closes 15:30 IST
/** During trading hours a price older than this is flagged. Hourly polling can run late, so allow a margin. */
export const STALE_IN_SESSION_MS = 2 * 3600 * 1000;

/** The instant (ms) a YYYY-MM-DD day starts in IST. */
export function istDayStart(date) {
  return Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
}

/** Minutes since midnight and weekday (0 = Sunday) of an instant, in IST. */
function istParts(ts) {
  const d = new Date(ts + IST_OFFSET_MS);
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
}

/** The most recent weekday 09:15 IST at or before `ts` (market holidays are not known, so they count as sessions). */
function lastSessionOpen(ts) {
  let t = ts;
  for (let i = 0; i < 8; i++) {
    const { minutes, day } = istParts(t);
    if (day !== 0 && day !== 6 && minutes >= OPEN_MIN) return t - (minutes - OPEN_MIN) * 60_000 - (t % 60_000);
    // step back to the end of the previous IST day
    t -= (minutes + 1) * 60_000;
  }
  return ts;
}

/**
 * Is a price taken at `asOf` too old to trust as "now"?
 * In trading hours it must be under two hours old. Outside them the last session's price is expected,
 * so it only counts as stale when it predates that session's open (a whole session was missed).
 * `asOf` null or missing counts as stale.
 */
export function isStale(asOf, now = Date.now()) {
  if (asOf == null) return true;
  const { minutes, day } = istParts(now);
  const inSession = day !== 0 && day !== 6 && minutes >= OPEN_MIN && minutes <= CLOSE_MIN;
  if (inSession) return now - asOf > STALE_IN_SESSION_MS;
  return asOf < lastSessionOpen(now);
}
