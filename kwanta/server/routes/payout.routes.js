import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getBalance, addEntry } from '../services/ledger.js';

const router = Router();
const METHODS = new Set(['airtime', 'data', 'cash']);

// Requesting a payout immediately debits (holds) the points via a ledger entry,
// so the same points can't be spent twice while the request is pending. A
// rejection refunds them (see admin.routes.js).
async function requestPayout({ userId, points, method, destination }) {
  return withTransaction(async (tx) => {
    // Postgres doesn't serialize transactions the way SQLite's single-writer
    // model did — without this, two concurrent payout requests could both
    // read the same balance before either commits and double-spend it. This
    // lock forces concurrent requests for the same user to queue up.
    await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    const balance = await getBalance(userId, tx);
    if (balance < points) return { ok: false, error: 'Not enough points.' };
    if (points < config.minPayoutPoints)
      return { ok: false, error: `Minimum payout is ${config.minPayoutPoints} points.` };

    const valueCents = points * config.pointValueCents;
    const inserted = await tx.get(
      `INSERT INTO payouts (user_id, points, value_cents, method, destination, status)
       VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
      [userId, points, valueCents, method, destination]
    );

    await addEntry(
      {
        userId,
        points: -points,
        reason: 'redemption',
        refType: 'payout',
        refId: String(inserted.id),
      },
      tx
    );
    return { ok: true, payoutId: inserted.id, valueCents };
  });
}

router.post(
  '/request',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 5, key: (r) => r.user.id }),
  async (req, res) => {
    const { points, method, destination } = req.body || {};
    const pts = Number(points);

    if (config.requirePhoneVerification && !req.user.phone_verified)
      return res.status(403).json({ error: 'Verify your phone number before requesting a payout.' });
    if (!METHODS.has(method))
      return res.status(400).json({ error: 'Choose airtime, data, or cash.' });
    if (!destination || String(destination).length < 4)
      return res.status(400).json({ error: 'Enter where the payout should go.' });
    if (!Number.isInteger(pts) || pts <= 0)
      return res.status(400).json({ error: 'Enter a valid points amount.' });

    const result = await requestPayout({
      userId: req.user.id,
      points: pts,
      method,
      destination: String(destination),
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({
      requested: true,
      payoutId: result.payoutId,
      valueCents: result.valueCents,
      message: 'Payout requested. It will be reviewed and paid to your account.',
    });
  }
);

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT id, points, value_cents, method, destination, status, note, created_at, resolved_at
       FROM payouts WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ payouts: rows });
});

export default router;