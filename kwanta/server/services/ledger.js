import { db } from '../db.js';

// Balance is always derived from the ledger — never stored as a mutable field,
// so it can't drift or be tampered with independently of its entries.
export async function getBalance(userId, runner = db) {
  const row = await runner.get(
    'SELECT COALESCE(SUM(points), 0) AS bal FROM points_ledger WHERE user_id = ?',
    [userId]
  );
  return Number(row.bal);
}

export async function getLedger(userId, limit = 50) {
  return db.all(
    `SELECT points, reason, ref_type, ref_id, created_at
       FROM points_ledger WHERE user_id = ?
      ORDER BY id DESC LIMIT ?`,
    [userId, limit]
  );
}

// Append a ledger entry. Callers that need atomicity with other writes should
// pass a transaction runner (see adReward.creditAdView / payout.routes.js).
export async function addEntry({ userId, points, reason, refType = null, refId = null }, runner = db) {
  return runner.run(
    `INSERT INTO points_ledger (user_id, points, reason, ref_type, ref_id)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, points, reason, refType, refId]
  );
}