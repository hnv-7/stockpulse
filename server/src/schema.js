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
