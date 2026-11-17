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

const GREEN = '#15803d';
const RED = '#b91c1c';
const BLUE = '#2563eb';

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
            <CartesianGrid stroke="#eef0f3" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
            <YAxis domain={['auto', 'auto']} tickFormatter={compactMoney} width={64} fontSize={12} />
            <Tooltip formatter={(v, n) => [money(v), n === 'value' ? 'Value' : 'Invested']} labelFormatter={shortDate} />
            <Area type="monotone" dataKey="value" stroke={BLUE} fill="#dbeafe" strokeWidth={2} />
            <Line type="stepAfter" dataKey="invested" stroke="#6b7280" strokeDasharray="4 4" dot={false} />
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

const ORANGE = '#d97706';
const RANGE_LABEL = { '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year' };

/** "1.25 points ahead of Nifty 50" for a difference in percentage points. */
function versus(gap, name) {
  if (gap == null) return '';
  if (Math.abs(gap) < 0.005) return `Level with ${name}`;
  return `${Math.abs(gap).toFixed(2)} points ${gap > 0 ? 'ahead of' : 'behind'} ${name}`;
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
  const partial = sp && sp.coverage && sp.coverage.holdings < sp.coverage.of;
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
              <p className="small">
                {money(sp.yourValue)} now, against {money(sp.indexValue)} if the same {money(sp.invested)} had gone into {name} on the
                days you bought.{' '}
                <strong className={tone(sp.yourValue - sp.indexValue)}>
                  {money(Math.abs(sp.yourValue - sp.indexValue))} {sp.yourValue >= sp.indexValue ? 'ahead' : 'behind'}
                </strong>
                {partial && <span className="muted"> Covers {sp.coverage.holdings} of {sp.coverage.of} holdings: the ones with every purchase dated.</span>}
              </p>
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
                <CartesianGrid stroke="#eef0f3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
                <YAxis domain={['auto', 'auto']} width={56} fontSize={12} tickFormatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`} />
                <ReferenceLine y={0} stroke="#9ca3af" />
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
          <CartesianGrid stroke="#eef0f3" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => signedMoney(v)} fontSize={12} />
          <YAxis type="category" dataKey="symbol" width={90} fontSize={12} />
          <Tooltip formatter={(v) => [signedMoney(v), 'Change']} />
          <ReferenceLine x={0} stroke="#9ca3af" />
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
              {r === '1d' ? 'Hourly' : r.toUpperCase()}
            </button>
          ))}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <p className="muted">
        Your average cost is {price(row.avgCost)} (dashed line). {PERIOD_LABEL[period]}: {pct(row.periodChangePct)} vs {PERIOD_VS[period]}.
      </p>
      {points.length < 2 ? (
        <p className="muted">{intraday ? 'Hourly points build up while the server runs during market hours.' : 'Not enough history yet.'}</p>
      ) : (
        <div role="img" aria-label={`${row.symbol} price from ${price(points[0].price)} to ${price(points[points.length - 1].price)}. Your average cost is ${price(row.avgCost)}.`}>
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
            {hist?.avgCost && <ReferenceLine y={hist.avgCost} stroke="#6b7280" strokeDasharray="4 4" />}
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
  if (!c || c.holdings === 0) return 'Add purchase dates to see this';
  if (c.holdings === c.of) return 'All holdings dated';
  return `${c.holdings} of ${c.of} holdings dated (${c.investedPct.toFixed(0)}% of invested)`;
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
      {selectedRow && <StockDetail row={selectedRow} period={period} onClose={() => setSelected(null)} />}
      <ContributionChart rows={report.holdings} period={period} />
      <PortfolioChart />
      <BenchmarkCard period={period} />

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
