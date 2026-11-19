import { useState } from 'react';
import { api } from '../../api.js';
import { money, price } from '../../format.js';
import SymbolSearch from '../SymbolSearch.jsx';
import { todayIST, niceDate } from './shared.js';

export default function AddForm({ onAdded, portfolios = [], defaultPortfolio = null }) {
  const [portfolioId, setPortfolioId] = useState(defaultPortfolio);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [invested, setInvested] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [duplicate, setDuplicate] = useState(null); // symbol already held, awaiting the user's OK to add to it
  const [busy, setBusy] = useState(false);

  // Mutual funds are bought in units, at the day's NAV.
  const isFund = (picked?.symbol ?? query).toUpperCase().startsWith('MF:');
  const unit = isFund ? 'units' : 'shares';

  const submit = async (e, merge = false) => {
    e?.preventDefault();
    setError('');
    setNotice('');
    const symbol = picked?.symbol ?? query.trim().toUpperCase();
    setBusy(true);
    try {
      const added = await api.addHolding({
        symbol,
        ...(quantity ? { quantity: Number(quantity) } : {}),
        ...(invested ? { invested: Number(invested) } : {}),
        ...(purchaseDate ? { purchaseDate } : {}),
        ...(merge ? { merge: true } : {}),
        ...(portfolioId ? { portfolioId: Number(portfolioId) } : {}),
      });
      if (added.merged) {
        setNotice(`${symbol} updated: you now hold ${added.quantity} ${unit} for ${money(added.invested)} in total.`);
      } else if (added.priceOn) {
        const { date, close } = added.priceOn;
        setNotice(
          `Added ${added.quantity} ${unit} for ${money(added.invested)}, using the ${isFund ? 'NAV' : 'closing price'} of ${price(close)} on ${niceDate(date)}` +
          `${date !== purchaseDate ? ` (the last trading day on or before ${niceDate(purchaseDate)})` : ''}.`,
        );
      }
      setDuplicate(null);
      setQuery(''); setPicked(null); setQuantity(''); setInvested(''); setPurchaseDate('');
      onAdded();
    } catch (err) {
      if (err.status === 409) setDuplicate(symbol);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Add a stock or fund</h2>
      <SymbolSearch
        id="add-stock"
        label="Company, fund or symbol"
        query={query}
        setQuery={setQuery}
        picked={picked}
        setPicked={setPicked}
        onType={() => setDuplicate(null)}
      />
      <div className="row">
        {portfolios.length > 1 && (
          <label>
            Portfolio
            <select value={portfolioId ?? ''} onChange={(e) => { setPortfolioId(e.target.value); setDuplicate(null); }}>
              {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label>
          Purchase date (optional)
          <input type="date" max={todayIST()} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </label>
        <label>
          Quantity ({unit})
          <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required={!purchaseDate || !invested} />
        </label>
        <label>
          Total invested (₹)
          <input type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} required={!purchaseDate || !quantity} />
        </label>
      </div>
      {purchaseDate && (
        <p className="muted small">
          With a purchase date you can fill in just one of quantity or amount. The other is worked out from that day's
          {isFund ? ' NAV' : ' closing price on Yahoo Finance'} (the previous trading day if the market was closed).
        </p>
      )}
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {duplicate && (
        <div className="warn box" role="alert">
          <strong>{duplicate}</strong> is already in {portfolios.length > 1 ? 'this' : 'your'} portfolio. Proceeding will add this purchase
          {quantity ? ` (${quantity} ${unit})` : ''}{invested ? ` (${money(Number(invested))})` : ''} to your existing quantity and invested amount.
          The average cost is recalculated{purchaseDate ? ', and the earliest purchase date is kept' : ''}.
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => submit(null, true)}>
              {busy ? 'Updating…' : 'Proceed and update'}
            </button>
            <button type="button" disabled={busy} onClick={() => setDuplicate(null)}>Cancel</button>
          </div>
        </div>
      )}
      <button className="primary" disabled={busy || !!duplicate}>{busy ? 'Adding…' : 'Add to portfolio'}</button>
    </form>
  );
}
