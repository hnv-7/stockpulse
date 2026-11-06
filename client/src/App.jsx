import { useCallback, useEffect, useState } from 'react';
import { api, setCsrfToken } from './api.js';
import { timeAgo } from './format.js';
import Dashboard from './components/Dashboard.jsx';
import Holdings from './components/Holdings.jsx';
import Alerts from './components/Alerts.jsx';
import Account from './components/Account.jsx';
import Login from './components/Login.jsx';
import Brand from './components/Brand.jsx';

const TABS = [
  ['dashboard', 'Dashboard'],
  ['holdings', 'My Stocks'],
  ['alerts', 'Alerts'],
  ['account', 'Account'],
];

function Portfolio({ me, setMe, onSignedOut }) {
  const [tab, setTab] = useState('dashboard');
  const [period, setPeriod] = useState('1w');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handle = useCallback(
    (e) => {
      if (e.status === 401) onSignedOut();
      else setError(e.message);
    },
    [onSignedOut],
  );

  const load = useCallback(async () => {
    try {
      const [r, n] = await Promise.all([api.report(period), api.notifications()]);
      setReport(r);
      setUnread(n.unread);
      setError('');
    } catch (e) {
      handle(e);
    }
  }, [period, handle]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
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

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <nav>
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
              {label}
              {id === 'alerts' && unread > 0 && <span className="badge">{unread}</span>}
            </button>
          ))}
        </nav>
        <div className="asof">
          <span>Updated {timeAgo(report?.asOf)}</span>
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      <main>
        {tab === 'dashboard' && (
          <Dashboard report={report} period={period} setPeriod={setPeriod} goToStocks={() => setTab('holdings')} />
        )}
        {tab === 'holdings' && <Holdings onChange={load} />}
        {tab === 'alerts' && <Alerts onRead={load} />}
        {tab === 'account' && (
          <Account
            me={me}
            onUserChange={(user) => setMe({ ...me, user })}
            onSignedOut={onSignedOut}
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
