import { Fragment, useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.js';
import { useSort, SortTh } from '../sort.jsx';
import { price, pct, tone, shortDate, timeAgo } from '../format.js';
import SymbolSearch from './SymbolSearch.jsx';
import { SplitReview } from './Holdings.jsx';

const BLUE = '#2563eb';
const GREEN = '#15803d';
const RED = '#b91c1c';
const COLS = 9;

const dayOf = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** How far the price has to move to reach a target, e.g. "4.1% to fall". */
function distance(t, current) {
  if (!t.enabled) return 'reached or paused';
  if (current == null) return '';
  const move = ((t.targetPrice - current) / current) * 100;
  if (t.direction === 'below' ? move >= 0 : move <= 0) return 'reached';
  return `${Math.abs(move).toFixed(1)}% to ${move < 0 ? 'fall' : 'rise'}`;
}

function AddWatch({ onAdded }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const symbol = picked?.symbol ?? query.trim().toUpperCase();
    setBusy(true);
    try {
      const item = await api.addWatch({ symbol, note });
      let text = `${item.symbol} added to your watchlist at ${price(item.added_price)}.`;
      if (target) {
        // The target's side follows the price now: lower means "tell me when it falls to", higher "when it rises to".
        const direction = Number(target) < item.added_price ? 'below' : 'above';
        try {
          await api.addRule({ kind: 'price', symbol: item.symbol, direction, targetPrice: Number(target) });
          text += ` You'll be alerted when it goes ${direction} ${price(Number(target))}.`;
        } catch (err) {
          text += ` The price alert wasn't added: ${err.message}`;
        }
      }
      setNotice(text);
      setQuery(''); setPicked(null); setNote(''); setTarget('');
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Watch a stock</h2>
      <p className="muted">Follow stocks you don't own yet. Prices update with your portfolio, and you can be alerted at the price you want.</p>
      <SymbolSearch id="watch-stock" query={query} setQuery={setQuery} picked={picked} setPicked={setPicked} onType={() => setNotice('')} />
      <div className="row">
        <label>
          Alert me at price (₹, optional)
          <input type="number" min="0.01" step="any" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. buy below 1,400 after results" />
        </label>
      </div>
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add to watchlist'}</button>
    </form>
  );
}

/** Inline form under a row: add a price alert for the stock. */
function AlertPanel({ row, onDone, onCancel }) {
  const [direction, setDirection] = useState('below');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.addRule({ kind: 'price', symbol: row.symbol, direction, targetPrice: Number(target) });
      onDone(`Alert added: ${row.symbol} goes ${direction} ${price(Number(target))}.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <tr className="sell-row">
      <td colSpan={COLS}>
        <form className="sell-panel" onSubmit={save}>
          <div className="sell-head">
            <strong>Price alert for {row.symbol}</strong>
            <span className="muted small">Now {price(row.price)}. It fires once, then pauses; manage it on the Alerts tab.</span>
          </div>
          <div className="row">
            <label className="field">
              When the price goes
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="below">Below</option>
                <option value="above">Above</option>
              </select>
            </label>
            <label className="field">
              Price (₹)
              <input type="number" min="0.01" step="any" value={target} onChange={(e) => setTarget(e.target.value)} required autoFocus />
            </label>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="split-actions">
            <button className="primary" disabled={busy}>Add alert</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </td>
    </tr>
  );
}

/** Inline form under a row: edit the note. */
function NotePanel({ row, onDone, onCancel }) {
  const [note, setNote] = useState(row.note);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.updateWatch(row.id, { note });
      onDone(null);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <tr className="sell-row">
      <td colSpan={COLS}>
        <form className="sell-panel" onSubmit={save}>
          <label className="field">
            Note for {row.symbol}
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoFocus />
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="split-actions">
            <button className="primary">Save note</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </td>
    </tr>
  );
}

/** Price chart for a watched stock, with its alert levels and the price when it was added. */
function WatchChart({ row, onClose }) {
  const [range, setRange] = useState('3m');
  const [hist, setHist] = useState(null);
  useEffect(() => {
    api.stockHistory(row.symbol, range).then(setHist).catch(() => setHist({ points: [] }));
  }, [row.symbol, range]);

  const intraday = range === '1d';
  const points = hist?.points ?? [];
  const live = row.targets.filter((t) => t.enabled);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{row.symbol} <span className="muted">{row.name}</span></h2>
        <div className="seg">
          {['1d', '1m', '3m', '6m', '1y'].map((r) => (
            <button key={r} className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r === '1d' ? 'Hourly' : r.toUpperCase()}
            </button>
          ))}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <p className="muted">
        Added at {price(row.addedPrice)} on {dayOf(row.addedAt)} (grey line).
        {live.length > 0 && ` Alert levels: ${live.map((t) => `${t.direction} ${price(t.targetPrice)}`).join(', ')} (green above, red below).`}
      </p>
      {points.length < 2 ? (
        <p className="muted">{intraday ? 'Hourly points build up while the server runs during market hours.' : 'Not enough history yet.'}</p>
      ) : (
        <div role="img" aria-label={`${row.symbol} price from ${price(points[0].price)} to ${price(points[points.length - 1].price)}.`}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid stroke="#eef0f3" vertical={false} />
              <XAxis
                dataKey={intraday ? 'ts' : 'date'}
                tickFormatter={(v) => (intraday ? new Date(v).toLocaleString('en-IN', { day: 'numeric', hour: '2-digit', minute: '2-digit' }) : shortDate(v))}
                minTickGap={40}
                fontSize={12}
              />
              <YAxis domain={['auto', 'auto']} width={64} fontSize={12} tickFormatter={(v) => `₹${Math.round(v)}`} />
              <Tooltip formatter={(v) => [price(v), 'Price']} labelFormatter={(v) => (intraday ? new Date(v).toLocaleString('en-IN') : shortDate(v))} />
              {row.addedPrice && <ReferenceLine y={row.addedPrice} stroke="#6b7280" strokeDasharray="4 4" ifOverflow="extendDomain" />}
              {live.map((t) => (
                <ReferenceLine key={t.id} y={t.targetPrice} stroke={t.direction === 'above' ? GREEN : RED} strokeDasharray="2 3" ifOverflow="extendDomain" />
              ))}
              <Line type="monotone" dataKey="price" stroke={BLUE} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function Row({ r, panel, setPanel, onRemove, selected, onSelect }) {
  return (
    <tr className={selected ? 'sel' : ''}>
      <td>
        <button className="link" onClick={onSelect} aria-label={`Show ${r.symbol} chart`}>{r.symbol}</button>
        <div className="muted small">{r.name}</div>
        {r.held && <div className="muted small">You hold this</div>}
        {r.splitPending && <span className="stale" title="A split or bonus issue is waiting for you to confirm it, above">Split to confirm</span>}
        {r.note && <div className="watch-note small">{r.note}</div>}
      </td>
      <td className="r">
        {price(r.price)}
        {r.stale && <div><span className="stale" title="This price is older than expected. The next refresh will update it.">Stale · {timeAgo(r.priceAsOf)}</span></div>}
      </td>
      <td className={`r ${tone(r.dayChangePct)}`}>{pct(r.dayChangePct)}</td>
      <td className={`r ${tone(r.weekChangePct)}`}>{pct(r.weekChangePct)}</td>
      <td className={`r ${tone(r.monthChangePct)}`}>{pct(r.monthChangePct)}</td>
      <td className={`r ${tone(r.fromHighPct)}`}>{pct(r.fromHighPct)}</td>
      <td className={`r ${tone(r.sinceAddedPct)}`} title={`Added at ${price(r.addedPrice)}`}>
        {pct(r.sinceAddedPct)}
        <div className="muted small nowrap">since {dayOf(r.addedAt)}</div>
      </td>
      <td>
        {r.targets.length === 0 ? (
          <span className="muted small">None</span>
        ) : (
          <ul className="watch-targets">
            {r.targets.map((t) => (
              <li key={t.id} className={t.enabled ? '' : 'muted'}>
                {t.direction === 'below' ? '↓' : '↑'} {price(t.targetPrice)} <span className="muted small">{distance(t, r.price)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="nowrap">
        <button onClick={() => setPanel(panel === 'alert' ? null : 'alert')} aria-expanded={panel === 'alert'} aria-label={`Add a price alert for ${r.symbol}`}>Alert</button>{' '}
        <button onClick={() => setPanel(panel === 'note' ? null : 'note')} aria-expanded={panel === 'note'} aria-label={`Edit note for ${r.symbol}`}>Note</button>{' '}
        <button className="danger" onClick={onRemove} aria-label={`Remove ${r.symbol} from watchlist`}>Remove</button>
      </td>
    </tr>
  );
}

export default function Watchlist({ onChange }) {
  const [rows, setRows] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [open, setOpen] = useState({ id: null, panel: null }); // the row whose inline form is open
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState(null); // { ok, text }

  const load = async () => {
    const [w, sp] = await Promise.all([api.watchlist(), api.splits()]);
    setRows(w);
    setReviews(sp.filter((r) => r.watching));
  };
  useEffect(() => { load().catch(() => setRows([])); }, []);
  const changed = async () => { await load(); onChange(); };

  const { sorted, sort, toggle } = useSort(rows ?? [], { key: 'symbol', dir: 'asc' });

  const remove = async (r) => {
    const extra = r.targets.length && !r.held ? ` Its ${r.targets.length === 1 ? 'price alert goes' : 'price alerts go'} too.` : '';
    if (!window.confirm(`Remove ${r.symbol} from your watchlist?${extra}`)) return;
    try {
      await api.removeWatch(r.id);
      if (selected === r.symbol) setSelected(null);
      setMessage({ ok: true, text: `${r.symbol} removed from your watchlist.` });
      await changed();
    } catch (e) {
      setMessage({ ok: false, text: e.message });
    }
  };
  const closePanel = async (text) => {
    setOpen({ id: null, panel: null });
    if (text) setMessage({ ok: true, text });
    await changed();
  };

  const selectedRow = rows?.find((r) => r.symbol === selected);
  return (
    <>
      {reviews.map((r) => <SplitReview key={r.id} r={r} onChanged={changed} onMessage={setMessage} />)}
      <AddWatch onAdded={changed} />
      <section className="card">
        <div className="card-head">
          <h2>Watchlist {rows && <span className="muted">({rows.length} {rows.length === 1 ? 'stock' : 'stocks'})</span>}</h2>
        </div>
        {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
        {rows == null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">Nothing on your watchlist yet. Add a stock you're thinking of buying to follow its price.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Stock" k="symbol" textual right={false} sort={sort} toggle={toggle} />
                  <SortTh label="Price" k="price" sort={sort} toggle={toggle} />
                  <SortTh label="Today" k="dayChangePct" sort={sort} toggle={toggle} />
                  <SortTh label="1 week" k="weekChangePct" sort={sort} toggle={toggle} />
                  <SortTh label="1 month" k="monthChangePct" sort={sort} toggle={toggle} />
                  <SortTh label="From 52w high" k="fromHighPct" sort={sort} toggle={toggle} />
                  <SortTh label="Since added" k="sinceAddedPct" sort={sort} toggle={toggle} />
                  <th>Price alerts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const panel = open.id === r.id ? open.panel : null;
                  return (
                    <Fragment key={r.id}>
                      <Row
                        r={r}
                        panel={panel}
                        setPanel={(p) => setOpen({ id: p ? r.id : null, panel: p })}
                        onRemove={() => remove(r)}
                        selected={selected === r.symbol}
                        onSelect={() => setSelected(selected === r.symbol ? null : r.symbol)}
                      />
                      {panel === 'alert' && <AlertPanel row={r} onDone={closePanel} onCancel={() => setOpen({ id: null, panel: null })} />}
                      {panel === 'note' && <NotePanel row={r} onDone={closePanel} onCancel={() => setOpen({ id: null, panel: null })} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {selectedRow && <WatchChart key={selectedRow.symbol} row={selectedRow} onClose={() => setSelected(null)} />}
    </>
  );
}
