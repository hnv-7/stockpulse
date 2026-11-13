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
`;
