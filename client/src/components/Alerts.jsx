import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { timeAgo } from '../format.js';

const WINDOWS = {
  '1d': 'in one day (vs yesterday\'s close)',
  '1w': 'in one week',
  '1m': 'in one month',
  high52: 'from its 52-week high',
};

function RuleRow({ rule, onChanged }) {
  const isPrice = rule.kind === 'price';
  const current = isPrice ? rule.target_price : rule.threshold_pct;
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState('');

  const update = async (patch) => {
    try {
      const level = isPrice ? { targetPrice: Number(value) } : { thresholdPct: Number(value) };
      await api.updateRule(rule.id, { ...level, enabled: rule.enabled, ...patch });
      setError('');
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  const label = rule.symbol ?? 'Any stock';
  return (
    <li className="rule">
      <div>
        <strong>{label}</strong>
        {isPrice ? (
          <>
            {' '}goes {rule.direction === 'above' ? 'above' : 'below'} ₹
            <input className="narrow" type="number" min="0.01" step="any" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Target price for ${label}`} />
            {!rule.enabled && <span className="muted small"> · reached or paused</span>}
          </>
        ) : (
          <>
            {' '}falls ≥
            <input className="narrow" type="number" min="0.1" max="99" step="any" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Threshold percent for ${label}`} />%
            <span className="muted"> {WINDOWS[rule.window]}</span>
          </>
        )}
        {error && <span className="neg small"> {error}</span>}
      </div>
      <div className="nowrap">
        {String(current) !== value && <button onClick={() => update({})}>Save</button>}{' '}
        <button onClick={() => update({ enabled: !rule.enabled })}>{rule.enabled ? 'Pause' : 'Resume'}</button>{' '}
        <button className="danger" aria-label={`Delete alert for ${label}`} onClick={async () => { await api.removeRule(rule.id); onChanged(); }}>Delete</button>
      </div>
    </li>
  );
}

export default function Alerts({ onRead }) {
  const [rules, setRules] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [watched, setWatched] = useState([]);
  const [notes, setNotes] = useState({ unread: 0, items: [] });
  const [kind, setKind] = useState('drop'); // 'drop' = falls by a percentage, 'price' = reaches a price
  const [form, setForm] = useState({ symbol: '', window: '1d', thresholdPct: '5', direction: 'above', targetPrice: '' });
  const [error, setError] = useState('');

  const load = async () => {
    const [r, h, w, n] = await Promise.all([api.rules(), api.holdings(), api.watchlist(), api.notifications()]);
    setRules(r); setHoldings(h); setNotes(n);
    const held = new Set(h.map((x) => x.symbol));
    setWatched(w.filter((x) => !held.has(x.symbol)));
  };
  useEffect(() => {
    load().then(async () => { await api.markRead(); onRead(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (kind === 'price') {
        await api.addRule({ kind: 'price', symbol: form.symbol, direction: form.direction, targetPrice: Number(form.targetPrice) });
      } else {
        await api.addRule({ kind: 'drop', symbol: form.symbol || null, window: form.window, thresholdPct: Number(form.thresholdPct) });
      }
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <form className="card form" onSubmit={add}>
        <h2>New alert</h2>
        <div className="seg" role="group" aria-label="Alert type">
          <button type="button" aria-pressed={kind === 'drop'} className={kind === 'drop' ? 'on' : ''} onClick={() => setKind('drop')}>Falls by a percentage</button>
          <button type="button" aria-pressed={kind === 'price'} className={kind === 'price' ? 'on' : ''} onClick={() => setKind('price')}>Reaches a price</button>
        </div>
        {kind === 'drop' ? (
          <p className="muted">Get notified when a stock falls by the percentage you choose. Checked every hour during market hours; each alert repeats at most once a day.</p>
        ) : (
          <p className="muted">Get notified once when a stock goes above (a target) or below (a stop-loss) the price you set. After it fires the alert pauses itself; resume it to watch again.</p>
        )}
        <div className="row">
          <label>
            Stock
            <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} required={kind === 'price'}>
              <option value="">{kind === 'price' ? 'Choose a stock' : 'Any stock in my portfolio'}</option>
              {watched.length > 0 ? (
                <>
                  <optgroup label="My stocks">{holdings.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)}</optgroup>
                  <optgroup label="Watchlist">{watched.map((w) => <option key={w.symbol} value={w.symbol}>{w.symbol}</option>)}</optgroup>
                </>
              ) : (
                holdings.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)
              )}
            </select>
          </label>
          {kind === 'drop' ? (
            <>
              <label>
                Falls by (%)
                <input type="number" min="0.1" max="99" step="any" value={form.thresholdPct} onChange={(e) => setForm({ ...form, thresholdPct: e.target.value })} required />
              </label>
              <label>
                Measured
                <select value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })}>
                  {Object.entries(WINDOWS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                When the price goes
                <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                </select>
              </label>
              <label>
                Price (₹)
                <input type="number" min="0.01" step="any" value={form.targetPrice} onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} required />
              </label>
            </>
          )}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary">Add alert</button>
      </form>

      <section className="card">
        <h2>Your alerts</h2>
        {rules.length === 0 ? <p className="muted">No alerts yet.</p> : (
          <ul className="rules">{rules.map((r) => <RuleRow key={`${r.id}-${r.threshold_pct}-${r.enabled}`} rule={r} onChanged={load} />)}</ul>
        )}
        <p className="muted small">Alerts appear here. To also get them by email, turn that on in the Account tab.</p>
      </section>

      <section className="card">
        <h2>Recent notifications</h2>
        {notes.items.length === 0 ? <p className="muted">Nothing has triggered yet.</p> : (
          <ul className="notes">
            {notes.items.map((n) => (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <span>{n.message}</span>
                <span className="muted small">{timeAgo(n.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
