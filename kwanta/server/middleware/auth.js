import { verifyToken, isAdmin } from '../auth.js';
import { db } from '../db.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const payload = verifyToken(token);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    if (user.status === 'banned')
      return res.status(403).json({ error: 'This account is suspended.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Sign in again.' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || !isAdmin(req.user.email))
    return res.status(403).json({ error: 'Admins only.' });
  next();
}