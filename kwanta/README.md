# Kwanta — ad-rewards platform

Users watch rewarded video ads, earn points, and cash out for airtime, data, or
money. You earn the **margin** between what the ad network pays you per view and
the smaller value you credit the user. Every reward is verified server-side, so
views can't be faked, and payouts are real — which is what keeps your ad account
alive and users coming back.

## How you make money (the honest model)

- Ad network pays you an **eCPM** per 1,000 rewarded views (e.g. ~R2 in SA).
- That's ~R0.002 (0.2c) per view — set as `REVENUE_PER_AD_CENTS`.
- You credit the user **less** than that per view (`POINTS_PER_AD` × `POINT_VALUE_CENTS`).
- The difference is your margin. The admin dashboard shows gross revenue, paid
  out, pending liability, and margin in real time.

Keep `POINTS_PER_AD × POINT_VALUE_CENTS` well below `REVENUE_PER_AD_CENTS` or you
lose money on every view. At 0.2c revenue and a 1-point (1c) reward you'd be
paying more than you earn — lower the point value or raise your effective eCPM
with mediation before going live. Tune these in `.env`.

## Play & earn (mini-games hub)

`server/public/games.js` adds two real, playable canvas games — **Coin Rush**
(20s tap-the-coins-dodge-the-bombs) and **Reflex Tap** (3-round reaction-time
test). They're cosmetic engagement, not the reward mechanism: finishing a
round just unlocks the same server-verified earn flow (`window.kwantaEarn.run()`
in `app.js`) used by the plain "watch ad" button, so scores can never be
gamed into free points. This also matters for approval — Google requires
actual playable H5 games on the domain before allowlisting H5 Games Ads (see
"Getting approved" below); a bare "watch ad for airtime" page gets rejected.

## Quick start

```bash
npm install
cp .env.example .env        # then edit secrets + rates
npm run init-db
npm start                    # http://localhost:3000
```

Create an account in the UI. To use the admin panel, register with an email
listed in `ADMIN_EMAILS`, then click **Admin**.

In development there's no live ad network, so a **dev-only** button runs the full
earn loop through the *real* verification path (HMAC-signed reward → same SSV
handler → same credit logic). This route is disabled automatically when
`NODE_ENV=production`.

## Architecture

```
server/
  index.js            Express app, security headers, routing
  config.js           Env config + economics knobs
  db.js               SQLite schema (swap for Postgres via this module)
  auth.js             bcrypt + JWT
  middleware/         auth guard, admin guard, rate limiter
  services/
    ledger.js         Append-only points ledger (balance = SUM of entries)
    fraud.js          Daily caps, IP velocity, multi-account checks
    adReward.js       Ad sessions + HMAC/AdMob SSV verify + idempotent credit
  routes/             auth, ads, points, payouts, admin
  public/             Frontend (vanilla, no build step)
```

**Why views can't be faked:** the browser never credits points. Only the ad
network's **server-to-server (SSV) callback** does, and it's verified by
signature. Each reward carries a unique `transaction_id` (replay-protected by a
UNIQUE constraint) and a single-use session token tying it to a real user.

## Ad network: Google AdSense H5 Games Ads (free)

This is wired and ready. It's free — you just need an AdSense account and a
Publisher ID. Set it and the real rewarded ad turns on automatically:

```
ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX   # in .env
```

With no Publisher ID the app runs a simulated ad (dev mode) so you can build and
test offline. With one set, the frontend loads Google's Ad Placement API,
shows a real rewarded video via `adBreak({ type: 'reward' })`, and — once the
browser confirms the view (`adViewed`) — calls `POST /api/ads/claim` to credit
the point. `initAds()` in `public/app.js` handles loading; the tag and Publisher
ID are injected from `/api/ads/public-config`, so nothing is hard-coded.

### Important: web rewards are client-confirmed

AdSense H5 on the **web** grants the reward through a browser callback. There is
**no cryptographic server-side verification (SSV) for web** — SSV only exists on
the **AdMob app** path. So `/api/ads/claim` credits a point only against a
valid, single-use, unexpired session token we issued to that signed-in user, and
it's still bound by the daily cap, IP-velocity checks, and idempotency. That
caps abuse at "a user farming their own capped account," not free point minting.
If you need un-fakeable rewards, ship the game inside an Android app and use the
AdMob rewarded SSV path (already built — `POST /api/ads/ssv`, verified with
Google's public keys).

### Getting approved (do this before launch)

Google allowlists H5 Games Ads. They review your AdSense account, your domain,
and confirm the site hosts **actual playable H5 games** — a bare "watch ad for
airtime" page will be rejected. This is why the product is a mini-games hub:
real games on the page are what make you eligible. Steps: get an AdSense account,
apply for H5 Games Ads (it's a beta), pass the game/domain review, then drop your
Publisher ID into `.env`.

## Alternative networks

- **AdMob (app path)** — for a wrapped Android app: set the SSV callback URL to
  `{PUBLIC_BASE_URL}/api/ads/ssv` and pass the session token as `custom_data`.
  Real SSV, no faking. Verification already implemented.
- **HMAC networks / mediation** — set `AD_SSV_HMAC_SECRET`, give the network the
  same secret; callbacks hit `/api/ads/ssv` and are verified by `verifyHmacSignature`.

## Going live — payouts

Payouts are **manual by default**: users request, an admin reviews in the panel
and marks **paid**. To automate, implement the provider call in
`routes/admin.routes.js` under the `markPaid` action using `PAYOUT_PROVIDER_KEY`
(e.g. Flutterwave/Peach for cash, or an airtime/data reseller API — resellers
often pay you commission, improving your margin).

## Fraud controls included

- Server-side reward verification (signature + single-use session + unique txn).
- Daily per-user ad cap (`MAX_ADS_PER_DAY`).
- IP velocity + multi-account-per-IP checks (`services/fraud.js`).
- Phone (OTP) verification required before payout.
- Points held on payout request; refunded on rejection (no double-spend).
- Rate limits on auth, sessions, OTP, and payout endpoints.
- Account status: `active` / `flagged` / `banned`.

## Go-live checklist

- [ ] Set strong `JWT_SECRET` and `AD_SSV_HMAC_SECRET` (the app refuses to boot
      in production with the dev defaults).
- [ ] Put the app behind HTTPS (a reverse proxy); `trust proxy` is already on.
- [ ] Move from SQLite to Postgres/MySQL for real traffic (re-implement `db.js`).
- [ ] Wire a real SMS provider in `auth.routes.js` (`sendOtp`).
- [ ] Get AdSense approved for H5 Games Ads, then set `ADSENSE_CLIENT` (rewarded
      ads are already wired). For un-fakeable rewards, use the AdMob app path.
- [ ] Wire a payout provider (or keep manual to start).
- [ ] Write clear terms: state the point-to-rand rate and that payouts are
      reviewed before payment. Users must know what they're earning.
- [ ] Add a privacy policy and cookie/consent notice for ads (required by most
      ad networks and by POPIA in South Africa).

## A word on compliance

Ad networks ban incentivised traffic that fakes engagement or never pays out.
This build pays real rewards and verifies real views, which keeps you on the
right side of their policies — but read your chosen network's incentivised-ads
rules, since some restrict rewarded formats or require specific disclosures.
```
