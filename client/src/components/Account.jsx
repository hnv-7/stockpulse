import { useState } from 'react';
import { api } from '../api.js';

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
          Also email me drop alerts at this address
        </label>
      ) : (
        <p className="muted small">Email alerts are not enabled on this server. Alerts still appear in the app.</p>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <div className="row">
        <button onClick={signOut} disabled={busy}>Sign out</button>
        <button className="danger" onClick={deleteAccount} disabled={busy}>Delete my account and data</button>
      </div>
    </section>
  );
}
