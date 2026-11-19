import { useEffect, useState } from 'react';
import { useSort, SortTh } from '../sort.jsx';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api.js';
import { money, compactMoney, price, pct, signedMoney, tone, shortDate, timeAgo, PERIOD_LABEL, PERIOD_VS } from '../format.js';

const GREEN = 'var(--chart-green)';
const RED = 'var(--chart-red)';
const BLUE = 'var(--chart-blue)';

function Stat({ label, value, sub, cls = '' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls}`}>{value}</div>
      {sub && <div className={`stat-sub ${cls}`}>{sub}</div>}
    </div>
  );
}

function PortfolioChart() {
  const [range, setRange] = useState('3m');
  const [data, setData] = useState([]);
  useEffect(() => {
    api.portfolioHistory(range).then(setData).catch(() => setData([]));
  }, [range]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Portfolio value over time</h2>
        <div className="seg">
          {['1m', '3m', '6m', '1y'].map((r) => (
            <button key={r} className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {data.length < 2 ? (
        <p className="muted">Not enough history yet.</p>
      ) : (
        <div role="img" aria-label={`Portfolio value from ${money(data[0].value)} on ${shortDate(data[0].date)} to ${money(data[data.length - 1].value)} on ${shortDate(data[data.length - 1].date)}. You invested ${money(data[data.length - 1].invested)}.`}>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
            <YAxis domain={['auto', 'auto']} tickFormatter={compactMoney} width={64} fontSize={12} />
            <Tooltip formatter={(v, n) => [money(v), n === 'value' ? 'Value' : 'Invested']} labelFormatter={shortDate} />
            <Area type="monotone" dataKey="value" stroke={BLUE} fill="var(--chart-area)" strokeWidth={2} />
            <Line type="stepAfter" dataKey="invested" stroke="var(--ref)" strokeDasharray="4 4" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
        </div>
      )}
      {data.length >= 2 && (
        <p className="muted small">What you held on each day: purchases count from the day you bought them, and shares you sold count until the day you sold them.</p>
      )}
    </section>
  );
}

const ORANGE = 'var(--chart-orange)';
const RANGE_LABEL = { '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year' };

/** "1.25 points ahead of Nifty 50" for a difference in percentage points. */
function versus(gap, name) {
  if (gap == null) return '';
  if (Math.abs(gap) < 0.005) return `Level with ${name}`;
  return `${Math.abs(gap).toFixed(2)} points ${gap > 0 ? 'ahead of' : 'behind'} ${name}`;
}

/**
 * "₹X now, against ₹Y …", counting money taken out in sales on both sides when there were any: each purchase you sold
 * is matched by Nifty 50 bought and sold on the same days.
 */
function SinceBoughtText({ sp, name, partial }) {
  const yours = sp.yourValue + (sp.yourReceived ?? 0);
  const theirs = sp.indexValue + (sp.indexReceived ?? 0);
  const gap = yours - theirs;
  return (
    <p className="small">
      {sp.yourReceived > 0 ? (
        <>
          {money(yours)} in all ({money(sp.yourValue)} still held and {money(sp.yourReceived)} taken out in sales), against{' '}
          {money(theirs)} if each of your purchases had been {name}, held for the same days.{' '}
        </>
      ) : (
        <>{money(sp.yourValue)} now, against {money(sp.indexValue)} if the same {money(sp.invested)} had gone into {name} on the days you bought.{' '}</>
      )}
      <strong className={tone(gap)}>{money(Math.abs(gap))} {gap >= 0 ? 'ahead' : 'behind'}</strong>
      {partial && <span className="muted"> Covers {partial}: the ones with every purchase dated.</span>}
    </p>
  );
}

/** Your stocks against Nifty 50: this period, since you bought (same money, same days), and over time. */
function BenchmarkCard({ period }) {
  const [summary, setSummary] = useState(null);
  const [range, setRange] = useState('3m');
  const [hist, setHist] = useState(null);
  useEffect(() => {
    api.benchmark(period).then(setSummary).catch(() => setSummary({ available: false, name: 'Nifty 50' }));
  }, [period]);
  useEffect(() => {
    api.benchmarkHistory(range).then(setHist).catch(() => setHist({ points: [] }));
  }, [range]);

  if (!summary) return null;
  const { name } = summary;
  if (!summary.available) {
    return (
      <section className="card">
        <h2>Compared with {name}</h2>
        <p className="muted">{name} prices aren't available right now. They'll appear after the next price refresh.</p>
      </section>
    );
  }

  const p = summary.period;
  const sp = summary.sincePurchase;
  const points = hist?.points ?? [];
  const last = points[points.length - 1];
  // e.g. "3 of 4 holdings and 2 of 3 sales", naming only what is partly covered.
  const partial = sp?.coverage && [
    sp.coverage.holdings < sp.coverage.of && `${sp.coverage.holdings} of ${sp.coverage.of} holdings`,
    sp.coverage.sales < sp.coverage.salesOf && `${sp.coverage.sales} of ${sp.coverage.salesOf} sales`,
  ].filter(Boolean).join(' and ');
  return (
    <section className="card">
      <div className="card-head">
        <h2>Compared with {name}</h2>
      </div>
      <div className="bench-grid">
        <div className="bench-block">
          <h3>{PERIOD_LABEL[period]}</h3>
          <div className="bench-row"><span>Your stocks</span><strong className={tone(p.yoursPct)}>{pct(p.yoursPct)}</strong></div>
          <div className="bench-row"><span>{name}</span><strong className={tone(p.indexPct)}>{pct(p.indexPct)}</strong></div>
          <p className={`small ${p.yoursPct != null && p.indexPct != null ? tone(p.yoursPct - p.indexPct) : ''}`}>
            {versus(p.yoursPct != null && p.indexPct != null ? p.yoursPct - p.indexPct : null, name)}
          </p>
        </div>
        <div className="bench-block">
          <h3>Since you bought</h3>
          {sp ? (
            <>
              <div className="bench-row"><span>Your XIRR</span><strong className={tone(sp.yourXirrPct)}>{pct(sp.yourXirrPct)}</strong></div>
              <div className="bench-row"><span>{name}, same days</span><strong className={tone(sp.indexXirrPct)}>{pct(sp.indexXirrPct)}</strong></div>
              <SinceBoughtText sp={sp} name={name} partial={partial} />
            </>
          ) : (
            <p className="muted small">Add purchase dates to your holdings to compare them with {name} bought on the same days.</p>
          )}
        </div>
      </div>

      <div className="card-head bench-chart-head">
        <h3>Your stocks vs {name}</h3>
        <div className="seg">
          {['1m', '3m', '6m', '1y'].map((r) => (
            <button key={r} className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {points.length < 2 ? (
        <p className="muted">Not enough history yet.</p>
      ) : (
        <>
          <p className="small">
            Over {RANGE_LABEL[range]}: <span className="bench-key" style={{ background: BLUE }} /> your stocks{' '}
            <strong className={tone(last.yoursPct)}>{pct(last.yoursPct)}</strong>,{' '}
            <span className="bench-key" style={{ background: ORANGE }} /> {name} <strong className={tone(last.indexPct)}>{pct(last.indexPct)}</strong>.
          </p>
          <div role="img" aria-label={`Over ${RANGE_LABEL[range]}, your stocks ${pct(last.yoursPct)} and ${name} ${pct(last.indexPct)}.`}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
                <YAxis domain={['auto', 'auto']} width={56} fontSize={12} tickFormatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`} />
                <ReferenceLine y={0} stroke="var(--zero)" />
                <Tooltip formatter={(v, n) => [pct(v), n === 'yoursPct' ? 'Your stocks' : name]} labelFormatter={shortDate} />
                <Line type="monotone" dataKey="yoursPct" stroke={BLUE} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="indexPct" stroke={ORANGE} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <p className="muted small">
        Your line counts only the shares you held through each day, so buying and selling don't show up as gains or losses.
        Dividends aren't included on either side.
      </p>
    </section>
  );
}

const ticker = (symbol) => symbol.replace(/\.(NS|BO)$/, '');
const exDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const UNKNOWN_SECTOR = 'Sector not known';
/** Yahoo's sectors, plus the groups funds and ETFs go in, so a target can be set before you hold anything there. */
const SECTOR_CHOICES = [
  'Financial Services', 'Technology', 'Consumer Cyclical', 'Consumer Defensive', 'Healthcare', 'Industrials', 'Energy',
  'Basic Materials', 'Communication Services', 'Utilities', 'Real Estate', 'Mutual funds', 'ETFs',
];

/**
 * New money split between the sectors furthest below target, so they move towards it without selling anything.
 * Returns [{sector, amount}].
 */
function splitNewMoney(rows, amount) {
  const total = rows.reduce((s, r) => s + r.value, 0) + amount;
  const short = rows.map((r) => ({ sector: r.sector, gap: Math.max((r.targetPct / 100) * total - r.value, 0), targetPct: r.targetPct }));
  const gaps = short.reduce((s, r) => s + r.gap, 0);
  if (gaps <= 0) {
    const pcts = short.reduce((s, r) => s + r.targetPct, 0) || 1;
    return short.map((r) => ({ sector: r.sector, amount: (amount * r.targetPct) / pcts })).filter((r) => r.amount > 0.5);
  }
  return short.map((r) => ({ sector: r.sector, amount: (amount * r.gap) / gaps })).filter((r) => r.amount > 0.5);
}

function TargetEditor({ sectors, targets, onSaved, onCancel }) {
  const names = [...new Set([...sectors.map((s) => s.sector ?? UNKNOWN_SECTOR), ...targets.map((t) => t.sector), ...SECTOR_CHOICES])];
  const [values, setValues] = useState(() => Object.fromEntries(targets.map((t) => [t.sector, String(t.pct)])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const total = names.reduce((s, n) => s + (Number(values[n]) || 0), 0);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const list = names.filter((n) => Number(values[n]) > 0).map((n) => ({ sector: n, pct: Number(values[n]) }));
      await api.setTargets(list);
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  // Fill in today's weights as a starting point.
  const useCurrent = () =>
    setValues(Object.fromEntries(sectors.map((s) => [s.sector ?? UNKNOWN_SECTOR, String(Math.round(s.weightPct))])));
  return (
    <div className="review">
      <h3>Target share of your portfolio per sector</h3>
      <div className="target-grid">
        {names.map((n) => (
          <label key={n}>
            <span>{n}</span>
            <span className="with-unit">
              <input type="number" min="0" max="100" step="any" value={values[n] ?? ''} onChange={(e) => setValues({ ...values, [n]: e.target.value })} aria-label={`Target for ${n}`} />
              %
            </span>
          </label>
        ))}
      </div>
      <p className={`small ${Math.abs(total - 100) < 0.01 ? 'pos' : total > 100 ? 'neg' : 'muted'}`}>
        Total {Number(total.toFixed(2))}%{Math.abs(total - 100) < 0.01 ? '' : total > 100 ? ': more than 100%' : `: ${Number((100 - total).toFixed(2))}% still to assign`}
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="actions">
        <button className="primary" onClick={save} disabled={busy || total > 100.0001}>Save targets</button>
        <button onClick={useCurrent} disabled={busy}>Start from today's weights</button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function Rebalance({ plan }) {
  const [amount, setAmount] = useState('');
  if (!plan.complete) {
    return <p className="muted small">Your targets add up to {Number(plan.targetTotal.toFixed(2))}%. Set them to 100% to see how to rebalance.</p>;
  }
  const extra = Number(amount) > 0 ? splitNewMoney(plan.rows, Number(amount)) : null;
  const near = (r) => Math.abs(r.driftPct) < 2;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Sector</th><th className="r">Now</th><th className="r">Target</th><th className="r">To get there</th></tr></thead>
          <tbody>
            {plan.rows.map((r) => (
              <tr key={r.sector}>
                <td>{r.sector}</td>
                <td className="r">{r.weightPct.toFixed(1)}%<div className="muted small">{money(r.value)}</div></td>
                <td className="r">{r.targetPct ? `${r.targetPct}%` : '—'}</td>
                <td className={`r ${near(r) ? 'muted' : r.amount > 0 ? 'pos' : 'neg'}`}>
                  {near(r) ? 'On target' : `${r.amount > 0 ? 'Buy' : 'Sell'} ${money(Math.abs(r.amount))}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row new-money">
        <label className="field">
          <span className="muted small">Investing new money? Amount (₹)</span>
          <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000" />
        </label>
        {extra && (
          <p className="small">
            Put it into the sectors furthest below target, without selling: {extra.map((e) => `${e.sector} ${money(e.amount)}`).join(', ')}.
          </p>
        )}
      </div>
      <p className="muted small">Within 2 points of target counts as on target. Selling can mean capital gains tax; check the Capital gains tab first.</p>
    </>
  );
}

/** How the portfolio splits by sector, how much sits in its largest stocks, and how far it is from your targets. */
function AllocationCard() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = () => api.allocation().then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, []);
  if (!data || !data.sectors.length) return null;
  const [largest] = data.top;
  const target = new Map((data.targets ?? []).map((t) => [t.sector, t.pct]));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Where your money is</h2>
        {!editing && <button onClick={() => setEditing(true)}>{data.targets?.length ? 'Edit targets' : 'Set targets'}</button>}
      </div>
      <ul className="alloc">
        {data.sectors.map((s) => {
          const t = target.get(s.sector ?? UNKNOWN_SECTOR);
          return (
            <li key={s.sector ?? 'unknown'}>
              <div className="alloc-head">
                <span className={s.sector ? '' : 'muted'}>{s.sector ?? UNKNOWN_SECTOR}</span>
                <strong>{s.weightPct.toFixed(1)}%{t != null && <span className="muted small"> / target {t}%</span>}</strong>
              </div>
              <div className="alloc-bar" aria-hidden="true">
                <span style={{ width: `${s.weightPct}%` }} />
                {t != null && <i className="alloc-target" style={{ left: `${Math.min(t, 100)}%` }} />}
              </div>
              <div className="muted small">{money(s.value)} · {s.stocks.map(ticker).join(', ')}</div>
            </li>
          );
        })}
      </ul>
      <p className="small">
        Your largest stock, {ticker(largest.symbol)}, is {largest.weightPct.toFixed(1)}% of your portfolio
        {data.top.length > 1 && <>; your top {data.top.length} ({data.top.map((t) => ticker(t.symbol)).join(', ')}) are {data.topPct.toFixed(1)}%</>}.
      </p>
      {editing && (
        <TargetEditor
          sectors={data.sectors}
          targets={data.targets ?? []}
          onSaved={() => { setEditing(false); load(); }}
          onCancel={() => setEditing(false)}
        />
      )}
      {!editing && data.rebalance && (
        <>
          <h3>Rebalancing</h3>
          <Rebalance plan={data.rebalance} />
        </>
      )}
    </section>
  );
}

const eventDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/** Results and ex-dividend dates in the next few weeks, for stocks you hold or watch. */
function ComingUpCard() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.events().then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;
  return (
    <section className="card">
      <h2>Coming up</h2>
      {data.items.length === 0 ? (
        <p className="muted small">
          {data.pending > 0 ? 'Looking up results and dividend dates for your stocks…' : `No results or ex-dividend dates known for the next ${data.days ?? 60} days.`}
        </p>
      ) : (
        <ul className="div-list">
          {data.items.map((e) => (
            <li key={`${e.symbol}-${e.type}`}>
              <span>
                <strong>{ticker(e.symbol)}</strong>{' '}
                {e.type === 'results' ? 'quarterly results' : 'goes ex-dividend'}
                {e.estimate && <span className="muted small"> (expected)</span>}
                {!e.held && e.watching && <span className="mk-tag">watching</span>}
              </span>
              <span className="nowrap">{eventDay(e.date)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        From Yahoo Finance; results dates marked expected may move. To get a dividend you must hold the shares before the ex-dividend date.
      </p>
    </section>
  );
}

/** Dividends received, by stock and most recent first. */
function DividendsCard() {
  const [data, setData] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.dividends().then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;
  if (!data.payments.length) {
    return (
      <section className="card">
        <h2>Dividends</h2>
        <p className="muted">
          {data.pending > 0 ? 'Looking up dividends for your stocks…' : 'No dividends since you bought your stocks.'}
        </p>
      </section>
    );
  }
  const shown = all ? data.payments : data.payments.slice(0, 5);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Dividends</h2>
        <div className="sell-total">
          <span className="muted small">Last 12 months</span>
          <strong className="pos">{money(data.last12m)}</strong>
        </div>
      </div>
      <p className="muted small">
        {money(data.total)} received since you bought, before any tax deducted. Worked out from the shares you held going into each
        ex-dividend date. Not included in XIRR or the Nifty 50 comparison, which are price-only.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Stock</th><th className="r">Last 12 months</th><th className="r">Since you bought</th><th className="r">Yield on cost</th></tr>
          </thead>
          <tbody>
            {data.byStock.map((s) => (
              <tr key={s.symbol}>
                <td><strong>{s.symbol}</strong><div className="muted small">{s.held ? s.name : `${s.name} · sold`}</div></td>
                <td className="r">{money(s.last12m)}</td>
                <td className="r">{money(s.total)}</td>
                <td className="r" title="Last 12 months' dividends per share, on the shares you hold now, against what they cost">{s.yieldOnCostPct == null ? '—' : `${s.yieldOnCostPct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="div-recent">Payments</h3>
      <ul className="div-list">
        {shown.map((p) => (
          <li key={`${p.symbol}-${p.exDate}`}>
            <span><strong>{ticker(p.symbol)}</strong> <span className="muted small">ex-date {exDay(p.exDate)} · {Number(p.shares.toFixed(4))} × {price(p.perShare)}</span></span>
            <strong>{money(p.amount)}</strong>
          </li>
        ))}
      </ul>
      {data.payments.length > 5 && (
        <button className="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${data.payments.length} payments`}</button>
      )}
    </section>
  );
}

function ContributionChart({ rows, period }) {
  const data = rows
    .filter((r) => r.periodChangeValue != null)
    .map((r) => ({ symbol: r.symbol.replace(/\.(NS|BO)$/, ''), change: Math.round(r.periodChangeValue) }))
    .sort((a, b) => a.change - b.change);
  if (!data.length) return null;
  return (
    <section className="card">
      <h2>What moved your portfolio — {PERIOD_LABEL[period].toLowerCase()}</h2>
      <p className="muted">Rupee change in each stock's value vs {PERIOD_VS[period]}. Red bars are pulling you down.</p>
      <div role="img" aria-label={`Change in value by stock, ${PERIOD_LABEL[period].toLowerCase()}: ${[...data].reverse().map((d) => `${d.symbol} ${signedMoney(d.change)}`).join(', ')}.`}>
      <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ left: 16, right: 24 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => signedMoney(v)} fontSize={12} />
          <YAxis type="category" dataKey="symbol" width={90} fontSize={12} />
          <Tooltip formatter={(v) => [signedMoney(v), 'Change']} />
          <ReferenceLine x={0} stroke="var(--zero)" />
          <Bar dataKey="change" radius={2}>
            {data.map((d) => (
              <Cell key={d.symbol} fill={d.change < 0 ? RED : GREEN} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      </div>
    </section>
  );
}

function StockDetail({ row, period, onClose }) {
  const [range, setRange] = useState('3m');
  const [hist, setHist] = useState(null);
  useEffect(() => {
    api.stockHistory(row.symbol, range).then(setHist).catch(() => setHist({ points: [] }));
  }, [row.symbol, range]);

  const intraday = range === '1d';
  const points = hist?.points ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <h2>{row.symbol} <span className="muted">{row.name}</span></h2>
        <div className="seg">
          {['1d', '1m', '3m', '6m', '1y'].map((r) => (
            <button key={r} className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r === '1d' ? 'Intraday' : r.toUpperCase()}
            </button>
          ))}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <p className="muted">
        Your average cost is {price(row.avgCost)} (dashed line). {PERIOD_LABEL[period]}: {pct(row.periodChangePct)} vs {PERIOD_VS[period]}.
      </p>
      {points.length < 2 ? (
        <p className="muted">{intraday ? 'Intraday points build up from the price refreshes at about 9:30, 12:30 and 15:30 IST.' : 'Not enough history yet.'}</p>
      ) : (
        <div role="img" aria-label={`${row.symbol} price from ${price(points[0].price)} to ${price(points[points.length - 1].price)}. Your average cost is ${price(row.avgCost)}.`}>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey={intraday ? 'ts' : 'date'}
              tickFormatter={(v) => (intraday ? new Date(v).toLocaleString('en-IN', { day: 'numeric', hour: '2-digit', minute: '2-digit' }) : shortDate(v))}
              minTickGap={40}
              fontSize={12}
            />
            <YAxis domain={['auto', 'auto']} width={64} fontSize={12} tickFormatter={(v) => `₹${Math.round(v)}`} />
            <Tooltip formatter={(v) => [price(v), 'Price']} labelFormatter={(v) => (intraday ? new Date(v).toLocaleString('en-IN') : shortDate(v))} />
            {hist?.avgCost && <ReferenceLine y={hist.avgCost} stroke="var(--ref)" strokeDasharray="4 4" />}
            <Line type="monotone" dataKey="price" stroke={BLUE} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function Insights({ report, period, onPick }) {
  const { draggers, dips, laggards } = report;
  const label = PERIOD_LABEL[period].toLowerCase();
  const List = ({ items, render, empty }) =>
    items.length ? (
      <ul className="insight-list">
        {items.slice(0, 5).map((r) => (
          <li key={r.symbol}>
            <button className="link" onClick={() => onPick(r.symbol)}>{r.symbol}</button>
            <span>{render(r)}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{empty}</p>
    );

  return (
    <div className="grid3">
      <section className="card">
        <h3>Dragging you down <span className="muted">({label})</span></h3>
        <List
          items={draggers}
          empty="No stock lost value in this period."
          render={(r) => <><span className="neg">{signedMoney(r.periodChangeValue)}</span> <span className="muted">({pct(r.periodChangePct)})</span></>}
        />
      </section>
      <section className="card">
        <h3>Buy-the-dip candidates</h3>
        <p className="muted small">Still in profit overall, but price fell {label}.</p>
        <List
          items={dips}
          empty="No profitable stock is down in this period."
          render={(r) => <><span className="neg">{pct(r.periodChangePct)}</span> <span className="muted">· {pct(r.fromHighPct)} from 52w high</span></>}
        />
      </section>
      <section className="card">
        <h3>Lagging the portfolio</h3>
        <p className="muted small">Lower return on cost than your overall {pct(report.totals.pnlPct)}.</p>
        <List
          items={laggards}
          empty="Every stock is at or above your average return."
          render={(r) => <><span className={tone(r.pnlPct)}>{pct(r.pnlPct)}</span> <span className="muted">· {r.weightPct?.toFixed(1)}% of portfolio</span></>}
        />
      </section>
    </div>
  );
}

function xirrSub(c) {
  if (!c || (c.holdings === 0 && !c.sales)) return 'Add purchase dates to see this';
  const parts = [];
  if (c.of > 0) parts.push(c.holdings === c.of ? 'All holdings dated' : `${c.holdings} of ${c.of} holdings dated (${c.investedPct.toFixed(0)}% of invested)`);
  // Sales count as money taken out, so selling doesn't change the rate you earned.
  if (c.salesOf) parts.push(c.sales === c.salesOf ? `includes ${c.sales} ${c.sales === 1 ? 'sale' : 'sales'}` : `${c.sales} of ${c.salesOf} sales dated`);
  return parts.join(' · ');
}

export default function Dashboard({ report, period, setPeriod, goToStocks }) {
  const [selected, setSelected] = useState(null);
  const { sorted, sort, toggle } = useSort(report?.holdings ?? [], { key: 'value', dir: 'desc' });

  if (!report) return <p className="muted">Loading…</p>;
  if (!report.holdings.length) {
    return (
      <section className="card empty">
        <h2>Add your first stock</h2>
        <p>Enter each holding's quantity and the total amount you invested. Stock Beat tracks prices and builds your reports from there.</p>
        <button className="primary" onClick={goToStocks}>Add stocks</button>
      </section>
    );
  }

  const { totals } = report;
  const selectedRow = report.holdings.find((h) => h.symbol === selected);

  const pendingSplits = report.pendingSplits ?? [];

  return (
    <>
      {pendingSplits.length > 0 && (
        <div className="warn box split-notice" role="status">
          {pendingSplits.map((p) => p.symbol).join(', ')} had a split or bonus issue. Until you confirm{' '}
          {pendingSplits.length === 1 ? 'it' : 'them'}, your figures for {pendingSplits.length === 1 ? 'it are' : 'them are'} in the old shares.{' '}
          <button onClick={goToStocks}>Review on Holdings</button>
        </div>
      )}
      <div className="stats">
        <Stat label="Stocks held" value={report.holdings.length} />
        <Stat label="Invested" value={money(totals.invested)} />
        <Stat label="Current value" value={money(totals.value)} />
        <Stat label="Overall profit" value={signedMoney(totals.pnl)} sub={pct(totals.pnlPct)} cls={tone(totals.pnl)} />
        <Stat label="XIRR (annualised)" value={pct(totals.xirrPct)} sub={xirrSub(totals.xirrCoverage)} cls={tone(totals.xirrPct)} />
        {report.realised?.count > 0 && (
          <Stat
            label="Profit booked (sold)"
            value={signedMoney(report.realised.realised)}
            sub={`${report.realised.count} ${report.realised.count === 1 ? 'sale' : 'sales'} · ${money(report.realised.proceeds - report.realised.charges)} received`}
            cls={tone(report.realised.realised)}
          />
        )}
        <Stat
          label={PERIOD_LABEL[period]}
          value={signedMoney(totals.changeValue)}
          sub={`${pct(totals.changePct)} vs ${PERIOD_VS[period]}`}
          cls={tone(totals.changeValue)}
        />
      </div>

      <div className="period-bar">
        <span>Report period</span>
        <div className="seg">
          {Object.entries(PERIOD_LABEL).map(([k, v]) => (
            <button key={k} className={period === k ? 'on' : ''} aria-pressed={period === k} onClick={() => setPeriod(k)}>{v}</button>
          ))}
        </div>
      </div>

      <Insights report={report} period={period} onPick={setSelected} />
      <ComingUpCard />
      {selectedRow && <StockDetail row={selectedRow} period={period} onClose={() => setSelected(null)} />}
      <ContributionChart rows={report.holdings} period={period} />
      <PortfolioChart />
      <BenchmarkCard period={period} />
      <AllocationCard />
      <DividendsCard />

      <section className="card">
        <h2>All holdings <span className="muted">({report.holdings.length})</span></h2>
        <p className="muted small">
          Click a column heading to sort. XIRR is the yearly rate that turns what you paid into today's value, counted from the purchase date.
          Holdings without a purchase date are left out. For positions held under a year it is an extrapolated figure and can look extreme.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Stock" k="symbol" textual right={false} sort={sort} toggle={toggle} />
                <SortTh label="Price" k="price" sort={sort} toggle={toggle} />
                <SortTh label="Avg cost" k="avgCost" sort={sort} toggle={toggle} />
                <SortTh label="Value" k="value" sort={sort} toggle={toggle} />
                <SortTh label="Profit ₹" k="pnl" sort={sort} toggle={toggle} />
                <SortTh label="Profit %" k="pnlPct" sort={sort} toggle={toggle} />
                <SortTh label="XIRR" k="xirrPct" sort={sort} toggle={toggle} />
                <SortTh label={PERIOD_LABEL[period]} k="periodChangePct" sort={sort} toggle={toggle} />
                <SortTh label="From 52w high" k="fromHighPct" sort={sort} toggle={toggle} />
                <SortTh label="Weight" k="weightPct" sort={sort} toggle={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.symbol} className={selected === r.symbol ? 'sel' : ''} onClick={() => setSelected(r.symbol)}>
                  <td><strong>{r.symbol}</strong><div className="muted small">{r.name}</div></td>
                  <td className="r">
                    {price(r.price)}
                    {r.stale && <div><span className="stale" title="This price is older than expected. The next refresh will update it.">Stale · {timeAgo(r.priceAsOf)}</span></div>}
                    {r.splitPending && <div><span className="stale" title="Confirm the split or bonus issue on the Holdings tab">Split to confirm</span></div>}
                  </td>
                  <td className="r">{price(r.avgCost)}</td>
                  <td className="r">{money(r.value)}</td>
                  <td className={`r ${tone(r.pnl)}`}>{signedMoney(r.pnl)}</td>
                  <td className={`r ${tone(r.pnlPct)}`}>{pct(r.pnlPct)}</td>
                  <td className={`r ${tone(r.xirrPct)}`} title={r.purchaseDate ? `Held since ${r.purchaseDate} (${r.daysHeld} days)` : 'Add a purchase date to see XIRR'}>{pct(r.xirrPct)}</td>
                  <td className={`r ${tone(r.periodChangePct)}`}>{pct(r.periodChangePct)}</td>
                  <td className={`r ${tone(r.fromHighPct)}`}>{pct(r.fromHighPct)}</td>
                  <td className="r">{r.weightPct == null ? '—' : `${r.weightPct.toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
