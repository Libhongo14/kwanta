import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { getBalance, getLedger } from '../services/ledger.js';

const router = Router();

router.get('/balance', requireAuth, (req, res) => {
  const balance = getBalance(req.user.id);
  res.json({
    points: balance,
    valueCents: balance * config.pointValueCents,
    minPayoutPoints: config.minPayoutPoints,
    canRequestPayout: balance >= config.minPayoutPoints,
  });
});

router.get('/history', requireAuth, (req, res) => {
  res.json({ entries: getLedger(req.user.id, 100) });
});

export default router;
