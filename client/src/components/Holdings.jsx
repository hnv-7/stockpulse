import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSort, SortTh } from '../sort.jsx';
import { money, price, signedMoney, pct, tone } from '../format.js';

function AddForm({ onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [invested, setInvested] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1); // highlighted suggestion, -1 = none
  const timer = useRef();
  const latest = useRef('');
  const listRef = useRef();

  const open = !picked && results.length > 0;

  const onQuery = (v) => {
    setQuery(v);
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

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const symbol = picked?.symbol ?? query.trim().toUpperCase();
    setBusy(true);
    try {
      await api.addHolding({ symbol, quantity: Number(quantity), invested: Number(invested) });
      setQuery(''); setResults([]); setPicked(null); setQuantity(''); setInvested('');
      onAdded();
    } catch (err) {
      setError(err.message);
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
          Quantity (shares)
          <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
        </label>
        <label>
          Total invested (₹)
          <input type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} required />
        </label>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add to portfolio'}</button>
    </form>
  );
}

function Row({ h, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(String(h.quantity));
  const [invested, setInvested] = useState(String(h.invested));
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.updateHolding(h.id, { quantity: Number(quantity), invested: Number(invested) });
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
    <tr>
      <td><strong>{h.symbol}</strong><div className="muted small">{h.name}</div></td>
      {editing ? (
        <>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Quantity" /></td>
          <td className="r"><input className="narrow" type="number" min="0" step="any" value={invested} onChange={(e) => setInvested(e.target.value)} aria-label="Invested" /></td>
          <td colSpan={3} className="r">
            {error && <span className="neg small">{error} </span>}
            <button onClick={save}>Save</button> <button onClick={() => setEditing(false)}>Cancel</button>
          </td>
        </>
      ) : (
        <>
          <td className="r">{h.quantity}</td>
          <td className="r">{money(h.invested)}</td>
          <td className="r">{h.value == null ? '—' : money(h.value)}</td>
          <td className={`r ${tone(h.pnl)}`}>{h.pnl == null ? '—' : <>{signedMoney(h.pnl)} <span className="small">({pct(h.pnlPct)})</span></>}</td>
          <td className="r">{price(h.price)}</td>
        </>
      )}
      <td className="r nowrap">
        {!editing && <button onClick={() => setEditing(true)}>Edit</button>} <button className="danger" onClick={remove}>Remove</button>
      </td>
    </tr>
  );
}

export default function Holdings({ onChange }) {
  const [holdings, setHoldings] = useState([]);
  const [rows, setRows] = useState(new Map());

  const load = async () => {
    const [h, r] = await Promise.all([api.holdings(), api.report('1w')]);
    setHoldings(h);
    setRows(new Map(r.holdings.map((x) => [x.symbol, x])));
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const changed = async () => { await load(); onChange(); };

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
        <h2>Your holdings <span className="muted">({holdings.length} {holdings.length === 1 ? 'stock' : 'stocks'})</span></h2>
        <p className="muted">Update quantity and invested amount whenever you buy more (the average cost is invested ÷ quantity).</p>
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
                  <SortTh label="Current value" k="value" sort={sort} toggle={toggle} />
                  <SortTh label="Profit %" k="pnlPct" sort={sort} toggle={toggle} />
                  <SortTh label="Price" k="price" sort={sort} toggle={toggle} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((h) => <Row key={`${h.id}-${h.quantity}-${h.invested}`} h={h} onChanged={changed} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
