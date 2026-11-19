import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { money, price, signedMoney, pct, tone } from '../../format.js';
import { todayIST } from './shared.js';

/**
 * Sell form for one stock. Purchases are sold oldest first, so the preview walks them the same way the server does
 * and shows the cost of the shares being sold, the charges and the profit before anything is saved.
 */
export default function SellRow({ h, onDone, onCancel }) {
  const [quantity, setQuantity] = useState('');
  const [salePrice, setSalePrice] = useState(h.price != null ? String(h.price) : '');
  const [charges, setCharges] = useState('');
  const [saleDate, setSaleDate] = useState(todayIST());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const qty = Number(quantity);
  const sp = Number(salePrice);
  const fee = Number(charges) || 0;
  const valid = qty > 0 && qty <= h.quantity && sp > 0 && fee >= 0;

  // Cost of the shares being sold: whole purchases first (oldest), then a share of the next one.
  const preview = useMemo(() => {
    if (!valid) return null;
    let left = qty;
    let cost = 0;
    for (const l of h.lots ?? []) {
      if (left <= 0) break;
      const take = Math.min(l.quantity, left);
      cost += (l.invested * take) / l.quantity;
      left -= take;
    }
    const proceeds = qty * sp;
    const realised = proceeds - fee - cost;
    return { cost, proceeds, realised, realisedPct: cost > 0 ? (realised / cost) * 100 : null, closes: qty >= h.quantity };
  }, [valid, qty, sp, fee, h.lots, h.quantity]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.sell(h.id, { quantity: qty, salePrice: sp, charges: fee, saleDate });
      onDone(h.symbol, qty);
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
            <strong>Sell {h.symbol}</strong>
            <span className="muted small">You hold {h.quantity} shares · average cost {price(h.invested / h.quantity)} · oldest purchases are sold first</span>
          </div>
          <div className="row">
            <label className="field">Shares to sell
              <span className="with-link">
                <input type="number" min="0" max={h.quantity} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
                <button type="button" className="link" onClick={() => setQuantity(String(h.quantity))}>All {h.quantity}</button>
              </span>
            </label>
            <label className="field">Sale price per share (₹)
              <input type="number" min="0" step="any" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
            </label>
            <label className="field">Charges, optional (₹)
              <input type="number" min="0" step="any" placeholder="brokerage, STT…" value={charges} onChange={(e) => setCharges(e.target.value)} />
            </label>
            <label className="field">Sale date
              <input type="date" max={todayIST()} value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </label>
          </div>
          {quantity !== '' && qty > h.quantity && <div className="error" role="alert">You only hold {h.quantity} shares.</div>}
          {preview && (
            <div className="sell-preview" aria-live="polite">
              <div><span className="muted small">You receive</span><strong>{money(preview.proceeds - fee)}</strong></div>
              <div><span className="muted small">Cost of these shares</span><strong>{money(preview.cost)}</strong></div>
              <div>
                <span className="muted small">{preview.realised >= 0 ? 'Profit booked' : 'Loss booked'}</span>
                <strong className={tone(preview.realised)}>{signedMoney(preview.realised)} <span className="small">({pct(preview.realisedPct)})</span></strong>
              </div>
              <div><span className="muted small">Left after sale</span><strong>{preview.closes ? 'Nothing — position closes' : `${Math.round((h.quantity - qty) * 10000) / 10000} shares`}</strong></div>
            </div>
          )}
          {error && <div className="error" role="alert">{error}</div>}
          <div className="actions">
            <button className="primary" onClick={submit} disabled={!preview || busy}>{busy ? 'Saving…' : 'Confirm sale'}</button>
            <button onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </div>
      </td>
    </tr>
  );
}
