import { Fragment, useState } from 'react';
import { api } from '../../api.js';
import { money, price, signedMoney, pct, tone } from '../../format.js';
import { todayIST, niceDate, shares } from './shared.js';

/** Inline form to correct a recorded sale. The server undoes the old sale and applies the new one in one step. */
function EditSaleRow({ s, onDone, onCancel }) {
  const [quantity, setQuantity] = useState(String(s.quantity));
  const [salePrice, setSalePrice] = useState(String(s.salePrice));
  const [charges, setCharges] = useState(s.charges ? String(s.charges) : '');
  const [saleDate, setSaleDate] = useState(s.saleDate);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const qty = Number(quantity);
  const sp = Number(salePrice);
  const fee = Number(charges) || 0;
  const valid = qty > 0 && sp > 0 && fee >= 0 && !!saleDate;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.updateSale(s.id, { quantity: qty, salePrice: sp, charges: fee, saleDate });
      onDone(`Sale of ${s.symbol} updated.${r.reopened ? ' The stock is back in your holdings.' : ''}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <tr className="sell-row">
      <td colSpan={8}>
        <div className="sell-panel">
          <div className="sell-head">
            <strong>Edit sale of {s.symbol}</strong>
            <span className="muted small">Saving puts the old sale back first, then records the new figures.</span>
          </div>
          <div className="row">
            <label className="field">Shares sold
              <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
            </label>
            <label className="field">Sale price per share (₹)
              <input type="number" min="0" step="any" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
            </label>
            <label className="field">Charges (₹)
              <input type="number" min="0" step="any" value={charges} onChange={(e) => setCharges(e.target.value)} />
            </label>
            <label className="field">Sale date
              <input type="date" max={todayIST()} value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </label>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="actions">
            <button className="primary" onClick={submit} disabled={!valid || busy}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** Everything sold so far, newest first, with the profit or loss booked on each sale. */
export default function SalesHistory({ sales, onChanged, onMessage }) {
  const [editingId, setEditingId] = useState(null);
  if (!sales || !sales.items.length) return null;
  const { totals } = sales;

  const remove = async (s) => {
    if (!window.confirm(`Remove this sale of ${s.quantity} ${s.symbol}? The shares go back into your holdings.`)) return;
    try {
      const r = await api.removeSale(s.id);
      onMessage({ ok: true, text: `Sale removed.${r.reopened ? ` ${s.symbol} is back in your holdings.` : ' The shares are back in your holdings.'}` });
      await onChanged();
    } catch (e) {
      onMessage({ ok: false, text: e.message });
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Sales history <span className="muted">({totals.count} {totals.count === 1 ? 'sale' : 'sales'})</span></h2>
        <div className="sell-total">
          <span className="muted small">Total profit booked</span>
          <strong className={tone(totals.realised)}>{signedMoney(totals.realised)}</strong>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sold on</th><th>Stock</th><th className="r">Qty</th><th className="r">Sale price</th>
              <th className="r">Received</th><th className="r">Cost</th><th className="r">Profit booked</th><th />
            </tr>
          </thead>
          <tbody>
            {sales.items.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td className="nowrap">{niceDate(s.saleDate)}</td>
                  <td><strong>{s.symbol}</strong><div className="muted small">{s.name}</div></td>
                  <td className="r">
                    {s.quantity}
                    {s.splitFactor !== 1 && (
                      <div className="muted small" title={`Restated after a later split or bonus issue: you sold ${shares(s.quantity / s.splitFactor)} at ${price(s.salePrice * s.splitFactor)}`}>
                        in today's shares
                      </div>
                    )}
                  </td>
                  <td className="r">{price(s.salePrice)}</td>
                  <td className="r">{money(s.proceeds - s.charges)}{s.charges > 0 && <div className="muted small">after {money(s.charges)} charges</div>}</td>
                  <td className="r">{money(s.costBasis)}</td>
                  <td className={`r ${tone(s.realised)}`}>{signedMoney(s.realised)} <span className="small">({pct(s.realisedPct)})</span></td>
                  <td className="nowrap">
                    <button aria-label={`Edit sale of ${s.symbol} on ${s.saleDate}`} onClick={() => setEditingId(editingId === s.id ? null : s.id)} aria-expanded={editingId === s.id}>Edit</button>{' '}
                    <button className="danger" aria-label={`Remove sale of ${s.symbol} on ${s.saleDate}`} onClick={() => remove(s)}>Remove</button>
                  </td>
                </tr>
                {editingId === s.id && (
                  <EditSaleRow
                    s={s}
                    onCancel={() => setEditingId(null)}
                    onDone={async (text) => { setEditingId(null); onMessage({ ok: true, text }); await onChanged(); }}
                  />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
