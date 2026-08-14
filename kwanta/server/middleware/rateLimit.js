// Lightweight fixed-window rate limiter. In-memory is fine for a single
// instance; for multi-instance deployments back this with Redis.

const buckets = new Map();

export function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const id = (key ? key(req) : req.ip) + ':' + req.path;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(id, b);
    }
    b.count += 1;
    if (b.count > max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many requests. Try again in ${retry}s.` });
    }
    next();
  };
}

// Periodic cleanup to keep memory bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60_000).unref();
