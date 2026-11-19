import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { money, price, signedMoney, pct, tone, timeAgo } from '../../format.js';
import { todayIST, niceDate } from './shared.js';

/** One purchase of a stock, with its own date, quantity and amount. */
function LotRow({ h, lot, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(String(lot.quantity));
  const [invested, setInvested] = useState(String(lot.invested));
  const [purchaseDate, setPurchaseDate] = useState(lot.purchase_date ?? '');
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.updateLot(h.id, lot.id, { quantity: Number(quantity), invested: Number(invested), purchaseDate: purchaseDate || null });
      setEditing(false); setError('');
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove this purchase of ${h.symbol}? Your totals will be recalculated.`)) return;
    try {
      await api.removeLot(h.id, lot.id);
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <tr className="lot">
      <td className="muted small">↳ Purchase</td>
      {editing ? (
        <>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Quantity" /></td>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} aria-label="Invested" /></td>
          <td className="r"><input type="date" max={todayIST()} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} aria-label="Purchase date" /></td>
          <td colSpan={3} className="r">
            {error && <span className="neg small">{error} </span>}
            <button onClick={save}>Save</button> <button onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
          </td>
        </>
      ) : (
        <>
          <td className="r">{lot.quantity}</td>
          <td className="r">{money(lot.invested)}</td>
          <td className="r nowrap">{niceDate(lot.purchase_date)}</td>
          <td colSpan={3} className="r">{error && <span className="neg small">{error}</span>}</td>
        </>
      )}
      <td className="r nowrap">
        {!editing && <button onClick={() => setEditing(true)}>Edit</button>} <button className="danger" onClick={remove}>Remove</button>
      </td>
    </tr>
  );
}

export default function HoldingRow({ h, onChanged, onSell, selling, portfolios = [] }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const multi = (h.lots?.length ?? 0) > 1; // bought on several occasions: edit each purchase on its own
  const [quantity, setQuantity] = useState(String(h.quantity));
  const [invested, setInvested] = useState(String(h.invested));
  const [purchaseDate, setPurchaseDate] = useState(h.purchase_date ?? '');
  const [error, setError] = useState('');
  // The row is keyed by id, so refresh the edit fields whenever the saved figures change.
  useEffect(() => {
    setQuantity(String(h.quantity)); setInvested(String(h.invested)); setPurchaseDate(h.purchase_date ?? '');
  }, [h.quantity, h.invested, h.purchase_date]);



  const save = async () => {
    try {
      await api.updateHolding(h.id, {
        quantity: Number(quantity),
        invested: Number(invested),
        purchaseDate: purchaseDate || null, // empty clears the date
      });
      setEditing(false); setError('');
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };
  const move = async (portfolioId) => {
    const to = portfolios.find((p) => p.id === portfolioId)?.name;
    if (!window.confirm(`Move ${h.symbol} to ${to}? If ${to} already holds it, these purchases are added to that holding.`)) return;
    try {
      await api.moveHolding(h.id, portfolioId);
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${h.symbol} and its history/alerts?`)) return;
    await api.removeHolding(h.id);
    onChanged();
  };

  return (
    <>
    <tr>
      <td>
        <strong>{h.symbol}</strong><div className="muted small">{h.name}</div>
        {h.portfolioName && <span className="mk-tag">{h.portfolioName}</span>}
        {h.splitPending && <span className="stale" title="A split or bonus issue is waiting for you to confirm it, above">Split to confirm</span>}
      </td>
      {editing ? (
        <>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Quantity" /></td>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} aria-label="Invested" /></td>
          <td className="r"><input type="date" max={todayIST()} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} aria-label="Purchase date" /></td>
          <td colSpan={3} className="r">
            {error && <span className="neg small">{error} </span>}
            <button onClick={save}>Save</button> <button onClick={() => setEditing(false)}>Cancel</button>
          </td>
        </>
      ) : (
        <>
          <td className="r">{h.quantity}</td>
          <td className="r">{money(h.invested)}</td>
          <td className="r nowrap">
            {niceDate(h.purchase_date)}
            {multi && <div className="muted small">earliest of {h.lots.length} purchases</div>}
          </td>
          <td className="r">{h.value == null ? '—' : money(h.value)}</td>
          <td className={`r ${tone(h.pnl)}`}>{h.pnl == null ? '—' : <>{signedMoney(h.pnl)} <span className="small">({pct(h.pnlPct)})</span></>}</td>
          <td className="r">
            {price(h.price)}
            {h.stale && <div><span className="stale" title="This price is older than expected. The next refresh will update it.">Stale · {timeAgo(h.priceAsOf)}</span></div>}
          </td>
        </>
      )}
      <td className="r nowrap">
        <button onClick={onSell} aria-expanded={selling} aria-label={`Sell ${h.symbol}`}>Sell</button>{' '}
        {multi
          ? <button onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Purchases'} ({h.lots.length})</button>
          : !editing && <button aria-label={`Edit ${h.symbol}`} onClick={() => setEditing(true)}>Edit</button>}{' '}
        <button className="danger" aria-label={`Remove ${h.symbol}`} onClick={remove}>Remove</button>
        {portfolios.length > 1 && (
          <div className="move">
            <select value="" onChange={(e) => move(Number(e.target.value))} aria-label={`Move ${h.symbol} to another portfolio`}>
              <option value="" disabled>Move to…</option>
              {portfolios.filter((p) => p.id !== h.portfolioId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </td>
    </tr>
    {multi && open && h.lots.map((l) => <LotRow key={`${l.id}-${l.quantity}-${l.invested}-${l.purchase_date}`} h={h} lot={l} onChanged={onChanged} />)}
    </>
  );
}
