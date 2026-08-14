// SQLite data layer. Kept behind this single module so you can swap to
// Postgres/MySQL later by re-implementing `db` with the same query surface.
// The schema below is standard SQL and ports with minimal changes.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, '..', 'data.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');   // better concurrency for a web workload
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active', -- active | flagged | banned
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_ip       TEXT
    );

    -- Append-only ledger. Balance = SUM(points) for a user. Never UPDATE/DELETE.
    -- Each ad credit references its ad_event so a view can only ever pay once.
    CREATE TABLE IF NOT EXISTS points_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      points      INTEGER NOT NULL,               -- + earn, - redeem
      reason      TEXT NOT NULL,                  -- ad_reward | redemption | adjustment
      ref_type    TEXT,                           -- ad_event | payout
      ref_id      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id);

    -- One row per verified rewarded-ad view. transaction_id is the network's
    -- unique id; the UNIQUE constraint is our replay/double-credit guard.
    CREATE TABLE IF NOT EXISTS ad_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE NOT NULL,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      network        TEXT NOT NULL,
      verified       INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      revenue_cents  REAL NOT NULL DEFAULT 0,
      ip             TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adevents_user_day
      ON ad_events(user_id, created_at);

    -- Short-lived tokens issued when a user starts an ad, echoed back by the
    -- network in the SSV callback as custom_data. Ties a view to a real session.
    CREATE TABLE IF NOT EXISTS ad_sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      ip         TEXT,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      points      INTEGER NOT NULL,
      value_cents INTEGER NOT NULL,
      method      TEXT NOT NULL,                  -- airtime | data | cash
      destination TEXT NOT NULL,                  -- phone number / account
      status      TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected | paid
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

    CREATE TABLE IF NOT EXISTS otp_codes (
      phone      TEXT PRIMARY KEY,
      code       TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );
  `);
}
