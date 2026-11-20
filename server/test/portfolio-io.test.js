import { test } from 'node:test';
import assert from 'node:assert/strict';
import writeExcelFile from 'write-excel-file/node';
import { setup } from './helpers.js';
import { parseCsv, toCsv } from '../src/portfolio-io.js';
import { isRealDate } from '../src/dates.js';
import { detectFormat } from '../src/import-formats.js';

// ---------- helpers ----------
const raw = (t, u, path, body, type = 'application/octet-stream', csrf = true) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { cookie: u.session.cookie, ...(csrf ? { 'x-csrf-token': u.session.csrfToken } : {}), 'content-type': type },
    body,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const preview = (t, u, body) => raw(t, u, '/api/holdings/import/preview', body);
const confirm = (u, items) => u.call('POST', '/api/holdings/import', { items });
const toItems = (p) => p.body.items.map(({ symbol, quantity, invested, purchaseDate }) => ({ symbol, quantity, invested, purchaseDate }));

/** Minimal one-page PDF with absolutely positioned text, so the table has real columns. */
function makePdf(cells) {
  const esc = (s) => s.replace(/[\\()]/g, '\\$&');
  const stream = cells.map((c) => `BT /F1 9 Tf ${c.x} ${c.y} Td (${esc(c.text)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- unit tests ----------
test('CSV parser handles quotes, CRLF, BOM and blank lines', () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\r\n\r\n1,2\n');
  assert.deepEqual(rows.map((r) => r.cells), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
});

test('CSV writer quotes cells and neutralises spreadsheet formulas', () => {
  const out = toCsv(['A', 'B'], [['=1+1', 'a,"b"'], [-5, null]]);
  assert.equal(out, "A,B\r\n'=1+1,\"a,\"\"b\"\"\"\r\n-5,\r\n");
});

test('isRealDate rejects impossible dates', () => {
  assert.ok(isRealDate('2024-02-29'));
  assert.ok(!isRealDate('2023-02-29'));
  assert.ok(!isRealDate('2024-13-01'));
  assert.ok(!isRealDate('24-01-01'));
});

test('file type is detected from the bytes, not the name', async () => {
  const xlsx = await writeExcelFile([['a']]).toBuffer();
  assert.equal(detectFormat(xlsx), 'xlsx');
  assert.equal(detectFormat(makePdf([{ x: 10, y: 10, text: 'hi' }])), 'pdf');
  assert.equal(detectFormat(Buffer.from('  {"a":1}')), 'json');
  assert.equal(detectFormat(Buffer.from('[1]')), 'json');
  assert.equal(detectFormat(Buffer.from('a,b\n1,2')), 'csv');
  assert.equal(detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), 'xls');
});

// ---------- purchase date ----------
test('purchase date is optional, validated, editable and clearable', async () => {
  const t = await setup();
  try {
    const u = await t.login('d@example.test');
    let r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 10 });
    assert.equal(r.status, 201);
    assert.equal(r.body.purchase_date, null);
    const id = r.body.id;

    const bad = ['2999-01-01', '2023-02-30', 'yesterday', '01-02-2024'];
    for (const purchaseDate of bad) {
      assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 1, purchaseDate })).status, 400, purchaseDate);
      assert.equal((await u.call('PUT', `/api/holdings/${id}`, { quantity: 1, invested: 10, purchaseDate })).status, 400, purchaseDate);
    }

    r = await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 2, invested: 20, purchaseDate: '2024-03-05' });
    assert.equal(r.status, 201);
    assert.equal(r.body.purchase_date, '2024-03-05');

    r = await u.call('PUT', `/api/holdings/${id}`, { quantity: 1, invested: 10, purchaseDate: '2023-12-31' });
    assert.equal(r.body.purchase_date, '2023-12-31');
    r = await u.call('PUT', `/api/holdings/${id}`, { quantity: 2, invested: 12 });
    assert.equal(r.body.purchase_date, '2023-12-31', 'omitting the date keeps it');
    r = await u.call('PUT', `/api/holdings/${id}`, { quantity: 2, invested: 12, purchaseDate: null });
    assert.equal(r.body.purchase_date, null, 'null clears it');
  } finally {
    await t.close();
  }
});

test('purchase date fills in the missing quantity or amount from that day\'s close', async () => {
  const asked = [];
  const t = await setup({
    deps: {
      // Saturday 2024-03-02 resolves to Friday's close, as the real lookup does.
      getCloseOn: async (symbol, date) => {
        asked.push([symbol, date]);
        if (symbol === 'BBB.NS') return null;
        return { date: date === '2024-03-02' ? '2024-03-01' : date, close: 250 };
      },
    },
  });
  try {
    const u = await t.login('f@example.test');

    // amount only -> shares
    let r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', invested: 1000, purchaseDate: '2024-03-02' });
    assert.equal(r.status, 201);
    assert.equal(r.body.quantity, 4);
    assert.equal(r.body.invested, 1000);
    assert.deepEqual(r.body.priceOn, { date: '2024-03-01', close: 250 });
    assert.deepEqual(asked, [['AAA.NS', '2024-03-02']]);

    // shares only -> amount
    await u.call('DELETE', `/api/holdings/${r.body.id}`);
    r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 3, purchaseDate: '2024-03-05' });
    assert.equal(r.status, 201);
    assert.equal(r.body.invested, 750);

    // both given -> Yahoo is not consulted and nothing is overridden
    const before = asked.length;
    await u.call('DELETE', `/api/holdings/${r.body.id}`);
    r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 3, invested: 600, purchaseDate: '2024-03-05' });
    assert.equal(r.status, 201);
    assert.equal(r.body.invested, 600);
    assert.equal(r.body.priceOn, undefined);
    assert.equal(asked.length, before);

    // refusals
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1 })).status, 400, 'one field, no date');
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', purchaseDate: '2024-03-05' })).status, 400, 'neither field');
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', invested: 100, purchaseDate: '2024-03-05' })).status, 404, 'no price that day');
    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', invested: 100, purchaseDate: '2999-01-01' })).status, 400, 'future date');
  } finally {
    await t.close();
  }
});

test('buying the same stock again keeps each purchase with its own date; each can be edited or removed', async () => {
  const t = await setup();
  try {
    const u = await t.login('lots@example.test');
    let r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: '2024-01-10' });
    assert.equal(r.status, 201);
    const id = r.body.id;
    assert.equal(r.body.lots.length, 1);

    assert.equal((await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 600, purchaseDate: '2025-06-01' })).status, 409, 'needs the user to agree');

    r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 5, invested: 600, purchaseDate: '2025-06-01', merge: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.merged, true);
    assert.equal(r.body.quantity, 15);
    assert.equal(r.body.invested, 1600);
    assert.equal(r.body.purchase_date, '2024-01-10', 'earliest purchase date');
    assert.deepEqual(r.body.lots.map((l) => [l.quantity, l.invested, l.purchase_date]), [[10, 1000, '2024-01-10'], [5, 600, '2025-06-01']]);

    // A purchase made before the first one becomes the earliest.
    r = await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 50, purchaseDate: '2023-02-02', merge: true });
    assert.equal(r.body.purchase_date, '2023-02-02');
    assert.equal(r.body.lots.length, 3);

    // Edit one purchase's date and amount: totals follow.
    const second = r.body.lots.find((l) => l.purchase_date === '2025-06-01');
    r = await u.call('PUT', `/api/holdings/${id}/lots/${second.id}`, { quantity: 4, invested: 500, purchaseDate: '2025-07-01' });
    assert.equal(r.status, 200);
    assert.equal(r.body.quantity, 15);
    assert.equal(r.body.invested, 1550);
    assert.ok(r.body.lots.some((l) => l.purchase_date === '2025-07-01'));
    assert.equal((await u.call('PUT', `/api/holdings/${id}/lots/999999`, { quantity: 1, invested: 1 })).status, 404);
    assert.equal((await u.call('PUT', `/api/holdings/${id}/lots/${second.id}`, { quantity: 1, invested: 1, purchaseDate: '2999-01-01' })).status, 400);

    // Remove one purchase: totals and earliest date follow. The last one cannot be removed.
    const earliest = r.body.lots.find((l) => l.purchase_date === '2023-02-02');
    r = await u.call('DELETE', `/api/holdings/${id}/lots/${earliest.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.quantity, 14);
    assert.equal(r.body.invested, 1500);
    assert.equal(r.body.purchase_date, '2024-01-10');
    const rest = r.body.lots;
    assert.equal((await u.call('DELETE', `/api/holdings/${id}/lots/${rest[0].id}`)).status, 200);
    assert.equal((await u.call('DELETE', `/api/holdings/${id}/lots/${rest[1].id}`)).status, 400, 'only purchase left');

    // Another user cannot touch these purchases.
    const other = await t.login('other-lots@example.test');
    assert.equal((await other.call('PUT', `/api/holdings/${id}/lots/${rest[1].id}`, { quantity: 1, invested: 1 })).status, 404);
    assert.equal((await other.call('DELETE', `/api/holdings/${id}/lots/${rest[1].id}`)).status, 404);

    // The single-purchase edit still works and leaves one purchase.
    r = await u.call('PUT', `/api/holdings/${id}`, { quantity: 3, invested: 300, purchaseDate: '2024-05-05' });
    assert.equal(r.body.lots.length, 1);
    assert.equal(r.body.lots[0].purchase_date, '2024-05-05');
  } finally {
    await t.close();
  }
});



// ---------- export ----------
test('export is a CSV that previews back to the same holdings', async () => {
  const t = await setup();
  try {
    const u = await t.login('e@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 1000, purchaseDate: '2024-01-15' });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 4, invested: 200 });

    const exp = await fetch(`${t.base}/api/holdings/export`, { headers: { cookie: u.session.cookie } });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-type'), /text\/csv/);
    assert.match(exp.headers.get('content-disposition'), /attachment; filename="stockbeat-portfolio-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = await exp.text();
    assert.equal(csv.split('\r\n')[0], 'Symbol,Name,Quantity,Invested,Purchase Price,Purchase Date');
    assert.match(csv, /AAA\.NS,AAA\.NS Ltd,10,1000,100,2024-01-15\r\n/);
    // No date stored: the cell is left blank rather than made up.
    assert.match(csv, /BBB\.NS,BBB\.NS Ltd,4,200,50,\r\n/);

    const p = await preview(t, u, csv);
    assert.equal(p.status, 200);
    assert.equal(p.body.format, 'csv');
    assert.deepEqual(p.body.errors, []);
    assert.deepEqual(p.body.items.map((i) => [i.symbol, i.action, i.quantity, i.invested, i.purchaseDate]), [
      ['AAA.NS', 'update', 10, 1000, '2024-01-15'],
      ['BBB.NS', 'update', 4, 200, null],
    ]);
    assert.equal((await t.anon('GET', '/api/holdings/export')).status, 401);
  } finally {
    await t.close();
  }
});

// ---------- broker statements ----------
const GROWW_ROWS = [
  ['Name', 'Test User'],
  ['Unique Client Code', '1234567890'],
  [null],
  ['Holdings statement for stocks as on 05-11-2026'],
  [null],
  ['Summary'],
  ['Invested Value', 1000],
  [null],
  ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', 'Unrealised P&L'],
  ['ADANI ENTERPRISES LIMITED', 'INE423A01024', 3, 2471, 7413, 2733.3, 8199.9, 786.9],
  ['HINDUSTAN UNILEVER LTD.', 'INE030A01027', 10, 1836.14, 18361.4, 1982, 19820, 1458.6],
  ['TATA MOTORS PASS VEH LTD', 'INE155A01022', 8, 263.9, 2111.2, 293.7, 2349.6, 238.4],
  ['MYSTERY CORP', 'INE000000000', 5, 10, 50, 11, 55, 5],
];
const growwSearch = async (q) =>
  ({
    INE423A01024: [{ symbol: 'ADANIENT.BO', name: 'Adani Enterprises', exchange: 'BSE' }], // BSE only: NSE must be derived
    INE030A01027: [{ symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever', exchange: 'NSE' }],
    'TATA MOTORS PASS VEH LTD': [{ symbol: 'TMPV.NS', name: 'Tata Motors PV', exchange: 'NSE' }],
  })[q] ?? [];

test('Groww-style XLSX: finds the header after the preamble, resolves ISIN/name to NSE symbols, imports', async () => {
  const t = await setup({
    prices: { 'ADANIENT.NS': 2733, 'HINDUNILVR.NS': 1982, 'TMPV.NS': 293 },
    deps: { searchSymbols: growwSearch },
  });
  try {
    const u = await t.login('g@example.test');
    const file = await writeExcelFile(GROWW_ROWS).toBuffer();
    const p = await preview(t, u, file);
    assert.equal(p.status, 200);
    assert.equal(p.body.format, 'xlsx');

    const by = Object.fromEntries(p.body.items.map((i) => [i.symbol, i]));
    assert.deepEqual(Object.keys(by).sort(), ['ADANIENT.NS', 'HINDUNILVR.NS', 'TMPV.NS']);
    assert.equal(by['ADANIENT.NS'].quantity, 3);
    assert.equal(by['ADANIENT.NS'].invested, 7413);
    assert.equal(by['ADANIENT.NS'].match, 'isin');
    assert.equal(by['HINDUNILVR.NS'].invested, 18361.4);
    assert.equal(by['TMPV.NS'].match, 'name', 'no ISIN hit, so matched by name');
    assert.ok(by['TMPV.NS'].notes.some((n) => /check/.test(n)));
    assert.equal(p.body.errors.length, 1);
    assert.match(p.body.errors[0].error, /could not match "MYSTERY CORP"/);
    assert.equal(p.body.errors[0].line, 13);

    // Previewing saved nothing.
    assert.equal((await u.call('GET', '/api/holdings')).body.length, 0);

    const r = await confirm(u, toItems(p));
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 3);
    assert.deepEqual(r.body.errors, []);
    const saved = (await u.call('GET', '/api/holdings')).body;
    assert.equal(saved.length, 3);
    assert.equal(saved.find((h) => h.symbol === 'TMPV.NS').name, 'TMPV.NS Ltd');

    // A second statement updates in place and shows the old values.
    const again = await preview(t, u, file);
    assert.ok(again.body.items.every((i) => i.action === 'update' && i.current));
    assert.equal(again.body.items.find((i) => i.symbol === 'HINDUNILVR.NS').current.quantity, 10);
  } finally {
    await t.close();
  }
});

test('Zerodha Kite CSV: Instrument / Qty. / Avg. cost, with exchange series suffixes', async () => {
  const t = await setup({ prices: { 'RELIANCE.NS': 1, 'TCS.NS': 1, 'SMALL.NS': 1 } });
  try {
    const u = await t.login('k@example.test');
    const csv = [
      'Instrument,Qty.,Avg. cost,LTP,Invested,Cur. val,P&L,Net chg.,Day chg.',
      'RELIANCE,2,"1,200.50",1300,"2,401.00",2600,199,8.2%,0.5%',
      'TCS-BE,1,3500,3600,3500,3600,100,2.8%,0.1%',
      'SMALL,0,10,10,0,0,0,0%,0%',
      'Total,,,,5901,6200,299,,',
    ].join('\n');
    const p = await preview(t, u, csv);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.errors, []);
    assert.deepEqual(
      p.body.items.map((i) => [i.symbol, i.quantity, i.invested]),
      [['RELIANCE.NS', 2, 2401], ['TCS.NS', 1, 3500]],
      'fully-sold (qty 0) and Total rows are skipped; invested comes from the column',
    );
  } finally {
    await t.close();
  }
});

test('Zerodha Console statement: preamble, split quantity columns, average price only', async () => {
  const t = await setup({ prices: { 'INFY.NS': 1, 'ITC.NS': 1 } });
  try {
    const u = await t.login('c@example.test');
    const csv = [
      'Equity Holdings Statement as on 2026-11-05',
      '',
      'Client ID,AB1234',
      '',
      'Symbol,ISIN,Sector,Quantity Available,Quantity Discrepant,Quantity Long Term,Quantity Pledged (Margin),Quantity Pledged (Loan),Average Price,Previous Closing Price,Unrealized P&L,Unrealized P&L Pct.',
      'INFY,INE009A01021,IT,5,0,5,2,1,1500.25,1600,100,6.5',
      'ITC,INE154A01025,FMCG,10,0,0,0,0,255.13,278,22,8.9',
    ].join('\r\n');
    const p = await preview(t, u, csv);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.errors, []);
    const infy = p.body.items.find((i) => i.symbol === 'INFY.NS');
    assert.equal(infy.quantity, 8, 'available + pledged; the long-term column is a subset');
    assert.equal(infy.invested, 12002, '8 x 1500.25');
    assert.equal(p.body.items.find((i) => i.symbol === 'ITC.NS').invested, 2551.3);
  } finally {
    await t.close();
  }
});

test('JSON from broker APIs: Dhan array, Zerodha {data:[]}, Upstox nested', async () => {
  const t = await setup({ prices: { 'HDFCBANK.NS': 1, 'SBIN.NS': 1, 'ONGC.NS': 1 } });
  try {
    const u = await t.login('j@example.test');
    const dhan = JSON.stringify([
      { exchange: 'ALL', tradingSymbol: 'HDFCBANK', securityId: '1333', isin: 'INE040A01034', totalQty: 10, dpQty: 10, avgCostPrice: 1500.5 },
    ]);
    let p = await preview(t, u, dhan);
    assert.equal(p.body.format, 'json');
    assert.deepEqual(p.body.items.map((i) => [i.symbol, i.quantity, i.invested]), [['HDFCBANK.NS', 10, 15005]]);

    const kite = JSON.stringify({ status: 'success', data: [{ tradingsymbol: 'SBIN', exchange: 'NSE', quantity: 3, average_price: 600, last_price: 700 }] });
    p = await preview(t, u, kite);
    assert.deepEqual(p.body.items.map((i) => [i.symbol, i.quantity, i.invested]), [['SBIN.NS', 3, 1800]]);

    const upstox = JSON.stringify({ status: 'success', data: { holdings: [{ company_name: 'ONGC', trading_symbol: 'ONGC', isin: 'INE213A01029', quantity: 4, average_price: 220 }] } });
    p = await preview(t, u, upstox);
    assert.deepEqual(p.body.items.map((i) => [i.symbol, i.quantity, i.invested]), [['ONGC.NS', 4, 880]]);

    assert.match((await preview(t, u, '{"hello":"world"}')).body.error, /could not find a list of holdings/);
    assert.match((await preview(t, u, '{"broken":')).body.error, /not valid JSON/);
  } finally {
    await t.close();
  }
});

test('PDF statement: text positions are rebuilt into a table', async () => {
  const t = await setup({ prices: { 'AAA.NS': 1, 'BBB.NS': 1 } });
  try {
    const u = await t.login('p@example.test');
    const cols = [40, 200, 270, 340, 420];
    const row = (y, vals) => vals.map((text, i) => ({ x: cols[i], y, text }));
    const pdf = makePdf([
      { x: 40, y: 740, text: 'Holdings Statement (Equity)' },
      ...row(700, ['Symbol', 'ISIN', 'Quantity', 'Average buy price', 'Buy value']),
      ...row(680, ['AAA.NS', 'INE000AAA011', '10', '1,000.50', '10,005.00']),
      ...row(660, ['BBB.NS', 'INE000BBB012', '4', '250', '1,000']),
      ...row(640, ['Total', '', '', '', '11,005.00']),
    ]);
    const p = await preview(t, u, pdf);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.format, 'pdf');
    assert.deepEqual(p.body.items.map((i) => [i.symbol, i.quantity, i.invested]), [['AAA.NS', 10, 10005], ['BBB.NS', 4, 1000]]);

    assert.match((await preview(t, u, makePdf([{ x: 40, y: 700, text: 'Nothing useful here' }]))).body.error, /could not find a holdings table/);
    assert.match((await preview(t, u, Buffer.from('%PDF-1.4\nthis is not a real pdf'))).body.error, /could not read this PDF/);
  } finally {
    await t.close();
  }
});

test('preview: duplicate lots merge, bad dates are ignored with a note, cap applies', async () => {
  const t = await setup({ prices: { 'AAA.NS': 1, 'BBB.NS': 1, 'CCC.NS': 1 }, env: { MAX_HOLDINGS_PER_USER: '2' } });
  try {
    const u = await t.login('m@example.test');
    const csv = [
      'Symbol,Quantity,Invested,Purchase Date',
      'AAA.NS,2,200,05-03-2024',
      'AAA.NS,3,330,12 Jan 2023',
      'BBB.NS,1,10,2999-01-01',
      'CCC.NS,1,10,',
      'BBB.NS,abc,10,',
    ].join('\n');
    const p = await preview(t, u, csv);
    assert.equal(p.status, 200);
    const aaa = p.body.items.find((i) => i.symbol === 'AAA.NS');
    assert.equal(aaa.quantity, 5);
    assert.equal(aaa.invested, 530);
    assert.equal(aaa.purchaseDate, '2023-01-12', 'earliest purchase date wins');
    assert.ok(aaa.notes.some((n) => /merged/.test(n)));
    const bbb = p.body.items.find((i) => i.symbol === 'BBB.NS');
    assert.equal(bbb.purchaseDate, null);
    assert.ok(bbb.notes.some((n) => /date ignored/.test(n)));
    assert.ok(p.body.errors.some((e) => /quantity/.test(e.error)), 'non-numeric quantity is reported');
    assert.ok(p.body.errors.some((e) => /up to 2 stocks/.test(e.error)), 'third new stock exceeds the cap');
    assert.equal(p.body.items.length, 2);
  } finally {
    await t.close();
  }
});

test('confirm step validates every row, never deletes, and a blank date keeps the stored one', async () => {
  const t = await setup();
  try {
    const u = await t.login('v@example.test');
    await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 1, invested: 10, purchaseDate: '2024-01-01' });
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 1, invested: 10 });

    assert.equal((await confirm(u, [])).status, 400);
    assert.equal((await confirm(u, [{ symbol: 'A; DROP', quantity: 1, invested: 1 }])).status, 400);
    assert.equal((await confirm(u, [{ symbol: 'AAA.NS', quantity: -1, invested: 1 }])).status, 400);
    assert.equal((await confirm(u, [{ symbol: 'AAA.NS', quantity: 1, invested: 1, purchaseDate: '2999-01-01' }])).status, 400);
    assert.equal((await u.call('POST', '/api/holdings/import', { nope: true })).status, 400);

    const r = await confirm(u, [{ symbol: 'AAA.NS', quantity: 5, invested: 55, purchaseDate: null }, { symbol: 'ZZZ.NS', quantity: 1, invested: 1 }]);
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, 1);
    assert.equal(r.body.added, 0);
    assert.match(r.body.errors[0].error, /symbol not found/);
    const list = (await u.call('GET', '/api/holdings')).body;
    assert.equal(list.length, 2, 'BBB.NS, absent from the import, is untouched');
    const aaa = list.find((h) => h.symbol === 'AAA.NS');
    assert.equal(aaa.quantity, 5);
    assert.equal(aaa.purchase_date, '2024-01-01');
  } finally {
    await t.close();
  }
});

test('bad uploads get clear errors; limits and auth are enforced', async () => {
  const t = await setup();
  try {
    const u = await t.login('b@example.test');
    assert.equal((await raw(t, u, '/api/holdings/import/preview', Buffer.alloc(0))).status, 400);
    assert.match((await preview(t, u, Buffer.from([0, 1, 2, 3, 255, 254, 0]))).body.error, /unsupported file/);
    assert.match((await preview(t, u, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]))).body.error, /\.xls files are not supported/);
    assert.match((await preview(t, u, Buffer.from('PK\x03\x04 definitely not a zip'))).body.error, /could not read this Excel file/);
    assert.match((await preview(t, u, 'Foo,Bar\n1,2')).body.error, /could not find a holdings table/);
    assert.match((await preview(t, u, 'Symbol,Quantity,Invested')).body.error, /no holdings rows/);

    const big = await raw(t, u, '/api/holdings/import/preview', Buffer.alloc(2 * 1024 * 1024 + 10, 97));
    assert.equal(big.status, 413);

    const many = `Symbol,Quantity,Invested\n${Array.from({ length: 501 }, (_, i) => `S${i}.NS,1,1`).join('\n')}`;
    assert.match((await preview(t, u, many)).body.error, /too many rows/);

    assert.equal((await raw(t, u, '/api/holdings/import/preview', 'Symbol,Quantity,Invested\nAAA.NS,1,1', 'text/csv', false)).status, 403, 'CSRF token required');
    const anon = await fetch(`${t.base}/api/holdings/import/preview`, { method: 'POST', body: 'x' });
    assert.equal(anon.status, 401);
  } finally {
    await t.close();
  }
});
