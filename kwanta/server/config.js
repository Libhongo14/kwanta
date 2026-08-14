// Loads configuration from environment with safe, explicit defaults.
// In production, set these via .env (see .env.example) or your host's
// environment settings. Never commit real secrets.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Minimal .env loader (no dependency) — only sets vars not already present.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',

  jwtSecret: process.env.JWT_SECRET || 'dev_insecure_jwt_secret_change_me',
  adSsvHmacSecret: process.env.AD_SSV_HMAC_SECRET || 'dev_insecure_ssv_secret',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  revenuePerAdCents: num(process.env.REVENUE_PER_AD_CENTS, 0.2),
  pointsPerAd: num(process.env.POINTS_PER_AD, 1),
  pointValueCents: num(process.env.POINT_VALUE_CENTS, 1),

  minPayoutPoints: num(process.env.MIN_PAYOUT_POINTS, 5000),
  maxAdsPerDay: num(process.env.MAX_ADS_PER_DAY, 25),
  requirePhoneVerification: bool(process.env.REQUIRE_PHONE_VERIFICATION, true),

  smsProviderKey: process.env.SMS_PROVIDER_KEY || '',
  payoutProviderKey: process.env.PAYOUT_PROVIDER_KEY || '',

  // Google AdSense H5 Games Ads (free web rewarded ads).
  // adsenseClient looks like "ca-pub-1234567890123456". When blank, the app
  // runs in dev mode with the simulated ad (no real network calls).
  adsenseClient: process.env.ADSENSE_CLIENT || '',
  adFrequencyHint: process.env.AD_FREQUENCY_HINT || '30s',
};

// Loud warnings so you never ship with dev secrets by accident.
if (config.env === 'production') {
  const bad = [];
  if (config.jwtSecret.startsWith('dev_')) bad.push('JWT_SECRET');
  if (config.adSsvHmacSecret.startsWith('dev_')) bad.push('AD_SSV_HMAC_SECRET');
  if (bad.length) {
    throw new Error(`FATAL: insecure default secrets in production: ${bad.join(', ')}. Set real values in your host's environment variables.`);
  }
}
