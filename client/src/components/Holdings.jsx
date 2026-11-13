import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSort, SortTh } from '../sort.jsx';
import { money, price, signedMoney, pct, tone } from '../format.js';

// Latest allowed purchase date (today in India, matching the server's rule).
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const niceDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function AddForm({ onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [invested, setInvested] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [duplicate, setDuplicate] = useState(null); // symbol already held, awaiting the user's OK to add to it
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1); // highlighted suggestion, -1 = none
  const timer = useRef();
  const latest = useRef('');
  const listRef = useRef();

  const open = !picked && results.length > 0;

  const onQuery = (v) => {
    setQuery(v);
    setDuplicate(null);
    setPicked(null);
    setActive(-1);
    clearTimeout(timer.current);
    latest.current = v.trim();
    if (latest.current.length < 2) return setResults([]);
    timer.current = setTimeout(() => {
      const q = latest.current;
      api
        .search(q)
        .then((r) => { if (q === latest.current) setResults(r); }) // ignore out-of-date responses
        .catch(() => setResults([]));
    }, 300);
  };

  const pick = (r) => {
    setPicked(r);
    setQuery(r.symbol);
    setResults([]);
    setActive(-1);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (active + step + results.length) % results.length;
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); // pick the suggestion instead of submitting the form
      pick(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setResults([]);
      setActive(-1);
    }
  };

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
      });
      if (added.merged) {
        setNotice(`${symbol} updated: you now hold ${added.quantity} shares for ${money(added.invested)} in total.`);
      } else if (added.priceOn) {
        const { date, close } = added.priceOn;
        setNotice(
          `Added ${added.quantity} shares for ${money(added.invested)}, using the closing price of ${money(close)} on ${niceDate(date)}` +
          `${date !== purchaseDate ? ` (the last trading day on or before ${niceDate(purchaseDate)})` : ''}.`,
        );
      }
      setDuplicate(null);
      setQuery(''); setResults([]); setPicked(null); setQuantity(''); setInvested(''); setPurchaseDate('');
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
      <h2>Add a stock</h2>
      <label>
        Company or symbol
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. Infosys or INFY.NS"
          required
          maxLength={40}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="stock-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `stock-opt-${active}` : undefined}
        />
      </label>
      {open && (
        <ul className="suggest" id="stock-suggestions" role="listbox" ref={listRef}>
          {results.map((r, i) => (
            <li
              key={r.symbol}
              id={`stock-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(r); }}
            >
              <strong>{r.symbol}</strong> <span className="muted">{r.name} · {r.exchange}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <label>
          Purchase date (optional)
          <input type="date" max={todayIST()} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </label>
        <label>
          Quantity (shares)
          <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required={!purchaseDate || !invested} />
        </label>
        <label>
          Total invested (₹)
          <input type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} required={!purchaseDate || !quantity} />
        </label>
      </div>
      {purchaseDate && (
        <p className="muted small">
          With a purchase date you can fill in just one of quantity or amount. The other is worked out from that day's closing price on Yahoo Finance
          (the previous trading day if the market was closed).
        </p>
      )}
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {duplicate && (
        <div className="warn box" role="alert">
          <strong>{duplicate}</strong> is already in your portfolio. Proceeding will add this purchase
          {quantity ? ` (${quantity} shares)` : ''}{invested ? ` (${money(Number(invested))})` : ''} to your existing quantity and invested amount.
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

/**
 * Sell form for one stock. Purchases are sold oldest first, so the preview walks them the same way the server does
 * and shows the cost of the shares being sold, the charges and the profit before anything is saved.
 */
function SellRow({ h, onDone, onCancel }) {
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

function Row({ h, onChanged, onSell, selling }) {
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
  const remove = async () => {
    if (!window.confirm(`Remove ${h.symbol} and its history/alerts?`)) return;
    await api.removeHolding(h.id);
    onChanged();
  };

  return (
    <>
    <tr>
      <td><strong>{h.symbol}</strong><div className="muted small">{h.name}</div></td>
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
          <td className="r">{price(h.price)}</td>
        </>
      )}
      <td className="r nowrap">
        <button onClick={onSell} aria-expanded={selling}>Sell</button>{' '}
        {multi
          ? <button onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Purchases'} ({h.lots.length})</button>
          : !editing && <button onClick={() => setEditing(true)}>Edit</button>}{' '}
        <button className="danger" onClick={remove}>Remove</button>
      </td>
    </tr>
    {multi && open && h.lots.map((l) => <LotRow key={`${l.id}-${l.quantity}-${l.invested}-${l.purchase_date}`} h={h} lot={l} onChanged={onChanged} />)}
    </>
  );
}

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
function SalesHistory({ sales, onChanged, onMessage }) {
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
                  <td className="r">{s.quantity}</td>
                  <td className="r">{price(s.salePrice)}</td>
                  <td className="r">{money(s.proceeds - s.charges)}{s.charges > 0 && <div className="muted small">after {money(s.charges)} charges</div>}</td>
                  <td className="r">{money(s.costBasis)}</td>
                  <td className={`r ${tone(s.realised)}`}>{signedMoney(s.realised)} <span className="small">({pct(s.realisedPct)})</span></td>
                  <td className="nowrap">
                    <button onClick={() => setEditingId(editingId === s.id ? null : s.id)} aria-expanded={editingId === s.id}>Edit</button>{' '}
                    <button className="danger" onClick={() => remove(s)}>Remove</button>
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

const MAX_UPLOAD = 2 * 1024 * 1024; // keep in step with the server limit

/** Export button plus a file picker. Reading the file is the server's job; this only uploads it for a preview. */
function ImportExport({ onPreview, onMessage }) {
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    onMessage(null);
    if (file.size > MAX_UPLOAD) return onMessage({ ok: false, text: 'File is too large (max 2 MB).' });
    setBusy(true);
    try {
      onPreview(await api.previewImport(file));
    } catch (err) {
      onMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      <a className="button" href="/api/holdings/export" download>Export CSV</a>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? 'Reading file…' : 'Import statement'}</button>
      <input ref={fileRef} type="file" accept=".xlsx,.csv,.json,.pdf,text/csv,application/json,application/pdf" hidden onChange={onFile} />
    </div>
  );
}

const FORMAT_LABEL = { xlsx: 'Excel', csv: 'CSV', json: 'JSON', pdf: 'PDF' };

/** Shows what the uploaded statement would change; nothing is saved until the user confirms. */
function ImportReview({ preview, onDone, onCancel }) {
  const [picked, setPicked] = useState(() => new Set(preview.items.map((i) => i.symbol)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (symbol) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });

  const chosen = preview.items.filter((i) => picked.has(i.symbol));
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.importHoldings(
        chosen.map((i) => ({ symbol: i.symbol, quantity: i.quantity, invested: i.invested, purchaseDate: i.purchaseDate })),
      );
      onDone(r);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="review" role="region" aria-label="Import preview">
      <h3>
        Review import <span className="muted">({FORMAT_LABEL[preview.format] ?? preview.format} file)</span>
      </h3>
      <p className="muted small">
        Nothing has been saved yet. Matching stocks are updated with the figures from the file, new ones are added, and nothing is removed.
        Check any stock matched by company name.
      </p>
      {preview.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th><span className="sr-only">Include</span></th>
                <th>Stock</th>
                <th className="r">Qty</th>
                <th className="r">Invested</th>
                <th className="r">Bought</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((i) => (
                <tr key={i.symbol}>
                  <td><input type="checkbox" checked={picked.has(i.symbol)} onChange={() => toggle(i.symbol)} aria-label={`Include ${i.symbol}`} /></td>
                  <td>
                    <strong>{i.symbol}</strong>
                    <div className="muted small">{i.name}</div>
                    {i.notes.map((n) => <div key={n} className="warn small">{n}</div>)}
                  </td>
                  <td className="r">{i.quantity}</td>
                  <td className="r">{money(i.invested)}</td>
                  <td className="r nowrap">{niceDate(i.purchaseDate)}</td>
                  <td className="small">
                    {i.action === 'add' ? <span className="pos">New</span> : (
                      <>Update<div className="muted">was {i.current.quantity} for {money(i.current.invested)}</div></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.errors.length > 0 && (
        <div className="error" role="status">
          {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} skipped:
          <ul className="small">
            {preview.errors.map((x, k) => <li key={k}>{x.name ? `${x.name}: ` : ''}{x.error}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="actions">
        <button className="primary" onClick={confirm} disabled={busy || chosen.length === 0}>
          {busy ? 'Importing…' : `Import ${chosen.length} stock${chosen.length === 1 ? '' : 's'}`}
        </button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

export default function Holdings({ onChange }) {
  const [holdings, setHoldings] = useState([]);
  const [rows, setRows] = useState(new Map());
  const [preview, setPreview] = useState(null); // an uploaded statement awaiting confirmation
  const [message, setMessage] = useState(null); // { ok, text }
  const [sellingId, setSellingId] = useState(null); // holding whose sell form is open
  const [sales, setSales] = useState(null);

  const load = async () => {
    const [h, r, s] = await Promise.all([api.holdings(), api.report('1w'), api.sales()]);
    setHoldings(h);
    setRows(new Map(r.holdings.map((x) => [x.symbol, x])));
    setSales(s);
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

  // Merge live figures into each holding so every column is sortable.
  const merged = useMemo(
    () => holdings.map((h) => ({ ...h, value: rows.get(h.symbol)?.value ?? null, pnl: rows.get(h.symbol)?.pnl ?? null, pnlPct: rows.get(h.symbol)?.pnlPct ?? null, price: rows.get(h.symbol)?.price ?? null })),
    [holdings, rows],
  );
  const { sorted, sort, toggle } = useSort(merged, { key: 'symbol', dir: 'asc' });

  return (
    <>
      <AddForm onAdded={changed} />
      <section className="card">
        <div className="card-head">
          <h2>Your holdings <span className="muted">({holdings.length} {holdings.length === 1 ? 'stock' : 'stocks'})</span></h2>
          <ImportExport onPreview={(p) => { setMessage(null); setPreview(p); }} onMessage={setMessage} />
        </div>
        <p className="muted">
          When you buy more of a stock you already hold, add it again with its purchase date: each purchase is kept separately and the totals
          are worked out for you (the average cost is invested ÷ quantity).
          To load your portfolio from a broker, use <strong>Import statement</strong> with the holdings file you download from Groww, Zerodha, Dhan, Upstox, Angel One and similar
          (Excel, CSV, JSON or PDF). You can review everything before it is saved. Export CSV gives you a file you can edit and import back.
        </p>
        {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
        {preview && <ImportReview preview={preview} onDone={imported} onCancel={() => setPreview(null)} />}
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
                    <Row h={h} onChanged={changed} selling={sellingId === h.id} onSell={() => setSellingId(sellingId === h.id ? null : h.id)} />
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
