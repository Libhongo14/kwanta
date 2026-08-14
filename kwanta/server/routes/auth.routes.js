import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, signToken, isAdmin } from '../auth.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

router.post(
  '/register',
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res) => {
    const { email, password } = req.body || {};
    if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (exists) return res.status(409).json({ error: 'That email is already registered.' });

    const hash = await hashPassword(password);
    const info = db
      .prepare('INSERT INTO users (email, password_hash, last_ip) VALUES (?, ?, ?)')
      .run(email.toLowerCase(), hash, req.ip);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.json({ token: signToken(user), user: publicUser(user) });
  }
);

router.post(
  '/login',
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res) => {
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!user || !(await verifyPassword(password || '', user.password_hash)))
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    db.prepare('UPDATE users SET last_ip = ? WHERE id = ?').run(req.ip, user.id);
    res.json({ token: signToken(user), user: publicUser(user) });
  }
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ── Phone verification (OTP) ───────────────────────────────────────────────
router.post(
  '/phone/request',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 3, key: (r) => r.user.id }),
  (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid SA mobile number.' });

    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(
      `INSERT INTO otp_codes (phone, code, expires_at, attempts)
       VALUES (?, ?, datetime('now', '+10 minutes'), 0)
       ON CONFLICT(phone) DO UPDATE SET code = excluded.code,
         expires_at = excluded.expires_at, attempts = 0`
    ).run(phone, code);
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);

    sendOtp(phone, code);
    res.json({ sent: true, devHint: config.smsProviderKey ? undefined : code });
  }
);

router.post('/phone/verify', requireAuth, (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '');
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(phone);
  if (!row) return res.status(400).json({ error: 'Request a code first.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);

  const expired = db.prepare("SELECT datetime('now') > expires_at AS e FROM otp_codes WHERE phone = ?").get(phone).e;
  if (expired) return res.status(400).json({ error: 'Code expired. Request a new one.' });
  if (row.code !== code) return res.status(400).json({ error: 'Incorrect code.' });

  db.prepare('UPDATE users SET phone_verified = 1, phone = ? WHERE id = ?').run(phone, req.user.id);
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ verified: true, user: publicUser(user) });
});

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    phoneVerified: !!u.phone_verified,
    status: u.status,
    isAdmin: isAdmin(u.email),
  };
}

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s-]/g, '');
  if (/^0\d{9}$/.test(s)) s = '+27' + s.slice(1);       // 0XXXXXXXXX -> +27XXXXXXXXX
  else if (/^27\d{9}$/.test(s)) s = '+' + s;
  if (!/^\+27\d{9}$/.test(s)) return null;
  return s;
}

// Swap this for a real SMS provider (Clickatell, Twilio, etc.).
function sendOtp(phone, code) {
  if (config.smsProviderKey) {
    // TODO: call your SMS provider's API here with config.smsProviderKey.
    console.log(`[sms] would send code to ${phone} via provider`);
  } else {
    console.log(`[otp:dev] ${phone} -> ${code}`); // dev fallback
  }
}

export default router;
