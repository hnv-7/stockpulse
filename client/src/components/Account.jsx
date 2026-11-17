import { useEffect, useState } from 'react';
import { api } from '../api.js';

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

export default function Account({ me, onUserChange, onSignedOut }) {
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

      {error && <div className="error" role="alert">{error}</div>}

      <div className="row">
        <button onClick={signOut} disabled={busy}>Sign out</button>
        <button className="danger" onClick={deleteAccount} disabled={busy}>Delete my account and data</button>
      </div>
    </section>
  );
}
