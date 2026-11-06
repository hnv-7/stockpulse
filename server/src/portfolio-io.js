import { istDate, isRealDate } from './dates.js';

/** Most data rows accepted from one uploaded file. */
export const MAX_IMPORT_ROWS = 500;

/** Minimal RFC 4180 parser: quoted fields, "" escapes, CRLF/LF, leading BOM. Returns [{line, cells}] for non-blank rows. */
export function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells: row });
    row = [];
    cell = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += c;
  }
  endRow();
  return rows;
}

/**
 * Serialise rows to CSV. Text cells that a spreadsheet could run as a formula
 * (leading = + - @ tab CR) are prefixed with an apostrophe so exported files are safe to open.
 */
export function toCsv(header, rows) {
  const cell = (v) => {
    if (v == null) return '';
    let t = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Purchase dates may not be in the future. */
export const isPastOrToday = (s) => isRealDate(s) && s <= istDate();

/**
 * Merge validated rows into a user's portfolio: existing symbols are updated, new ones are added
 * (after checking the symbol exists). Nothing is ever deleted. Per-row failures don't stop the rest.
 */
export async function importHoldings({ store, tracker, lookupQuote, maxHoldings, userId, rows }) {
  const existing = new Map((await store.listHoldings(userId)).map((h) => [h.symbol, h]));
  const errors = [];
  const toUpdate = [];
  const toAdd = [];
  const seen = new Set();
  let count = existing.size;

  for (const r of rows) {
    if (seen.has(r.symbol)) {
      errors.push({ line: r.line, symbol: r.symbol, error: 'symbol appears more than once in the file' });
      continue;
    }
    seen.add(r.symbol);
    if (existing.has(r.symbol)) toUpdate.push(r);
    else if (count >= maxHoldings) {
      errors.push({ line: r.line, symbol: r.symbol, error: `you can track up to ${maxHoldings} stocks` });
    } else {
      count++;
      toAdd.push(r);
    }
  }

  let updated = 0;
  for (const r of toUpdate) {
    // A blank date in the file keeps the stored one; it never clears it.
    const saved = await store.updateHolding(userId, existing.get(r.symbol).id, {
      quantity: r.quantity,
      invested: r.invested,
      purchaseDate: r.purchaseDate ?? undefined,
    });
    if (saved) updated++;
    else errors.push({ line: r.line, symbol: r.symbol, error: 'could not update' });
  }

  const quotes = await Promise.all(toAdd.map((r) => lookupQuote(r.symbol).catch(() => null)));
  const added = [];
  for (let i = 0; i < toAdd.length; i++) {
    const r = toAdd[i];
    const quote = quotes[i];
    if (!quote) {
      errors.push({ line: r.line, symbol: r.symbol, error: 'symbol not found (use NSE/BSE format, e.g. INFY.NS)' });
      continue;
    }
    try {
      await store.addHolding(userId, {
        symbol: r.symbol,
        name: quote.name,
        quantity: r.quantity,
        invested: r.invested,
        purchaseDate: r.purchaseDate ?? null,
      });
      added.push({ symbol: r.symbol, price: quote.price });
    } catch {
      errors.push({ line: r.line, symbol: r.symbol, error: 'could not add' });
    }
  }

  // Price history is shared between users; fetch it for the new symbols a few at a time.
  for (let i = 0; i < added.length; i += 5) {
    await Promise.allSettled(added.slice(i, i + 5).map((a) => tracker.backfill(a.symbol)));
  }
  await store.saveSnapshots(added.map((a) => ({ symbol: a.symbol, ts: Date.now(), price: a.price })));

  errors.sort((a, b) => a.line - b.line);
  return { added: added.length, updated, errors };
}
