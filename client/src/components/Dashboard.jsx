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
import { money, compactMoney, price, pct, signedMoney, tone, shortDate, PERIOD_LABEL, PERIOD_VS } from '../format.js';

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
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {data.length < 2 ? (
        <p className="muted">Not enough history yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid stroke="#eef0f3" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
            <YAxis domain={['auto', 'auto']} tickFormatter={compactMoney} width={64} fontSize={12} />
            <Tooltip formatter={(v, n) => [money(v), n === 'value' ? 'Current value' : 'Invested']} labelFormatter={shortDate} />
            <Area type="monotone" dataKey="value" stroke={BLUE} fill="#dbeafe" strokeWidth={2} />
            <Line type="stepAfter" dataKey="invested" stroke="#6b7280" strokeDasharray="4 4" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
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
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
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

  return (
    <>
      <div className="stats">
        <Stat label="Stocks held" value={report.holdings.length} />
        <Stat label="Invested" value={money(totals.invested)} />
        <Stat label="Current value" value={money(totals.value)} />
        <Stat label="Overall profit" value={signedMoney(totals.pnl)} sub={pct(totals.pnlPct)} cls={tone(totals.pnl)} />
        <Stat label="XIRR (annualised)" value={pct(totals.xirrPct)} sub={xirrSub(totals.xirrCoverage)} cls={tone(totals.xirrPct)} />
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
            <button key={k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{v}</button>
          ))}
        </div>
      </div>

      <Insights report={report} period={period} onPick={setSelected} />
      {selectedRow && <StockDetail row={selectedRow} period={period} onClose={() => setSelected(null)} />}
      <ContributionChart rows={report.holdings} period={period} />
      <PortfolioChart />

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
                  <td className="r">{price(r.price)}</td>
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
