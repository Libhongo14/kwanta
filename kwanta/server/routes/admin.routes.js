import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { addEntry } from '../services/ledger.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// Business dashboard: what you earned vs what you owe/paid — your margin.
router.get('/overview', async (req, res) => {
  const revenue = await db.get(
    'SELECT COALESCE(SUM(revenue_cents),0) AS c, COUNT(*) AS n FROM ad_events WHERE verified = 1'
  );
  const paid = await db.get(
    "SELECT COALESCE(SUM(value_cents),0) AS c FROM payouts WHERE status = 'paid'"
  );
  const pending = await db.get(
    "SELECT COALESCE(SUM(value_cents),0) AS c, COUNT(*) AS n FROM payouts WHERE status IN ('pending','approved')"
  );
  const users = await db.get('SELECT COUNT(*) AS n FROM users');

  res.json({
    adViews: Number(revenue.n),
    grossRevenueCents: Number(revenue.c),
    paidOutCents: Number(paid.c),
    pendingLiabilityCents: Number(pending.c),
    pendingCount: Number(pending.n),
    marginCents: Number(revenue.c) - Number(paid.c),
    totalUsers: Number(users.n),
  });
});

router.get('/payouts', async (req, res) => {
  const status = req.query.status || 'pending';
  const rows = await db.all(
    `SELECT p.*, u.email, u.phone, u.phone_verified
       FROM payouts p JOIN users u ON u.id = p.user_id
      WHERE p.status = ? ORDER BY p.id ASC LIMIT 200`,
    [status]
  );
  res.json({ payouts: rows });
});

// Approve → mark for payment (or trigger provider). Reject → refund the hold.
async function resolvePayout({ id, action, note }) {
  return withTransaction(async (tx) => {
    const p = await tx.get('SELECT * FROM payouts WHERE id = ?', [id]);
    if (!p) return { ok: false, error: 'Payout not found.' };
    if (p.status !== 'pending' && p.status !== 'approved')
      return { ok: false, error: `Payout already ${p.status}.` };

    if (action === 'reject') {
      await tx.run(
        "UPDATE payouts SET status='rejected', note=?, resolved_at=NOW() WHERE id=?",
        [note || null, id]
      );
      // Refund the held points.
      await addEntry(
        {
          userId: p.user_id,
          points: p.points,
          reason: 'adjustment',
          refType: 'payout',
          refId: String(id),
        },
        tx
      );
      return { ok: true, status: 'rejected' };
    }

    if (action === 'approve') {
      await tx.run("UPDATE payouts SET status='approved', note=? WHERE id=?", [note || null, id]);
      return { ok: true, status: 'approved' };
    }

    if (action === 'markPaid') {
      // In production, call your payout provider here (Flutterwave/Peach/airtime
      // reseller) using config.payoutProviderKey, then mark paid on success.
      await tx.run(
        "UPDATE payouts SET status='paid', note=?, resolved_at=NOW() WHERE id=?",
        [note || null, id]
      );
      return { ok: true, status: 'paid' };
    }
    return { ok: false, error: 'Unknown action.' };
  });
}

router.post('/payouts/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  const { action, note } = req.body || {};
  if (!['approve', 'reject', 'markPaid'].includes(action))
    return res.status(400).json({ error: 'action must be approve, reject, or markPaid.' });
  const r = await resolvePayout({ id, action, note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, status: r.status });
});

// Basic account moderation.
router.post('/users/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!['active', 'flagged', 'banned'].includes(status))
    return res.status(400).json({ error: 'Invalid status.' });
  await db.run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  res.json({ ok: true });
});

export default router;