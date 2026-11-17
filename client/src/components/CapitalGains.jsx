import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, signedMoney, tone } from '../format.js';

const niceDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const shares = (q) => Number(q.toFixed(4)).toLocaleString('en-IN', { maximumFractionDigits: 4 });
const heldFor = (days) => {
  if (days == null) return '—';
  if (days < 365) return `${days} days`;
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30.44);
  return `${y}y${m ? ` ${m}m` : ''}`;
};
const rate = (r) => `${Number(r.toFixed(2))}%`;
const TERM = { short: 'Short-term', long: 'Long-term', unknown: 'No purchase date' };

function Term({ term }) {
  return <span className={`term ${term}`}>{TERM[term]}</span>;
}

/** Download the year's rows as CSV, e.g. for a tax return or an accountant. */
function downloadCsv(data) {
  const head = ['Sale date', 'Symbol', 'Name', 'Shares', 'Purchase date', 'Days held', 'Type', 'Sale value', 'Charges', 'Cost', 'Gain'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head, ...data.rows.map((r) => [
    r.saleDate, r.symbol, r.name, r.quantity, r.purchaseDate ?? '', r.holdingDays ?? '', TERM[r.term],
    r.proceeds.toFixed(2), r.charges.toFixed(2), r.cost.toFixed(2), r.gain.toFixed(2),
  ])].map((row) => row.map(cell).join(','));
  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `capital-gains-${data.label.replace(/^FY /, 'FY')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Totals({ data }) {
  const { shortTerm, longTerm, exemption, rates, tax, current } = data;
  return (
    <div className="stats">
      <div className="stat">
        <div className="stat-label">Short-term (held up to 12 months)</div>
        <div className={`stat-value ${tone(shortTerm.net)}`}>{signedMoney(shortTerm.net)}</div>
        <div className="stat-sub">{shortTerm.count} {shortTerm.count === 1 ? 'sale' : 'sales'} · taxed at {rate(rates.shortTerm)}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Long-term (held over 12 months)</div>
        <div className={`stat-value ${tone(longTerm.net)}`}>{signedMoney(longTerm.net)}</div>
        <div className="stat-sub">{longTerm.count} {longTerm.count === 1 ? 'sale' : 'sales'} · first {money(exemption.limit)} free, then {rate(rates.longTerm)}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Estimated tax</div>
        <div className="stat-value">{money(tax.total)}</div>
        <div className="stat-sub">Including {rates.cess}% cess</div>
      </div>
      {current && (
        <div className="stat">
          <div className="stat-label">Long-term exemption left this year</div>
          <div className="stat-value">{money(exemption.left)}</div>
          <div className="stat-sub">of {money(exemption.limit)}; {money(exemption.used)} used</div>
        </div>
      )}
    </div>
  );
}

function Notes({ data }) {
  const notes = [];
  if (data.setOff.shortTermLossAgainstLongTerm > 0) {
    notes.push(`${money(data.setOff.shortTermLossAgainstLongTerm)} of short-term losses is set off against long-term gains.`);
  }
  if (data.carriedForward.shortTerm > 0 || data.carriedForward.longTerm > 0) {
    const parts = [];
    if (data.carriedForward.shortTerm > 0) parts.push(`${money(data.carriedForward.shortTerm)} short-term`);
    if (data.carriedForward.longTerm > 0) parts.push(`${money(data.carriedForward.longTerm)} long-term`);
    notes.push(`Losses left over (${parts.join(' and ')}) can be carried forward for up to 8 years if you file your return on time.`);
  }
  if (data.unknown.count > 0) {
    notes.push(`${data.unknown.count} ${data.unknown.count === 1 ? 'sale is' : 'sales are'} of shares with no purchase date (${signedMoney(data.unknown.net)}), so ${data.unknown.count === 1 ? "it isn't" : "they aren't"} in the estimate. Add purchase dates to your holdings to include them.`);
  }
  if (data.rates.changedMidYear) {
    notes.push('Tax rates changed during this year, so each sale uses the rate in force on its date.');
  }
  return notes.length ? <ul className="gains-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null;
}

function SalesTable({ data }) {
  if (!data.rows.length) return <p className="muted">No sales in {data.label}.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Sold on</th><th>Stock</th><th className="r">Shares</th><th>Bought on</th><th>Held</th><th>Type</th>
            <th className="r">Received</th><th className="r">Cost</th><th className="r">Gain</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={`${r.saleId}-${i}`}>
              <td className="nowrap">{niceDate(r.saleDate)}</td>
              <td><strong>{r.symbol}</strong><div className="muted small">{r.name}</div></td>
              <td className="r">{shares(r.quantity)}</td>
              <td className="nowrap">{niceDate(r.purchaseDate)}</td>
              <td className="nowrap">{heldFor(r.holdingDays)}</td>
              <td><Term term={r.term} /></td>
              <td className="r">{money(r.proceeds - r.charges)}{r.charges > 0 && <div className="muted small">after {money(r.charges)} charges</div>}</td>
              <td className="r">{money(r.cost)}</td>
              <td className={`r ${tone(r.gain)}`}>{signedMoney(r.gain)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** For the current year: unrealised gains by type, and purchases about to turn long-term. */
function StillHeld({ open }) {
  const { unrealised, turningLongTerm } = open;
  return (
    <section className="card">
      <h2>Shares you still hold</h2>
      <p className="muted">If you sold everything at today's prices, the gains would be:</p>
      <div className="gains-unrealised">
        <div><span className="muted small">Short-term</span><strong className={tone(unrealised.shortTerm.net)}>{signedMoney(unrealised.shortTerm.net)}</strong></div>
        <div><span className="muted small">Long-term</span><strong className={tone(unrealised.longTerm.net)}>{signedMoney(unrealised.longTerm.net)}</strong></div>
        {unrealised.unknown.count > 0 && (
          <div><span className="muted small">No purchase date</span><strong className={tone(unrealised.unknown.net)}>{signedMoney(unrealised.unknown.net)}</strong></div>
        )}
      </div>
      <h3>Turning long-term in the next 60 days</h3>
      {turningLongTerm.length === 0 ? (
        <p className="muted small">None of your dated purchases turn long-term in the next 60 days.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Stock</th><th>Bought on</th><th className="r">Shares</th><th>Long-term from</th><th className="r">Gain now</th></tr>
            </thead>
            <tbody>
              {turningLongTerm.map((l, i) => (
                <tr key={`${l.symbol}-${l.purchaseDate}-${i}`}>
                  <td><strong>{l.symbol}</strong><div className="muted small">{l.name}</div></td>
                  <td className="nowrap">{niceDate(l.purchaseDate)}</td>
                  <td className="r">{shares(l.quantity)}</td>
                  <td className="nowrap">{niceDate(l.longTermOn)} <span className="muted small">in {l.daysToLongTerm} {l.daysToLongTerm === 1 ? 'day' : 'days'}</span></td>
                  <td className={`r ${tone(l.gain)}`}>{signedMoney(l.gain)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Dividends with an ex-date in the year: income, taxed at your slab rate rather than as capital gains. */
function DividendIncome({ data, dividends }) {
  if (!dividends) return null;
  const rows = dividends.payments.filter((p) => p.exDate >= data.from && p.exDate <= data.to);
  const total = rows.reduce((s, p) => s + p.amount, 0);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Dividends in {data.label}</h2>
        <strong className={total > 0 ? 'pos' : ''}>{money(total)}</strong>
      </div>
      <p className="muted small">
        Dividends are added to your income and taxed at your slab rate, not as capital gains. Companies deduct tax at source
        above a yearly limit; check Form 26AS or your annual statement.
      </p>
      {rows.length > 0 && (
        <ul className="div-list">
          {rows.map((p) => (
            <li key={`${p.symbol}-${p.exDate}`}>
              <span><strong>{p.symbol}</strong> <span className="muted small">ex-date {niceDate(p.exDate)}</span></span>
              <strong>{money(p.amount)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function CapitalGains() {
  const [fy, setFy] = useState(null); // null = the current financial year
  const [data, setData] = useState(null);
  const [dividends, setDividends] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    api.capitalGains(fy).then(setData).catch((e) => setError(e.message));
  }, [fy]);
  useEffect(() => {
    api.dividends().then(setDividends).catch(() => setDividends(null));
  }, []);

  if (error) return <div className="error" role="alert">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Capital gains, {data.label}</h2>
          <div className="gains-actions">
            <label className="gains-year">
              <span className="muted small">Year</span>
              <select value={data.fy} onChange={(e) => setFy(Number(e.target.value))}>
                {data.years.map((y) => <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>)}
              </select>
            </label>
            <button onClick={() => downloadCsv(data)} disabled={!data.rows.length}>Export CSV</button>
          </div>
        </div>
        <p className="muted">
          Profit booked from your sales between {niceDate(data.from)} and {niceDate(data.to)}, split the way income tax treats listed
          shares: sold after holding them more than 12 months is long-term, otherwise short-term. Your oldest shares are sold first.
        </p>
        <Totals data={data} />
        <Notes data={data} />
      </section>

      <section className="card">
        <h2>Sales in {data.label}</h2>
        <SalesTable data={data} />
      </section>

      {data.current && data.open && <StillHeld open={data.open} />}
      <DividendIncome data={data} dividends={dividends} />

      <p className="muted small gains-footnote">
        An estimate to plan with, not tax advice. It uses the rates for listed shares where STT was paid, plus {data.rates.cess}% cess,
        and leaves out surcharge, rebates, any unused basic exemption, and the 31 Jan 2018 grandfathering of older shares.
        Charges are deducted as you entered them. After a bonus issue, the extra shares here carry the original purchase date
        with the cost spread over all shares; for tax they count from the allotment date at zero cost. Check against your
        broker's tax P&amp;L statement before filing.
      </p>
    </>
  );
}
