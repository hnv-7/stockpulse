import { inflateRawSync } from 'node:zlib';

/**
 * NSE's own end-of-day file (the "bhavcopy"): every listed security's official close for one trading day, published
 * at about 16:30 IST. It backs up Yahoo for daily closes of NSE (.NS) symbols when Yahoo fails or lags.
 */
export const bhavcopyUrl = (date) =>
  `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${date.replaceAll('-', '')}_F_0000.csv.zip`;

/** Equity series: shares (EQ, BE, BZ), SME shares (SM, ST). ETFs trade as EQ. Bonds, gold bonds and the like are left out. */
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);

/** The first file in a zip archive (the bhavcopy zip holds one CSV), using the central directory for its size. */
export function unzipFirst(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const dir = buf.readUInt32LE(end + 16);
  if (buf.readUInt32LE(dir) !== 0x02014b50) throw new Error('bad zip directory');
  const method = buf.readUInt16LE(dir + 10);
  const size = buf.readUInt32LE(dir + 20);
  const local = buf.readUInt32LE(dir + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error('unsupported zip compression');
}

/**
 * Closes from a bhavcopy CSV (the UDiFF format NSE has used since July 2024), as {date, closes: Map('INFY.NS' -> close)}.
 * Columns are found by name.
 */
export function parseBhavcopy(csv) {
  const lines = String(csv).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { date: null, closes: new Map() };
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const [iDate, iSym, iSeries, iClose] = [col('TradDt'), col('TckrSymb'), col('SctySrs'), col('ClsPric')];
  if ([iDate, iSym, iSeries, iClose].some((i) => i < 0)) throw new Error('unexpected bhavcopy columns');
  const closes = new Map();
  let date = null;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    if (!EQUITY_SERIES.has(f[iSeries]?.trim())) continue;
    const close = Number(f[iClose]);
    if (!(close > 0)) continue;
    date ??= f[iDate]?.trim() || null;
    closes.set(`${f[iSym].trim()}.NS`, close);
  }
  return { date, closes };
}

/**
 * Official NSE closes for `date` (YYYY-MM-DD), or null when there is no file (a holiday or weekend, or not out yet).
 * NSE turns away requests that don't look like a browser, so a browser-like User-Agent is sent.
 */
export async function getNseCloses(date, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(bhavcopyUrl(date), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'application/zip,*/*',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`NSE returned ${res.status}`);
  const parsed = parseBhavcopy(unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  return parsed.date === date ? parsed : null;
}
