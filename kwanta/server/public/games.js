// ── Kwanta mini-games ────────────────────────────────────────────────────
// Two small, genuinely playable canvas games. They don't award points
// themselves — completing a round unlocks the SAME server-verified reward
// flow used by "Watch ad & earn" (window.kwantaEarn.run), so scores can't be
// gamed into free points. Having real games on the page is also what Google
// requires for AdSense H5 Games Ads eligibility (see README).

const $$ = (s) => document.querySelector(s);

const modal = $$('#game-modal');
const modalBody = $$('#game-modal-body');
const modalTitle = $$('#game-modal-title');

function closeGame() {
  modal.classList.add('hidden');
  modalBody.innerHTML = '';
  document.removeEventListener('keydown', onEsc);
}
function onEsc(e) { if (e.key === 'Escape') closeGame(); }
$$('#game-modal-close').addEventListener('click', closeGame);

function openGame(title, render) {
  modalTitle.textContent = title;
  modalBody.innerHTML = '';
  modal.classList.remove('hidden');
  document.addEventListener('keydown', onEsc);
  render(modalBody);
}

// Shared "round over" screen: shows score + a claim button that runs the
// real earn flow (ad session → ad → server-verified claim → balance refresh).
function endScreen(container, scoreLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'game-end';
  wrap.innerHTML = `
    <div class="game-end-score">${scoreLabel}</div>
    <button class="btn btn-primary btn-lg" id="game-claim">Watch ad to claim reward</button>
    <button class="btn" id="game-again">Play again</button>
  `;
  container.appendChild(wrap);
  wrap.querySelector('#game-claim').addEventListener('click', async () => {
    // Close the game overlay first so the ad-playing indicator (which lives
    // in the main page, not the modal) is actually visible to the user.
    closeGame();
    try {
      await window.kwantaEarn.run();
      await window.kwantaEarn.refresh();
      window.kwantaEarn.celebrate();
      window.kwantaEarn.toast('+1 point earned — nice game!');
    } catch (err) {
      window.kwantaEarn.toast(err.message, true);
    }
  });
  wrap.querySelector('#game-again').addEventListener('click', () => {
    const game = wrap.dataset.replay;
    closeGame();
    if (game === 'coin') openCoinRush();
    if (game === 'reflex') openReflexTap();
  });
  return wrap;
}

// ── Game 1: Coin Rush ───────────────────────────────────────────────────
// Coins and bombs fall from the top for 20 seconds. Tap coins, dodge bombs.
function openCoinRush() {
  openGame('Coin Rush', (root) => {
    root.innerHTML = `
      <p class="game-instructions">Tap the coins 🪙, dodge the bombs 💣. 20 seconds.</p>
      <div class="game-hud"><span id="cr-score">Score: 0</span><span id="cr-time">20s</span></div>
      <canvas id="cr-canvas" class="game-canvas" width="600" height="420"></canvas>
    `;
    const canvas = $$('#cr-canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = $$('#cr-score');
    const timeEl = $$('#cr-time');
    function fit() {
      const w = Math.min(600, root.clientWidth - 4);
      canvas.style.width = w + 'px';
      canvas.style.height = (w * 0.7) + 'px';
    }
    fit();
    window.addEventListener('resize', fit);

    let score = 0, timeLeft = 20, running = true;
    const items = [];
    let spawnAcc = 0;

    function spawn() {
      const isBomb = Math.random() < 0.28;
      items.push({
        x: 30 + Math.random() * (600 - 60),
        y: -30,
        r: 22,
        vy: 2.4 + Math.random() * 2.2,
        bomb: isBomb,
        dead: false,
      });
    }

    function pointInItem(px, py, it) {
      const dx = px - it.x, dy = py - it.y;
      return dx * dx + dy * dy <= (it.r + 10) * (it.r + 10);
    }

    function handleHit(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const px = (clientX - rect.left) * scaleX;
      const py = (clientY - rect.top) * scaleY;
      for (const it of items) {
        if (it.dead) continue;
        if (pointInItem(px, py, it)) {
          it.dead = true;
          score += it.bomb ? -2 : 1;
          if (score < 0) score = 0;
          scoreEl.textContent = 'Score: ' + score;
          break;
        }
      }
    }
    canvas.addEventListener('pointerdown', (e) => handleHit(e.clientX, e.clientY));

    let last = performance.now();
    const timerIv = setInterval(() => {
      timeLeft -= 1;
      timeEl.textContent = timeLeft + 's';
      if (timeLeft <= 0) { running = false; clearInterval(timerIv); }
    }, 1000);

    function loop(now) {
      const dt = Math.min(40, now - last) / 16.6;
      last = now;
      if (!running) {
        const wrap = endScreen(root, `You scored ${score} 🪙`);
        wrap.dataset.replay = 'coin';
        return;
      }
      spawnAcc += dt;
      if (spawnAcc > 22) { spawn(); spawnAcc = 0; }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // background
      ctx.fillStyle = '#0E1A2B';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const it of items) {
        if (it.dead) continue;
        it.y += it.vy * dt;
        if (it.y > canvas.height + 40) it.dead = true;
        ctx.beginPath();
        ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
        ctx.fillStyle = it.bomb ? '#F06565' : '#F5A623';
        ctx.fill();
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(it.bomb ? '💣' : '🪙', it.x, it.y + 1);
      }
      for (let i = items.length - 1; i >= 0; i--) if (items[i].dead) items.splice(i, 1);

      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
}

// ── Game 2: Reflex Tap ───────────────────────────────────────────────────
// Classic reaction-time test across 3 rounds: wait for green, tap fast.
function openReflexTap() {
  openGame('Reflex Tap', (root) => {
    root.innerHTML = `
      <p class="game-instructions">Wait for the box to turn green, then tap it as fast as you can. 3 rounds.</p>
      <div class="game-hud"><span id="rx-round">Round 1 / 3</span><span id="rx-best"></span></div>
      <div id="rx-box" class="reflex-box">Get ready…</div>
    `;
    const box = $$('#rx-box');
    const roundEl = $$('#rx-round');
    const bestEl = $$('#rx-best');
    let round = 0;
    const total = 3;
    const times = [];
    let state = 'idle'; // idle | waiting | ready | tooSoon
    let readyAt = 0;
    let timeoutId;

    function nextRound() {
      round += 1;
      if (round > total) return finish();
      roundEl.textContent = `Round ${round} / ${total}`;
      state = 'waiting';
      box.textContent = 'Wait for it…';
      box.className = 'reflex-box wait';
      const delay = 900 + Math.random() * 2200;
      timeoutId = setTimeout(() => {
        state = 'ready';
        readyAt = performance.now();
        box.textContent = 'TAP NOW!';
        box.className = 'reflex-box go';
      }, delay);
    }

    box.addEventListener('pointerdown', () => {
      if (state === 'waiting') {
        clearTimeout(timeoutId);
        state = 'tooSoon';
        box.textContent = 'Too soon! Tap to retry this round.';
        box.className = 'reflex-box early';
        box.dataset.retry = '1';
        return;
      }
      if (state === 'tooSoon') {
        state = 'idle';
        round -= 1;
        nextRound();
        return;
      }
      if (state === 'ready') {
        const ms = Math.round(performance.now() - readyAt);
        times.push(ms);
        state = 'idle';
        box.textContent = `${ms} ms`;
        box.className = 'reflex-box done';
        bestEl.textContent = 'Best: ' + Math.min(...times) + ' ms';
        setTimeout(nextRound, 700);
      }
    });

    function finish() {
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      const wrap = endScreen(root, `Average reaction: ${avg} ms`);
      wrap.dataset.replay = 'reflex';
    }

    nextRound();
  });
}

document.getElementById('play-coin')?.addEventListener('click', openCoinRush);
document.getElementById('play-reflex')?.addEventListener('click', openReflexTap);
