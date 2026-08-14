// ── tiny helpers ────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
let token = localStorage.getItem('kwanta_token');
let me = null;
let state = { points: 0, minPayout: 5000 };

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const rand = (cents) => 'R' + (cents / 100).toFixed(2);

// ── auth ────────────────────────────────────────────────────────────────────
let mode = 'login';
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    mode = tab.dataset.tab;
    $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  })
);

$('#form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  try {
    const path = mode === 'login' ? '/auth/login' : '/auth/register';
    const data = await api(path, { method: 'POST', body: { email, password } });
    token = data.token;
    localStorage.setItem('kwanta_token', token);
    me = data.user;
    enterApp();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('kwanta_token');
  location.reload();
});

// ── dashboard ───────────────────────────────────────────────────────────────
function enterApp() {
  $('#view-auth').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#user-email').textContent = me.email;
  $('#nav-admin').hidden = !me.isAdmin;
  $('#verify-block').classList.toggle('hidden', !!me.phoneVerified);
  refreshAll();
}

async function refreshAll() {
  await Promise.all([loadBalance(), loadAdConfig(), loadLedger(), loadPayouts()]);
}

let displayed = 0;
function animateBalance(to) {
  const from = displayed;
  const start = performance.now();
  const dur = 600;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const val = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    $('#balance-points').textContent = val.toLocaleString();
    if (p < 1) requestAnimationFrame(step);
    else displayed = to;
  };
  requestAnimationFrame(step);
}

async function loadBalance() {
  const b = await api('/points/balance');
  state.points = b.points;
  state.minPayout = b.minPayoutPoints;
  animateBalance(b.points);
  $('#balance-value').textContent = rand(b.valueCents);
  const pct = Math.min(100, (b.points / b.minPayoutPoints) * 100);
  $('#progress-bar').style.width = pct + '%';
  $('#progress-caption').textContent = b.canRequestPayout
    ? 'You can request a payout.'
    : `${(b.minPayoutPoints - b.points).toLocaleString()} pts to your first payout`;
  $('#payout-points').placeholder = b.minPayoutPoints;
}

async function loadAdConfig() {
  const c = await api('/ads/config');
  $('#ads-remaining').textContent =
    `${c.adsRemaining} of ${c.dailyLimit} ads left today · +${c.pointsPerAd} pt each`;
  $('#btn-watch').disabled = c.adsRemaining <= 0;
}

async function loadLedger() {
  const { entries } = await api('/points/history');
  const el = $('#ledger');
  if (!entries.length) { el.innerHTML = '<li class="empty">No activity yet. Watch an ad to start.</li>'; return; }
  el.innerHTML = entries.map((e) => {
    const label = e.reason === 'ad_reward' ? 'Ad reward'
      : e.reason === 'redemption' ? 'Payout request'
      : e.reason === 'adjustment' ? 'Refund' : e.reason;
    const cls = e.points >= 0 ? 'led-plus' : 'led-minus';
    const sign = e.points >= 0 ? '+' : '';
    return `<li><span>${label}<br><span class="led-time">${fmt(e.created_at)}</span></span>
      <span class="${cls}">${sign}${e.points}</span></li>`;
  }).join('');
}

async function loadPayouts() {
  const { payouts } = await api('/payouts/mine');
  const el = $('#payouts');
  if (!payouts.length) { el.innerHTML = '<li class="empty">No payouts yet.</li>'; return; }
  el.innerHTML = payouts.map((p) =>
    `<li><span>${rand(p.value_cents)} · ${p.method}<br>
      <span class="led-time">${p.destination} · ${fmt(p.created_at)}</span></span>
      <span class="badge ${p.status}">${p.status}</span></li>`
  ).join('');
}

// ── earn loop ───────────────────────────────────────────────────────────────
// When an AdSense Publisher ID is configured, this shows a real AdSense H5
// rewarded ad and credits via /ads/claim after the browser confirms the view
// (adViewed). With no Publisher ID (dev), it runs the simulated ad through the
// signed dev path instead. Either way the server enforces session + caps.
let adsLive = false;

// Reusable earn flow: issue a session, show the ad (real AdSense H5 when live,
// dev simulator otherwise), claim the reward, refresh the UI. Used by the
// plain "Watch ad" button AND by every mini-game's "claim" step, so games and
// the AdSense-required H5 ad surface share one server-verified reward path.
async function runEarnFlow() {
  const { sessionToken } = await api('/ads/session', { method: 'POST' });
  if (adsLive) {
    await showRewardedAd();
    const r = await api('/ads/claim', { method: 'POST', body: { sessionToken } });
    return r.points;
  } else {
    await playAd();
    const r = await api('/ads/dev-complete', { method: 'POST', body: { sessionToken } });
    return r.points;
  }
}
window.kwantaEarn = {
  run: runEarnFlow,
  refresh: () => Promise.all([loadBalance(), loadAdConfig(), loadLedger()]),
  toast,
  celebrate,
};

$('#btn-watch').addEventListener('click', async () => {
  $('#btn-watch').disabled = true;
  try {
    await runEarnFlow();
    await window.kwantaEarn.refresh();
    celebrate();
    toast('+1 point earned');
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#btn-watch').disabled = false;
    $('#ad-modal').classList.add('hidden');
  }
});

// Shows a real AdSense H5 rewarded ad. Resolves only if the user watched it to
// completion (adViewed). Rejects on dismiss, no fill, or if the network never
// calls back at all (common for a site still pending approval — without a
// timeout the modal would hang forever with no way out).
function showRewardedAd() {
  return new Promise((resolve, reject) => {
    let rewarded = false;
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn(...args);
    };
    const doResolve = settle(resolve);
    const doReject = settle(reject);

    $('#ad-modal').classList.remove('hidden');
    $('#ad-count').textContent = '';

    const timeoutId = setTimeout(() => {
      doReject(new Error('Ad took too long to load. Try again shortly.'));
    }, 12000);

    window.adBreak({
      type: 'reward',
      name: 'earn_points',
      beforeAd: () => {},
      afterAd: () => {},
      // The user already tapped our button (a user gesture), so show immediately.
      beforeReward: (showAdFn) => showAdFn(),
      adViewed: () => { rewarded = true; },
      adDismissed: () => doReject(new Error('Ad skipped — no points this time.')),
      adBreakDone: () =>
        rewarded ? doResolve() : doReject(new Error('No ad available right now. Try again shortly.')),
    });
  });
}

// Dev-only simulated ad (used when no Publisher ID is set).
function playAd() {
  return new Promise((resolve) => {
    const modal = $('#ad-modal');
    modal.classList.remove('hidden');
    let n = 3;
    $('#ad-count').textContent = `(${n}s)`;
    const iv = setInterval(() => {
      n -= 1;
      $('#ad-count').textContent = n > 0 ? `(${n}s)` : '';
      if (n <= 0) { clearInterval(iv); resolve(); }
    }, 1000);
  });
}

// Loads the AdSense H5 Ad Placement API if a Publisher ID is configured.
// The script tag itself is now injected server-side directly into the HTML
// <head> (see server/index.js) — required for AdSense's site-verification
// crawler to find it reliably. This just waits for that tag to finish
// loading and preloads a rewarded ad break.
async function initAds() {
  try {
    const c = await api('/ads/public-config');
    if (!c.adsenseClient) return; // dev mode: simulated ad
    if (!window.adBreak) {
      // Script tag hasn't loaded yet (or ADSENSE_CLIENT isn't set on the
      // server side) — wait briefly for it, since it loads async.
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = setInterval(() => {
          if (window.adBreak) { clearInterval(check); resolve(); }
          else if (Date.now() - start > 8000) { clearInterval(check); reject(new Error('ad script not ready')); }
        }, 100);
      });
    }
    // Preload rewarded ads and start muted (best practice for autoplay policies).
    window.adConfig({ preloadAdBreaks: 'on', sound: 'off' });
    adsLive = true;
  } catch {
    adsLive = false; // fall back to dev simulator
  }
}

// ── phone verification ──────────────────────────────────────────────────────
$('#btn-send-otp').addEventListener('click', async () => {
  try {
    const phone = $('#phone').value.trim();
    const r = await api('/auth/phone/request', { method: 'POST', body: { phone } });
    $('#otp-row').classList.remove('hidden');
    toast(r.devHint ? `Dev code: ${r.devHint}` : 'Code sent by SMS');
  } catch (err) { toast(err.message, true); }
});

$('#btn-verify-otp').addEventListener('click', async () => {
  try {
    const phone = $('#phone').value.trim();
    const code = $('#otp').value.trim();
    const r = await api('/auth/phone/verify', { method: 'POST', body: { phone, code } });
    me = r.user;
    $('#verify-block').classList.add('hidden');
    toast('Phone verified');
  } catch (err) { toast(err.message, true); }
});

// ── payout ──────────────────────────────────────────────────────────────────
$('#form-payout').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const points = Number($('#payout-points').value);
    const method = $('#payout-method').value;
    const destination = $('#payout-dest').value.trim();
    const r = await api('/payouts/request', { method: 'POST', body: { points, method, destination } });
    toast(r.message);
    $('#form-payout').reset();
    await Promise.all([loadBalance(), loadLedger(), loadPayouts()]);
  } catch (err) { toast(err.message, true); }
});

// ── admin ───────────────────────────────────────────────────────────────────
$('#nav-admin').addEventListener('click', showAdmin);
$('#admin-back').addEventListener('click', () => {
  $('#view-admin').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
});

async function showAdmin() {
  $('#view-app').classList.add('hidden');
  $('#view-admin').classList.remove('hidden');
  const o = await api('/admin/overview');
  $('#admin-stats').innerHTML = [
    ['Users', o.totalUsers],
    ['Ad views', o.adViews],
    ['Gross revenue', rand(o.grossRevenueCents)],
    ['Paid out', rand(o.paidOutCents)],
    ['Pending', rand(o.pendingLiabilityCents)],
    ['Margin', rand(o.marginCents)],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  await loadAdminPayouts();
}

async function loadAdminPayouts() {
  const { payouts } = await api('/admin/payouts?status=pending');
  const el = $('#admin-payouts');
  if (!payouts.length) { el.innerHTML = '<li class="empty">No pending payouts.</li>'; return; }
  el.innerHTML = payouts.map((p) => `
    <li>
      <div><strong>${rand(p.value_cents)}</strong> · ${p.method} → ${p.destination}</div>
      <div class="led-time">${p.email} · ${p.phone_verified ? 'phone ✓' : 'phone ✗'} · ${fmt(p.created_at)}</div>
      <div class="apr">
        <button class="btn btn-primary" data-act="markPaid" data-id="${p.id}">Mark paid</button>
        <button class="btn" data-act="approve" data-id="${p.id}">Approve</button>
        <button class="btn" data-act="reject" data-id="${p.id}">Reject</button>
      </div>
    </li>`).join('');
  el.querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/admin/payouts/${b.dataset.id}/resolve`, { method: 'POST', body: { action: b.dataset.act } });
        toast('Done');
        await showAdmin();
      } catch (err) { toast(err.message, true); }
    })
  );
}

// ── utils + boot ────────────────────────────────────────────────────────────
function fmt(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Tiny confetti burst — no external library, just a canvas overlay that
// fades itself out. Called on every reward claim so earning feels good.
function celebrate() {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-layer';
  canvas.width = innerWidth; canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#12A66E', '#F5A623', '#5AA0FF', '#F06565', '#0E8A5C'];
  const pieces = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 3,
    size: Math.random() * 6 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  let frame = 0;
  const gravity = 0.28;
  (function tick() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.vy += gravity; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - frame / 70);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (frame < 75) requestAnimationFrame(tick);
    else canvas.remove();
  })();
}

(async function boot() {
  initAds(); // load AdSense if configured (non-blocking)
  if (!token) return;
  try {
    const { user } = await api('/auth/me');
    me = user;
    enterApp();
  } catch {
    localStorage.removeItem('kwanta_token');
  }
})();