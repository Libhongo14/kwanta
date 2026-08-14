import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { addEntry } from '../services/ledger.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// Business dashboard: what you earned vs what you owe/paid — your margin.
router.get('/overview', (req, res) => {
  const revenue = db
    .prepare('SELECT COALESCE(SUM(revenue_cents),0) AS c, COUNT(*) AS n FROM ad_events WHERE verified = 1')
    .get();
  const paid = db
    .prepare("SELECT COALESCE(SUM(value_cents),0) AS c FROM payouts WHERE status = 'paid'")
    .get();
  const pending = db
    .prepare("SELECT COALESCE(SUM(value_cents),0) AS c, COUNT(*) AS n FROM payouts WHERE status IN ('pending','approved')")
    .get();
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get();

  res.json({
    adViews: revenue.n,
    grossRevenueCents: revenue.c,
    paidOutCents: paid.c,
    pendingLiabilityCents: pending.c,
    pendingCount: pending.n,
    marginCents: revenue.c - paid.c,
    totalUsers: users.n,
  });
});

router.get('/payouts', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db
    .prepare(
      `SELECT p.*, u.email, u.phone, u.phone_verified
         FROM payouts p JOIN users u ON u.id = p.user_id
        WHERE p.status = ? ORDER BY p.id ASC LIMIT 200`
    )
    .all(status);
  res.json({ payouts: rows });
});

// Approve → mark for payment (or trigger provider). Reject → refund the hold.
const resolvePayout = db.transaction(({ id, action, note }) => {
  const p = db.prepare("SELECT * FROM payouts WHERE id = ?").get(id);
  if (!p) return { ok: false, error: 'Payout not found.' };
  if (p.status !== 'pending' && p.status !== 'approved')
    return { ok: false, error: `Payout already ${p.status}.` };

  if (action === 'reject') {
    db.prepare("UPDATE payouts SET status='rejected', note=?, resolved_at=datetime('now') WHERE id=?")
      .run(note || null, id);
    // Refund the held points.
    addEntry({
      userId: p.user_id,
      points: p.points,
      reason: 'adjustment',
      refType: 'payout',
      refId: String(id),
    });
    return { ok: true, status: 'rejected' };
  }

  if (action === 'approve') {
    db.prepare("UPDATE payouts SET status='approved', note=? WHERE id=?").run(note || null, id);
    return { ok: true, status: 'approved' };
  }

  if (action === 'markPaid') {
    // In production, call your payout provider here (Flutterwave/Peach/airtime
    // reseller) using config.payoutProviderKey, then mark paid on success.
    db.prepare("UPDATE payouts SET status='paid', note=?, resolved_at=datetime('now') WHERE id=?")
      .run(note || null, id);
    return { ok: true, status: 'paid' };
  }
  return { ok: false, error: 'Unknown action.' };
});

router.post('/payouts/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const { action, note } = req.body || {};
  if (!['approve', 'reject', 'markPaid'].includes(action))
    return res.status(400).json({ error: 'action must be approve, reject, or markPaid.' });
  const r = resolvePayout({ id, action, note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, status: r.status });
});

// Basic account moderation.
router.post('/users/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!['active', 'flagged', 'banned'].includes(status))
    return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true });
});

export default router;
