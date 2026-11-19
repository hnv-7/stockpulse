import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.js';
import { useSort, SortTh } from '../sort.jsx';
import { price, pct, tone, shortDate, timeAgo } from '../format.js';

const BLUE = 'var(--chart-blue)';
const ORANGE = 'var(--chart-orange)';
const GREEN = 'var(--chart-green)';
const RED = 'var(--chart-red)';
const SLATE = 'var(--chart-slate)';

const PERIODS = { '1d': 'Today', '1w': '1 week', '1m': '1 month', '3m': '3 months' };
/** A move this size (in %) gets the strongest tile colour; smaller moves are paler. */
const FULL_TINT = { '1d': 2, '1w': 4, '1m': 8, '3m': 15 };

const ticker = (symbol) => symbol.replace(/\.(NS|BO)$/, '');
const sessionDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const level = (n) => (n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * The points a line for `period` covers: from the close its change is measured against to now.
 * "Today" has no intraday points, so its line is the past week, ending with today's move.
 */
function windowOf(item, period) {
  const from = item.since?.[period === '1d' ? '1w' : period];
  return from ? item.points.filter((p) => p.date >= from) : item.points;
}

/**
 * A small trend line, green when it ends higher than it starts. Decorative: the numbers sit next to it.
 * `neutral` draws it grey, for "Today", whose line is the past week and could disagree in colour with today's move.
 */
function Spark({ points, width = 96, height = 28, neutral = false }) {
  if (!points || points.length < 2) return <span className="spark-empty" style={{ width, height }} />;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const xy = closes.map((c, i) => `${((i / (closes.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 1 - ((c - min) / span) * (height - 2)).toFixed(1)}`);
  const up = closes[closes.length - 1] >= closes[0];
  return (
    // Stretches to the width it is given (cards, tiles) with an even line.
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={xy.join(' ')} fill="none" stroke={neutral ? SLATE : up ? GREEN : RED} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Tile background: green or red, stronger for bigger moves. */
function tint(change, period) {
  if (change == null || change === 0) return undefined;
  const strength = Math.min(Math.abs(change) / FULL_TINT[period], 1);
  const rgb = change > 0 ? '21, 128, 61' : '185, 28, 28';
  return { background: `rgba(${rgb}, ${(0.05 + 0.25 * strength).toFixed(3)})`, borderColor: `rgba(${rgb}, ${(0.2 + 0.4 * strength).toFixed(3)})` };
}

function Marks({ r }) {
  return (
    <>
      {r.held && <span className="mk-tag">You hold</span>}
      {r.watching && <span className="mk-tag">Watching</span>}
    </>
  );
}

/** Up/down split of the popular stocks for the last session, as a bar and in words. */
function Breadth({ b, when }) {
  const total = b.up + b.down + b.flat;
  if (!total) return null;
  return (
    <div className="mk-breadth">
      <div className="mk-breadth-bar" aria-hidden="true">
        <span className="up" style={{ width: `${(b.up / total) * 100}%` }} />
        <span className="flat" style={{ width: `${(b.flat / total) * 100}%` }} />
        <span className="down" style={{ width: `${(b.down / total) * 100}%` }} />
      </div>
      <span className="small">
        <strong className="pos">{b.up} up</strong>, <strong className="neg">{b.down} down</strong>
        {b.flat > 0 && `, ${b.flat} unchanged`} of {total} popular stocks {when}
      </span>
    </div>
  );
}

/** "Leading: IT +1.2%, Pharma +0.8%. Lagging: Metals −2.1%." for the chosen period. */
function SectorSummary({ ranked, period, label }) {
  const known = ranked.filter((s) => s.changes[period] != null);
  if (!known.length) return null;
  const up = known.filter((s) => s.changes[period] > 0).length;
  const name = (s) => <><strong>{s.name}</strong> <span className={tone(s.changes[period])}>{pct(s.changes[period])}</span></>;
  const join = (list) => list.map((s, i) => <span key={s.key}>{i > 0 && ', '}{name(s)}</span>);
  return (
    <p className="mk-summary">
      {up} of {known.length} sectors up {label}. Leading: {join(known.slice(0, 2))}. Lagging: {join(known.slice(-2).reverse())}.
    </p>
  );
}

/** The sector's line against the selected stock's, both as % change from the start of the period. */
function CompareChart({ sector, stock, period }) {
  const base = windowOf(sector, period);
  if (base.length < 2) return <p className="muted">Not enough history for a chart yet.</p>;
  const from = base[0].date;
  const stockPts = stock ? stock.points.filter((p) => p.date >= from) : [];
  const stockStart = stockPts[0]?.close;
  const stockAt = new Map(stockPts.map((p) => [p.date, p.close]));
  const data = base.map((p) => {
    const s = stockAt.get(p.date);
    return {
      date: p.date,
      sector: (p.close / base[0].close - 1) * 100,
      stock: stock && s != null && stockStart ? (s / stockStart - 1) * 100 : null,
    };
  });
  const last = data[data.length - 1];
  const span = period === '1d' ? 'the past week' : `the past ${PERIODS[period]}`;
  const sectorName = sector.basis === 'stocks' ? `${sector.name} (average of its popular stocks)` : sector.indexName;
  return (
    <>
      <p className="small">
        Over {span}: <span className="bench-key" style={{ background: BLUE }} /> {sectorName} <strong className={tone(last.sector)}>{pct(last.sector)}</strong>
        {stock && (
          <>
            , <span className="bench-key" style={{ background: ORANGE }} /> {stock.name} <strong className={tone(last.stock)}>{pct(last.stock)}</strong>
          </>
        )}
        {!stock && <span className="muted"> · Pick a stock below to compare it with the sector.</span>}
      </p>
      <div role="img" aria-label={`Over ${span}, ${sectorName} ${pct(last.sector)}${stock ? ` and ${stock.name} ${pct(last.stock)}` : ''}.`}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} fontSize={12} />
            <YAxis domain={['auto', 'auto']} width={56} fontSize={12} tickFormatter={(v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) < 2 ? 1 : 0)}%`} />
            <ReferenceLine y={0} stroke="var(--zero)" />
            <Tooltip formatter={(v, n) => [pct(v), n === 'sector' ? sector.name : stock?.name]} labelFormatter={shortDate} />
            <Line type="monotone" dataKey="sector" stroke={BLUE} strokeWidth={2} dot={false} />
            {stock && <Line type="monotone" dataKey="stock" stroke={ORANGE} strokeWidth={2} dot={false} connectNulls />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/** One sector opened: its chart and its popular stocks, which can be compared with it or added to the watchlist. */
function SectorDetail({ row, period, periodLabel, focus, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState(focus ?? null);
  const [message, setMessage] = useState(null);
  const [added, setAdded] = useState(() => new Set());

  useEffect(() => {
    api.marketSector(row.key).then(setData).catch((e) => setError(e.message));
  }, [row.key]);
  useEffect(() => setPicked(focus ?? null), [focus]);

  const rows = useMemo(
    () => (data?.stocks ?? []).map((s) => ({ ...s, change: s.changes[period], watching: s.watching || added.has(s.symbol) })),
    [data, period, added],
  );
  const { sorted, sort, toggle } = useSort(rows, { key: 'change', dir: 'desc' });
  const stock = rows.find((s) => s.symbol === picked);

  const watch = async (s) => {
    setMessage(null);
    try {
      await api.addWatch({ symbol: s.symbol });
      setAdded((a) => new Set(a).add(s.symbol));
      setMessage({ ok: true, text: `${s.name} added to your watchlist at ${price(s.price)}.` });
    } catch (e) {
      setMessage({ ok: false, text: e.message });
    }
  };

  return (
    <section className="card" aria-labelledby="mk-sector-title">
      <div className="card-head">
        <h2 id="mk-sector-title">
          {row.name}{' '}
          <span className="muted">
            {row.indexName} {level(row.price)} · <span className={tone(row.changes[period])}>{pct(row.changes[period])}</span> {periodLabel.toLowerCase()}
          </span>
        </h2>
        <button onClick={onClose}>Close</button>
      </div>
      <CompareChart sector={row} stock={stock} period={period} />
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
      {!data && !error ? (
        <p className="muted">Loading stocks…</p>
      ) : data && (
        <div className="table-wrap">
          <table className="mk-table">
            <thead>
              <tr>
                <SortTh label="Stock" k="name" textual right={false} sort={sort} toggle={toggle} />
                <SortTh label="Price" k="price" sort={sort} toggle={toggle} />
                <SortTh label={periodLabel} k="change" sort={sort} toggle={toggle} />
                <th className="r">Trend</th>
                <SortTh label="From 52w high" k="fromHighPct" sort={sort} toggle={toggle} />
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.symbol} className={picked === s.symbol ? 'sel' : ''} onClick={() => setPicked(picked === s.symbol ? null : s.symbol)}>
                  <td>
                    <button className="link" aria-pressed={picked === s.symbol} onClick={(e) => { e.stopPropagation(); setPicked(picked === s.symbol ? null : s.symbol); }}>
                      {s.name}
                    </button>
                    <div className="muted small">{ticker(s.symbol)} <Marks r={s} /></div>
                  </td>
                  <td className="r">{price(s.price)}</td>
                  <td className={`r ${tone(s.change)}`}>{pct(s.change)}</td>
                  <td className="r"><Spark points={windowOf(s, period)} width={88} height={24} neutral={period === '1d'} /></td>
                  <td className={`r ${tone(s.fromHighPct)}`}>{pct(s.fromHighPct)}</td>
                  <td className="r nowrap">
                    {!s.held && !s.watching && (
                      <button onClick={(e) => { e.stopPropagation(); watch(s); }} aria-label={`Add ${s.name} to your watchlist`}>Watch</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Today's biggest moves among the popular stocks. */
function Movers({ movers, when, onPick }) {
  const List = ({ items, empty }) =>
    items.length ? (
      <ul className="insight-list">
        {items.map((m) => (
          <li key={m.symbol}>
            <span>
              <button className="link" onClick={() => onPick(m)}>{m.name}</button>
              <span className="muted small"> {m.sector}</span> <Marks r={m} />
            </span>
            <span className="nowrap">{price(m.price)} <strong className={tone(m.changePct)}>{pct(m.changePct)}</strong></span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{empty}</p>
    );
  return (
    <div className="grid3 mk-movers">
      <section className="card">
        <h3>Top gainers <span className="muted">({when})</span></h3>
        <List items={movers.gainers} empty="None of the popular stocks is up." />
      </section>
      <section className="card">
        <h3>Top losers <span className="muted">({when})</span></h3>
        <List items={movers.losers} empty="None of the popular stocks is down." />
      </section>
    </div>
  );
}

export default function Markets() {
  const [period, setPeriod] = useState('1d');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({ key: null, focus: null });

  useEffect(() => {
    const load = () =>
      api.markets().then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const ranked = useMemo(
    () => [...(data?.sectors ?? [])].sort((a, b) => (b.changes[period] ?? -Infinity) - (a.changes[period] ?? -Infinity)),
    [data, period],
  );

  if (!data) {
    return error ? <div className="error" role="alert">{error}</div> : <p className="muted">Loading market data…</p>;
  }

  const live = data.session === data.today;
  // What "1d" means right now: today while the market has traded today, else the last session's move.
  const label = (p) => (p === '1d' ? (live ? 'Today' : 'Last session') : PERIODS[p]);
  const when = live ? 'today' : `on ${sessionDay(data.session)}`;
  const periodWords = period === '1d' ? when : `over ${PERIODS[period]}`;
  const openRow = data.sectors.find((s) => s.key === open.key);
  const openSector = (key, focus = null) => {
    setOpen({ key, focus });
    requestAnimationFrame(() => document.getElementById('mk-sector-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <div className="period-bar">
        <span>Compare</span>
        <div className="seg">
          {Object.keys(PERIODS).map((p) => (
            <button key={p} className={period === p ? 'on' : ''} aria-pressed={period === p} onClick={() => setPeriod(p)}>{label(p)}</button>
          ))}
        </div>
        <span className="small">Prices updated {timeAgo(data.asOf)}{!live && ` · market closed, last session ${sessionDay(data.session)}`}</span>
      </div>
      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <h2>Market {periodWords}</h2>
        <div className="mk-indices">
          {data.indices.map((i) => (
            <div key={i.symbol} className="mk-index">
              <div className="muted small">{i.name}</div>
              <div className="mk-index-row">
                <strong>{level(i.price)}</strong>
                <span className={tone(i.changes[period])}>{pct(i.changes[period])}</span>
              </div>
              <Spark points={windowOf(i, period)} width={140} height={30} neutral={period === '1d'} />
            </div>
          ))}
        </div>
        <Breadth b={data.breadth} when={when} />
      </section>

      <section className="card">
        <h2>Sectors <span className="muted">{periodWords}</span></h2>
        <SectorSummary ranked={ranked} period={period} label={periodWords} />
        <div className="mk-sectors">
          {ranked.map((s) => {
            const change = s.changes[period];
            const b = s.breadth;
            return (
              <button
                key={s.key}
                className={`mk-tile${open.key === s.key ? ' on' : ''}`}
                style={tint(change, period)}
                aria-pressed={open.key === s.key}
                onClick={() => (open.key === s.key ? setOpen({ key: null, focus: null }) : openSector(s.key))}
              >
                <span className="mk-tile-name">
                  {s.name}
                  {s.basis === 'stocks' && period !== '1d' && <span className="muted" title="Average of its popular stocks: Yahoo doesn't publish this index's history"> ≈</span>}
                </span>
                <span className={`mk-tile-pct ${tone(change)}`}>{pct(change)}</span>
                <Spark points={windowOf(s, period)} width={120} height={26} neutral={period === '1d'} />
                <span className="muted small">{b.up} of {b.up + b.down + b.flat} up {live ? 'today' : 'last session'}</span>
              </button>
            );
          })}
        </div>
        <p className="muted small">
          Best to worst. Darker green or red means a bigger move. Click a sector to see its popular stocks.
          {period === '1d' && ' Lines show the past week, ending with today.'}
        </p>
      </section>

      {openRow && (
        <SectorDetail key={openRow.key} row={openRow} period={period} periodLabel={label(period)} focus={open.focus} onClose={() => setOpen({ key: null, focus: null })} />
      )}

      <Movers
        movers={data.movers}
        when={when}
        onPick={(m) => {
          const sec = data.sectors.find((s) => s.name === m.sector);
          if (sec) openSector(sec.key, m.symbol);
        }}
      />

      <p className="muted small mk-foot">
        Popular stocks are six large, well-known members of each Nifty sector index, picked by Stock Beat. They are not recommendations.
        Prices come from Yahoo Finance and are usually about 15 minutes behind. ≈ marks sectors whose index history Yahoo doesn't publish:
        their week and month figures and lines are the average of the popular stocks shown.
      </p>
    </>
  );
}
