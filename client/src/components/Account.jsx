import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { applyTheme, readPref, writePref, THEMES } from '../prefs.js';

const THEME_LABEL = { system: 'Same as device', light: 'Light', dark: 'Dark' };

/** Light, dark, or the device's setting. Kept in this browser only. */
function Appearance() {
  const [theme, setTheme] = useState(() => readPref('theme', 'system'));
  const choose = (t) => {
    setTheme(t);
    writePref('theme', t === 'system' ? null : t);
    applyTheme(t);
  };
  return (
    <div className="telegram">
      <h3>Appearance</h3>
      <div className="seg" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t} type="button" className={theme === t ? 'on' : ''} aria-pressed={theme === t} onClick={() => choose(t)}>
            {THEME_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Add, rename and remove portfolios (e.g. one per family member or broker). */
function Portfolios({ portfolios, onChange }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null); // { id, name }
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn, ok) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ ok: true, text: ok });
      onChange();
    } catch (e) {
      setMessage({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const add = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    act(async () => { await api.addPortfolio(n); setName(''); }, `Portfolio "${n}" added. Choose it at the top of the page.`);
  };
  const rename = () => act(async () => { await api.renamePortfolio(editing.id, editing.name.trim()); setEditing(null); });
  const remove = (p) => {
    const what = p.holdings ? ` and its ${p.holdings} ${p.holdings === 1 ? 'stock' : 'stocks'} and their sales` : '';
    if (!window.confirm(`Remove the portfolio "${p.name}"${what}? This can't be undone.`)) return;
    act(() => api.removePortfolio(p.id), `Portfolio "${p.name}" removed.`);
  };

  return (
    <div className="telegram">
      <h3>Portfolios</h3>
      <p className="small">
        Keep separate portfolios, for example one for each family member or broker. Capital gains, dividends and charts can be shown for
        one portfolio or for all of them together, using the picker at the top of the page.
      </p>
      <ul className="rules">
        {portfolios.map((p) => (
          <li key={p.id} className="rule">
            {editing?.id === p.id ? (
              <>
                <input value={editing.name} maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Portfolio name" />
                <span className="split-actions">
                  <button onClick={rename} disabled={busy || !editing.name.trim()}>Save</button>
                  <button onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                </span>
              </>
            ) : (
              <>
                <span><strong>{p.name}</strong> <span className="muted small">{p.holdings} {p.holdings === 1 ? 'stock' : 'stocks'}</span></span>
                <span className="split-actions">
                  <button onClick={() => setEditing({ id: p.id, name: p.name })} disabled={busy}>Rename</button>
                  {portfolios.length > 1 && <button className="danger" onClick={() => remove(p)} disabled={busy}>Remove</button>}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={add}>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amma's demat" aria-label="New portfolio name" />
        <button disabled={busy || !name.trim()}>Add portfolio</button>
      </form>
      {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
    </div>
  );
}

/**
 * Telegram alerts: get a one-time link that opens the bot, then wait for Telegram to confirm (the page checks every few
 * seconds while the link is valid).
 */
function TelegramAlerts({ me, onUserChange }) {
  const [link, setLink] = useState(null); // { url, expiresAt } while waiting for the user to press Start
  const [message, setMessage] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);
  const connected = me.user.telegramConnected;

  useEffect(() => {
    if (!link || connected) return undefined;
    const timer = setInterval(async () => {
      if (Date.now() > link.expiresAt) {
        setLink(null);
        setMessage({ ok: false, text: 'That link expired. Connect again to get a new one.' });
        return;
      }
      const fresh = await api.me().catch(() => null);
      if (fresh?.user?.telegramConnected) {
        setLink(null);
        setMessage({ ok: true, text: 'Telegram connected. Your alerts will arrive there too.' });
        onUserChange(fresh.user);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [link, connected, onUserChange]);

  const act = async (fn) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const connect = () => act(async () => setLink(await api.telegramLink()));
  const test = () => act(async () => {
    await api.telegramTest();
    setMessage({ ok: true, text: 'Test message sent. Check Telegram.' });
  });
  const disconnect = () => act(async () => {
    await api.telegramDisconnect();
    onUserChange({ ...me.user, telegramConnected: false });
    setMessage({ ok: true, text: 'Telegram disconnected.' });
  });

  return (
    <div className="telegram">
      <h3>Telegram alerts</h3>
      {connected ? (
        <>
          <p className="small">Your alerts are also sent to Telegram. You can send /stop to the bot at any time.</p>
          <div className="split-actions">
            <button onClick={test} disabled={busy}>Send a test message</button>
            <button className="danger" onClick={disconnect} disabled={busy}>Disconnect Telegram</button>
          </div>
        </>
      ) : link ? (
        <>
          <p className="small">Open the bot and press <strong>Start</strong>. This page updates once Telegram confirms; the link works for 15 minutes.</p>
          <div className="split-actions">
            <a className="button primary" href={link.url} target="_blank" rel="noopener noreferrer">Open Telegram</a>
            <button onClick={() => setLink(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="small">Get your alerts as Telegram messages as well, on any phone or computer with Telegram.</p>
          <div className="split-actions">
            <button onClick={connect} disabled={busy}>Connect Telegram</button>
          </div>
        </>
      )}
      {message && <div className={message.ok ? 'notice' : 'error'} role="status">{message.text}</div>}
    </div>
  );
}

export default function Account({ me, onUserChange, onSignedOut, portfolios = [], onPortfoliosChange }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEmail = (checked) =>
    run(async () => onUserChange(await api.updateSettings({ alertEmail: checked })));
  const toggleDigest = (checked) =>
    run(async () => onUserChange(await api.updateSettings({ weeklyDigest: checked })));
  const channels = [me.user.alertEmail && 'email', me.user.telegramConnected && 'Telegram'].filter(Boolean);

  const signOut = () =>
    run(async () => {
      await api.logout();
      onSignedOut();
    });

  const deleteAccount = () => {
    const ok = window.confirm(
      'Delete your account? All your stocks, alerts and notifications will be permanently removed.',
    );
    if (!ok) return;
    run(async () => {
      await api.deleteAccount();
      onSignedOut();
    });
  };

  return (
    <section className="card form">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{me.user.email}</strong>
      </p>

      {me.emailAvailable ? (
        <label className="check">
          <input
            type="checkbox"
            checked={me.user.alertEmail}
            disabled={busy}
            onChange={(e) => toggleEmail(e.target.checked)}
          />
          Also email me alerts at this address
        </label>
      ) : (
        <p className="muted small">Email alerts are not enabled on this server. Alerts still appear in the app.</p>
      )}

      {me.telegramAvailable && <TelegramAlerts me={me} onUserChange={onUserChange} />}

      <div className="telegram">
        <h3>Weekly summary</h3>
        <label className="check">
          <input type="checkbox" checked={!!me.user.weeklyDigest} disabled={busy} onChange={(e) => toggleDigest(e.target.checked)} />
          Send me a summary every Friday after the market closes
        </label>
        <p className="muted small">
          How your portfolio did over the week against Nifty 50, your biggest movers, alerts that fired, and results or ex-dividend dates
          coming up in the next week. It appears under Alerts{channels.length ? ` and is sent by ${channels.join(' and ')}` : ''}.
        </p>
      </div>

      <Portfolios portfolios={portfolios} onChange={onPortfoliosChange ?? (() => {})} />
      <Appearance />

      {error && <div className="error" role="alert">{error}</div>}

      <div className="row">
        <button onClick={signOut} disabled={busy}>Sign out</button>
        <button className="danger" onClick={deleteAccount} disabled={busy}>Delete my account and data</button>
      </div>
    </section>
  );
}
