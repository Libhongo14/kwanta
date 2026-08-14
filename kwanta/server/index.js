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
import { readFileSync } from 'node:fs';   // add this import near the top

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
// index.html is served through a small template step (not express.static)
// so the AdSense script tag can be injected server-side, directly into the
// raw HTML response. AdSense's site-verification crawler scans the initial
// page source for the ca-pub tag — it doesn't reliably wait for the async
// fetch + DOM injection the frontend used to do, which is why verification
// was failing. { index: false } stops express.static from also serving the
// unprocessed file for '/'.
app.use(express.static(join(__dirname, 'public'), { index: false }));

const indexPath = join(__dirname, 'public', 'index.html');
const adsenseHead = config.adsenseClient
  ? `<script>
window.adsbygoogle = window.adsbygoogle || [];
window.adBreak = window.adConfig = function(o){ window.adsbygoogle.push(o); };
</script>
<script async crossorigin="anonymous" data-ad-frequency-hint="${config.adFrequencyHint}"
  src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(config.adsenseClient)}"></script>`
  : '';

function renderIndex(req, res) {
  const html = readFileSync(indexPath, 'utf8').replace('<!--ADSENSE_HEAD-->', adsenseHead);
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
}

// SPA fallback for any non-API GET (Express 5 wildcard syntax).
app.get('/', renderIndex);
app.get('/{*any}', renderIndex);