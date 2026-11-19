import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { istDate, addDays } from '../src/dates.js';
import { parseNavAll, fundDate, createFunds, isFund } from '../src/mf.js';
import { taxClass, kindOf } from '../src/assets.js';
import { capitalGains, estimateTax, harvesting, openPositions } from '../src/capital-gains.js';
import { resolveSymbols } from '../src/import-mapping.js';

const NAV_FILE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Flexi Cap Fund)

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;94.1452;18-Nov-2026
122640;INF879O01019;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth;86.0001;18-Nov-2026

Open Ended Schemes(Debt Scheme - Liquid Fund)

HDFC Mutual Fund

119091;INF179KB1HP9;-;HDFC Liquid Fund - Direct Plan - Growth Option;4981.20;18-Nov-2026
bad;line;here
`;

const fakeFetch = (routes) => async (url) => {
  const body = routes[url];
  if (body === undefined) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};

test('AMFI dates and the NAV file are read, with each scheme in its category', () => {
  assert.equal(fundDate('18-Nov-2026'), '2026-11-18');
  assert.equal(fundDate('05-01-2027'), '2027-01-05');
  assert.equal(fundDate('31-Foo-2026'), null);
  const t = parseNavAll(NAV_FILE);
  assert.equal(t.size, 3);
  assert.deepEqual(t.get('122639'), {
    code: '122639', name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', category: 'Equity Scheme - Flexi Cap Fund',
    nav: 94.1452, date: '2026-11-18', isins: ['INF879O01027'],
  });
  assert.equal(t.get('119091').category, 'Debt Scheme - Liquid Fund');
  assert.ok(isFund('MF:122639') && !isFund('MF:1') && !isFund('INFY.NS'));
});

test('fund quotes, search, history and ISINs come from AMFI and mfapi.in', async () => {
  const history = {
    meta: { scheme_name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', scheme_category: 'Equity Scheme - Flexi Cap Fund' },
    data: [{ date: '18-11-2026', nav: '94.1452' }, { date: '14-11-2026', nav: '93.0000' }, { date: '01-01-2020', nav: '30.0' }],
  };
  const funds = createFunds({
    fetch: fakeFetch({
      'https://portal.amfiindia.com/spages/NAVAll.txt': NAV_FILE,
      'https://api.mfapi.in/mf/122639': history,
    }),
    now: () => Date.parse('2026-11-19T06:00:00Z'),
  });
  const q = await funds.quote('MF:122639');
  assert.equal(q.price, 94.1452);
  assert.equal(istDate(q.marketTime), '2026-11-18', 'priced as of its NAV date');
  assert.equal(await funds.quote('MF:999999'), null);
  assert.deepEqual((await funds.search('parag flexi')).map((r) => r.symbol), ['MF:122639', 'MF:122640'], 'direct plan first');
  assert.equal((await funds.search('parag flexi'))[0].exchange, 'MF');
  assert.deepEqual(await funds.history('MF:122639', 30), [{ date: '2026-11-14', close: 93 }, { date: '2026-11-18', close: 94.1452 }]);
  assert.deepEqual(await funds.closeOn('MF:122639', '2026-11-16'), { date: '2026-11-14', close: 93 });
  assert.equal(await funds.closeOn('MF:122639', '2019-06-01'), null, 'before the fund existed');
  assert.deepEqual(await funds.profile('MF:122639'), { sector: 'Mutual funds', industry: 'Equity Scheme - Flexi Cap Fund', kind: 'mf' });
  assert.deepEqual(await funds.byIsin('INF879O01027'), { symbol: 'MF:122639', name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth' });

  // AMFI down: the latest NAV comes from mfapi.in instead.
  const fallback = createFunds({ fetch: fakeFetch({ 'https://api.mfapi.in/mf/122639': history }) });
  assert.equal((await fallback.quote('MF:122639')).price, 94.1452);
});

test('statements match mutual funds by ISIN once listed shares are ruled out', async () => {
  const rows = [{ line: 2, symbolRaw: '', isin: 'INF879O01027', name: 'PPFAS FLEXI CAP DIRECT GROWTH', exchange: '' }];
  const [m] = await resolveSymbols(rows, {
    lookupQuote: async () => null,
    search: async () => [],
    fundByIsin: async (isin) => (isin === 'INF879O01027' ? { symbol: 'MF:122639', name: 'Parag Parikh Flexi Cap Fund' } : null),
  });
  assert.deepEqual(m, { symbol: 'MF:122639', name: 'Parag Parikh Flexi Cap Fund', match: 'isin' });
});

test('tax classes: shares and equity funds are equity; debt, gold and international are not', () => {
  const c = (symbol, name, info = null) => taxClass({ symbol, name, info });
  assert.equal(c('INFY.NS', 'Infosys Limited'), 'equity');
  assert.equal(c('NIFTYBEES.NS', 'Nippon India ETF Nifty 50 BeES'), 'equity');
  assert.equal(c('GOLDBEES.NS', 'Nippon India ETF Gold BeES'), 'other');
  assert.equal(c('MON100.NS', 'Motilal Oswal NASDAQ 100 ETF'), 'other');
  assert.equal(c('PSUBNKBEES.NS', 'Nippon India ETF Nifty PSU Bank BeES'), 'equity');
  assert.equal(c('MF:122639', 'Parag Parikh Flexi Cap', { kind: 'mf', industry: 'Equity Scheme - Flexi Cap Fund' }), 'equity');
  assert.equal(c('MF:119091', 'HDFC Liquid Fund', { kind: 'mf', industry: 'Debt Scheme - Liquid Fund' }), 'other');
  assert.equal(c('MF:120716', 'UTI Nifty 50 Index Fund', { kind: 'mf', industry: 'Other Scheme - Index Funds' }), 'equity');
  assert.equal(c('MF:120717', 'Nifty G-Sec Index Fund', { kind: 'mf', industry: 'Other Scheme - Index Funds' }), 'other');
  assert.equal(c('MF:120718', 'Some Balanced Advantage Fund', { kind: 'mf', industry: 'Hybrid Scheme - Dynamic Asset Allocation or Balanced Advantage' }), 'equity');
  assert.equal(c('MF:120719', 'Some Equity Fund - Growth'), 'equity', 'category not looked up yet: by name');
  assert.equal(c('MF:120720', 'Some Corporate Bond Fund'), 'other');
  assert.equal(kindOf({ symbol: 'MF:120720' }), 'mf');
});

const sale = (saleDate, purchaseDate, gain, symbol = 'X.NS') => ({
  saleId: 1, symbol, name: symbol, saleDate, salePrice: (100_000 + gain) / 10, saleQuantity: 10, charges: 0, quantity: 10, cost: 100_000, purchaseDate,
});

test('non-equity sales are listed but left out of the estimate', () => {
  const r = capitalGains({
    lots: [sale('2026-06-01', '2026-01-01', 50_000), sale('2026-07-01', '2026-02-01', 30_000, 'MF:119091')],
    fy: 2026,
    classOf: (s) => (s.startsWith('MF:') ? 'other' : 'equity'),
  });
  assert.deepEqual(r.rows.map((x) => x.term), ['other', 'short']);
  assert.equal(r.shortTerm.net, 50_000);
  assert.deepEqual([r.other.count, r.other.net], [1, 30_000]);
  assert.equal(r.tax.shortTerm, 10_000);
  assert.equal(estimateTax(r.rows, 2026).tax.total, r.tax.total, 'estimateTax ignores other rows');
});

test('harvesting: losses saved against booked gains, then long-term gains inside the exemption, oldest purchases first', () => {
  const today = '2026-11-19';
  const lots = [
    // A: an old long-term gain, then a recent short-term one (selling the recent one means selling the old one first).
    { symbol: 'A.NS', name: 'A', purchaseDate: '2024-01-01', quantity: 10, cost: 1_000, value: 1_600, gain: 600, term: 'long' },
    { symbol: 'A.NS', name: 'A', purchaseDate: '2026-06-01', quantity: 10, cost: 1_500, value: 1_600, gain: 100, term: 'short' },
    { symbol: 'B.NS', name: 'B', purchaseDate: '2026-02-01', quantity: 5, cost: 5_000, value: 3_000, gain: -2_000, term: 'short' },
    { symbol: 'C.NS', name: 'C', purchaseDate: '2020-01-01', quantity: 100, cost: 100_000, value: 300_000, gain: 200_000, term: 'long' },
    // D has an undated purchase, so it is left out.
    { symbol: 'D.NS', name: 'D', purchaseDate: null, quantity: 1, cost: 500, value: 100, gain: -400, term: 'unknown' },
    { symbol: 'MF:119091', name: 'Liquid', purchaseDate: '2026-01-01', quantity: 1, cost: 500, value: 100, gain: -400, term: 'other' },
  ];
  const realised = [{ gain: 50_000, term: 'short', saleDate: '2026-06-01' }];
  const h = harvesting({ realised, lots, fy: 2026, today });
  assert.equal(h.daysLeft, 132);
  assert.equal(Math.round(h.taxNow), 10_400);
  assert.deepEqual(h.losses.map((l) => [l.symbol, l.loss, Math.round(l.taxSaved)]), [['B.NS', -2_000, 416]]);
  assert.equal(Math.round(h.allLosses.taxSaved), 416);
  // C has the most gain per rupee: 62 shares fill 124,000 of the 125,000; A's long-term purchase fits in what is left.
  assert.deepEqual(h.exemption.picks.map((p) => [p.symbol, p.quantity, p.gain]), [['C.NS', 62, 124_000], ['A.NS', 10, 600]]);
  assert.equal(Math.round(h.exemption.futureTaxSaved), Math.round(124_600 * 0.125 * 1.04));

  // Nothing booked yet: a loss can't save tax this year, it carries forward.
  const none = harvesting({ realised: [], lots, fy: 2026, today });
  assert.equal(none.losses[0].taxSaved, 0);
  assert.equal(none.losses[0].carriedForward, 2_000);
});

test('the capital gains endpoint includes the harvesting ideas for the current year', async () => {
  const t = await setup({ prices: { 'AAA.NS': 100, 'BBB.NS': 50 } });
  try {
    const today = istDate();
    const u = await t.login('a@example.test');
    const a = (await u.call('POST', '/api/holdings', { symbol: 'AAA.NS', quantity: 10, invested: 500, purchaseDate: addDays(today, -800) })).body;
    await u.call('POST', '/api/holdings', { symbol: 'BBB.NS', quantity: 10, invested: 900, purchaseDate: addDays(today, -30) });
    await u.call('POST', `/api/holdings/${a.id}/sell`, { quantity: 5, salePrice: 100, saleDate: today });
    await t.anon('GET', '/api/cron/poll', { headers: { authorization: 'Bearer test-cron-secret-value' } });
    const r = (await u.call('GET', '/api/capital-gains')).body;
    assert.ok(r.harvest);
    assert.deepEqual(r.harvest.losses.map((l) => [l.symbol, l.loss]), [['BBB.NS', 50 * 10 - 900]]);
    assert.deepEqual(r.harvest.exemption.picks.map((p) => [p.symbol, p.quantity]), [['AAA.NS', 5]]);
    assert.deepEqual(r.notEquity, []);
    assert.equal(r.open.lots, undefined, 'per-purchase rows stay on the server');
    const lots = openPositions({ holdings: [], latestBySymbol: new Map(), today }).lots;
    assert.deepEqual(lots, []);
  } finally {
    await t.close();
  }
});
