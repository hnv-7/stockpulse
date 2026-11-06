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
  const [value, setValue] = useState(String(rule.threshold_pct));
  const [error, setError] = useState('');

  const update = async (patch) => {
    try {
      await api.updateRule(rule.id, { thresholdPct: Number(value), enabled: rule.enabled, ...patch });
      setError('');
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <li className="rule">
      <div>
        <strong>{rule.symbol ?? 'Any stock'}</strong> falls ≥
        <input className="narrow" type="number" min="0.1" max="99" step="any" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Threshold percent" />%
        <span className="muted"> {WINDOWS[rule.window]}</span>
        {error && <span className="neg small"> {error}</span>}
      </div>
      <div className="nowrap">
        {String(rule.threshold_pct) !== value && <button onClick={() => update({})}>Save</button>}{' '}
        <button onClick={() => update({ enabled: !rule.enabled })}>{rule.enabled ? 'Pause' : 'Resume'}</button>{' '}
        <button className="danger" onClick={async () => { await api.removeRule(rule.id); onChanged(); }}>Delete</button>
      </div>
    </li>
  );
}

export default function Alerts({ onRead }) {
  const [rules, setRules] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [notes, setNotes] = useState({ unread: 0, items: [] });
  const [form, setForm] = useState({ symbol: '', window: '1d', thresholdPct: '5' });
  const [error, setError] = useState('');

  const load = async () => {
    const [r, h, n] = await Promise.all([api.rules(), api.holdings(), api.notifications()]);
    setRules(r); setHoldings(h); setNotes(n);
  };
  useEffect(() => {
    load().then(async () => { await api.markRead(); onRead(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.addRule({ symbol: form.symbol || null, window: form.window, thresholdPct: Number(form.thresholdPct) });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <form className="card form" onSubmit={add}>
        <h2>Drop alerts</h2>
        <p className="muted">Get notified when a stock falls by the percentage you choose. Checked every hour during market hours; each alert repeats at most once a day.</p>
        <div className="row">
          <label>
            Stock
            <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>
              <option value="">Any stock in my portfolio</option>
              {holdings.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)}
            </select>
          </label>
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
