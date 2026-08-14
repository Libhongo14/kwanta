import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { checkAdEligibility, adsToday, ipVelocityHigh } from '../services/fraud.js';
import {
  issueAdSession,
  verifyHmacSignature,
  verifyAdmobSsv,
  creditAdView,
} from '../services/adReward.js';

const router = Router();

// Public (no auth): tells the frontend how to load the ad network. Safe to
// expose — the Publisher ID is public by design (it ships in the page tag).
router.get('/public-config', (req, res) => {
  res.json({
    adsenseClient: config.adsenseClient,      // '' => dev simulated ad
    adFrequencyHint: config.adFrequencyHint,
    live: !!config.adsenseClient,
  });
});

// What the client needs to render the "watch ad" UI.
router.get('/config', requireAuth, (req, res) => {
  const used = adsToday(req.user.id);
  res.json({
    pointsPerAd: config.pointsPerAd,
    adsWatchedToday: used,
    dailyLimit: config.maxAdsPerDay,
    adsRemaining: Math.max(0, config.maxAdsPerDay - used),
  });
});

// Client calls this right before showing an ad. Returns a single-use token to
// hand to the ad SDK (as custom_data / SSV user identifier).
router.post(
  '/session',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 30, key: (r) => r.user.id }),
  (req, res) => {
    const elig = checkAdEligibility(req.user);
    if (!elig.ok) return res.status(403).json({ error: elig.reason });
    if (ipVelocityHigh(req.ip))
      return res.status(429).json({ error: 'Unusual activity detected. Please slow down.' });
    const token = issueAdSession(req.user.id, req.ip);
    res.json({ sessionToken: token });
  }
);

// ── Public S2S reward callback ──────────────────────────────────────────────
// Called by the ad network's SERVERS (not the browser) when a view completes.
// This is the ONLY thing that credits points, so a client can never fake a
// reward. Configure this URL in your ad-network dashboard as the SSV callback:
//   {PUBLIC_BASE_URL}/api/ads/ssv
// AdMob path: verified with Google's ECDSA public keys (key_id present).
// HMAC path:  verified with AD_SSV_HMAC_SECRET (for mediation/your test tool).
async function handleSsv(req, res) {
  // Raw query string is required for AdMob signature verification.
  const rawQuery = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
    : '';
  const p = { ...req.query };

  const transactionId = p.transaction_id;
  const sessionToken = p.custom_data; // we passed our session token here
  const network = p.ad_network || (p.key_id ? 'admob' : 'hmac');
  if (!transactionId || !sessionToken)
    return res.status(400).send('missing transaction_id or custom_data');

  // Verify authenticity.
  let ok = false;
  try {
    if (p.key_id) ok = await verifyAdmobSsv(rawQuery);
    else ok = verifyHmacSignature(p, p.signature);
  } catch (e) {
    console.error('SSV verify error:', e.message);
    return res.status(502).send('verification unavailable');
  }
  if (!ok) return res.status(403).send('invalid signature');

  const result = creditAdView({
    transactionId: String(transactionId),
    sessionToken: String(sessionToken),
    network: String(network),
    ip: req.ip,
  });

  // Ad networks expect a 200 to consider the callback delivered. We return 200
  // for "already processed" too (idempotent) to stop unnecessary retries.
  if (result.credited || result.reason === 'already_processed')
    return res.status(200).send('ok');
  return res.status(200).send(`ignored:${result.reason}`);
}

router.get('/ssv', handleSsv);
router.post('/ssv', handleSsv);

// ── AdSense H5 reward claim (client-confirmed) ──────────────────────────────
// AdSense H5 Games Ads (web) grant rewards via the browser `adViewed` callback
// — there is NO cryptographic server-side verification for web (SSV is an
// AdMob/app feature). So this endpoint is our best-effort equivalent: it
// credits a reward only against a valid, single-use, unexpired session token
// that WE issued to THIS user, and it's still bound by the daily cap, IP
// velocity checks, and idempotency. That means abuse is limited to a user
// forging calls for their own account within their own cap — not free minting.
// For true un-fakeable rewards, ship the app + AdMob SSV path (/ssv) instead.
router.post(
  '/claim',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 30, key: (r) => r.user.id }),
  async (req, res) => {
    const sessionToken = req.body?.sessionToken;
    if (!sessionToken) return res.status(400).json({ error: 'Missing ad session.' });
    if (ipVelocityHigh(req.ip))
      return res.status(429).json({ error: 'Unusual activity detected. Please slow down.' });

    const { randomBytes } = await import('node:crypto');
    const result = creditAdView({
      transactionId: 'h5-' + randomBytes(12).toString('hex'),
      sessionToken: String(sessionToken),
      network: 'adsense-h5',
      ip: req.ip,
    });
    if (!result.credited) {
      const msg = {
        invalid_or_expired_session: 'That ad session has expired. Try again.',
        already_processed: 'This ad was already rewarded.',
        daily_cap_reached: 'Daily reward limit reached. Come back tomorrow.',
        user_ineligible: 'Your account can’t earn right now.',
      }[result.reason] || 'Could not credit this ad.';
      return res.status(400).json({ error: msg, reason: result.reason });
    }
    res.json({ credited: true, points: result.points });
  }
);

// ── DEV-ONLY simulator ──────────────────────────────────────────────────────
// Lets you test the full earn loop with no live ad network. It builds a real
// HMAC-signed reward and runs it through the SAME verification + credit path a
// real network callback uses — so nothing here is faked or bypassed. Disabled
// automatically when NODE_ENV=production. In production the ad SDK + the
// network's SSV callback replace this entirely.
if (config.env !== 'production') {
  const crypto = await import('node:crypto');
  router.post('/dev-complete', requireAuth, (req, res) => {
    const sessionToken = req.body?.sessionToken;
    if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
    const params = {
      ad_network: 'dev-simulator',
      transaction_id: 'dev-' + crypto.randomBytes(10).toString('hex'),
      custom_data: sessionToken,
      reward_amount: '1',
      reward_item: 'points',
      timestamp: String(Date.now()),
    };
    const base = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    params.signature = crypto
      .createHmac('sha256', config.adSsvHmacSecret)
      .update(base)
      .digest('hex');

    // Verify with the real verifier before crediting — identical to production.
    if (!verifyHmacSignature(params, params.signature))
      return res.status(500).json({ error: 'signature self-check failed' });

    const result = creditAdView({
      transactionId: params.transaction_id,
      sessionToken,
      network: params.ad_network,
      ip: req.ip,
    });
    if (!result.credited)
      return res.status(400).json({ error: result.reason });
    res.json({ credited: true, points: result.points });
  });
}

export default router;
