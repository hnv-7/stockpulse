/**
 * Postgres schema. Idempotent so it can run on every cold start.
 * Shared market data (prices, snapshots) has no user_id; everything a user owns does.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT,
  alert_email BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS holdings (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL,
  quantity   DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  invested   DOUBLE PRECISION NOT NULL CHECK (invested > 0),
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings (symbol);
-- Optional: when the user bought the stock. Added later, so it is an idempotent ALTER.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS purchase_date DATE;

-- Each purchase of a stock is a lot with its own date. holdings.quantity / invested / purchase_date are the
-- totals (and earliest date) of its lots, kept in step by the store.
CREATE TABLE IF NOT EXISTS holding_lots (
  id            BIGSERIAL PRIMARY KEY,
  holding_id    BIGINT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity      DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  invested      DOUBLE PRECISION NOT NULL CHECK (invested > 0),
  purchase_date DATE,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lots_holding ON holding_lots (holding_id);
-- Holdings that predate lots become a single lot.
INSERT INTO holding_lots (holding_id, user_id, quantity, invested, purchase_date, created_at)
  SELECT h.id, h.user_id, h.quantity, h.invested, h.purchase_date, h.created_at FROM holdings h
  WHERE NOT EXISTS (SELECT 1 FROM holding_lots l WHERE l.holding_id = h.id);

-- A sale of (part of) a stock. Kept after the shares are gone, so it has no foreign key to holdings: a fully sold
-- stock leaves the holdings table but its sales stay. cost_basis is what the sold shares cost (oldest purchases first).
CREATE TABLE IF NOT EXISTS sales (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL,
  quantity   DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  sale_price DOUBLE PRECISION NOT NULL CHECK (sale_price > 0),
  charges    DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (charges >= 0),
  cost_basis DOUBLE PRECISION NOT NULL CHECK (cost_basis >= 0),
  sale_date  DATE NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales (user_id, sale_date DESC, id DESC);

-- Which purchases a sale used up (and what they cost), so removing or editing the sale can give them back exactly.
CREATE TABLE IF NOT EXISTS sale_lots (
  id            BIGSERIAL PRIMARY KEY,
  sale_id       BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  quantity      DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  invested      DOUBLE PRECISION NOT NULL CHECK (invested >= 0),
  purchase_date DATE
);
CREATE INDEX IF NOT EXISTS idx_sale_lots_sale ON sale_lots (sale_id);

-- Stocks a user follows without (necessarily) holding them. added_price is the price when they were added, so the
-- list can show the move since; it is restated, like everything else in old shares, when a split is confirmed.
CREATE TABLE IF NOT EXISTS watchlist (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  name        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  added_price DOUBLE PRECISION CHECK (added_price > 0),
  created_at  BIGINT NOT NULL,
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist (symbol);

CREATE TABLE IF NOT EXISTS daily_prices (
  symbol TEXT NOT NULL,
  date   DATE NOT NULL,
  close  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS snapshots (
  symbol TEXT NOT NULL,
  ts     BIGINT NOT NULL,
  price  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        TEXT,
  win           TEXT NOT NULL CHECK (win IN ('1d','1w','1m','high52')),
  threshold_pct DOUBLE PRECISION NOT NULL CHECK (threshold_pct > 0 AND threshold_pct < 100),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_rules_user ON alert_rules (user_id);

-- Price-target rules: "tell me when SYMBOL goes above/below a price". Drop rules keep win + threshold_pct.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'drop';
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS target_price DOUBLE PRECISION;
ALTER TABLE alert_rules ALTER COLUMN win DROP NOT NULL;
ALTER TABLE alert_rules ALTER COLUMN threshold_pct DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_kind_shape') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_shape CHECK (
      (kind = 'drop' AND win IS NOT NULL AND threshold_pct IS NOT NULL AND target_price IS NULL AND direction IS NULL)
      OR
      (kind = 'price' AND symbol IS NOT NULL AND target_price > 0 AND direction IN ('above','below')
        AND win IS NULL AND threshold_pct IS NULL)
    );
  END IF;
END $$;

-- When a price rule was made, so a split only rescales targets set before it. Older rules have NULL (= before).
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS created_at BIGINT;

-- Splits and bonus issues (shared market data) as Yahoo reports them: every "denominator" shares became "numerator".
-- Yahoo stores bonus issues as splits and sometimes gets combined actions wrong, so price_ratio keeps what the price
-- itself moved by (last price before the ex-date / Yahoo's adjusted close for that day) when it is known.
CREATE TABLE IF NOT EXISTS stock_splits (
  symbol      TEXT NOT NULL,
  ex_date     DATE NOT NULL,
  numerator   DOUBLE PRECISION NOT NULL CHECK (numerator > 0),
  denominator DOUBLE PRECISION NOT NULL CHECK (denominator > 0),
  price_ratio DOUBLE PRECISION,
  found_at    BIGINT NOT NULL,
  PRIMARY KEY (symbol, ex_date)
);
-- The IST date each symbol was last checked for splits.
CREATE TABLE IF NOT EXISTS split_checks (
  symbol     TEXT PRIMARY KEY,
  checked_on DATE NOT NULL
);
-- A split that may change a user's shares. Nothing of theirs changes until they confirm it (with a ratio they can
-- correct) or dismiss it.
CREATE TABLE IF NOT EXISTS split_reviews (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  ex_date     DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  numerator   DOUBLE PRECISION,
  denominator DOUBLE PRECISION,
  created_at  BIGINT NOT NULL,
  resolved_at BIGINT,
  UNIQUE (user_id, symbol, ex_date)
);
CREATE INDEX IF NOT EXISTS idx_split_reviews_user ON split_reviews (user_id, status);
-- How many of today's shares each share in a sale has become through splits confirmed since (1 = none).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS split_factor DOUBLE PRECISION NOT NULL DEFAULT 1;

-- Company details from Yahoo (shared): sector and industry, refreshed every few months. A NULL sector means Yahoo had
-- none; fetched_at says when that was found, so it isn't asked again every time.
CREATE TABLE IF NOT EXISTS stock_info (
  symbol     TEXT PRIMARY KEY,
  sector     TEXT,
  industry   TEXT,
  fetched_at BIGINT NOT NULL
);

-- Dividends per share by ex-date (shared), in today's shares as Yahoo reports them.
CREATE TABLE IF NOT EXISTS dividends (
  symbol  TEXT NOT NULL,
  ex_date DATE NOT NULL,
  amount  DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  PRIMARY KEY (symbol, ex_date)
);
-- How far back each symbol's dividends have been fetched.
CREATE TABLE IF NOT EXISTS dividend_checks (
  symbol     TEXT PRIMARY KEY,
  from_date  DATE NOT NULL,
  checked_at BIGINT NOT NULL
);

-- Telegram: the chat a user's alerts go to, and a short-lived code that links it (sent as /start <code>).
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_code ON users (telegram_link_code) WHERE telegram_link_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id      BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts      BIGINT NOT NULL,
  rule_id BIGINT,
  symbol  TEXT,
  message TEXT NOT NULL,
  read    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_rule ON notifications (rule_id, symbol, ts);
-- Cleared by the user: hidden from the list, but kept (until pruned) so alert cooldowns and the weekly summary's
-- count of alerts still see them. Deleting the row would let the same alert fire again on the next refresh.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS cleared BOOLEAN NOT NULL DEFAULT FALSE;

-- Portfolios: a user can keep several (their own, a family member's, one per broker). Every holding and sale belongs
-- to one. Users from before portfolios get one called "Main" holding everything they had.
CREATE TABLE IF NOT EXISTS portfolios (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, name)
);
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS portfolio_id BIGINT REFERENCES portfolios(id) ON DELETE CASCADE;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS portfolio_id BIGINT REFERENCES portfolios(id) ON DELETE CASCADE;
INSERT INTO portfolios (user_id, name, created_at)
  SELECT u.id, 'Main', u.created_at FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = u.id)
     AND (EXISTS (SELECT 1 FROM holdings h WHERE h.user_id = u.id AND h.portfolio_id IS NULL)
       OR EXISTS (SELECT 1 FROM sales s WHERE s.user_id = u.id AND s.portfolio_id IS NULL));
UPDATE holdings h SET portfolio_id = (SELECT MIN(p.id) FROM portfolios p WHERE p.user_id = h.user_id) WHERE h.portfolio_id IS NULL;
UPDATE sales s SET portfolio_id = (SELECT MIN(p.id) FROM portfolios p WHERE p.user_id = s.user_id) WHERE s.portfolio_id IS NULL;
ALTER TABLE holdings ALTER COLUMN portfolio_id SET NOT NULL;
-- A stock appears once per portfolio (it used to be once per user).
ALTER TABLE holdings DROP CONSTRAINT IF EXISTS holdings_user_id_symbol_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_holdings_portfolio_symbol ON holdings (portfolio_id, symbol);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings (user_id);
CREATE INDEX IF NOT EXISTS idx_sales_portfolio ON sales (portfolio_id);

-- Target share of the portfolio per sector. scope is a portfolio id, or 0 for all of the user's portfolios together.
CREATE TABLE IF NOT EXISTS allocation_targets (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      BIGINT NOT NULL DEFAULT 0,
  sector     TEXT NOT NULL,
  target_pct DOUBLE PRECISION NOT NULL CHECK (target_pct > 0 AND target_pct <= 100),
  PRIMARY KEY (user_id, scope, sector)
);

-- The weekly summary (opt-in), and the IST date it was last sent so a repeated cron call doesn't send it twice.
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_digest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_sent_on DATE;

-- What kind of instrument a symbol is: 'stock', 'etf' or 'mf' (mutual fund). NULL until looked up.
ALTER TABLE stock_info ADD COLUMN IF NOT EXISTS kind TEXT;

-- Upcoming results and ex-dividend dates (shared), as Yahoo publishes them; refreshed every few days.
CREATE TABLE IF NOT EXISTS stock_events (
  symbol            TEXT PRIMARY KEY,
  earnings_date     DATE,
  earnings_estimate BOOLEAN NOT NULL DEFAULT FALSE,
  ex_dividend_date  DATE,
  fetched_at        BIGINT NOT NULL
);

-- Rate-limit counters shared by every server instance (serverless instances don't share memory). Keys are hashed.
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  hits     INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);
`;
