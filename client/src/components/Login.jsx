const MESSAGES = {
  expired: 'Your sign-in attempt expired. Please try again.',
  unverified: 'Your Google email address is not verified, so it cannot be used to sign in.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again later.',
  failed: 'Sign-in failed. Please try again.',
};

export default function Login({ authConfigured }) {
  const code = new URLSearchParams(window.location.search).get('login_error');
  const message = code ? MESSAGES[code] || MESSAGES.failed : '';

  return (
    <div className="app">
      <div className="card login">
        <div className="brand">StockPulse</div>
        <p>
          Track your own portfolio, see which stocks are dragging it down even when every holding is in profit,
          spot buy-the-dip candidates, and get an alert when a stock falls by a percentage you choose.
        </p>
        {message && <div className="error" role="alert">{message}</div>}
        {authConfigured ? (
          <a className="button primary" href="/api/auth/login">Sign in with Google</a>
        ) : (
          <div className="error" role="alert">Sign-in is not configured on this server yet.</div>
        )}
        <p className="muted small">
          Prices come from Yahoo Finance and can be delayed by about 15 minutes. This is not investment advice.
        </p>
      </div>
    </div>
  );
}
