import { db } from '../db.js';
import { config } from '../config.js';

// How many verified ad views this user already earned today (UTC day).
export async function adsToday(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM ad_events
      WHERE user_id = ? AND verified = 1
        AND created_at::date = CURRENT_DATE`,
    [userId]
  );
  return Number(row.n);
}

// Returns { ok } or { ok:false, reason } — checked before crediting a view.
export async function checkAdEligibility(user) {
  if (user.status === 'banned') return { ok: false, reason: 'Account suspended.' };
  if (user.status === 'flagged') return { ok: false, reason: 'Account under review.' };
  if ((await adsToday(user.id)) >= config.maxAdsPerDay)
    return { ok: false, reason: 'Daily reward limit reached. Come back tomorrow.' };
  return { ok: true };
}

// Velocity check: too many views from one IP across accounts is a click-farm tell.
export async function ipVelocityHigh(ip, withinMinutes = 10, threshold = 40) {
  if (!ip) return false;
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM ad_events
      WHERE ip = ? AND created_at >= NOW() - (? || ' minutes')::interval`,
    [ip, withinMinutes]
  );
  return Number(row.n) >= threshold;
}

// Distinct accounts crediting views from one IP recently (multi-accounting).
export async function distinctAccountsForIp(ip, withinHours = 24) {
  if (!ip) return 0;
  const row = await db.get(
    `SELECT COUNT(DISTINCT user_id) AS n FROM ad_events
      WHERE ip = ? AND created_at >= NOW() - (? || ' hours')::interval`,
    [ip, withinHours]
  );
  return Number(row.n);
}