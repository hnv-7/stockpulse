import { useRef, useState } from 'react';
import { api } from '../../api.js';
import { money } from '../../format.js';
import { niceDate } from './shared.js';

const MAX_UPLOAD = 2 * 1024 * 1024; // keep in step with the server limit

/** Export button plus a file picker. Reading the file is the server's job; this only uploads it for a preview. */
export function ImportExport({ onPreview, onMessage, portfolios = [], defaultPortfolio = null }) {
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [into, setInto] = useState(defaultPortfolio);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    onMessage(null);
    if (file.size > MAX_UPLOAD) return onMessage({ ok: false, text: 'File is too large (max 2 MB).' });
    setBusy(true);
    try {
      onPreview(await api.previewImport(file, into), into);
    } catch (err) {
      onMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      <a className="button" href={api.exportUrl()} download>Export CSV</a>
      {portfolios.length > 1 && (
        <label className="picker">
          <span className="sr-only">Import into portfolio</span>
          <select value={into ?? ''} onChange={(e) => setInto(Number(e.target.value))} title="Portfolio to import into">
            {portfolios.map((p) => <option key={p.id} value={p.id}>Import into {p.name}</option>)}
          </select>
        </label>
      )}
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? 'Reading file…' : 'Import statement'}</button>
      <input ref={fileRef} type="file" accept=".xlsx,.csv,.json,.pdf,text/csv,application/json,application/pdf" hidden onChange={onFile} />
    </div>
  );
}

const FORMAT_LABEL = { xlsx: 'Excel', csv: 'CSV', json: 'JSON', pdf: 'PDF' };

/** Shows what the uploaded statement would change; nothing is saved until the user confirms. */
export function ImportReview({ preview, into = null, intoName = null, onDone, onCancel }) {
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
        into,
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
        Review import <span className="muted">({FORMAT_LABEL[preview.format] ?? preview.format} file{intoName ? `, into ${intoName}` : ''})</span>
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
