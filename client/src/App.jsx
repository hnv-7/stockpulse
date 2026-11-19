import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setCsrfToken, setScope } from './api.js';
import { timeAgo } from './format.js';
import { readPref, writePref } from './prefs.js';
import Dashboard from './components/Dashboard.jsx';
import Markets from './components/Markets.jsx';
import Holdings from './components/Holdings.jsx';
import Watchlist from './components/Watchlist.jsx';
import CapitalGains from './components/CapitalGains.jsx';
import Alerts from './components/Alerts.jsx';
import Account from './components/Account.jsx';
import Login from './components/Login.jsx';
import Brand from './components/Brand.jsx';

const sessionDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

const TABS = [
  ['dashboard', 'Dashboard'],
  ['markets', 'Markets'],
  ['holdings', 'My Stocks'],
  ['watchlist', 'Watchlist'],
  ['gains', 'Capital gains'],
  ['alerts', 'Alerts'],
  ['account', 'Account'],
];
const TAB_IDS = new Set(TABS.map(([id]) => id));
/** How often the open dashboard reloads its figures (paused while the tab is hidden). */
const AUTO_REFRESH_MS = 5 * 60 * 1000;

/** The tab named in the address (#/holdings), so reloading, bookmarks and the Back button work. */
const tabFromHash = () => {
  const id = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return TAB_IDS.has(id) ? id : 'dashboard';
};

function useHashTab() {
  const [tab, setTabState] = useState(tabFromHash);
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = useCallback((id) => {
    if (`#/${id}` !== window.location.hash) window.location.hash = `/${id}`;
    setTabState(id);
  }, []);
  return [tab, setTab];
}

function PortfolioPicker({ portfolios, scope, onChange }) {
  if (portfolios.length < 2) return null;
  return (
    <label className="picker">
      <span className="sr-only">Portfolio</span>
      <select value={scope} onChange={(e) => onChange(e.target.value)}>
        <option value="all">All portfolios</option>
        {portfolios.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
      </select>
    </label>
  );
}

function Portfolio({ me, setMe, onSignedOut }) {
  const [tab, setTab] = useHashTab();
  const [period, setPeriod] = useState('1w');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [portfolios, setPortfolios] = useState([]);
  const [scope, setScopeState] = useState(() => readPref('portfolio', 'all'));
  const lastLoad = useRef(0);

  // The API reads the chosen portfolio from here, before any component below asks for data.
  setScope(scope);

  const handle = useCallback(
    (e) => {
      if (e.status === 401) onSignedOut();
      else setError(e.message);
    },
    [onSignedOut],
  );

  const loadPortfolios = useCallback(async () => {
    try {
      const list = await api.portfolios();
      setPortfolios(list);
      // A remembered portfolio that no longer exists falls back to all of them.
      if (scope !== 'all' && !list.some((p) => String(p.id) === scope)) {
        writePref('portfolio', null);
        setScopeState('all');
      }
    } catch (e) {
      handle(e);
    }
  }, [scope, handle]);
  useEffect(() => { loadPortfolios(); }, [loadPortfolios]);

  const chooseScope = (s) => {
    writePref('portfolio', s === 'all' ? null : s);
    setScopeState(s);
    setReport(null);
  };

  const load = useCallback(async () => {
    lastLoad.current = Date.now(); // as it starts, so a page turning visible meanwhile doesn't load again
    try {
      const [r, n] = await Promise.all([api.report(period), api.notifications()]);
      setReport(r);
      setUnread(n.unread);
      setError('');
    } catch (e) {
      handle(e);
    }
  }, [period, handle, scope]); // scope: it changes what the API returns

  // Reload every few minutes while the page is visible; a page coming back after a while reloads at once.
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastLoad.current > AUTO_REFRESH_MS) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.refresh();
      await load();
      if (r?.throttled) setError('Prices were refreshed a moment ago. Please wait a few minutes before refreshing again.');
    } catch (e) {
      handle(e);
    } finally {
      setRefreshing(false);
    }
  };

  const changed = () => { load(); loadPortfolios(); };

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <Brand />
        <nav aria-label="Main">
          {TABS.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={tab === id ? 'tab active' : 'tab'} aria-current={tab === id ? 'page' : undefined}>
              {label}
              {id === 'alerts' && unread > 0 && <span className="badge">{unread}<span className="sr-only"> unread</span></span>}
            </a>
          ))}
        </nav>
        <div className="asof">
          <PortfolioPicker portfolios={portfolios} scope={scope} onChange={chooseScope} />
          {report?.market?.closedToday && report.market.lastSession && (
            <span className="market-closed" title="Prices are from the last trading session">
              Market closed{report.market.holiday ? ' today' : ''} · last session {sessionDay(report.market.lastSession)}
            </span>
          )}
          <span>Updated {timeAgo(report?.asOf)}</span>
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {/* Keyed by portfolio, so switching it reloads every view. */}
      <main id="main" tabIndex={-1} key={scope}>
        {tab === 'dashboard' && (
          <Dashboard report={report} period={period} setPeriod={setPeriod} goToStocks={() => setTab('holdings')} />
        )}
        {tab === 'markets' && <Markets />}
        {tab === 'holdings' && <Holdings onChange={changed} portfolios={portfolios} scope={scope} />}
        {tab === 'watchlist' && <Watchlist onChange={load} />}
        {tab === 'gains' && <CapitalGains />}
        {tab === 'alerts' && <Alerts onRead={load} />}
        {tab === 'account' && (
          <Account
            me={me}
            onUserChange={(user) => setMe({ ...me, user })}
            onSignedOut={onSignedOut}
            portfolios={portfolios}
            onPortfoliosChange={changed}
          />
        )}
      </main>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, otherwise the /api/me response
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setCsrfToken(m.csrfToken);
        setMe(m);
      })
      .catch(() => setLoadError('Could not reach the server. Please reload the page.'));
  }, []);

  const signedOut = useCallback(() => {
    setCsrfToken('');
    window.history.replaceState(null, '', '/');
    setMe((m) => ({ ...m, user: null }));
  }, []);

  if (loadError) return <div className="app"><div className="error" role="alert">{loadError}</div></div>;
  if (me === undefined) return <div className="app"><p className="muted">Loading…</p></div>;
  if (!me.user) return <Login authConfigured={me.authConfigured} />;
  return <Portfolio me={me} setMe={setMe} onSignedOut={signedOut} />;
}
