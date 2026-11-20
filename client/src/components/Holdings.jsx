import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useSort, SortTh } from '../sort.jsx';
import SplitReview from './SplitReview.jsx';
import AddForm from './holdings/AddForm.jsx';
import HoldingRow from './holdings/HoldingRow.jsx';
import SellRow from './holdings/SellRow.jsx';
import SalesHistory from './holdings/SalesHistory.jsx';
import { ImportExport, ImportReview } from './holdings/ImportExport.jsx';

export default function Holdings({ onChange, portfolios = [], scope = 'all' }) {
  const [holdings, setHoldings] = useState([]);
  const [rows, setRows] = useState(new Map());
  const [preview, setPreview] = useState(null); // an uploaded statement awaiting confirmation
  const [message, setMessage] = useState(null); // { ok, text }
  const [sellingId, setSellingId] = useState(null); // holding whose sell form is open
  const [sales, setSales] = useState(null);
  const [splits, setSplits] = useState([]); // splits / bonus issues waiting for the user to confirm
  const [exported, setExported] = useState(false); // exported while some stocks had no purchase date

  const load = async () => {
    const [h, r, s, sp] = await Promise.all([api.holdings(), api.report('1w'), api.sales(), api.splits()]);
    setHoldings(h);
    setRows(new Map(r.holdings.map((x) => [x.symbol, x])));
    setSales(s);
    setSplits(sp);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const changed = async () => { await load(); onChange(); };

  const sold = async (symbol, qty) => {
    setSellingId(null);
    setMessage({ ok: true, text: `Sale recorded: ${qty} ${symbol} sold. The profit is in Sales history below.` });
    await changed();
  };

  const imported = async (r) => {
    setPreview(null);
    const parts = [`${r.added} added`, `${r.updated} updated`];
    if (r.errors.length) parts.push(`${r.errors.length} skipped (${r.errors.map((e) => `${e.symbol}: ${e.error}`).join('; ')})`);
    setMessage({ ok: r.errors.length === 0, text: `Import finished: ${parts.join(', ')}.` });
    await changed();
  };

  // Several portfolios: say which one each holding is in, and where new stocks and imports go.
  const several = portfolios.length > 1;
  const portfolioName = new Map(portfolios.map((p) => [p.id, p.name]));
  const target = scope !== 'all' ? Number(scope) : portfolios[0]?.id ?? null;

  // Merge live figures into each holding so every column is sortable. The value is worked out per holding, since the
  // report has one row per stock across portfolios.
  const merged = useMemo(
    () =>
      holdings.map((h) => {
        const r = rows.get(h.symbol);
        const price = r?.price ?? null;
        const value = price == null ? null : price * h.quantity;
        const pnl = value == null ? null : value - h.invested;
        return {
          ...h,
          value,
          pnl,
          pnlPct: pnl == null || !(h.invested > 0) ? null : (pnl / h.invested) * 100,
          price,
          stale: r?.stale ?? false,
          priceAsOf: r?.priceAsOf ?? null,
          splitPending: r?.splitPending ?? false,
          portfolioName: several ? portfolioName.get(h.portfolioId) : null,
        };
      }),
    [holdings, rows, several, portfolios], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const { sorted, sort, toggle } = useSort(merged, { key: 'symbol', dir: 'asc' });
  // Stocks the export would send without a purchase date (once each, though one may sit in several portfolios).
  const undated = useMemo(() => [...new Set(holdings.filter((h) => !h.purchase_date).map((h) => h.symbol))].sort(), [holdings]);

  return (
    <>
      {splits.map((r) => <SplitReview key={r.id} r={r} onChanged={changed} onMessage={setMessage} />)}
      <AddForm onAdded={changed} portfolios={portfolios} defaultPortfolio={target} />
      <section className="card">
        <div className="card-head">
          <h2>Your holdings <span className="muted">({holdings.length} {holdings.length === 1 ? 'stock' : 'stocks'})</span></h2>
          <ImportExport
            onPreview={(p, into) => { setMessage(null); setPreview({ ...p, into }); }}
            onMessage={setMessage}
            onExport={() => setExported(undated.length > 0)}
            portfolios={portfolios}
            defaultPortfolio={target}
          />
        </div>
        <p className="muted">
          When you buy more of a stock you already hold, add it again with its purchase date: each purchase is kept separately and the totals
          are worked out for you (the average cost is invested ÷ quantity).
          To load your portfolio from a broker, use <strong>Import statement</strong> with the holdings file you download from Groww, Zerodha, Dhan, Upstox, Angel One and similar
          (Excel, CSV, JSON or PDF). You can review everything before it is saved. Export CSV gives you a file you can edit and import back,
          or load into Google Finance and other trackers (they need a purchase date for every stock).
        </p>
        {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
        {exported && (
          // Worked out from the live list, so it shrinks as dates are added.
          <div className={undated.length ? 'warn box' : 'notice'} role="status">
            {undated.length
              ? `${undated.length === 1 ? 'One stock has' : `${undated.length} stocks have`} no purchase date, so the export leaves the date blank ` +
                `and Google Finance (or another tracker) will ask for it: ${undated.join(', ')}. ` +
                'Use Add date in the Bought column, then export again.'
              : 'Every stock now has a purchase date. Export again to get them all in the file.'}
          </div>
        )}
        {preview && (
          <ImportReview preview={preview} into={preview.into} intoName={several ? portfolioName.get(preview.into) : null} onDone={imported} onCancel={() => setPreview(null)} />
        )}
        {holdings.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Stock" k="symbol" textual right={false} sort={sort} toggle={toggle} />
                  <SortTh label="Qty" k="quantity" sort={sort} toggle={toggle} />
                  <SortTh label="Invested" k="invested" sort={sort} toggle={toggle} />
                  <SortTh label="Bought" k="purchase_date" sort={sort} toggle={toggle} />
                  <SortTh label="Current value" k="value" sort={sort} toggle={toggle} />
                  <SortTh label="Profit %" k="pnlPct" sort={sort} toggle={toggle} />
                  <SortTh label="Price" k="price" sort={sort} toggle={toggle} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((h) => (
                  <Fragment key={h.id}>
                    <HoldingRow h={h} onChanged={changed} selling={sellingId === h.id} onSell={() => setSellingId(sellingId === h.id ? null : h.id)} portfolios={portfolios} />
                    {sellingId === h.id && <SellRow h={h} onDone={sold} onCancel={() => setSellingId(null)} />}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <SalesHistory sales={sales} onChanged={changed} onMessage={setMessage} />
    </>
  );
}
