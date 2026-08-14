// Postgres data layer (works with Supabase, Render Postgres, or any Postgres
// instance — set DATABASE_URL). Provides a small SQLite-shaped async API
// (db.get/all/run + a transaction helper) so the rest of the app reads close
// to plain SQL without a full ORM.

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { Pool } = pg;

// Minimal .env loader, duplicated from config.js so db.js works standalone
// (e.g. from initDb.js, which doesn't import config.js).
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Thrown, not console.error + process.exit — a manual process.exit() right
  // after console.error can race the stdio flush on some hosts (Render
  // included) and lose the message, showing only a silent "Application
  // exited early" with no clue why. Throwing lets Node's own
  // uncaught-exception handler print it reliably.
  throw new Error('FATAL: DATABASE_URL is not set. Point it at your Postgres/Supabase instance.');
}

export const pool = new Pool({
  connectionString,
  // Supabase (and most managed Postgres) terminate TLS with a cert chain
  // that Node won't have locally — this is the standard safe-enough setting
  // for that case. Swap for a pinned CA bundle if your provider requires it.
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Converts SQLite-style `?` placeholders (in call order) to Postgres `$1, $2…`.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeRunner(exec) {
  return {
    async get(sql, params = []) {
      const { rows } = await exec(toPg(sql), params);
      return rows[0];
    },
    async all(sql, params = []) {
      const { rows } = await exec(toPg(sql), params);
      return rows;
    },
    async run(sql, params = []) {
      const res = await exec(toPg(sql), params);
      return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
    },
  };
}

export const db = makeRunner((text, params) => pool.query(text, params));

// Runs `fn(txDb)` inside a BEGIN/COMMIT/ROLLBACK block on a dedicated client.
// Replaces better-sqlite3's synchronous db.transaction() — callers now await
// the whole thing instead of calling it like a function.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txDb = makeRunner((text, params) => client.query(text, params));
    const result = await fn(txDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active', -- active | flagged | banned
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ip       TEXT
    );

    -- Append-only ledger. Balance = SUM(points) for a user. Never UPDATE/DELETE.
    -- Each ad credit references its ad_event so a view can only ever pay once.
    CREATE TABLE IF NOT EXISTS points_ledger (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      points      INTEGER NOT NULL,               -- + earn, - redeem
      reason      TEXT NOT NULL,                  -- ad_reward | redemption | adjustment
      ref_type    TEXT,                           -- ad_event | payout
      ref_id      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id);

    -- One row per verified rewarded-ad view. transaction_id is the network's
    -- unique id; the UNIQUE constraint is our replay/double-credit guard.
    CREATE TABLE IF NOT EXISTS ad_events (
      id             SERIAL PRIMARY KEY,
      transaction_id TEXT UNIQUE NOT NULL,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      network        TEXT NOT NULL,
      verified       INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      revenue_cents  REAL NOT NULL DEFAULT 0,
      ip             TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      points      INTEGER NOT NULL,
      value_cents INTEGER NOT NULL,
      method      TEXT NOT NULL,                  -- airtime | data | cash
      destination TEXT NOT NULL,                  -- phone number / account
      status      TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected | paid
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

    CREATE TABLE IF NOT EXISTS otp_codes (
      phone      TEXT PRIMARY KEY,
      code       TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );
  `);
}