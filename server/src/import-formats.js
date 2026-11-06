import { parseCsv, MAX_IMPORT_ROWS } from './portfolio-io.js';

/** A problem with the uploaded file that is safe to show to the user. */
export class ImportError extends Error {}

/** Largest upload accepted (Vercel itself caps request bodies at 4.5 MB). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const PARSE_TIMEOUT_MS = 20_000;

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decide the format from the bytes (never from the file name, which the client controls). */
export function detectFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'xls';
  if (buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
  const head = buf.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'csv';
}

const hasText = (c) => c != null && String(c).trim() !== '';

// ---------- XLSX ----------
async function xlsxTables(buf) {
  try {
    const { default: readXlsx } = await import('read-excel-file/node');
    const sheets = await withTimeout(readXlsx(buf), PARSE_TIMEOUT_MS);
    return sheets.map((s) =>
      s.data.map((cells, i) => ({ line: i + 1, cells })).filter((r) => r.cells.some(hasText)),
    );
  } catch {
    throw new ImportError('could not read this Excel file - is it a valid .xlsx?');
  }
}

// ---------- JSON ----------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Find the list of holdings inside broker API responses such as {data:[...]}, {payload:{holdings:[...]}} or a bare array. */
function findObjectArray(node, depth = 0) {
  if (Array.isArray(node)) return node.length && node.every(isPlainObject) ? node : null;
  if (!isPlainObject(node) || depth > 3) return null;
  const keys = Object.keys(node);
  const preferred = ['data', 'holdings', 'holding', 'payload', 'result'].filter((k) => k in node);
  for (const k of [...preferred, ...keys.filter((k) => !preferred.includes(k))]) {
    const found = findObjectArray(node[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function jsonTable(buf) {
  let data;
  try {
    data = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new ImportError('this file is not valid JSON');
  }
  const list = findObjectArray(data);
  if (!list) throw new ImportError('could not find a list of holdings in this JSON');
  if (list.length > MAX_IMPORT_ROWS) throw new ImportError(`too many rows (max ${MAX_IMPORT_ROWS})`);
  const keys = [...new Set(list.flatMap((o) => Object.keys(o)))];
  const prim = (v) => (v == null || typeof v === 'object' ? null : v);
  return [
    [{ line: 0, cells: keys }, ...list.map((o, i) => ({ line: i + 1, cells: keys.map((k) => prim(o[k])) }))],
  ];
}

// ---------- PDF ----------
/** Group positioned text into lines (by y) and cells (by horizontal gaps). */
function pdfPageRows(items) {
  const live = items.filter((i) => i.str.trim() !== '');
  live.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of live) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, it.fontSize * 0.5)) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map(({ items: row }) => {
    row.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    for (const it of row) {
      const size = it.fontSize || 10;
      // A word space is ~0.3 em; column gaps are wider. Break the cell above 0.6 em.
      if (cur && it.x - cur.end <= size * 0.6) {
        cur.text += (it.x - cur.end > size * 0.1 ? ' ' : '') + it.str.trim();
        cur.end = it.x + it.width;
      } else {
        if (cur) cells.push(cur.text);
        cur = { text: it.str.trim(), end: it.x + it.width };
      }
    }
    if (cur) cells.push(cur.text);
    return cells;
  });
}

async function pdfTables(buf) {
  let pages;
  try {
    const { extractTextItems } = await import('unpdf');
    ({ items: pages } = await withTimeout(extractTextItems(new Uint8Array(buf)), PARSE_TIMEOUT_MS));
  } catch (e) {
    if (/password/i.test(`${e?.name} ${e?.message}`)) {
      throw new ImportError('this PDF is password-protected - use an unprotected copy or the XLSX/CSV statement');
    }
    throw new ImportError('could not read this PDF - try the XLSX or CSV statement instead');
  }
  if (pages.length > MAX_PDF_PAGES) throw new ImportError(`this PDF has too many pages (max ${MAX_PDF_PAGES})`);
  const records = [];
  for (const page of pages) for (const cells of pdfPageRows(page)) records.push({ line: records.length + 1, cells });
  if (!records.length) throw new ImportError('no text found in this PDF (scanned image?) - use the XLSX or CSV statement');
  return [records];
}

/**
 * Read an uploaded file into candidate tables: an array (one per sheet; a single one for other formats)
 * of [{line, cells}] rows. Column meaning is worked out later by import-mapping.js.
 */
export async function readTables(buf) {
  if (!buf?.length) throw new ImportError('the file is empty');
  const format = detectFormat(buf);
  if (format === 'xls') throw new ImportError('old .xls files are not supported - save it as .xlsx or .csv');
  if (format === 'xlsx') return { format, tables: await xlsxTables(buf) };
  if (format === 'pdf') return { format, tables: await pdfTables(buf) };
  if (format === 'json') return { format, tables: jsonTable(buf) };
  if (buf.includes(0)) throw new ImportError('unsupported file - upload a CSV, XLSX, JSON or PDF holdings statement');
  return { format, tables: [parseCsv(buf.toString('utf8'))] };
}
