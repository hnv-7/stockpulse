import { useState } from 'react';
import { api } from '../api.js';
import { money, price } from '../format.js';
import { niceDate, shares, plural } from './holdings/shared.js';

/**
 * A split or bonus issue found for one of your stocks. Nothing changes until you confirm it, with the ratio
 * pre-filled from Yahoo (or from the price move, when the two disagree) and editable.
 */
export default function SplitReview({ r, onChanged, onMessage }) {
  const [before, setBefore] = useState(String(r.suggested.denominator));
  const [after, setAfter] = useState(String(r.suggested.numerator));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const den = Number(before);
  const num = Number(after);
  const valid = den > 0 && num > 0 && den <= 1000 && num <= 1000 && den !== num;
  const ratio = valid ? num / den : null;
  const reported = `every ${r.reported.denominator} ${r.reported.denominator === 1 ? 'share' : 'shares'} became ${r.reported.numerator}`;

  const act = async (fn, text) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onMessage({ ok: true, text });
      await onChanged();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  const apply = () =>
    act(() => api.applySplit(r.id, { numerator: num, denominator: den }), `${r.symbol} updated for the split or bonus issue.`);
  const dismiss = () => act(() => api.dismissSplit(r.id), `${r.symbol}: left as it was.`);

  const { lots } = r;
  return (
    <section className="card split-review" aria-labelledby={`split-${r.id}`}>
      <h2 id={`split-${r.id}`}>Split or bonus issue: {r.symbol}</h2>
      <p>
        {r.name} had a split or bonus issue on <strong>{niceDate(r.exDate)}</strong>.{' '}
        {r.lots.count > 0
          ? 'Your figures for it are still in the old shares, so its value looks lower than it is. Check the ratio with your broker and confirm.'
          : 'Your figures for it are still in the old shares. Check the ratio and confirm.'}
      </p>
      {r.suggested.mismatch && r.priceRatio != null && (
        <div className="warn box" role="note">
          Yahoo reports that {reported}, but the price moved by about {r.priceRatio.toFixed(1)}×. The ratio below follows the price
          move. Check it against your broker before you confirm.
        </div>
      )}
      <div className="split-ratio">
        Every
        <input type="number" min="1" step="any" value={before} onChange={(e) => setBefore(e.target.value)} aria-label="Shares before" />
        {den === 1 ? 'share' : 'shares'} became
        <input type="number" min="1" step="any" value={after} onChange={(e) => setAfter(e.target.value)} aria-label="Shares after" />
      </div>
      <ul className="split-effects">
        {lots.count > 0 && (
          <li>
            Shares you bought before then: <strong>{shares(lots.quantity)} → {ratio ? shares(lots.quantity * ratio) : '…'}</strong>
            {ratio && <>, average cost {price(lots.invested / lots.quantity)} → {price(lots.invested / (lots.quantity * ratio))}</>}.
            The amount you invested ({money(lots.invested)}) stays the same.
          </li>
        )}
        {r.sales > 0 && (
          <li>{plural(r.sales, 'earlier sale is', 'earlier sales are')} restated in the new shares. What you received and the profit stay the same.</li>
        )}
        {r.priceTargets > 0 && <li>{plural(r.priceTargets, 'price target is', 'price targets are')} divided by the same ratio.</li>}
        {r.watching && <li>The price on your watchlist from when you added it is divided by the same ratio.</li>}
      </ul>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="split-actions">
        <button className="primary" disabled={!valid || busy} onClick={apply}>Update my shares</button>
        <button disabled={busy} onClick={dismiss} title="Use this if your quantities already include it">Already done / not needed</button>
      </div>
    </section>
  );
}
