import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { addEntry } from './ledger.js';

// ─────────────────────────────────────────────────────────────────────────
// Ad sessions: issued when the client starts an ad. The token is passed to the
// ad SDK as custom_data / user identifier, and comes back in the SSV callback.
// This ties a paid view to a real, single-use session for a known user.
// ─────────────────────────────────────────────────────────────────────────
export function issueAdSession(userId, ip) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    'INSERT INTO ad_sessions (token, user_id, ip) VALUES (?, ?, ?)'
  ).run(token, userId, ip);
  return token;
}

function consumeAdSession(token) {
  const row = db.prepare('SELECT * FROM ad_sessions WHERE token = ?').get(token);
  if (!row || row.used) return null;
  // Expire sessions after 15 minutes.
  const age = db
    .prepare("SELECT (julianday('now') - julianday(?)) * 24 * 60 AS mins")
    .get(row.created_at).mins;
  if (age > 15) return null;
  db.prepare('UPDATE ad_sessions SET used = 1 WHERE token = ?').run(token);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Verification path A — HMAC shared secret.
// For mediation/networks that sign callbacks with a secret you configure, or
// for your own test harness. Signs the sorted key=value pairs (excluding the
// signature field) with HMAC-SHA256.
// ─────────────────────────────────────────────────────────────────────────
export function verifyHmacSignature(params, provided) {
  const base = Object.keys(params)
    .filter((k) => k !== 'signature' && k !== 'key_id')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const expected = crypto
    .createHmac('sha256', config.adSsvHmacSecret)
    .update(base)
    .digest('hex');
  if (!provided || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

// ─────────────────────────────────────────────────────────────────────────
// Verification path B — Google AdMob Server-Side Verification (SSV).
// AdMob signs the callback with ECDSA. The content to verify is the raw query
// string up to (but excluding) `&signature=`. Keys are published by Google.
// Docs: developers.google.com/admob/android/rewarded-video-ssv
// ─────────────────────────────────────────────────────────────────────────
const ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
let keyCache = { at: 0, keys: null };

async function getAdmobKeys() {
  // Cache for 24h; Google rotates keys infrequently.
  if (keyCache.keys && Date.now() - keyCache.at < 24 * 3600 * 1000) return keyCache.keys;
  const res = await fetch(ADMOB_KEYS_URL);
  if (!res.ok) throw new Error(`AdMob key fetch failed: ${res.status}`);
  const json = await res.json();
  const map = {};
  for (const k of json.keys) map[String(k.keyId)] = k.pem;
  keyCache = { at: Date.now(), keys: map };
  return map;
}

export async function verifyAdmobSsv(rawQuery) {
  const sigMarker = '&signature=';
  const idx = rawQuery.indexOf(sigMarker);
  if (idx === -1) return false;
  const content = rawQuery.slice(0, idx);
  const tail = new URLSearchParams(rawQuery.slice(idx + 1));
  const signature = tail.get('signature');
  const keyId = tail.get('key_id');
  if (!signature || !keyId) return false;

  const keys = await getAdmobKeys();
  const pem = keys[keyId];
  if (!pem) return false;

  const verifier = crypto.createVerify('sha256');
  verifier.update(content);
  verifier.end();
  // AdMob signatures are base64url-encoded DER ECDSA signatures.
  const sig = Buffer.from(signature, 'base64url');
  return verifier.verify({ key: pem, dsaEncoding: 'der' }, sig);
}

// ─────────────────────────────────────────────────────────────────────────
// Credit a verified view. Atomic + idempotent: the UNIQUE transaction_id and
// the used-session guard mean a view can never pay twice, and only a real
// session for a real user can pay at all.
// Returns { credited:true, points } or { credited:false, reason }.
// ─────────────────────────────────────────────────────────────────────────
export const creditAdView = db.transaction(
  ({ transactionId, sessionToken, network, ip }) => {
    // Replay guard.
    const existing = db
      .prepare('SELECT id FROM ad_events WHERE transaction_id = ?')
      .get(transactionId);
    if (existing) return { credited: false, reason: 'already_processed' };

    const session = consumeAdSession(sessionToken);
    if (!session) return { credited: false, reason: 'invalid_or_expired_session' };

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user || user.status === 'banned')
      return { credited: false, reason: 'user_ineligible' };

    // Daily cap enforced here too (defence in depth alongside the API check).
    const todays = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ad_events
          WHERE user_id = ? AND verified = 1 AND date(created_at) = date('now')`
      )
      .get(user.id).n;
    if (todays >= config.maxAdsPerDay)
      return { credited: false, reason: 'daily_cap_reached' };

    const points = config.pointsPerAd;
    db.prepare(
      `INSERT INTO ad_events
         (transaction_id, user_id, network, verified, points_awarded, revenue_cents, ip)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    ).run(transactionId, user.id, network, points, config.revenuePerAdCents, ip);

    addEntry({
      userId: user.id,
      points,
      reason: 'ad_reward',
      refType: 'ad_event',
      refId: transactionId,
    });

    return { credited: true, points, userId: user.id };
  }
);
