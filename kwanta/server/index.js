import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { migrate } from './db.js';
import { rateLimit } from './middleware/rateLimit.js';

import authRoutes from './routes/auth.routes.js';
import adsRoutes from './routes/ads.routes.js';
import pointsRoutes from './routes/points.routes.js';
import payoutRoutes from './routes/payout.routes.js';
import adminRoutes from './routes/admin.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
migrate();

const app = express();
app.set('trust proxy', 1); // behind a reverse proxy / load balancer in prod
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// Minimal security headers (add helmet in prod if you want more).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// Global soft rate limit as a backstop.
app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }));

app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env }));
app.use('/api/auth', authRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/points', pointsRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/admin', adminRoutes);

// Frontend.
app.use(express.static(join(__dirname, 'public')));
// SPA fallback for any non-API GET (Express 5 wildcard syntax).
app.get('/{*any}', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

app.listen(config.port, () => {
  console.log(`AdRewards running on ${config.publicBaseUrl} (port ${config.port}, ${config.env})`);
});
