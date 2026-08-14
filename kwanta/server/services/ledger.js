import { db } from '../db.js';

// Balance is always derived from the ledger — never stored as a mutable field,
// so it can't drift or be tampered with independently of its entries.
export function getBalance(userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(points), 0) AS bal FROM points_ledger WHERE user_id = ?')
    .get(userId);
  return row.bal;
}

export function getLedger(userId, limit = 50) {
  return db
    .prepare(
      `SELECT points, reason, ref_type, ref_id, created_at
         FROM points_ledger WHERE user_id = ?
        ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit);
}

// Append a ledger entry. Callers that need atomicity with other writes should
// wrap this in a db.transaction (see adReward.creditAdView).
export function addEntry({ userId, points, reason, refType = null, refId = null }) {
  return db
    .prepare(
      `INSERT INTO points_ledger (user_id, points, reason, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, points, reason, refType, refId);
}
