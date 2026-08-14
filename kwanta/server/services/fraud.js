import { db } from '../db.js';
import { config } from '../config.js';

// How many verified ad views this user already earned today (UTC day).
export function adsToday(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ad_events
        WHERE user_id = ? AND verified = 1
          AND date(created_at) = date('now')`
    )
    .get(userId);
  return row.n;
}

// Returns { ok } or { ok:false, reason } — checked before crediting a view.
export function checkAdEligibility(user) {
  if (user.status === 'banned') return { ok: false, reason: 'Account suspended.' };
  if (user.status === 'flagged') return { ok: false, reason: 'Account under review.' };
  if (adsToday(user.id) >= config.maxAdsPerDay)
    return { ok: false, reason: 'Daily reward limit reached. Come back tomorrow.' };
  return { ok: true };
}

// Velocity check: too many views from one IP across accounts is a click-farm tell.
export function ipVelocityHigh(ip, withinMinutes = 10, threshold = 40) {
  if (!ip) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ad_events
        WHERE ip = ? AND created_at >= datetime('now', ?)`
    )
    .get(ip, `-${withinMinutes} minutes`);
  return row.n >= threshold;
}

// Distinct accounts crediting views from one IP recently (multi-accounting).
export function distinctAccountsForIp(ip, withinHours = 24) {
  if (!ip) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM ad_events
        WHERE ip = ? AND created_at >= datetime('now', ?)`
    )
    .get(ip, `-${withinHours} hours`);
  return row.n;
}
