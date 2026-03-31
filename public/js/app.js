/* ═══════════════════════════════════════════════════════════════════════════
   GOLDPOT — Main Application v2
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let player = null;
  let currentPot = 'mini';
  let gameState = null;
  let game = null;
  let lastGameScore = 0;
  let isPlaying = false;
  let pollTimer = null;
  let selectedPayMethod = null;
  let pendingPurchaseQty = 0;
  let pendingDoubleDownQty = 0;
  let pendingFirstPurchaseBoost = false;
  let countdownInterval = null;
  let flashCountdownInterval = null;
  let soundEnabled = localStorage.getItem('goldpot_muted') !== 'true';
  let sessionStartTime = Date.now();
  let sessionGamesPlayed = 0;
  let sessionRewardTimers = { 5: false, 15: false, 30: false };
  let sessionTimerInterval = null;
  let jackpotCountdownInterval = null;
  let lastJackpotActive = false;
  let jackpotAnnounced = false;
  let lightningInterval = null;
  let surgeInterval = null;
  let mysteryCooldownInterval = null;
  let megaMultShown = false;
  let gamesThisSession = 0;
  let lastDoubleDownTime = 0;
  let _urgencyNudgeShown = false;
  let _criticalNudgeShown = false;
  let limitedViewerCount = 12;

  // ─── Sound Engine (Web Audio API — no files needed) ──────────────────────
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  const SFX = {
    coinTap(pitch) {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(800 + (pitch || 0) * 200, t);
      o.frequency.exponentialRampToValueAtTime(1600, t + 0.06);
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.12);
    },
    goldenCoin() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      [0, 0.08, 0.16].forEach((d, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(1200 + i * 300, t + d);
        g.gain.setValueAtTime(0.15, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.15);
        o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.15);
      });
    },
    combo(level) {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
      const count = Math.min(level, 4);
      for (let i = 0; i < count; i++) {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'square'; o.frequency.setValueAtTime(notes[i], t + i * 0.07);
        g.gain.setValueAtTime(0.08, t + i * 0.07); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.2);
        o.connect(g); g.connect(ctx.destination); o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.2);
      }
    },
    win() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const melody = [523, 659, 784, 1047, 784, 1047, 1319]; // victory fanfare
      melody.forEach((freq, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(freq, t + i * 0.12);
        g.gain.setValueAtTime(0.15, t + i * 0.12); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.25);
        o.connect(g); g.connect(ctx.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.25);
      });
    },
    tick() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(440, t);
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.05);
    },
    alert() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(660, t);
      o.frequency.setValueAtTime(880, t + 0.1);
      o.frequency.setValueAtTime(660, t + 0.2);
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    },
    urgentTick() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(880, t);
      g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.08);
    },
    click() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(600, t);
      g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.04);
    },
    flash() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      [0, 0.1, 0.2].forEach((d) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(600 + d * 2000, t + d);
        g.gain.setValueAtTime(0.1, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.1);
        o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.1);
      });
    },
    bonus() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1760, t + 0.15);
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    },
    jackpot() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      // Dramatic rising fanfare
      const melody = [262, 330, 392, 523, 659, 784, 1047, 1319, 1568];
      melody.forEach((freq, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = i < 4 ? 'triangle' : 'sawtooth';
        o.frequency.setValueAtTime(freq, t + i * 0.1);
        g.gain.setValueAtTime(0.12 + i * 0.01, t + i * 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.3);
      });
      // Deep bass hit
      const bass = ctx.createOscillator(); const bg = ctx.createGain();
      bass.type = 'sine'; bass.frequency.setValueAtTime(80, t);
      bass.frequency.exponentialRampToValueAtTime(40, t + 0.6);
      bg.gain.setValueAtTime(0.2, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      bass.connect(bg); bg.connect(ctx.destination); bass.start(t); bass.stop(t + 0.6);
    },
    jackpotWin() {
      if (!soundEnabled) return;
      const ctx = getAudio(); const t = ctx.currentTime;
      // Massive celebration — longer and more dramatic than regular win
      const melody = [523, 659, 784, 1047, 784, 1047, 1319, 1568, 1319, 1568, 2093];
      melody.forEach((freq, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(freq, t + i * 0.15);
        g.gain.setValueAtTime(0.15, t + i * 0.15); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.35);
        o.connect(g); g.connect(ctx.destination); o.start(t + i * 0.15); o.stop(t + i * 0.15 + 0.35);
      });
      // Sustained chord
      [523, 659, 784].forEach(freq => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(freq, t + 1.5);
        g.gain.setValueAtTime(0.08, t + 1.5); g.gain.exponentialRampToValueAtTime(0.001, t + 3);
        o.connect(g); g.connect(ctx.destination); o.start(t + 1.5); o.stop(t + 3);
      });
    }
  };

  const ACHIEVEMENTS = {
    gold_fingers: { icon: '🏅', label: 'Gold Fingers', desc: 'Score 50+ in mini-game' },
    veteran:      { icon: '🎖️', label: 'Veteran', desc: 'Play 100 games' },
    dedicated:    { icon: '🔥', label: 'Dedicated', desc: '7-day streak' },
    unstoppable:  { icon: '💪', label: 'Unstoppable', desc: '30-day streak' },
    whale:        { icon: '🐋', label: 'Big Spender', desc: 'Spend $100+' },
    winner:       { icon: '🏆', label: 'Winner', desc: 'Win a pot' },
    networker:    { icon: '🤝', label: 'Networker', desc: 'Refer 5 friends' },
    influencer:   { icon: '📣', label: 'Influencer', desc: 'Refer 25 friends' },
  };

  const ACHIEVEMENT_REWARDS = {
    gold_fingers: 2, veteran: 5, dedicated: 3, unstoppable: 10,
    whale: 5, networker: 3, influencer: 10, winner: 0,
  };

  let _prevAchievements = [];
  function detectNewAchievements(newPlayer) {
    if (!newPlayer || !newPlayer.achievements) return;
    const oldSet = new Set(_prevAchievements);
    const newlyUnlocked = newPlayer.achievements.filter(a => !oldSet.has(a));
    _prevAchievements = [...newPlayer.achievements];
    newlyUnlocked.forEach((key, i) => {
      const ach = ACHIEVEMENTS[key];
      if (!ach) return;
      const reward = ACHIEVEMENT_REWARDS[key] || 0;
      setTimeout(() => {
        showBonus(`${ach.icon} ACHIEVEMENT UNLOCKED: ${ach.label}!`);
        if (reward > 0) {
          setTimeout(() => showBonus(`🎁 +${reward} BONUS ENTRIES for ${ach.label}!`), 2800);
        }
      }, i * 3500);
    });
  }

  // ─── DOM Refs ───────────────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ─── API Helpers ────────────────────────────────────────────────────────
  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);
    return match ? match[1] : '';
  }

  // Fetch CSRF cookie if not present (e.g. first visit, cookie lost, Secure flag mismatch)
  async function ensureCsrfCookie() {
    if (getCsrfToken()) return;
    try { await fetch('/api/state', { credentials: 'same-origin' }); } catch {}
  }

  function getAuthToken() {
    return localStorage.getItem('goldpot_token') || '';
  }

  async function api(path, body, _retried) {
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['x-csrf-token'] = getCsrfToken();
    }
    const token = getAuthToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const opts = body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers };
    try {
      const res = await fetch('/api/' + path, opts);
      // Auto-refresh CSRF cookie on 403 and retry once
      if (res.status === 403 && body && !_retried) {
        await ensureCsrfCookie();
        return api(path, body, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => 'Server error');
        showError(parseErrorText(text) || 'Error ' + res.status);
        return { error: true };
      }
      return await res.json();
    } catch (e) {
      showError('Connection lost — check your internet');
      return { error: true };
    }
  }

  function parseErrorText(text) {
    try { const j = JSON.parse(text); return j.error || j.message || text; } catch { return text; }
  }

  function showError(msg) {
    // Remove any existing error toasts to prevent stacking
    document.querySelectorAll('.error-toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'error-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, 3000);
  }

  function track(event, data = {}) {
    const csrf = getCsrfToken();
    if (!csrf) { ensureCsrfCookie().then(() => track(event, data)); return; }
    const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
    const token = getAuthToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    fetch('/api/track-event', {
      method: 'POST',
      headers,
      body: JSON.stringify({ event, playerId: player ? player.id : null, data }),
    }).catch(() => {});
  }

  // ─── Stripe Purchase Helper ─────────────────────────────────────────────
  // Routes any purchase through create-checkout-session, handling demo vs real Stripe.
  // onDemoSuccess is called in demo mode after checkout session confirms demo: true.
  async function stripePurchase({ purchaseType, quantity, potId, tier, pendingData }, onDemoSuccess) {
    const body = { playerId: player.id, purchaseType, quantity: quantity || 1, potId: potId || currentPot };
    if (tier) body.tier = tier;
    if (pendingData) { if (pendingData.stake) body.stake = pendingData.stake; }
    const res = await api('create-checkout-session', body);
    if (res.error) { showBonus(res.error); return; }
    if (res.demo) {
      await onDemoSuccess(res);
    } else if (res.url) {
      sessionStorage.setItem('goldpot_pending_purchase', JSON.stringify({
        type: purchaseType,
        qty: quantity || 1,
        pot: potId || currentPot,
        tier: tier || '',
        ...pendingData,
      }));
      window.location.href = res.url;
    }
  }

  // ─── Init ───────────────────────────────────────────────────────────────
  let pendingStripeReturn = null;

  async function init() {
    // Check for Stripe return URL
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');
    if (sessionId) {
      const cleanUrl = window.location.origin + window.location.pathname;
      history.replaceState({}, '', cleanUrl);
      const pending = sessionStorage.getItem('goldpot_pending_purchase');
      if (pending) {
        try { pendingStripeReturn = { sessionId, ...JSON.parse(pending) }; } catch {}
        sessionStorage.removeItem('goldpot_pending_purchase');
      } else {
        // sessionStorage was cleared — still attempt to verify the session
        pendingStripeReturn = { sessionId };
      }
    }
    if (urlParams.get('canceled')) {
      const cleanUrl = window.location.origin + window.location.pathname;
      history.replaceState({}, '', cleanUrl);
      sessionStorage.removeItem('goldpot_pending_purchase');
      // Show cancel feedback after UI loads
      setTimeout(() => showBonus('Payment cancelled. No charge was made.'), 1500);
    }
    if (urlParams.get('donated')) {
      const cleanUrl = window.location.origin + window.location.pathname;
      history.replaceState({}, '', cleanUrl);
      setTimeout(() => showBonus('💚 Thank you for your donation! You rock!'), 1500);
    }
    if (urlParams.get('connect_return') || urlParams.get('connect_refresh')) {
      const cleanUrl = window.location.origin + window.location.pathname;
      history.replaceState({}, '', cleanUrl);
      if (urlParams.get('connect_return')) {
        setTimeout(() => {
          showBonus('🏦 Bank account setup complete!');
          // Auto-open withdraw modal to show status
          if ($('#btnWithdraw')) $('#btnWithdraw').click();
        }, 1500);
      }
    }
    // Auto-fill referral code from URL ?ref=CODE
    const refFromUrl = urlParams.get('ref');
    if (refFromUrl) {
      window._pendingRefCode = refFromUrl.toUpperCase();
      // Clean up URL but keep the code in memory
      if (!sessionId && !urlParams.get('canceled') && !urlParams.get('donated')) {
        const cleanUrl = window.location.origin + window.location.pathname;
        history.replaceState({}, '', cleanUrl);
      }
    }
    // Register service worker for PWA + Push
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // Attempt push subscription after player loads
        window._swReg = reg;
      }).catch(() => {});
    }

    track('app_init');
    initOfferDismiss();
    // Fast splash — get users to action quickly
    setTimeout(() => {
      $('#splash').classList.add('fade-out');
      setTimeout(() => {
        $('#splash').classList.add('hidden');
        const stored = localStorage.getItem('goldpot_player_id');
        if (stored) {
          loadPlayer(stored);
        } else {
          track('hero_shown');
          showHeroScreen();
        }
      }, 300);
    }, 1000);

    setupCanvas();
    setupEvents();
    setupTabNav();
    setupScrollTopBtn();
    setupAdvancedActions();
    // Q49: prevent accidental pull-to-refresh; use manual refresh instead
    document.body.style.overscrollBehavior = 'none';
    // Push ad slots
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
    setupCardFormatting();
  }

  // ─── Hero Screen ─────────────────────────────────────────────────────────
  async function showHeroScreen() {
    const hero = $('#heroScreen');
    hero.classList.remove('hidden');
    // Hide chat on login screen
    var cs = $('#chatSidebar'); if (cs) cs.classList.add('hidden');
    var ce = $('#chatExpandBtn'); if (ce) ce.classList.add('hidden');
    var cb = $('#chatBubble'); if (cb) cb.classList.add('hidden');
    // Fetch state to populate hero with live data
    try {
      const st = await api('state');
      if (st && st.pots) {
        // Show the gold pot amount as the main showcase
        const gold = st.pots.gold;
        if (gold) {
          $('#heroPotAmount').textContent = '$' + gold.potDisplay;
        }
        // Winner stats
        if (st.totalPaidOut !== undefined) {
          const paidStr = '$' + (st.totalPaidOut / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
          $('#heroTotalPaid').textContent = paidStr;
        }
        if (st.winnerCount !== undefined) {
          $('#heroWinnerCount').textContent = st.winnerCount;
        }
        if (st.onlineCount) {
          $('#heroPlayersLive').textContent = st.onlineCount;
        }
        // Recent winner
        if (st.recentWinners && st.recentWinners.length > 0) {
          const w = st.recentWinners[0];
          $('#heroWinnerText').textContent = `Latest: ${w.name} won $${w.prize}!`;
        }
        // Show launch fund on hero too
        if (st.launchFund) {
          gameState = st;
          renderLaunchFund();
        }
      }
    } catch (e) {}

    $('#btnHeroJoin').addEventListener('click', () => {
      hero.classList.add('hidden');
      track('onboarding_shown');
      showNameModal();
    });
  }

  function setupCanvas() {
    game = new GoldPotGame($('#gameCanvas'));
    // Sync mute state from saved preference
    if (game.setMuted) game.setMuted(!soundEnabled);

    // Mine game: onScore fires each dig with running total
    game.onScore = (totalGold) => {
      lastGameScore = totalGold;
    };

    // Mine game: onTick fires each frame with game state
    game.onTick = (state) => {
      // Update HUD elements
      const hearts = '❤️'.repeat(state.lives) + '🖤'.repeat(Math.max(0, 3 - state.lives));
      $('#mineLives').textContent = hearts;
      $('#mineGold').textContent = state.gold;
      $('#mineBanked').textContent = state.banked;
      $('#mineDepth').textContent = state.depth + 'm';
      $('#mineMult').textContent = '×' + state.multiplier;
      $('#mineMult').style.color = state.multiplier >= 5 ? '#ff4040' : state.multiplier >= 3 ? '#c080ff' : state.multiplier >= 2 ? '#9090b0' : '#d4a574';
      const shieldEl = $('#mineShield');
      if (state.hasShield) shieldEl.classList.remove('hidden');
      else shieldEl.classList.add('hidden');
      // Show/hide cashout button
      const cashWrap = $('#mineCashoutWrap');
      if (state.gold > 0) cashWrap.classList.add('active');
      else cashWrap.classList.remove('active');
    };

    game.onEnd = (score) => {
      // Default handler for free/demo play — overridden in startGame()
      lastGameScore = score;
      isPlaying = false;
      $('#gameOverlay').classList.remove('active');
      $('#mineCashoutWrap').classList.remove('active');
      $('#gameStartOverlay').classList.remove('hidden');
      const banked = game.banked || 0;
      const bonusText = banked >= 300 ? '🏆 +3 BONUS ENTRIES!' : banked >= 150 ? '🎯 +2 BONUS ENTRIES!' : banked >= 50 ? '✨ +1 BONUS ENTRY!' : 'Dig deeper next time!';
      $('#gameStartOverlay').querySelector('.game-start-title').textContent = `💰 BANKED: ${banked}`;
      $('#gameStartOverlay').querySelector('.game-start-sub').textContent = bonusText;
    };

    game.onCombo = (c) => {
      if (c === 5 || c === 10 || c === 20) { showBonus(`🔥 ${c}x COMBO!`); SFX.combo(c >= 20 ? 4 : c >= 10 ? 3 : 2); }
      if (player && (c === 10 || c === 20)) {
        api('report-combo', { playerId: player.id, combo: c });
      }
    };

    // Cash Out button
    $('#btnCashout').addEventListener('click', () => {
      if (game && isPlaying) {
        game.cashOut();
      }
    });
  }

  // ─── Bottom Tab Navigation ───────────────────────────────────────────────
  const TAB_NAMES = ['play', 'offers', 'progress', 'social'];
  let _currentTab = 'play';
  const _scrollPositions = {};
  let _lastScrollY = 0;
  let _navHideTimer = null;

  function setupTabNav() {
    const nav = $('#bottomNav');
    if (!nav) return;
    const btns = nav.querySelectorAll('.bottom-nav-btn');
    const panels = document.querySelectorAll('.tab-panel');

    btns.forEach(b => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    // Swipe gesture support with Q13 peek indicators
    let touchStartX = 0, touchStartY = 0;
    document.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      // Q13: show peek indicator during swipe
      const dx = touchStartX - e.touches[0].clientX;
      const dy = Math.abs(touchStartY - e.touches[0].clientY);
      if (Math.abs(dx) > 20 && dy < 80) {
        const idx = TAB_NAMES.indexOf(_currentTab);
        const leftPeek = $('#tabPeekLeft');
        const rightPeek = $('#tabPeekRight');
        if (dx > 0 && idx < TAB_NAMES.length - 1 && rightPeek) rightPeek.classList.add('visible');
        else if (dx < 0 && idx > 0 && leftPeek) leftPeek.classList.add('visible');
      }
    }, { passive: true });
    document.addEventListener('touchend', e => {
      // Hide peek indicators
      const leftPeek = $('#tabPeekLeft');
      const rightPeek = $('#tabPeekRight');
      if (leftPeek) leftPeek.classList.remove('visible');
      if (rightPeek) rightPeek.classList.remove('visible');

      const dx = touchStartX - e.changedTouches[0].clientX;
      const dy = Math.abs(touchStartY - e.changedTouches[0].clientY);
      // Q32: tuned swipe threshold to 50px
      if (Math.abs(dx) > 50 && dy < 80) {
        // Don't swipe if inside chat sidebar
        if (e.target.closest && e.target.closest('.chat-sidebar')) return;
        const idx = TAB_NAMES.indexOf(_currentTab);
        if (dx > 0 && idx < TAB_NAMES.length - 1) switchTab(TAB_NAMES[idx + 1], 'left');
        else if (dx < 0 && idx > 0) switchTab(TAB_NAMES[idx - 1], 'right');
      }
    }, { passive: true });

    // Keyboard navigation — Q17: wrap around
    nav.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = TAB_NAMES.indexOf(_currentTab);
        let next;
        if (e.key === 'ArrowRight') next = TAB_NAMES[(idx + 1) % TAB_NAMES.length];
        else next = TAB_NAMES[(idx - 1 + TAB_NAMES.length) % TAB_NAMES.length];
        switchTab(next, e.key === 'ArrowRight' ? 'left' : 'right');
        const activeBtn = nav.querySelector('.bottom-nav-btn.active');
        if (activeBtn) activeBtn.focus();
      }
    });

    // Deep-link support: ?tab=progress
    const urlTab = new URL(window.location.href).searchParams.get('tab');
    if (urlTab && TAB_NAMES.includes(urlTab)) {
      switchTab(urlTab);
      return;
    }

    // Restore last tab from localStorage
    const saved = localStorage.getItem('goldpot_tab');
    if (saved && TAB_NAMES.includes(saved)) {
      switchTab(saved);
    }
  }

  function switchTab(name, direction) {
    if (!TAB_NAMES.includes(name)) return;
    const nav = $('#bottomNav');
    if (!nav) return;
    const btns = nav.querySelectorAll('.bottom-nav-btn');
    const panels = document.querySelectorAll('.tab-panel');

    // Determine slide direction if not explicitly given
    if (!direction) {
      const oldIdx = TAB_NAMES.indexOf(_currentTab);
      const newIdx = TAB_NAMES.indexOf(name);
      direction = newIdx > oldIdx ? 'left' : 'right';
    }

    // Save scroll position for current tab
    _scrollPositions[_currentTab] = window.scrollY;

    // Q47: show skeleton loading on incoming tab
    showTabSkeleton(name);

    // Update buttons
    btns.forEach(b => {
      const isActive = b.dataset.tab === name;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Q43: directional slide transition
    panels.forEach(p => {
      if (p.dataset.panel === name) {
        p.classList.add('active');
        p.classList.remove('tab-slide-left', 'tab-slide-right');
        p.classList.add(direction === 'left' ? 'tab-slide-left' : 'tab-slide-right');
        // Clean up animation class after it completes
        p.addEventListener('animationend', function handler() {
          p.classList.remove('tab-slide-left', 'tab-slide-right');
          p.removeEventListener('animationend', handler);
        });
      } else {
        p.classList.remove('active');
      }
    });

    // Q19: sticky pot on play tab
    const potSection = document.querySelector('.pot-section');
    if (potSection) {
      if (name === 'play') potSection.classList.add('pot-section-sticky');
      else potSection.classList.remove('pot-section-sticky');
    }

    _currentTab = name;
    localStorage.setItem('goldpot_tab', name);

    // Rotate visible offers when switching to the offers tab
    if (name === 'offers') rotateOffers();

    // Restore scroll position for this tab
    const savedY = _scrollPositions[name] || 0;
    window.scrollTo({ top: savedY, behavior: 'instant' });

    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(8);

    // Update scroll-to-top visibility
    updateScrollTopBtn();

    // Show bottom nav when switching tabs
    if (nav) nav.classList.remove('nav-hidden');
  }

  // Tab badge system
  function updateTabBadge(tabName, count) {
    const btn = document.querySelector(`.bottom-nav-btn[data-tab="${CSS.escape(tabName)}"]`);
    if (!btn) return;
    let dot = btn.querySelector('.bnav-dot');
    if (count > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'bnav-dot';
        btn.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }

  // Scroll-to-top button + Q37: auto-hide bottom nav on scroll down
  function setupScrollTopBtn() {
    const btn = $('#btnScrollTop');
    if (!btn) return;
    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    window.addEventListener('scroll', () => {
      updateScrollTopBtn();
      // Q37: auto-hide nav on scroll down, show on scroll up
      const nav = $('#bottomNav');
      if (nav) {
        const sy = window.scrollY;
        if (sy > _lastScrollY && sy > 200) {
          nav.classList.add('nav-hidden');
        } else {
          nav.classList.remove('nav-hidden');
        }
        _lastScrollY = sy;
      }
    }, { passive: true });
  }
  function updateScrollTopBtn() {
    const btn = $('#btnScrollTop');
    if (btn) btn.classList.toggle('visible', window.scrollY > 300);
  }

  // Expose switchTab & updateTabBadge globally for use by purchase flows, win handlers, etc.
  window.switchTab = function(name) { switchTab(name); };
  window.updateTabBadge = function(tab, count) { updateTabBadge(tab, count); };

  // Refresh tab badges based on current game/player state
  function refreshTabBadges() {
    // Offers tab: badge if flash pot active, lightning deal available, or power surge available
    let offersCount = 0;
    if (gameState) {
      if (gameState.flashPot && gameState.flashPot.active) offersCount++;
      if (gameState.lightningDeal && gameState.lightningDeal.active) offersCount++;
      if (gameState.powerSurge && gameState.powerSurge.active) offersCount++;
    }
    updateTabBadge('offers', offersCount);

    // Progress tab: badge if unclaimed achievements or daily bonus ready
    let progressCount = 0;
    if (player) {
      const today = new Date().toDateString();
      if (player.lastDailyBonus !== today) progressCount++; // daily bonus available
      if (player.lastSpin !== today) progressCount++; // spin wheel available
    }
    updateTabBadge('progress', progressCount);

    // Social tab: badge if referral rewards waiting
    let socialCount = 0;
    if (player && player.referralCount > 0) {
      // Show badge if they have active referrals (encourage sharing)
      socialCount = 0; // Only show when new referrals arrive — controlled by server push
    }
    updateTabBadge('social', socialCount);
  }

  function setupEvents() {
    // ── Age Confirmation ──
    const ageBox = $('#ageConfirm');
    const joinBtn = $('#btnJoin');
    if (ageBox) {
      ageBox.addEventListener('change', () => {
        joinBtn.disabled = !ageBox.checked;
      });
    }

    // ── Custom State Picker ──
    (function initStatePicker() {
      const BLOCKED = ['NY','FL','RI','UT','HI'];
      const STATES = [
        { group: 'Popular', items: [['CA','California'],['TX','Texas'],['FL','Florida'],['NY','New York'],['PA','Pennsylvania'],['IL','Illinois'],['OH','Ohio'],['GA','Georgia'],['NC','North Carolina'],['MI','Michigan']] },
        { group: 'Northeast', items: [['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['NH','New Hampshire'],['NJ','New Jersey'],['RI','Rhode Island'],['VT','Vermont'],['VA','Virginia'],['WV','West Virginia']] },
        { group: 'Southeast', items: [['AL','Alabama'],['AR','Arkansas'],['KY','Kentucky'],['LA','Louisiana'],['MS','Mississippi'],['SC','South Carolina'],['TN','Tennessee']] },
        { group: 'Midwest', items: [['IA','Iowa'],['IN','Indiana'],['KS','Kansas'],['MN','Minnesota'],['MO','Missouri'],['NE','Nebraska'],['ND','North Dakota'],['SD','South Dakota'],['WI','Wisconsin']] },
        { group: 'West', items: [['AK','Alaska'],['AZ','Arizona'],['CO','Colorado'],['HI','Hawaii'],['ID','Idaho'],['MT','Montana'],['NV','Nevada'],['NM','New Mexico'],['OK','Oklahoma'],['OR','Oregon'],['UT','Utah'],['WA','Washington'],['WY','Wyoming']] }
      ];
      const picker = $('#statePicker');
      const btn = $('#statePickerBtn');
      const dropdown = $('#stateDropdown');
      const list = $('#stateList');
      const search = $('#stateSearch');
      const label = $('#statePickerLabel');
      const hidden = $('#playerStateInput');
      if (!picker) return;

      let highlighted = -1;
      let flatItems = [];

      function render(filter) {
        list.innerHTML = '';
        flatItems = [];
        const q = (filter || '').toLowerCase();
        STATES.forEach(g => {
          const matches = g.items.filter(([code, name]) => !q || name.toLowerCase().includes(q) || code.toLowerCase().includes(q));
          if (!matches.length) return;
          const gl = document.createElement('div');
          gl.className = 'state-picker-group-label';
          gl.textContent = g.group;
          list.appendChild(gl);
          matches.forEach(([code, name]) => {
            const isBlocked = BLOCKED.includes(code);
            const opt = document.createElement('div');
            opt.className = 'state-picker-option' + (hidden.value === code ? ' selected-opt' : '') + (isBlocked ? ' blocked' : '');
            opt.setAttribute('role', 'option');
            if (isBlocked) opt.setAttribute('aria-disabled', 'true');
            const abbr = document.createElement('span');
            abbr.className = 'state-abbr';
            abbr.textContent = code;
            opt.appendChild(abbr);
            opt.appendChild(document.createTextNode(name));
            if (isBlocked) {
              const tag = document.createElement('span');
              tag.className = 'state-blocked-tag';
              tag.textContent = 'Not available';
              opt.appendChild(tag);
            }
            opt.dataset.code = code;
            opt.dataset.name = name;
            if (!isBlocked) {
              opt.addEventListener('click', () => selectState(code, name));
              flatItems.push(opt);
            }
            list.appendChild(opt);
          });
        });
        highlighted = -1;
        if (!flatItems.length) {
          list.innerHTML = '<div class="state-picker-empty">No states found</div>';
        }
      }

      function selectState(code, name) {
        hidden.value = code;
        label.textContent = name;
        btn.classList.add('selected');
        close();
      }

      function open() {
        dropdown.classList.remove('hidden');
        picker.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        search.value = '';
        render('');
        setTimeout(() => search.focus(), 30);
      }

      function close() {
        dropdown.classList.add('hidden');
        picker.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }

      function highlightIdx(idx) {
        flatItems.forEach(el => el.classList.remove('highlighted'));
        if (idx >= 0 && idx < flatItems.length) {
          highlighted = idx;
          flatItems[idx].classList.add('highlighted');
          flatItems[idx].scrollIntoView({ block: 'nearest' });
        }
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        dropdown.classList.contains('hidden') ? open() : close();
      });

      search.addEventListener('input', () => render(search.value));

      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); highlightIdx(Math.min(highlighted + 1, flatItems.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); highlightIdx(Math.max(highlighted - 1, 0)); }
        else if (e.key === 'Enter' && highlighted >= 0 && flatItems[highlighted]) {
          e.preventDefault();
          const el = flatItems[highlighted];
          selectState(el.dataset.code, el.dataset.name);
        } else if (e.key === 'Escape') { close(); btn.focus(); }
      });

      document.addEventListener('click', (e) => {
        if (!picker.contains(e.target)) close();
      });

      render('');
    })();

    // ── Onboarding Step 1: Name → Step 2: Payment ──
    $('#btnJoin').addEventListener('click', async () => {
      const name = $('#playerNameInput').value.trim();
      const email = ($('#playerEmailInput') ? $('#playerEmailInput').value.trim() : '');
      const stateVal = ($('#playerStateInput') ? $('#playerStateInput').value : '');
      const ref = ($('#refCodeInput').value.trim() || window._pendingRefCode || '').toUpperCase();
      if (!name) { $('#playerNameInput').focus(); return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('Please enter a valid email address'); $('#playerEmailInput').focus(); return; }
      if (!stateVal) { $('#statePickerBtn').focus(); $('#statePickerBtn').click(); return; }
      // Register immediately
      const data = await api('register', { name, email: email || undefined, state: stateVal, referralCode: ref || undefined });
      player = data.player;
      if (data.token) localStorage.setItem('goldpot_token', data.token);
      localStorage.setItem('goldpot_player_id', player.id);
      // Store verification link for email verification prompt
      if (data.emailVerifyToken) {
        localStorage.setItem('goldpot_verify_url', '/api/verify-email?id=' + encodeURIComponent(player.id) + '&token=' + encodeURIComponent(data.emailVerifyToken));
      }
      track('onboarding_name_completed', { referred: !!ref });
      // Move to Step 2: payment
      $('#onboardStep1').classList.add('hidden');
      $('#onboardStep2').classList.remove('hidden');
      $$('.onboard-step').forEach(s => {
        if (s.dataset.step === '1') { s.classList.remove('active'); s.classList.add('done'); s.querySelector('span').textContent = '✓'; }
        if (s.dataset.step === '2') s.classList.add('active');
      });
      // Q45: update progress dots
      updateOnboardDots(2);
    });

    $('#playerNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btnJoin').click();
    });

    // ── Onboarding Step 2: Payment method selection ──
    setupPaymentGrid('onboardPaymentGrid');

    $('#btnSavePayment').addEventListener('click', async () => {
      if (!selectedPayMethod) { showBonus('Pick a payment method'); return; }
      await savePaymentMethod();
      closeModal('nameModal');
      showApp();
      track('onboarding_payment_completed', { method: selectedPayMethod });
      showBonus('🎉 You\'re all set! Start playing!');
    });

    $('#btnSkipPayment').addEventListener('click', () => {
      track('onboarding_payment_skipped');
      closeModal('nameModal');
      showApp();
    });

    // ── Change payment method (from top bar) ──
    $('#paymentBtn').addEventListener('click', () => {
      selectedPayMethod = null;
      if (player && player.paymentMethod) {
        $('#currentMethod').innerHTML = `<span>${esc(player.paymentMethod.icon)}</span> <span>${esc(player.paymentMethod.label)}</span> <span style="color:var(--green)">✓ Active</span>`;
        $('#currentMethod').classList.remove('hidden');
      } else {
        $('#currentMethod').classList.add('hidden');
      }
      // Reset selections
      $$('#paymentGrid .pay-option').forEach(o => o.classList.remove('selected'));
      openModal('paymentModal');
    });

    setupPaymentGrid('paymentGrid');

    $('#btnUpdatePayment').addEventListener('click', async () => {
      if (!selectedPayMethod) { showBonus('Pick a payment method'); return; }
      await savePaymentMethod();
      closeModal('paymentModal');
      showBonus('💳 Payment updated!');
    });

    $('#btnClosePayment').addEventListener('click', () => closeModal('paymentModal'));

    // ── Withdraw ──
    let selectedWithdrawMethod = null;

    $('#btnWithdraw').addEventListener('click', async () => {
      if (!player) return;
      selectedWithdrawMethod = null;
      $$('.withdraw-method-option').forEach(o => o.classList.remove('selected'));
      $('#withdrawHandleWrap').classList.add('hidden');
      $('#stripeConnectWrap').classList.add('hidden');
      $('#withdrawHandleInput').value = '';
      $('#withdrawAmountInput').value = '';
      $('#withdrawForm').classList.remove('hidden');
      $('#withdrawSuccess').classList.add('hidden');
      // Fetch latest balance
      const data = await api('withdrawals');
      if (!data.error) {
        $('#withdrawAvailable').textContent = '$' + data.availableDisplay;
        if (data.pendingTotal > 0) {
          $('#withdrawPendingInfo').classList.remove('hidden');
          $('#withdrawPendingAmount').textContent = data.pendingDisplay;
        } else {
          $('#withdrawPendingInfo').classList.add('hidden');
        }
        renderWithdrawHistory(data.withdrawals);
      }
      openModal('withdrawModal');
    });

    $$('.withdraw-method-option').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedWithdrawMethod = btn.dataset.method;
        $$('.withdraw-method-option').forEach(o => o.classList.remove('selected'));
        btn.classList.add('selected');
        if (selectedWithdrawMethod === 'stripe_connect') {
          $('#withdrawHandleWrap').classList.add('hidden');
          $('#stripeConnectWrap').classList.remove('hidden');
          checkConnectStatus();
        } else {
          $('#stripeConnectWrap').classList.add('hidden');
          const labels = { paypal: 'PayPal email', cashapp: 'Cash App $cashtag', venmo: 'Venmo username' };
          const placeholders = { paypal: 'you@email.com', cashapp: '$yourcashtag', venmo: '@yourusername' };
          $('#withdrawHandleLabel').textContent = labels[selectedWithdrawMethod];
          $('#withdrawHandleInput').placeholder = placeholders[selectedWithdrawMethod];
          $('#withdrawHandleWrap').classList.remove('hidden');
          setTimeout(() => $('#withdrawHandleInput').focus(), 100);
        }
      });
    });

    async function checkConnectStatus() {
      const res = await fetch('/api/connect-status', {
        headers: { 'Authorization': 'Bearer ' + getAuthToken() },
      });
      const data = await res.json();
      const msgEl = $('#connectStatusMsg');
      const connectBtn = $('#btnConnectBank');
      const dashBtn = $('#btnConnectDashboard');
      if (data.connected) {
        msgEl.textContent = '✅ Bank account connected — ready for payouts';
        msgEl.className = 'connect-status-msg connected';
        connectBtn.classList.add('hidden');
        dashBtn.classList.remove('hidden');
      } else if (data.detailsSubmitted) {
        msgEl.textContent = '⏳ Account under review by Stripe';
        msgEl.className = 'connect-status-msg pending';
        connectBtn.textContent = '🔄 Update Info';
        connectBtn.classList.remove('hidden');
        dashBtn.classList.add('hidden');
      } else {
        msgEl.textContent = 'Connect your bank to receive instant payouts';
        msgEl.className = 'connect-status-msg';
        connectBtn.textContent = '🔗 Connect Your Bank';
        connectBtn.classList.remove('hidden');
        dashBtn.classList.add('hidden');
      }
    }

    $('#btnConnectBank').addEventListener('click', async () => {
      if (!player) return;
      const res = await api('connect-account', { playerId: player.id });
      if (res.url) {
        window.location.href = res.url;
      }
    });

    $('#btnConnectDashboard').addEventListener('click', async () => {
      if (!player) return;
      const res = await api('connect-dashboard', { playerId: player.id });
      if (res.url) {
        window.open(res.url, '_blank');
      }
    });

    $('#btnWithdrawMax').addEventListener('click', async () => {
      const data = await api('withdrawals');
      if (!data.error && data.available > 0) {
        $('#withdrawAmountInput').value = (data.available / 100).toFixed(2);
      }
    });

    $('#btnSubmitWithdraw').addEventListener('click', async () => {
      if (!player) return;
      if (!selectedWithdrawMethod) { showError('Please select a withdrawal method'); return; }
      let handle = '';
      if (selectedWithdrawMethod !== 'stripe_connect') {
        handle = $('#withdrawHandleInput').value.trim();
        if (!handle || handle.length < 3) { showError('Please enter a valid account handle'); return; }
      }
      const amountStr = $('#withdrawAmountInput').value.trim();
      const amountDollars = parseFloat(amountStr);
      if (!amountDollars || amountDollars < 5) { showError('Minimum withdrawal is $5.00'); return; }
      const cents = Math.round(amountDollars * 100);

      const result = await api('withdraw', {
        playerId: player.id,
        method: selectedWithdrawMethod,
        handle,
        amount: cents,
      });
      if (!result.error) {
        $('#withdrawForm').classList.add('hidden');
        $('#withdrawSuccessMsg').textContent = result.message;
        $('#withdrawSuccess').classList.remove('hidden');
        SFX.win();
        track('withdrawal_submitted', { amount: cents, method: selectedWithdrawMethod });
        // Refresh history
        const updated = await api('withdrawals');
        if (!updated.error) renderWithdrawHistory(updated.withdrawals);
      }
    });

    function renderWithdrawHistory(withdrawals) {
      const container = $('#withdrawHistory');
      if (!withdrawals || withdrawals.length === 0) {
        container.innerHTML = '';
        return;
      }
      const statusIcons = { pending: '\u23f3', approved: '\u2705', rejected: '\u274c' };
      const statusLabels = { pending: 'Pending', approved: 'Sent', rejected: 'Declined' };
      container.innerHTML = '<div class="wh-title">History</div>' +
        withdrawals.slice(0, 10).map(w => {
          const date = new Date(w.requestedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const safeStatus = statusLabels[w.status] || esc(String(w.status));
          return `<div class="wh-row">
            <span class="wh-status">${statusIcons[w.status] || ''} ${safeStatus}</span>
            <span class="wh-detail">$${esc(String(w.amountDisplay))} \u2192 ${esc(w.methodLabel)}</span>
            <span class="wh-date">${esc(date)}</span>
          </div>`;
        }).join('');
    }

    $('#btnCloseWithdraw').addEventListener('click', () => closeModal('withdrawModal'));

    // ── Checkout sheet ──
    $('#checkoutClose').addEventListener('click', () => hideCheckout());
    $('#btnCheckoutConfirm').addEventListener('click', async () => {
      track('checkout_confirmed', { quantity: pendingPurchaseQty, pot: currentPot });
      const btn = $('#btnCheckoutConfirm');
      btn.disabled = true;
      btn.querySelector('.checkout-pay-label').textContent = 'Processing...';

      const res = await api('create-checkout-session', {
        playerId: player.id,
        quantity: pendingPurchaseQty,
        potId: currentPot,
        purchaseType: 'premium',
      });
      btn.disabled = false;

      if (res.error) {
        const pm = player.paymentMethod;
        const price = pendingPurchaseQty === 1 ? '1.00' : (gameState.bundles[pendingPurchaseQty] ? (gameState.bundles[pendingPurchaseQty].price / 100).toFixed(2) : pendingPurchaseQty.toFixed(2));
        btn.querySelector('.checkout-pay-label').textContent = `Pay $${price} with ${pm.label}`;
        return;
      }

      if (res.demo) {
        // Demo mode: no Stripe key — play game directly
        hideCheckout();
        startGame(pendingPurchaseQty);
      } else if (res.url) {
        // Real Stripe: save pending state and redirect
        sessionStorage.setItem('goldpot_pending_purchase', JSON.stringify({
          qty: pendingPurchaseQty,
          pot: currentPot,
          type: 'premium',
        }));
        window.location.href = res.url;
      }
    });

    // Pot tabs
    $$('.pot-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentPot = tab.dataset.pot;
        _urgencyNudgeShown = false;
        _criticalNudgeShown = false;
        $$('.pot-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        renderPot();
      });
    });

    // Premium button — donate $1 to current pot (pre-launch mode)
    $('#btnPremium').addEventListener('click', async () => {
      if (!player) return;
      const btn = $('#btnPremium');
      if (btn.disabled) return;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '⏳ Processing...';
      SFX.click();
      try {
        const name = player ? player.name : 'Anonymous';
        const res = await api('donate', { amount: 100, name, potId: currentPot });
        if (res && res.demo) {
          showBonus('💚 $1 added to the ' + (currentPot || 'gold').toUpperCase() + ' pot!');
          fetchState();
        } else if (res && res.url) {
          window.location.href = res.url;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

    // Quick Entry — skip game, instant purchase
    $('#btnQuickEntry').addEventListener('click', async () => {
      if (!player) return;
      if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
      const btn = $('#btnQuickEntry');
      btn.disabled = true;
      const res = await api('create-checkout-session', {
        playerId: player.id,
        quantity: 1,
        potId: currentPot,
        purchaseType: 'premium',
      });
      btn.disabled = false;
      if (res.error) return;
      if (res.demo) {
        // Demo mode: add entry directly
        const entry = await api('premium-entry', { playerId: player.id, quantity: 1, potId: currentPot, gameScore: 0 });
        if (!entry.error) {
          player = entry.player;
          renderPlayer();
          fetchState();
          showBonus('⚡ Quick entry added!');
          track('quick_entry', { pot: currentPot });
        }
      } else if (res.url) {
        sessionStorage.setItem('goldpot_pending_purchase', JSON.stringify({
          qty: 1, pot: currentPot, type: 'quick',
        }));
        window.location.href = res.url;
      }
    });

    const btnNextAction = $('#btnNextAction');
    if (btnNextAction) btnNextAction.addEventListener('click', () => {
      if (!player) return;
      const step = !player.paymentMethod ? 'add_payment' : ((player.totalSpent || 0) === 0 ? 'first_play' : 'play_again');
      track('guided_next_action_click', { step, totalSpent: player.totalSpent || 0 });
      if (!player.paymentMethod) {
        $('#paymentBtn').click();
        return;
      }
      showCheckout(1);
    });

    // Starter offer (first purchase accelerator)
    $('#btnStarterOffer').addEventListener('click', claimStarterOffer);

    // Bundles — show checkout confirmation
    $$('.btn-bundle, .btn-mega-bundle, .btn-whale-bundle').forEach(btn => {
      btn.addEventListener('click', () => showCheckout(parseInt(btn.dataset.qty)));
    });

    // Play Again (in-game quick replay)
    $('#btnPlayAgain').addEventListener('click', () => {
      SFX.click();
      showCheckout(1);
    });

    // Free entry
    $('#btnFree').addEventListener('click', async () => {
      if (!player) return;
      const res = await api('free-entry', { playerId: player.id, potId: currentPot });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      renderPot();
      showBonus('✅ Free entry added!');
    });

    // Daily bonus
    $('#btnDailyBonus').addEventListener('click', async () => {
      if (!player) return;
      const res = await api('daily-bonus', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      detectNewAchievements(player);
      renderPlayer();
      showBonus(`🎁 +${res.bonusEntries} BONUS (${res.streak} day streak!)`);
      $('#btnDailyBonus').classList.add('claimed');
      $('#btnDailyBonus').textContent = 'CLAIMED ✓';
    });

    // Spin wheel
    $('#btnSpinWheel').addEventListener('click', () => {
      openModal('wheelModal');
      const c = document.getElementById('wheelCanvas');
      if (c) { wheelDrawn = false; drawWheel(c, 0); startLedAnimation(false); }
    });

    setupSpinButton();

    // Watch Ad
    $('#btnWatchAd').addEventListener('click', watchAd);

    // Near-miss modal
    $('#btnNearMissPlay').addEventListener('click', () => {
      closeModal('nearMissModal');
      showCheckout(5);
    });
    $('#btnNearMissDismiss').addEventListener('click', () => closeModal('nearMissModal'));

    // Ad close
    $('#adClose').addEventListener('click', () => {
      // Only allow close after timer finishes — enforced via visibility
    });

    // Share
    $('#shareBtn').addEventListener('click', shareApp);
    $('#shareX').addEventListener('click', () => shareVia('twitter'));
    $('#shareSMS').addEventListener('click', () => shareVia('sms'));
    $('#shareLink').addEventListener('click', () => shareVia('link'));
    $('#btnCopy').addEventListener('click', copyReferral);

    // Logout
    $('#logoutBtn').addEventListener('click', () => {
      if (!confirm('Log out of GOLDPOT?')) return;
      localStorage.removeItem('goldpot_player_id');
      localStorage.removeItem('goldpot_token');
      localStorage.removeItem('goldpot_verify_url');
      if (pollTimer) clearInterval(pollTimer);
      if (ws) { ws.close(); ws = null; }
      player = null;
      $('#app').classList.add('hidden');
      showHeroScreen();
    });

    const btnRefCopyLink = $('#btnRefCopyLink');
    if (btnRefCopyLink) btnRefCopyLink.addEventListener('click', () => {
      const refUrl = getReferralUrl();
      navigator.clipboard.writeText(refUrl).then(() => {
        btnRefCopyLink.textContent = '✅ Copied!';
        setTimeout(() => { btnRefCopyLink.textContent = '📋 Copy My Referral Link'; }, 2000);
      }).catch(() => {});
    });

    // Winner modal
    $('#btnNewRound').addEventListener('click', () => closeModal('winnerModal'));
    // Winner share buttons
    const winShareX = $('#winShareX');
    const winShareSMS = $('#winShareSMS');
    const winShareNative = $('#winShareNative');
    const winShareCopy = $('#winShareCopy');
    if (winShareX) winShareX.addEventListener('click', () => shareWin('twitter', window._lastWinPrize, window._lastWinPot));
    if (winShareSMS) winShareSMS.addEventListener('click', () => shareWin('sms', window._lastWinPrize, window._lastWinPot));
    if (winShareNative) winShareNative.addEventListener('click', () => shareWin('native', window._lastWinPrize, window._lastWinPot));
    if (winShareCopy) winShareCopy.addEventListener('click', () => shareWin('copy', window._lastWinPrize, window._lastWinPot));

    // Mute toggle
    $('#muteBtn').textContent = soundEnabled ? '🔊' : '🔇';
    $('#muteBtn').addEventListener('click', () => {
      SFX.click(); // play feedback before toggling off
      soundEnabled = !soundEnabled;
      localStorage.setItem('goldpot_muted', soundEnabled ? 'false' : 'true');
      $('#muteBtn').textContent = soundEnabled ? '🔊' : '🔇';
      // Sync to game engine
      if (game && game.setMuted) game.setMuted(!soundEnabled);
    });

    // Flash pot entry
    $('#btnFlashEnter').addEventListener('click', async () => {
      if (!player) return;
      if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
      SFX.flash();
      await stripePurchase({ purchaseType: 'flash_entry' }, async () => {
        const res = await api('flash-entry', { playerId: player.id, quantity: 1 });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        showBonus('⚡ Entered FLASH POT!');
        fetchState();
      });
    });

    // Flash pot tab
    $('#flashTab').addEventListener('click', () => {
      const banner = $('#flashBanner');
      if (!banner.classList.contains('hidden')) {
        banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Jackpot entry buttons
    $('#btnJackpotEnter1').addEventListener('click', () => enterJackpot(1));
    $('#btnJackpotEnter5').addEventListener('click', () => enterJackpot(5));
    $('#btnJackpotEnter25').addEventListener('click', () => enterJackpot(25));

    // Jackpot tab — scroll to banner
    $('#jackpotTab').addEventListener('click', () => {
      const banner = $('#jackpotBanner');
      if (!banner.classList.contains('hidden')) {
        banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Jackpot announce modal — pre-launch: scroll to donate section
    $('#btnJpAnnouncePlay').addEventListener('click', () => {
      closeModal('jackpotAnnounceModal');
      // Scroll to the launch fund section for donation
      const fundSection = $('#launchFundSection');
      if (fundSection) {
        switchTab('social');
        setTimeout(() => fundSection.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      }
    });
    $('#btnJpAnnounceDismiss').addEventListener('click', () => closeModal('jackpotAnnounceModal'));

    // Jackpot winner modal
    $('#btnJpWinnerClose').addEventListener('click', () => closeModal('jackpotWinnerModal'));

    // VIP subscribe
    $$('.btn-vip').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!player) return;
        if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
        SFX.click();
        const vipType = btn.dataset.tier === 'monthly' ? 'vip_monthly' : 'vip_weekly';
        await stripePurchase({ purchaseType: vipType }, async () => {
          const res = await api('vip-subscribe', { playerId: player.id, tier: btn.dataset.tier });
          if (res.error) { showBonus(res.error); return; }
          player = res.player;
          renderPlayer();
          renderVipStatus();
          showBonus('👑 VIP Pass Activated!');
          SFX.win();
        });
      });
    });

    // Double Down
    $('#btnDoubleDown').addEventListener('click', async () => {
      if (!player) return;
      closeModal('doubleDownModal');
      await stripePurchase({
        purchaseType: 'double_down',
        quantity: pendingDoubleDownQty,
        potId: currentPot,
        pendingData: { firstPurchaseBoost: pendingFirstPurchaseBoost },
      }, async () => {
        const res = await api('double-down', { playerId: player.id, potId: currentPot, originalQty: pendingDoubleDownQty, firstPurchaseBoost: pendingFirstPurchaseBoost });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderPlayer();
        fetchState();
        showBonus(`⚡ +${res.qty} DOUBLE DOWN ENTRIES!${res.bonusQty > 0 ? ` (+${res.bonusQty} first-buyer boost)` : ''}`);
        track('double_down_accepted', { qty: res.qty, bonusQty: res.bonusQty || 0, firstPurchaseBoost: pendingFirstPurchaseBoost });
        pendingFirstPurchaseBoost = false;
        if (res.winnerDrawn && res.winnerDrawn.winner) {
          setTimeout(() => showWinner(res.winnerDrawn.winner), 1500);
          checkNearMissWithCooldown(res.winnerDrawn);
        }
      });
    });
    $('#btnDdSkip').addEventListener('click', () => closeModal('doubleDownModal'));

    // Backdrop close
    $$('.modal-backdrop').forEach(bd => {
      bd.addEventListener('click', () => {
        bd.parentElement.classList.add('hidden');
      });
    });

    // ── FOMO Feature Events ──

    // Mystery Boxes
    $$('.mystery-box').forEach(box => {
      box.addEventListener('click', () => buyMysteryBox(box.dataset.tier));
    });
    $('#btnMysteryClose').addEventListener('click', () => closeModal('mysteryRevealModal'));

    // Lightning Deal
    $('#btnLightningBuy').addEventListener('click', buyLightningDeal);

    // Power Surge
    $('#btnPowerSurge').addEventListener('click', buyPowerSurge);

    // All-In Pack
    $('#btnAllIn').addEventListener('click', buyAllIn);

    // Streak Saver
    $('#btnStreakSaver').addEventListener('click', buyStreakSaver);

    // Limited Edition Drop
    $('#btnLimitedBuy').addEventListener('click', buyLimited);

    // Mega Multiplier
    $('#btnMegaMult').addEventListener('click', buyMegaMultiplier);
    $('#btnMegaMultSkip').addEventListener('click', () => closeModal('megaMultModal'));

    // VIP Diamond
    var btnDiamond = $('#btnVipDiamond');
    if (btnDiamond) btnDiamond.addEventListener('click', () => {
      showDiamondPerks();
      stripePurchase({ purchaseType: 'vip_diamond' }, async () => {
        var res = await api('vip-subscribe', { playerId: player.id, tier: 'diamond' });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderPlayer(); renderVipStatus();
        showBonus('💎 VIP DIAMOND activated!');
        SFX.jackpotWin();
      });
    });

    // Battle Pass
    var btnBp = $('#btnBpBuy');
    if (btnBp) btnBp.addEventListener('click', buyBattlePass);
    var bpTrack = $('#bpTrack');
    if (bpTrack) bpTrack.addEventListener('click', function(e) {
      var tier = e.target.closest('.bp-tier-claim') || e.target.closest('.bp-claimable');
      if (tier) {
        var t = tier.closest('.bp-tier');
        if (t) claimBattlePassTier(parseInt(t.dataset.bptier));
      }
    });

    // Tournament
    var btnTourney = $('#btnTourneyEnter');
    if (btnTourney) btnTourney.addEventListener('click', enterTournament);

    // Lucky Boost
    var btnBoost = $('#btnLuckyBoost');
    if (btnBoost) btnBoost.addEventListener('click', buyLuckyBoost);

    // Second Chance
    var btnSC = $('#btnSecondChance');
    if (btnSC) btnSC.addEventListener('click', buySecondChance);

    // Gift Entries
    var btnGift = $('#btnGift');
    if (btnGift) btnGift.addEventListener('click', openGiftModal);
    var btnGiftSend = $('#btnGiftSend');
    if (btnGiftSend) btnGiftSend.addEventListener('click', sendGift);
    var btnGiftClose = $('#btnGiftClose');
    if (btnGiftClose) btnGiftClose.addEventListener('click', () => closeModal('giftModal'));
    $$('.gift-qty-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        $$('.gift-qty-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        giftQty = parseInt(btn.dataset.giftqty) || 3;
        updateGiftTotal();
      });
    });

    // Cosmetics
    var btnCos = $('#btnCosmetics');
    if (btnCos) btnCos.addEventListener('click', openCosmeticsModal);
    var btnCosClose = $('#btnCosmeticsClose');
    if (btnCosClose) btnCosClose.addEventListener('click', () => closeModal('cosmeticsModal'));
    $$('.cosmetics-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        $$('.cosmetics-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        cosmeticsType = tab.dataset.costype;
        renderCosmeticsGrid();
      });
    });
    var cosGrid = $('#cosmeticsGrid');
    if (cosGrid) cosGrid.addEventListener('click', function(e) {
      var item = e.target.closest('.cosmetic-item');
      if (item) handleCosmeticClick(item.dataset.cosid);
    });

    // Urgency Bundle
    var btnUrg = $('#btnUrgencyBuy');
    if (btnUrg) btnUrg.addEventListener('click', buyUrgencyBundle);

    // Donate buttons (launch fund)
    $$('.btn-donate').forEach(btn => {
      btn.addEventListener('click', async () => {
        const amount = parseInt(btn.dataset.amount);
        if (!amount) return;
        SFX.click();
        const name = player ? player.name : 'Anonymous';
        const res = await api('donate', { amount, name });
        if (res && res.demo) {
          showBonus('💚 Thank you for your $' + (amount / 100) + ' donation!');
          fetchState();
        } else if (res && res.url) {
          window.location.href = res.url;
        }
      });
    });

    // Donate-to-pot buttons (pre-launch: donate directly into the selected pot)
    $$('.btn-donate-pot').forEach(btn => {
      btn.addEventListener('click', async () => {
        const amount = parseInt(btn.dataset.amount);
        if (!amount) return;
        SFX.click();
        const name = player ? player.name : 'Anonymous';
        const res = await api('donate', { amount, name, potId: currentPot });
        if (res && res.demo) {
          showBonus('💚 $' + (amount / 100) + ' added to ' + (currentPot || 'gold').toUpperCase() + ' pot!');
          fetchState();
        } else if (res && res.url) {
          window.location.href = res.url;
        }
      });
    });
  }

  // ─── Premium Canvas Spin Wheel ──────────────────────────────────────────
  const WHEEL_SEGMENTS = [
    { label: '1 Entry',    short: '1',   color: '#f0c040', text: '#1a1000', icon: '🎟️', type: 'entry', value: 1 },
    { label: '2 Entries',  short: '2',   color: '#60c0ff', text: '#0a2040', icon: '🎟️', type: 'entry', value: 2 },
    { label: '3 Entries',  short: '3',   color: '#ff6090', text: '#3a0015', icon: '🎟️', type: 'entry', value: 3 },
    { label: '5 Entries',  short: '5',   color: '#40e070', text: '#0a2010', icon: '⭐', type: 'entry', value: 5 },
    { label: '2× Next',   short: '2×',  color: '#b060ff', text: '#1a0030', icon: '🔥', type: 'multiplier', value: 2 },
    { label: '10 Entries', short: '10',  color: '#ff8040', text: '#2a1000', icon: '💎', type: 'entry', value: 10 },
    { label: 'Shield',     short: '🛡️',  color: '#60ffe0', text: '#0a2020', icon: '🛡️', type: 'streak_shield', value: 1 },
    { label: '25 JACKPOT', short: '25!', color: '#ffe060', text: '#2a1a00', icon: '👑', type: 'entry', value: 25 },
  ];
  const WHEEL_SEG_COUNT = WHEEL_SEGMENTS.length;
  const WHEEL_ARC = (Math.PI * 2) / WHEEL_SEG_COUNT;
  let wheelAngle = 0;
  let wheelSpinning = false;
  let wheelDrawn = false;
  let ledAnimFrame = 0;
  let ledAnimId = null;

  function drawWheel(canvas, angle) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = 340;
    if (!wheelDrawn) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      wheelDrawn = true;
    }
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, r = size / 2 - 8;

    // Metallic outer ring
    const ringGrad = ctx.createRadialGradient(cx, cy, r - 2, cx, cy, r + 5);
    ringGrad.addColorStop(0, '#d4a020');
    ringGrad.addColorStop(0.4, '#f0d060');
    ringGrad.addColorStop(0.6, '#b8860d');
    ringGrad.addColorStop(1, '#8a6508');
    ctx.beginPath(); ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = ringGrad; ctx.lineWidth = 7; ctx.stroke();

    // Inner shadow ring
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2; ctx.stroke();

    // Segments
    for (let i = 0; i < WHEEL_SEG_COUNT; i++) {
      const seg = WHEEL_SEGMENTS[i];
      const startA = angle + i * WHEEL_ARC;
      const endA = startA + WHEEL_ARC;

      // Fill with radial gradient
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r - 2, startA, endA); ctx.closePath();
      const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
      grad.addColorStop(0, lightenColor(seg.color, 40));
      grad.addColorStop(0.5, seg.color);
      grad.addColorStop(1, darkenColor(seg.color, 15));
      ctx.fillStyle = grad; ctx.fill();

      // Subtle shine overlay
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r * 0.7, startA, endA); ctx.closePath();
      const shineGrad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r * 0.7);
      shineGrad.addColorStop(0, 'rgba(255,255,255,0.15)');
      shineGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shineGrad; ctx.fill();

      // Divider line
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(startA) * (r - 2), cy + Math.sin(startA) * (r - 2));
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 2; ctx.stroke();
      // Light edge
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(startA + 0.01) * (r - 2), cy + Math.sin(startA + 0.01) * (r - 2));
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();

      // Label and icon
      const midA = startA + WHEEL_ARC / 2;
      ctx.save();
      ctx.translate(cx + Math.cos(midA) * r * 0.58, cy + Math.sin(midA) * r * 0.58);
      ctx.rotate(midA + Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Short value (big)
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4;
      ctx.font = 'bold 20px "Inter", sans-serif';
      ctx.fillStyle = seg.text;
      ctx.fillText(seg.short, 0, -4);
      ctx.shadowBlur = 0;
      // Sub-label (small)
      ctx.font = '600 9px "Inter", sans-serif';
      ctx.globalAlpha = 0.65;
      ctx.fillText(seg.label, 0, 14);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Inner decorative circle
    ctx.beginPath(); ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    const innerGrad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 32);
    innerGrad.addColorStop(0, '#2a2a42');
    innerGrad.addColorStop(0.7, '#1a1a2e');
    innerGrad.addColorStop(1, '#0f0f1a');
    ctx.fillStyle = innerGrad; ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,64,0.5)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.restore();
  }

  function drawLedRing(ledCanvas, frame, spinning) {
    const ctx = ledCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = 380;
    if (ledCanvas.width !== size * dpr) {
      ledCanvas.width = size * dpr;
      ledCanvas.height = size * dpr;
      ledCanvas.style.width = size + 'px';
      ledCanvas.style.height = size + 'px';
    }
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, ledR = size / 2 - 8;
    const ledCount = 32;
    for (let i = 0; i < ledCount; i++) {
      const a = (Math.PI * 2 / ledCount) * i;
      const x = cx + Math.cos(a) * ledR;
      const y = cy + Math.sin(a) * ledR;
      // Alternating pattern: when spinning, chase effect; when idle, soft pulse
      let brightness;
      if (spinning) {
        brightness = ((i + frame) % 4 < 2) ? 1 : 0.25;
      } else {
        brightness = 0.4 + 0.3 * Math.sin(frame * 0.08 + i * 0.4);
      }
      const color = i % 2 === 0 ? `rgba(240,192,64,${brightness})` : `rgba(255,255,255,${brightness * 0.8})`;
      // Glow
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 8 * brightness;
      ctx.fill();
      // Core dot
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = brightness > 0.6 ? '#fff' : 'rgba(255,255,255,0.4)';
      ctx.shadowBlur = 0;
      ctx.fill();
    }
    ctx.restore();
  }

  function startLedAnimation(spinning) {
    const ledCanvas = document.getElementById('wheelLedCanvas');
    if (!ledCanvas) return;
    if (ledAnimId) cancelAnimationFrame(ledAnimId);
    function loop() {
      ledAnimFrame++;
      drawLedRing(ledCanvas, ledAnimFrame, spinning);
      ledAnimId = requestAnimationFrame(loop);
    }
    loop();
  }

  function stopLedAnimation() {
    if (ledAnimId) { cancelAnimationFrame(ledAnimId); ledAnimId = null; }
  }

  function darkenColor(hex, pct) {
    const num = parseInt(hex.slice(1), 16);
    let r = (num >> 16) - Math.round(pct * 2.55);
    let g = ((num >> 8) & 0xff) - Math.round(pct * 2.55);
    let b = (num & 0xff) - Math.round(pct * 2.55);
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function lightenColor(hex, pct) {
    const num = parseInt(hex.slice(1), 16);
    let r = (num >> 16) + Math.round(pct * 2.55);
    let g = ((num >> 8) & 0xff) + Math.round(pct * 2.55);
    let b = (num & 0xff) + Math.round(pct * 2.55);
    r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function wheelTickSound(speed) {
    if (!soundEnabled) return;
    const ctx = getAudio(); const t = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    // Higher pitch when fast, lower when slow
    const freq = 1800 + (speed || 1) * 800;
    o.type = 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.07, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.05);
  }

  function spawnWheelConfetti() {
    const container = document.createElement('div');
    container.className = 'wheel-confetti';
    const parent = document.querySelector('.wheel-stage');
    parent.appendChild(container);
    const colors = ['#f0c040','#60c0ff','#ff6090','#40e070','#b060ff','#ff8040','#ffe060','#60ffe0'];
    const shapes = ['circle', 'rect', 'diamond'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.className = 'wheel-confetti-piece';
      const angle = (Math.PI * 2 / 60) * i + (Math.random() - 0.5) * 0.3;
      const dist = 100 + Math.random() * 140;
      piece.style.setProperty('--cx', Math.cos(angle) * dist + 'px');
      piece.style.setProperty('--cy', Math.sin(angle) * dist + 'px');
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = (Math.random() * 0.3) + 's';
      const w = 4 + Math.random() * 8;
      const h = 4 + Math.random() * 8;
      piece.style.width = w + 'px';
      piece.style.height = h + 'px';
      const shape = shapes[Math.floor(Math.random() * shapes.length)];
      if (shape === 'circle') piece.style.borderRadius = '50%';
      else if (shape === 'diamond') { piece.style.borderRadius = '2px'; piece.style.transform = 'rotate(45deg)'; }
      container.appendChild(piece);
    }
    setTimeout(() => container.remove(), 2000);
  }

  function setupSpinButton() {
    const canvas = document.getElementById('wheelCanvas');
    if (canvas && !wheelDrawn) {
      drawWheel(canvas, 0);
      startLedAnimation(false);
    }

    $('#btnDoSpin').addEventListener('click', async () => {
      if (!player || wheelSpinning) return;
      wheelSpinning = true;
      const btn = $('#btnDoSpin');
      btn.disabled = true;
      btn.innerHTML = '<span class="wheel-spin-btn-icon">🎡</span> SPINNING...';

      const container = document.querySelector('.wheel-container');
      container.classList.add('spinning');
      startLedAnimation(true);

      // Fire API call and start spinning concurrently
      const resPromise = api('spin-wheel', { playerId: player.id });
      const spinStartedAt = performance.now();
      const SPIN_SPEED = 14;          // radians per second (constant-speed phase)
      const MIN_WIND_MS = 1500;       // minimum winding time before deceleration
      const DECEL_DURATION = 4000;    // deceleration phase duration

      let winding = true;
      let windAngle = wheelAngle;
      let lastSegIndex = -1;
      let windPrev = performance.now();

      // Phase 1: constant-speed winding — gives instant visual feedback
      function windFrame(now) {
        const dt = Math.min((now - windPrev) / 1000, 0.05);
        windPrev = now;
        windAngle += SPIN_SPEED * dt;
        drawWheel(canvas, -windAngle);
        const normA = ((windAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const segIdx = Math.floor(normA / WHEEL_ARC) % WHEEL_SEG_COUNT;
        if (segIdx !== lastSegIndex) {
          lastSegIndex = segIdx;
          wheelTickSound(1);
          const ptr = document.querySelector('.wheel-pointer-wrap');
          if (ptr) { ptr.classList.remove('wheel-pointer-bounce'); void ptr.offsetWidth; ptr.classList.add('wheel-pointer-bounce'); }
        }
        if (winding) requestAnimationFrame(windFrame);
      }
      requestAnimationFrame(windFrame);

      // Wait for API result (with 15 s timeout)
      let res;
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
        res = await Promise.race([resPromise, timeout]);
      } catch {
        res = { error: 'Connection timed out. Please try again.' };
      }

      // Ensure minimum visible spin so it never looks instant
      const elapsed = performance.now() - spinStartedAt;
      if (elapsed < MIN_WIND_MS) await new Promise(r => setTimeout(r, MIN_WIND_MS - elapsed));

      // Stop constant-speed phase
      winding = false;

      if (res.error) {
        container.classList.remove('spinning');
        const resultWrap = $('#wheelResultWrap');
        $('#wheelResult').textContent = res.error;
        resultWrap.classList.remove('hidden');
        startLedAnimation(false);
        btn.disabled = false;
        btn.innerHTML = '<span class="wheel-spin-btn-icon">🎡</span> SPIN!';
        wheelSpinning = false;
        return;
      }

      // Determine which segment to land on
      let targetIdx = WHEEL_SEGMENTS.findIndex(s => s.type === res.result.type && s.value === res.result.value);
      if (targetIdx < 0) targetIdx = 0;

      // Angle math: pointer sits at top of canvas (angle = −π/2).
      // drawWheel(canvas, −a) places segment i centre at  −a + i*ARC + ARC/2.
      // We need  −a + targetIdx*ARC + ARC/2 ≡ −π/2  (mod 2π)
      // ⇒  a ≡ targetIdx*ARC + ARC/2 + π/2  (mod 2π)
      const targetCenter = targetIdx * WHEEL_ARC + WHEEL_ARC / 2;
      const landInCircle = ((targetCenter + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);

      // Add 3+ full extra turns so the deceleration feels natural
      const currentMod = ((windAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let delta = landInCircle - currentMod;
      if (delta <= 0) delta += Math.PI * 2;          // always forward
      const extraTurns = 3 * Math.PI * 2;
      const totalDecel = extraTurns + delta;
      const decelFrom = windAngle;

      // Phase 2: smooth deceleration to the exact winning segment
      function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
      const decelStart = performance.now();

      await new Promise(resolve => {
        function decelFrame(now) {
          const p = Math.min((now - decelStart) / DECEL_DURATION, 1);
          const eased = easeOutQuart(p);
          const a = decelFrom + totalDecel * eased;
          const speed = 1 - p;
          drawWheel(canvas, -a);

          const normA = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          const segIdx = Math.floor(normA / WHEEL_ARC) % WHEEL_SEG_COUNT;
          if (segIdx !== lastSegIndex) {
            lastSegIndex = segIdx;
            wheelTickSound(speed);
            const ptr = document.querySelector('.wheel-pointer-wrap');
            if (ptr) { ptr.classList.remove('wheel-pointer-bounce'); void ptr.offsetWidth; ptr.classList.add('wheel-pointer-bounce'); }
          }

          if (p < 1) {
            requestAnimationFrame(decelFrame);
          } else {
            wheelAngle = a;
            resolve();
          }
        }
        requestAnimationFrame(decelFrame);
      });

      container.classList.remove('spinning');

      // Show result
      player = res.player;
      renderPlayer();
      SFX.win();
      spawnWheelConfetti();
      startLedAnimation(false);

      const resultWrap = $('#wheelResultWrap');
      const resultLabel = res.result.label;
      const isJackpot = res.result.value >= 10;
      $('#wheelResult').textContent = '\ud83c\udf89 ' + resultLabel;
      if (isJackpot) $('#wheelResult').style.fontSize = '1.5rem';
      else $('#wheelResult').style.fontSize = '';
      resultWrap.classList.remove('hidden');

      btn.innerHTML = 'CLOSE';
      btn.disabled = false;
      btn.onclick = () => {
        closeModal('wheelModal');
        stopLedAnimation();
        wheelAngle = 0;
        wheelDrawn = false;
        drawWheel(canvas, 0);
        btn.innerHTML = '<span class="wheel-spin-btn-icon">🎡</span> SPIN!';
        resultWrap.classList.add('hidden');
        btn.onclick = null;
        wheelSpinning = false;
        setupSpinButton();
      };
    }, { once: true });
  }

  // ─── Payment Helpers ─────────────────────────────────────────────────────
  const PAY_ICONS = {
    apple_pay: ' Pay', google_pay: 'G Pay', card: '💳',
    cashapp: '$', amazon_pay: 'a', link: '⚡'
  };

  function setupPaymentGrid(gridId) {
    $$(`#${gridId} .pay-option`).forEach(opt => {
      opt.addEventListener('click', () => {
        selectedPayMethod = opt.dataset.method;
        $$(`#${gridId} .pay-option`).forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });
  }

  async function savePaymentMethod() {
    const res = await api('payment-method', { playerId: player.id, method: selectedPayMethod });
    if (res.player) player = res.player;
    if (res.paymentMethod) player.paymentMethod = res.paymentMethod;
    track('payment_saved_client', { method: selectedPayMethod });
    renderPayButton();
  }

  function renderPayButton() {
    if (player && player.paymentMethod) {
      $('#payBtnIcon').textContent = player.paymentMethod.icon || '💳';
    }
  }

  function showCheckout(qty) {
    if (!player) return;
    // If no payment method, prompt to add one first
    if (!player.paymentMethod) {
      selectedPayMethod = null;
      $('#paymentBtn').click();
      showBonus('Add a payment method to play!');
      return;
    }
    pendingPurchaseQty = qty;
    const isFirstPurchase = (player.totalSpent || 0) === 0;
    const bundle = gameState && gameState.bundles ? gameState.bundles[qty] : null;
    const price = bundle ? (bundle.price / 100).toFixed(2) : (qty * 1).toFixed(2);
    const pot = gameState ? gameState.pots[currentPot] : null;
    const potLabel = pot ? pot.label : currentPot.toUpperCase();
    const savings = bundle && bundle.savings ? bundle.savings : '';

    $('#checkoutItem').textContent = isFirstPurchase ? `FIRST PLAY: ${qty}x Entries — ${potLabel}` : `${qty}x Entries — ${potLabel}`;
    $('#checkoutPrice').textContent = `$${price}`;
    $('#checkoutSavings').textContent = savings ? `You save ${savings.replace(' OFF', '')}` : (isFirstPurchase ? 'Your first paid play unlocks bonus offers' : '');
    $('#checkoutSavings').style.display = (savings || isFirstPurchase) ? 'block' : 'none';

    const pm = player.paymentMethod;
    $('#checkoutPayIcon').textContent = pm.icon || '💳';
    $('#checkoutPayLabel').textContent = `Pay $${price} with ${pm.label}`;

    // Show odds preview
    const potEntries = pot ? pot.totalEntries : 0;
    const myEntries = player.entries[currentPot] || 0;
    const drawThreshold = pot ? (pot.drawThreshold || 50000) : 50000;
    const projectedTotal = Math.max(potEntries + qty, drawThreshold / 100);
    const newOdds = ((myEntries + qty) / projectedTotal * 100).toFixed(1);
    const drawAmt = pot ? (pot.drawThreshold / 100).toFixed(0) : '25';
    const oddsEl = $('#checkoutOdds');
    if (oddsEl) {
      oddsEl.textContent = `Your odds: ${newOdds}% to win $${drawAmt}`;
      oddsEl.style.display = 'block';
    }

    $('#checkoutSheet').classList.remove('hidden');
    track('checkout_opened', { quantity: qty, pot: currentPot, firstPurchase: isFirstPurchase });
  }

  function hideCheckout() {
    $('#checkoutSheet').classList.add('hidden');
  }

  function renderStarterOffer() {
    const wrap = $('#starterOffer');
    if (!wrap || !player) return;
    const shouldShow = !!player.paymentMethod && (player.totalSpent || 0) === 0 && !player.starterOfferClaimed;
    if (shouldShow) {
      wrap.classList.remove('hidden');
      track('starter_offer_seen', { pot: currentPot });
    } else {
      wrap.classList.add('hidden');
    }
  }

  function renderGuidedFlow() {
    if (!player) return;
    const hasPayment = !!player.paymentMethod;
    const spent = player.totalSpent || 0;
    const firstPurchaseDone = spent >= 100;
    const secondPurchaseDone = spent >= 200;
    const advancedUnlock = spent >= 500;

    const text = $('#nextActionText');
    const btn = $('#btnNextAction');
    if (text && btn) {
      if (!hasPayment) {
        text.textContent = 'Step 1: Tap FREE ENTRY below to play free, or add a payment method to unlock $1 plays with bonus entries.';
        btn.textContent = 'ADD PAYMENT (OPTIONAL)';
      } else if (!firstPurchaseDone) {
        text.textContent = 'Step 2: Play your first game! Your entry goes into the pot — when it fills, a winner is drawn.';
        btn.textContent = 'PLAY YOUR FIRST GAME';
      } else if (!secondPurchaseDone) {
        text.textContent = 'Step 3: Play again to see your odds climb. More entries = better chance of winning the pot!';
        btn.textContent = 'BOOST YOUR ODDS';
      } else if (!advancedUnlock) {
        text.textContent = 'You\'re building momentum! Keep entering for your best shot at the next drawing.';
        btn.textContent = 'KEEP PLAYING';
      } else {
        text.textContent = 'You\'re in the running! Use boosts below to maximize your chances.';
        btn.textContent = 'PLAY AGAIN';
      }
    }

    const visibility = {
      missionsSection: firstPurchaseDone,
      milestonesSection: firstPurchaseDone,
      leaderboardSection: firstPurchaseDone,
      achievementsSection: secondPurchaseDone,
      vipSection: secondPurchaseDone,
      lightningSection: secondPurchaseDone,
      limitedSection: secondPurchaseDone,
      mysterySection: advancedUnlock,
      surgeSection: advancedUnlock,
      allinSection: advancedUnlock,
    };
    const unlockLabels = {
      missionsSection: 'Make your first play to unlock',
      milestonesSection: 'Make your first play to unlock',
      leaderboardSection: 'Make your first play to unlock',
      achievementsSection: 'Play 2 times to unlock',
      vipSection: 'Play 2 times to unlock',
      lightningSection: 'Play 2 times to unlock',
      limitedSection: 'Play 2 times to unlock',
      mysterySection: 'Spend $5 to unlock',
      surgeSection: 'Spend $5 to unlock',
      allinSection: 'Spend $5 to unlock',
    };
    for (const [id, show] of Object.entries(visibility)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.classList.remove('hidden');
      if (!show) {
        el.classList.add('section-locked');
        // Add unlock overlay if not already present
        if (!el.querySelector('.lock-overlay')) {
          const overlay = document.createElement('div');
          overlay.className = 'lock-overlay';
          overlay.innerHTML = `<span class="lock-icon">🔒</span><span class="lock-text">${unlockLabels[id]}</span>`;
          el.style.position = 'relative';
          el.appendChild(overlay);
        }
      } else {
        el.classList.remove('section-locked');
        const overlay = el.querySelector('.lock-overlay');
        if (overlay) overlay.remove();
      }
    }

    // Update guided step indicators
    const currentStep = !hasPayment ? 1 : !firstPurchaseDone ? 2 : !secondPurchaseDone ? 3 : 4;
    $$('.g-step').forEach(s => {
      const step = parseInt(s.dataset.gs);
      s.classList.toggle('done', step < currentStep);
      s.classList.toggle('active', step === currentStep);
      if (step < currentStep) s.textContent = '✓';
    });

    const saver = document.getElementById('streakSaver');
    if (saver && !secondPurchaseDone) saver.classList.add('hidden');

    // Rotate offers so only 2 are visible at a time
    rotateOffers();
  }

  async function claimStarterOffer() {
    if (!player) return;
    if (!player.paymentMethod) {
      $('#paymentBtn').click();
      showBonus('Add payment first to claim the starter offer');
      return;
    }
    await stripePurchase({ purchaseType: 'starter_offer', quantity: 1, potId: currentPot }, async () => {
      const res = await api('starter-offer-claim', { playerId: player.id, potId: currentPot });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      renderStarterOffer();
      showBonus(`🚀 Starter unlocked: ${res.qty} entries for $${(res.cost / 100).toFixed(2)}!`);
      track('starter_offer_claimed', { pot: currentPot, qty: res.qty, cost: res.cost });
      if (res.winnerDrawn && res.winnerDrawn.winner) {
        setTimeout(() => showWinner(res.winnerDrawn.winner), 1600);
      }
    });
  }

  function formatCardNumber(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '').slice(0, 16);
      input.value = v.replace(/(\d{4})(?=\d)/g, '$1 ');
    });
  }

  function formatExpiry(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '').slice(0, 4);
      if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
      input.value = v;
    });
  }

  function setupCardFormatting() {
    if ($('#cardNumber')) formatCardNumber($('#cardNumber'));
    if ($('#cardExpiry')) formatExpiry($('#cardExpiry'));
    if ($('#cardNumberModal')) formatCardNumber($('#cardNumberModal'));
    if ($('#cardExpiryModal')) formatExpiry($('#cardExpiryModal'));
  }

  // ─── Watch Ad Flow ─────────────────────────────────────────────────────────────
  // Try real rewarded ad (Google AdSense) first, fall back to simulated ad
  async function watchAd() {
    if (!player) return;
    const btn = $('#btnWatchAd');
    btn.classList.add('watching');

    // Try Google AdSense rewarded ad
    if (window.adsbygoogle && window.adsbygoogle.push) {
      try {
        await showRewardedAd();
        btn.classList.remove('watching');
        const res = await api('ad-reward-verify', { playerId: player.id, potId: currentPot, adNetwork: 'adsense', adUnitId: 'rewarded-1' });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        $('#adsLeft').textContent = res.adsLeft;
        if (res.adsLeft <= 0) btn.classList.add('disabled');
        renderPlayer();
        fetchState();
        showBonus('📺 +1 FREE ENTRY from ad!');
        return;
      } catch (e) { /* AdSense not available, fall back to simulated */ }
    }

    // Fallback: simulated ad overlay
    const overlay = $('#adOverlay');
    const fill = $('#adTimerFill');
    const skipText = $('#adSkipText');
    const closeBtn = $('#adClose');
    overlay.classList.remove('hidden');
    closeBtn.classList.remove('visible');
    fill.style.width = '0%';

    let elapsed = 0;
    const adDuration = 5000;
    const tick = 50;
    const adInterval = setInterval(() => {
      elapsed += tick;
      const pct = Math.min(100, (elapsed / adDuration) * 100);
      fill.style.width = pct + '%';
      const remaining = Math.ceil((adDuration - elapsed) / 1000);
      skipText.textContent = remaining > 0 ? `Wait ${remaining} seconds...` : 'Done!';

      if (elapsed >= adDuration) {
        clearInterval(adInterval);
        closeBtn.classList.add('visible');
        skipText.textContent = 'Close to claim your entry!';

        closeBtn.onclick = async () => {
          overlay.classList.add('hidden');
          btn.classList.remove('watching');
          const res = await api('watch-ad', { playerId: player.id, potId: currentPot });
          if (res.error) { showBonus(res.error); return; }
          player = res.player;
          $('#adsLeft').textContent = res.adsLeft;
          if (res.adsLeft <= 0) btn.classList.add('disabled');
          renderPlayer();
          fetchState();
          showBonus('📺 +1 FREE ENTRY from ad!');
        };
      }
    }, tick);
  }

  function showRewardedAd() {
    return new Promise((resolve, reject) => {
      // Google AdSense rewarded ad format (requires proper ad unit setup)
      try {
        const adBreak = window.adBreak || window.adConfig;
        if (adBreak) {
          adBreak({ type: 'reward', name: 'free-entry', beforeReward: (showAdFn) => showAdFn(), adViewed: () => resolve(), adDismissed: () => reject(new Error('dismissed')), adBreakDone: (info) => { if (info.breakStatus === 'viewed') resolve(); else reject(new Error('not-viewed')); } });
        } else {
          reject(new Error('no-ad-sdk'));
        }
      } catch (e) { reject(e); }
    });
  }

  // ─── Countdown Timer ────────────────────────────────────────────────────────
  function startCountdownTick() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function updateCountdown() {
    if (!gameState) return;
    const pot = gameState.pots[currentPot];
    if (!pot || !pot.deadline) return;

    const now = Date.now();
    const diff = Math.max(0, pot.deadline - now);
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    flipDigit($('#cdHours'), String(hours).padStart(2, '0'));
    flipDigit($('#cdMins'), String(mins).padStart(2, '0'));
    flipDigit($('#cdSecs'), String(secs).padStart(2, '0'));

    const wrap = $('#countdownWrap');
    if (diff < 600000) { // Under 10 minutes = urgent
      wrap.classList.add('urgent');
      if (secs % 2 === 0) SFX.urgentTick();
    } else {
      wrap.classList.remove('urgent');
    }

    // Loss aversion: remind player they have entries at stake
    if (player && pot) {
      const myEntries = player.entries && player.entries[currentPot] || 0;
      const pctFull = pot.pot / (pot.drawThreshold || 1);
      // Under 30 min + player has entries + pot 70%+ full = show urgency nudge
      if (diff < 1800000 && diff > 0 && myEntries > 0 && pctFull >= 0.7 && !_urgencyNudgeShown) {
        _urgencyNudgeShown = true;
        showBonus(`⏰ ${pot.label} draws in ${hours > 0 ? hours + 'h ' : ''}${mins}m — your ${myEntries} entries are waiting!`);
        setTimeout(() => {
          showBonus(`📈 Add more entries to improve your odds before the draw!`);
        }, 4000);
      }
      // Under 5 min + pot 90%+ full = critical warning (once)
      if (diff < 300000 && diff > 0 && myEntries > 0 && pctFull >= 0.9 && !_criticalNudgeShown) {
        _criticalNudgeShown = true;
        showBonus(`🚨 DRAWING SOON! Your ${myEntries} entries in ${pot.label} — last chance to add more!`);
      }
    }
  }

  function flipDigit(el, newVal) {
    if (!el || el.textContent === newVal) return;
    el.textContent = newVal;
    el.classList.remove('cd-flip');
    void el.offsetWidth; // force reflow
    el.classList.add('cd-flip');
  }

  // ─── Near-Miss ──────────────────────────────────────────────────────────
  function checkNearMiss(drawResult) {
    if (!drawResult || !drawResult.nearMisses || !drawResult.winner || !player) return;
    const myMiss = drawResult.nearMisses.find(m => m.playerId === player.id);
    if (myMiss) {
      setTimeout(() => {
        const prize = drawResult.winner.prize;
        const needed = myMiss.awayBy || 1;
        $('#nearMissText').innerHTML = `You had <strong>${myMiss.entries} entries</strong> — just <strong>${needed} more</strong> would have doubled your odds!<br><br>
          <span style="color:#f0c040">${drawResult.winner.name}</span> took home <strong style="color:#40e070">$${prize}</strong>.<br>
          <em style="color:#ff8040">That could have been YOU.</em>`;
        openModal('nearMissModal');
        SFX.alert && SFX.alert();
      }, 4000);
    }
  }

  // ─── Game Flow ──────────────────────────────────────────────────────────
  function startGame(quantity) {
    if (!player || isPlaying) return;
    const isFirstPurchase = (player.totalSpent || 0) === 0;
    isPlaying = true;
    lastGameScore = 0;
    $('#gameOverlay').classList.add('active');
    $('#gameStartOverlay').classList.add('hidden');
    $('#mineGold').textContent = '0';
    $('#mineBanked').textContent = '0';
    game.start();
    track('game_started', { quantity, pot: currentPot, firstPurchase: isFirstPurchase });

    game.onEnd = async (score) => {
      lastGameScore = score;
      isPlaying = false;
      $('#gameOverlay').classList.remove('active');
      $('#mineCashoutWrap').classList.remove('active');
      $('#gameStartOverlay').classList.remove('hidden');
      const banked = game.banked || 0;
      const bonusText = banked >= 300 ? '🏆 +3 BONUS ENTRIES!' : banked >= 150 ? '🎯 +2 BONUS ENTRIES!' : banked >= 50 ? '✨ +1 BONUS ENTRY!' : 'Dig deeper next time!';
      $('#gameStartOverlay').querySelector('.game-start-title').textContent = `💰 BANKED: ${banked}`;
      $('#gameStartOverlay').querySelector('.game-start-sub').textContent = bonusText;

      // Submit entry
      if (quantity > 0) {
        sessionGamesPlayed++;
        const res = await api('premium-entry', { playerId: player.id, quantity, potId: currentPot, gameScore: score });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        detectNewAchievements(player);
        track('premium_entry_success', { quantity, score, pot: currentPot, firstPurchase: isFirstPurchase });
        if (res.bonusEntries > 0) showBonus(`🎯 +${res.bonusEntries} BONUS ENTRIES!`);
        if (res.multiplier > 1) setTimeout(() => showBonus(`⚡ ${res.multiplier}x MULTIPLIER APPLIED!`), 1500);
        if (res.winnerDrawn && res.winnerDrawn.winner) {
          setTimeout(() => showWinner(res.winnerDrawn.winner), 2000);
          checkNearMissWithCooldown(res.winnerDrawn);
        }
        // Show Play Again button
        $('#btnPlayAgain').classList.remove('hidden');
        // Trigger Double Down upsell (after 2 seconds, max once per 60s)
        pendingDoubleDownQty = quantity;
        pendingFirstPurchaseBoost = isFirstPurchase;
        const now = Date.now();
        if (now - lastDoubleDownTime >= 60000) {
          lastDoubleDownTime = now;
          setTimeout(() => showDoubleDownWithCooldown(quantity), 2500);
        }
        // Update hot streak indicator
        renderHotStreak();
        // Re-render missions
        renderMissions();
        renderMilestones();
        // Maybe trigger rare Mega Multiplier popup
        gamesThisSession++;
        if (gamesThisSession >= 2) maybeTriggerMegaMultiplier();
      }
      renderPlayer();
      fetchState();
    };
  }

  // ─── Load Player ────────────────────────────────────────────────────────
  async function loadPlayer(id) {
    try {
      const data = await api('player/' + id);
      if (data.error) {
        // Token may be expired — try re-authenticating
        const reauth = await reauthorize(id);
        if (reauth) { player = reauth; showApp(); return; }
        localStorage.removeItem('goldpot_player_id');
        localStorage.removeItem('goldpot_token');
        showNameModal();
        return;
      }
      player = data;
      _prevAchievements = player.achievements ? [...player.achievements] : [];
      track('player_loaded', { hasPayment: !!player.paymentMethod, totalSpent: player.totalSpent || 0 });
      showApp();
    } catch {
      showNameModal();
    }
  }

  async function reauthorize(playerId) {
    try {
      const expiredToken = localStorage.getItem('goldpot_token');
      if (!expiredToken) return null;
      const res = await fetch('/api/reauth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + expiredToken,
          'X-CSRF-Token': getCsrfToken(),
        },
        body: JSON.stringify({ playerId }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.token) localStorage.setItem('goldpot_token', data.token);
      return data.player || null;
    } catch {
      return null;
    }
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────
  let ws = null;

  function connectWebSocket() {
    const wsToken = getAuthToken();
    if (!wsToken) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '?token=' + encodeURIComponent(wsToken));
    ws.onopen = () => {
      // Connected — slow down polling
      if (pollTimer) { clearInterval(pollTimer); pollTimer = setInterval(fetchState, 30000); }
      // Q50: hide reconnect banner on successful connect
      hideReconnectBanner();
      // Request chat history
      try { ws.send(JSON.stringify({ type: 'chat_history' })); } catch {}
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state_update' || msg.type === 'feed') fetchState();
        else if (msg.type === 'chat') handleChatMessage(msg);
        else if (msg.type === 'chat_history') handleChatHistory(msg.messages);
        else if (msg.type === 'chat_react') handleChatReaction(msg);
        else if (msg.type === 'chat_typing') handleChatTyping(msg);
        else if (msg.type === 'chat_delete') handleChatDelete(msg);
        else if (msg.type === 'chat_online') { chatOnlineUsers = msg.users || []; }
        else if (msg.type === 'chat_poll') handleChatPoll(msg);
        else if (msg.type === 'chat_poll_update') handleChatPollUpdate(msg);
        else if (msg.type === 'chat_poll_end') handleChatPollEnd(msg);
        else if (msg.type === 'chat_rain') handleChatRain(msg);
        else if (msg.type === 'chat_error') handleChatError(msg);
        else if (msg.type && msg.type.startsWith('duel_')) handleDuelWS(msg);
        else if (msg.type && msg.type.startsWith('stream_')) handleStreamWS(msg);
      } catch {}
    };
    ws.onclose = () => {
      ws = null;
      // Q50: show reconnect banner
      showReconnectBanner();
      // Clear stale chat state on disconnect
      clearReply();
      var typing = $('#chatTyping');
      if (typing) typing.classList.add('hidden');
      // Reconnect after 5s, restore fast polling
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(fetchState, 5000);
      setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = () => { ws && ws.close(); };
  }

  // ─── Show App ───────────────────────────────────────────────────────────
  function showApp() {
    $('#app').classList.remove('hidden');
    track('app_ready', { hasPayment: !!(player && player.paymentMethod), totalSpent: player ? player.totalSpent : 0 });
    renderPlayer();
    renderStarterOffer();
    renderGuidedFlow();
    renderPayButton();
    fetchState();
    pollTimer = setInterval(fetchState, 5000);
    connectWebSocket();
    startSessionTimer();
    subscribeToPush();
    // Show chat after login
    var cs = $('#chatSidebar'); if (cs) cs.classList.remove('hidden');
    initChat();
    initDuelUI();
    fetchDuels();
    initStreamUI();
    fetchStreams();

    // Comeback bonus — check if player was away 48+ hours
    checkComebackBonus();

    // Email verification reminder
    if (player && !player.emailVerified) {
      const verifyUrl = localStorage.getItem('goldpot_verify_url');
      if (verifyUrl) {
        const banner = document.createElement('div');
        banner.className = 'email-verify-banner';
        banner.innerHTML = '📧 <b>Verify your email</b> to secure your account. <a href="' + verifyUrl + '" target="_blank">Verify now</a> <button class="evb-close">&times;</button>';
        document.body.appendChild(banner);
        banner.querySelector('.evb-close').addEventListener('click', () => banner.remove());
      }
    }

    // Handle Stripe return — verify payment then play bonus game
    if (pendingStripeReturn) {
      const pending = pendingStripeReturn;
      pendingStripeReturn = null;
      handleStripeReturn(pending);
    }

    // Session time reminder (60 minutes)
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'session-time-warning';
      el.innerHTML = '<div class="stw-inner"><span class="stw-icon">⏰</span><b>You\'ve been playing for 1 hour.</b><p>Remember to take breaks. <a href="/responsible-gaming" target="_blank">Responsible Gaming</a></p><button class="stw-close">Got it</button></div>';
      document.body.appendChild(el);
      el.querySelector('.stw-close').addEventListener('click', () => el.remove());
    }, 3600000);
  }

  async function handleStripeReturn(pending) {
    showBonus('✅ Payment confirmed! Verifying...');
    const verify = await api('verify-stripe-session', { sessionId: pending.sessionId });
    if (verify.error) {
      showError('Payment verification failed');
      return;
    }
    const paymentProofToken = verify.paymentProofToken || '';

    const type = pending.type || 'premium';

    // Premium: play bonus game for extra entries (webhook already added main entries)
    if (type === 'premium') {
      currentPot = pending.pot || 'gold';
      $$('.pot-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.pot === currentPot);
      });
      renderPot();
      setTimeout(() => startBonusGame(pending.qty || 1), 1000);
      return;
    }

    // For all other FOMO types, call the server endpoint to apply the purchase
    // (webhook credited money, but these endpoints apply game effects: entries, power surge, etc.)
    const routes = {
      starter_offer: () => api('starter-offer-claim', { playerId: player.id, potId: pending.pot || currentPot, paymentProofToken }),
      mystery_box: () => api('mystery-box', { playerId: player.id, tier: pending.tier, paymentProofToken }),
      power_surge: () => api('power-surge', { playerId: player.id, paymentProofToken }),
      streak_saver: () => api('streak-saver', { playerId: player.id, paymentProofToken }),
      all_in: () => api('all-in-pack', { playerId: player.id, paymentProofToken }),
      mega_multiplier: () => api('mega-multiplier', { playerId: player.id, paymentProofToken }),
      vip_weekly: () => api('vip-subscribe', { playerId: player.id, tier: 'weekly', paymentProofToken }),
      vip_monthly: () => api('vip-subscribe', { playerId: player.id, tier: 'monthly', paymentProofToken }),
      double_down: () => api('double-down', { playerId: player.id, potId: pending.pot || currentPot, originalQty: pending.qty || 1, firstPurchaseBoost: pending.firstPurchaseBoost || false, paymentProofToken }),
      flash_entry: () => api('flash-entry', { playerId: player.id, quantity: pending.qty || 1, paymentProofToken }),
      lightning: () => api('lightning-buy', { playerId: player.id, potId: pending.pot || currentPot, paymentProofToken }),
      limited: () => api('limited-buy', { playerId: player.id, paymentProofToken }),
      jackpot_entry: () => api('jackpot-entry', { playerId: player.id, quantity: pending.qty || 1, paymentProofToken }),
      vip_diamond: () => api('vip-subscribe', { playerId: player.id, tier: 'diamond', paymentProofToken }),
      battle_pass: () => api('battle-pass-buy', { playerId: player.id, paymentProofToken }),
      gift_entries: () => api('gift-entries', { playerId: player.id, recipientName: pending.recipientName || '', quantity: pending.qty || 3, potId: pending.pot || currentPot, paymentProofToken }),
      tournament: () => api('tournament-enter', { playerId: player.id, paymentProofToken }),
      lucky_boost: () => api('lucky-boost', { playerId: player.id, paymentProofToken }),
      second_chance: () => api('second-chance', { playerId: player.id, potId: pending.pot || currentPot, paymentProofToken }),
      urgency_buy: () => api('urgency-buy', { playerId: player.id, potId: pending.pot || currentPot, paymentProofToken }),
      duel_create: () => api('duel-create', { playerId: player.id, stake: pending.stake, boosts: pending.boosts || [], paymentProofToken }),
      duel_join: () => api('duel-join', { playerId: player.id, duelId: pending.duelId, boosts: pending.boosts || [], paymentProofToken }),
      duel_tip: () => api('duel-tip', { playerId: player.id, duelId: pending.duelId, targetPlayerId: pending.targetPlayerId, paymentProofToken }),
      stream_subscribe: () => api('stream-subscribe', { playerId: player.id, streamId: pending.streamId, paymentProofToken }),
    };

    let handler = routes[type];
    if (!handler && type && type.startsWith('cosmetic_')) {
      handler = () => api('cosmetic-buy', { playerId: player.id, cosmeticId: type.replace('cosmetic_', ''), paymentProofToken });
    }
    if (!handler && type && type.startsWith('duel_boost_')) {
      handler = () => api('duel-boost', { playerId: player.id, boostId: type.replace('duel_boost_', ''), paymentProofToken });
    }
    if (!handler && type && type.startsWith('super_chat_')) {
      handler = () => api('stream-superchat', { playerId: player.id, streamId: pending.streamId, tier: type.replace('super_chat_', ''), message: pending.message || '', paymentProofToken });
    }
    if (!handler && type && type.startsWith('stream_gift_')) {
      handler = () => api('stream-gift', { playerId: player.id, streamId: pending.streamId, giftId: type.replace('stream_gift_', ''), paymentProofToken });
    }
    if (!handler) { showBonus('✅ Payment processed!'); fetchState(); return; }
    const res = await handler();
    if (res.error) { showBonus(res.error); return; }
    if (res.player) { player = res.player; renderPlayer(); }
    // Duel-specific post-processing
    if (type === 'duel_create' && res.duel) {
      activeDuelId = res.duel.id;
      showBonus('⚔️ Duel created! Waiting for opponent...');
      fetchDuels();
    } else if (type === 'duel_join' && res.duel) {
      activeDuelId = res.duel.id;
      showBonus('⚔️ Duel joined! Get ready...');
      enterDuelLiveView(res.duel);
    } else if (type && type.startsWith('super_chat_')) {
      showBonus('💬 Super Chat sent!');
      if (res.stream) renderStreamViewer(res.stream);
    } else if (type && type.startsWith('stream_gift_')) {
      showBonus('🎁 Gift sent!');
      if (res.stream) renderStreamViewer(res.stream);
    } else if (type === 'stream_subscribe') {
      showBonus('⭐ Subscribed! Thank you!');
      if (res.stream) renderStreamViewer(res.stream);
    } else {
      showBonus('✅ Purchase applied!');
    }
    fetchState();
  }

  function startBonusGame(quantity) {
    if (!player || isPlaying) return;
    isPlaying = true;
    lastGameScore = 0;
    $('#gameOverlay').classList.add('active');
    $('#gameStartOverlay').classList.add('hidden');
    $('#mineGold').textContent = '0';
    $('#mineBanked').textContent = '0';
    // Start a game session token before playing
    let bonusSessionId = null;
    api('start-game-session', { playerId: player.id }).then(r => {
      if (r && r.gameSessionId) bonusSessionId = r.gameSessionId;
    });
    game.start();
    track('bonus_game_started', { quantity, pot: currentPot });

    game.onEnd = async (score) => {
      lastGameScore = score;
      isPlaying = false;
      $('#gameOverlay').classList.remove('active');
      $('#mineCashoutWrap').classList.remove('active');
      $('#gameStartOverlay').classList.remove('hidden');
      const banked = game.banked || 0;
      const bonusText = banked >= 300 ? '🏆 +3 BONUS ENTRIES!' : banked >= 150 ? '🎯 +2 BONUS ENTRIES!' : banked >= 50 ? '✨ +1 BONUS ENTRY!' : 'Great game!';
      $('#gameStartOverlay').querySelector('.game-start-title').textContent = `💰 BANKED: ${banked}`;
      $('#gameStartOverlay').querySelector('.game-start-sub').textContent = bonusText;

      // Submit game score for bonus entries only (payment already processed)
      if (score >= 15 && bonusSessionId) {
        const res = await api('game-bonus', { playerId: player.id, potId: currentPot, gameScore: score, gameSessionId: bonusSessionId });
        if (!res.error && res.bonusEntries > 0) {
          showBonus(`🎯 +${res.bonusEntries} BONUS ENTRIES from your game!`);
        }
      }
      // Submit to tournament if entered
      if (score > 0) submitTournamentScore(score);
      $('#btnPlayAgain').classList.remove('hidden');
      renderPlayer();
      fetchState();
    };
  }

  // ─── Fetch State ────────────────────────────────────────────────────────
  async function fetchState() {
    gameState = await api('state');
    renderPot();
    renderLiveTicker();
    renderLeaderboard();
    renderWinnersList();
    renderFlashPot();
    renderVipStatus();
    startCountdownTick();
    renderFomoOffers();
    refreshTabBadges();
    renderServerInfo();
    renderGuidedFlow();
    renderPayoutProof();
    renderLaunchFund();
    renderBattlePass();
    renderTournament();
    renderUrgencyBundles();
    if (gameState.duels) renderDuels(gameState.duels);
    if (gameState.streams) renderStreams(gameState.streams);
    $('#onlineCount').textContent = formatNum(gameState.onlineCount);
    // Update chat online count
    const chatOnlineEl = $('#chatOnline');
    if (chatOnlineEl) chatOnlineEl.textContent = formatNum(gameState.onlineCount) + ' online';
  }

  function renderPayoutProof() {
    if (!gameState) return;
    const totalPaid = gameState.totalPaidOut || 0;
    const winCount = gameState.winnerCount || 0;
    const paidStr = '$' + (totalPaid / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const el1 = document.getElementById('proofTotalPaid');
    const el2 = document.getElementById('proofWinnerCount');
    if (el1) el1.textContent = paidStr;
    if (el2) el2.textContent = winCount;
  }

  function renderServerInfo() {
    // Removed — no server info should be exposed to users
  }

  // ─── Launch Fund ──────────────────────────────────────────────────────
  function renderLaunchFund() {
    if (!gameState || !gameState.launchFund) return;
    const f = gameState.launchFund;
    const fill = $('#launchFundFill');
    const raised = $('#launchFundRaised');
    const goal = $('#launchFundGoal');
    const donors = $('#launchFundDonors');
    if (fill) fill.style.width = Math.min(100, f.pct) + '%';
    if (raised) raised.textContent = '$' + (f.raised / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (goal) goal.textContent = 'Goal: $' + (f.goal / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (donors) donors.textContent = f.donors + (f.donors === 1 ? ' supporter' : ' supporters') + ' so far';
  }

  // ─── Double Down Upsell ──────────────────────────────────────────────
  function showDoubleDown(qty) {
    if (!player || !gameState) return;
    const bundle = gameState.bundles[qty];
    const originalPrice = bundle ? bundle.price : qty * 100;
    const halfPrice = Math.ceil(originalPrice * 0.5);
    const firstBoost = pendingFirstPurchaseBoost;
    $('#ddQty').textContent = qty;
    $('#ddPrice').textContent = '$' + (halfPrice / 100).toFixed(2);
    // Show original price for comparison
    const origEl = $('#ddOrigPrice');
    if (origEl) origEl.textContent = '$' + (originalPrice / 100).toFixed(2);
    $('.dd-title').textContent = firstBoost ? 'FIRST BUYER BOOST!' : 'DOUBLE DOWN!';
    $('.dd-sub').textContent = firstBoost ? 'One-time launch boost: extra entries included.' : 'Same pot. Double the odds. One tap.';
    track('double_down_shown', { qty, firstPurchaseBoost: firstBoost, pot: currentPot });
    openModal('doubleDownModal');
    SFX.bonus();
  }

  // ─── VIP Status ─────────────────────────────────────────────────────────
  function renderVipStatus() {
    if (!player) return;
    const section = $('#vipSection');
    const status = $('#vipStatus');
    const tiers = section.querySelectorAll('.vip-tiers');
    const perks = section.querySelector('.vip-perks');

    if (player.vip && player.vipExpires && player.vipExpires > Date.now()) {
      // VIP is active
      status.classList.remove('hidden');
      tiers.forEach(t => t.classList.add('hidden'));
      if (perks) perks.classList.add('hidden');
      const daysLeft = Math.ceil((player.vipExpires - Date.now()) / 86400000);
      $('#vipExpires').textContent = `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`;
      // Add VIP badge to level badge
      $('#levelBadge').classList.add('vip-glow');
    } else {
      status.classList.add('hidden');
      tiers.forEach(t => t.classList.remove('hidden'));
      if (perks) perks.classList.remove('hidden');
      $('#levelBadge').classList.remove('vip-glow');
    }
  }

  // ─── Pot Urgency Bar ────────────────────────────────────────────────────
  function renderUrgency() {
    if (!gameState) return;
    const pot = gameState.pots[currentPot];
    if (!pot) return;
    const bar = $('#potUrgency');
    const text = $('#urgencyText');

    if (pot.pctFull >= 90) {
      bar.classList.remove('hidden');
      if (pot.pctFull >= 99) text.textContent = 'DRAW IMMINENT! FINAL ENTRIES NOW';
      else if (pot.pctFull >= 95) text.textContent = 'ALMOST FULL! DRAWING VERY SOON';
      else text.textContent = 'POT ALMOST FULL!';
    } else {
      bar.classList.add('hidden');
      text.textContent = 'POT ALMOST FULL!';
    }
  }

  // ─── Flash Pot Rendering ───────────────────────────────────────────────
  let lastFlashActive = false;
  function renderFlashPot() {
    if (!gameState) return;
    const fp = gameState.flashPot;
    const banner = $('#flashBanner');
    const tab = $('#flashTab');
    if (!fp || !fp.active) {
      banner.classList.add('hidden');
      tab.classList.add('hidden');
      if (lastFlashActive && fp && fp.winner) {
        // Flash pot just ended with a winner
        showBonus(`⚡ ${fp.winner.name} won $${fp.winner.prize} FLASH POT!`);
      }
      lastFlashActive = false;
      if (flashCountdownInterval) { clearInterval(flashCountdownInterval); flashCountdownInterval = null; }
      return;
    }

    // Show flash pot
    banner.classList.remove('hidden');
    tab.classList.remove('hidden');
    if (!lastFlashActive) { SFX.flash(); lastFlashActive = true; } // Play sound when flash pot appears

    const prize = (fp.prize / 100).toFixed(0);
    $('#flashPrizeLabel').textContent = `$${prize}`;

    // Countdown
    if (!flashCountdownInterval) {
      flashCountdownInterval = setInterval(() => {
        if (!gameState || !gameState.flashPot || !gameState.flashPot.active) return;
        const diff = Math.max(0, gameState.flashPot.deadline - Date.now());
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        $('#flashTimeLeft').textContent = `${m}:${String(s).padStart(2, '0')}`;
        if (diff < 60000) {
          banner.classList.add('flash-urgent');
          if (s % 3 === 0) SFX.urgentTick();
        }
        if (diff <= 0) { clearInterval(flashCountdownInterval); flashCountdownInterval = null; fetchState(); }
      }, 1000);
    }
  }

  // ─── Render Pot ─────────────────────────────────────────────────────────
  function renderPot() {
    if (!gameState) return;
    const pot = gameState.pots[currentPot];
    if (!pot) return;

    $('#potLabel').textContent = pot.label;
    $('#potLabel').style.color = pot.color;
    $('#potAmount').textContent = '$' + pot.potDisplay;
    $('#potAmount').style.color = pot.color;
    $('#totalEntries').textContent = formatNum(pot.totalEntries);
    $('#roundNum').textContent = pot.round;
    const drawAmt = (pot.drawThreshold / 100).toFixed(2);
    $('#drawAt').textContent = '$' + drawAmt;
    const pct = Math.min(100, (pot.pot / pot.drawThreshold) * 100);
    $('#potBarFill').style.width = pct + '%';
    $('#potBarFill').style.background = `linear-gradient(90deg, ${pot.color}80, ${pot.color})`;

    // Update action button with price anchoring
    const btn = $('#btnPremium');
    const drawAmtRound = (pot.drawThreshold / 100).toFixed(0);
    btn.querySelector('.btn-label').textContent = `PLAY & ENTER ${pot.label}`;
    btn.querySelector('.btn-sub').textContent = `$1 for a chance at $${drawAmtRound}`;

    // Update bundle price anchoring
    $$('.btn-bundle, .btn-mega-bundle, .btn-whale-bundle').forEach(b => {
      const q = parseInt(b.dataset.qty);
      if (q && gameState.bundles[q]) {
        const bundlePrice = (gameState.bundles[q].price / 100).toFixed(2);
        const sub = b.querySelector('.btn-sub');
        if (!sub) {
          const s = document.createElement('span');
          s.className = 'btn-sub';
          s.textContent = `${q} chances at $${drawAmtRound}`;
          b.appendChild(s);
        }
      }
    });

    // Update your stats
    if (player) {
      const entries = player.entries[currentPot] || 0;
      $('#yourEntries').textContent = entries;
      const odds = player.yourOdds ? player.yourOdds[currentPot] : '0.00';
      $('#yourOdds').textContent = parseFloat(odds).toFixed(1) + '%';
      // Free entry status
      const potData = gameState.pots[currentPot];
      const freeKey = `${currentPot}_${potData ? potData.round : 0}`;
      const freeUsed = player.freeEntryUsed && player.freeEntryUsed[freeKey];
      const freeStatus = $('#freeEntryStatus');
      const freeBtn = $('#btnFree');
      if (freeUsed) {
        if (freeStatus) freeStatus.textContent = 'Used this round';
        if (freeBtn) freeBtn.classList.add('disabled');
      } else {
        if (freeStatus) freeStatus.textContent = '1 free entry available';
        if (freeBtn) freeBtn.classList.remove('disabled');
      }
    }
    renderUrgency();
    renderJackpot();
  }

  // ─── Jackpot System ──────────────────────────────────────────────────────
  const JP_TIER_ICONS = { silver: '💰', gold: '🏆', platinum: '⚡', diamond: '💎' };

  function renderJackpot() {
    if (!gameState) return;
    const jp = gameState.jackpot;
    const banner = $('#jackpotBanner');
    const tab = $('#jackpotTab');

    if (!jp || !jp.active) {
      banner.classList.add('hidden');
      tab.classList.add('hidden');
      if (lastJackpotActive && jp && jp.winner) {
        // Jackpot just ended — show winner modal
        showJackpotWinner(jp.winner);
      }
      lastJackpotActive = false;
      jackpotAnnounced = false;
      if (jackpotCountdownInterval) { clearInterval(jackpotCountdownInterval); jackpotCountdownInterval = null; }
      return;
    }

    // Show jackpot
    banner.classList.remove('hidden');
    tab.classList.remove('hidden');
    banner.setAttribute('data-tier', jp.tier);

    // Show announcement on first appearance
    if (!lastJackpotActive && !jackpotAnnounced) {
      jackpotAnnounced = true;
      SFX.jackpot();
      const icon = JP_TIER_ICONS[jp.tier] || '💎';
      $('#jpAnnounceIcon').textContent = icon;
      const prizeStr = '$' + (jp.prize / 100).toLocaleString('en-US');
      $('#jpAnnouncePrize').textContent = prizeStr;
      $('#jpAnnounceTier').textContent = jp.label;
      setTimeout(() => openModal('jackpotAnnounceModal'), 1000);
    }
    lastJackpotActive = true;

    // Update banner content
    const icon = JP_TIER_ICONS[jp.tier] || '💎';
    $('#jackpotBannerIcon').textContent = icon;
    $('#jackpotBannerLabel').textContent = jp.label;
    const prizeStr = '$' + (jp.prize / 100).toLocaleString('en-US');
    $('#jackpotBannerPrize').textContent = prizeStr;
    $('#jackpotEntryCount').textContent = formatNum(jp.totalEntries) + ' entries';

    // Progress bar
    const pct = jp.pctFull || 0;
    $('#jackpotBarFill').style.width = pct + '%';
    $('#jackpotBarPct').textContent = pct + '%';

    // Entry prices
    const ep = jp.entryPrice / 100;
    $('#jpPrice1').textContent = '$' + ep.toFixed(0);
    $('#jpPrice5').textContent = '$' + (ep * 5).toFixed(0);
    $('#jpPrice25').textContent = '$' + (ep * 25).toFixed(0);

    // Player odds
    if (player && player.entries && player.entries.jackpot > 0) {
      const oddsEl = $('#jackpotOdds');
      oddsEl.classList.remove('hidden');
      $('#jackpotYourEntries').textContent = player.entries.jackpot;
      const odds = jp.totalEntries > 0 ? ((player.entries.jackpot / jp.totalEntries) * 100).toFixed(2) : '0.00';
      $('#jackpotYourOdds').textContent = odds + '%';
    } else {
      $('#jackpotOdds').classList.add('hidden');
    }

    // Urgency states
    const diff = Math.max(0, jp.deadline - Date.now());
    if (diff < 3600000) { // Under 1 hour
      banner.classList.add('jackpot-urgent', 'jackpot-critical');
    } else if (diff < 6 * 3600000) { // Under 6 hours
      banner.classList.add('jackpot-urgent');
      banner.classList.remove('jackpot-critical');
    } else {
      banner.classList.remove('jackpot-urgent', 'jackpot-critical');
    }

    // Start countdown
    if (!jackpotCountdownInterval) {
      jackpotCountdownInterval = setInterval(() => {
        if (!gameState || !gameState.jackpot || !gameState.jackpot.active) return;
        const d = Math.max(0, gameState.jackpot.deadline - Date.now());
        const hrs = Math.floor(d / 3600000);
        const mins = Math.floor((d % 3600000) / 60000);
        const secs = Math.floor((d % 60000) / 1000);
        $('#jackpotTimeLeft').textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (d < 3600000 && secs % 5 === 0) SFX.urgentTick();
        if (d <= 0) { clearInterval(jackpotCountdownInterval); jackpotCountdownInterval = null; fetchState(); }
      }, 1000);
    }
  }

  async function enterJackpot(qty) {
    if (!player) return;
    if (!player.paymentMethod) {
      $('#paymentBtn').click();
      showBonus('Add payment to enter jackpot!');
      return;
    }
    SFX.jackpot();
    await stripePurchase({ purchaseType: 'jackpot_entry', quantity: qty }, async () => {
      const res = await api('jackpot-entry', { playerId: player.id, quantity: qty });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus(`💎 ${qty}x JACKPOT ENTRY!`);
      if (res.winnerDrawn) {
        setTimeout(() => showJackpotWinner(res.winnerDrawn), 1500);
      }
    });
  }

  function showJackpotWinner(winner) {
    $('#jpWinnerName').textContent = winner.name;
    $('#jpWinnerPrize').textContent = '$' + winner.prize;
    const tierLabel = winner.tier ? (winner.tier.toUpperCase() + ' JACKPOT') : 'JACKPOT';
    $('#jpWinnerTier').textContent = tierLabel;
    openModal('jackpotWinnerModal');
    // Spawn confetti
    const container = $('#jpConfetti');
    container.innerHTML = '';
    const colors = ['#b0e0ff', '#60c0ff', '#4080ff', '#e0f0ff', '#80b0ff', '#6060ff', '#f0c040'];
    for (let i = 0; i < 80; i++) {
      const c = document.createElement('div');
      c.className = 'confetti-piece';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[Math.floor(Math.random() * colors.length)];
      c.style.animationDelay = Math.random() * 2 + 's';
      c.style.animationDuration = (2 + Math.random() * 3) + 's';
      container.appendChild(c);
    }
    SFX.jackpotWin();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── FOMO EXCLUSIVE OFFERS ──────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════

  // ─── 1. Mystery Box ────────────────────────────────────────────────────
  async function buyMysteryBox(tier) {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    await stripePurchase({ purchaseType: 'mystery_box', tier }, async () => {
      const res = await api('mystery-box', { playerId: player.id, tier });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      const rarityClass = res.rarity.toLowerCase();
      const icons = { COMMON: '📦', RARE: '💎', LEGENDARY: '🌟' };
      $('#mysteryRevealBox').textContent = icons[res.rarity] || '🎁';
      const rarityEl = $('#mysteryRevealRarity');
      rarityEl.textContent = res.rarity;
      rarityEl.className = 'mystery-reveal-rarity ' + rarityClass;
      $('#mysteryRevealEntries').textContent = `+${res.entries} ENTRIES!`;
      $('#mysteryRevealSub').textContent = `Added to GOLD POT`;
      openModal('mysteryRevealModal');
      if (res.rarity === 'LEGENDARY') { SFX.jackpotWin(); spawnMysteryConfetti(); }
      else if (res.rarity === 'RARE') { SFX.win(); spawnMysteryConfetti(); }
      else { SFX.bonus(); }
      startMysteryCooldown();
      if (res.winnerDrawn && res.winnerDrawn.winner) {
        setTimeout(() => showWinner(res.winnerDrawn.winner), 3000);
      }
    });
  }

  function spawnMysteryConfetti() {
    const container = $('#mysteryConfetti');
    container.innerHTML = '';
    const colors = ['#f0c040', '#ff6090', '#60c0ff', '#40e070', '#b060ff', '#ff8040'];
    for (let i = 0; i < 50; i++) {
      const c = document.createElement('div');
      c.className = 'confetti-piece';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[Math.floor(Math.random() * colors.length)];
      c.style.animationDelay = Math.random() * 2 + 's';
      c.style.animationDuration = (2 + Math.random() * 3) + 's';
      container.appendChild(c);
    }
  }

  function startMysteryCooldown() {
    if (mysteryCooldownInterval) clearInterval(mysteryCooldownInterval);
    const cooldownEl = $('#mysteryCooldown');
    const timeEl = $('#mysteryCooldownTime');
    cooldownEl.classList.remove('hidden');
    let remaining = player.mysteryBoxCooldown || 180000;
    mysteryCooldownInterval = setInterval(() => {
      remaining -= 1000;
      if (remaining <= 0) {
        clearInterval(mysteryCooldownInterval);
        mysteryCooldownInterval = null;
        cooldownEl.classList.add('hidden');
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }

  // ─── 2. Lightning Deal ─────────────────────────────────────────────────
  let lightningRefetching = false;
  function renderLightningDeal() {
    if (!player || !player.lightningDeal) return;
    const deal = player.lightningDeal;
    const spent = player.totalSpent || 0;
    const secondPurchaseDone = spent >= 200;
    const diff = Math.max(0, deal.deadline - Date.now());

    if (diff <= 0) {
      if (lightningRefetching) return; // prevent infinite loop
      lightningRefetching = true;
      // Deal expired, fetch new one
      api('lightning-deal', { playerId: player.id }).then(res => {
        lightningRefetching = false;
        if (res.deal) { player.lightningDeal = res.deal; renderLightningDeal(); }
      }).catch(() => { lightningRefetching = false; });
      return;
    }

    const section = document.getElementById('lightningSection');
    if (!section) return;
    if (!secondPurchaseDone) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    $('#lightningDiscount').textContent = `${deal.discount}% OFF`;
    $('#lightningDetail').textContent = deal.label;
    $('#lightningOriginal').textContent = `$${(deal.normalPrice / 100).toFixed(2)}`;
    $('#lightningSale').textContent = `$${(deal.salePrice / 100).toFixed(2)}`;

    // Countdown
    if (lightningInterval) clearInterval(lightningInterval);
    lightningInterval = setInterval(() => {
      const remaining = Math.max(0, deal.deadline - Date.now());
      if (remaining <= 0) { clearInterval(lightningInterval); renderLightningDeal(); return; }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      const timeEl = $('#lightningTimer');
      if (timeEl) timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }

  async function buyLightningDeal() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.flash();
    await stripePurchase({ purchaseType: 'lightning' }, async () => {
      const res = await api('lightning-buy', { playerId: player.id, potId: currentPot });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus(`⚡ ${res.qty}x ENTRIES at ${res.discount}% OFF!`);
      SFX.win();
      if (res.winnerDrawn && res.winnerDrawn.winner) {
        setTimeout(() => showWinner(res.winnerDrawn.winner), 2000);
        checkNearMissWithCooldown(res.winnerDrawn);
      }
    });
  }

  // ─── 3. Power Surge ────────────────────────────────────────────────────
  function renderPowerSurge() {
    if (!player) return;
    const active = player.powerSurgeActive || (player.powerSurgeExpires && player.powerSurgeExpires > Date.now());
    const btn = $('#btnPowerSurge');
    const activeEl = $('#surgeActive');

    if (active) {
      btn.style.display = 'none';
      activeEl.classList.remove('hidden');
      if (surgeInterval) clearInterval(surgeInterval);
      surgeInterval = setInterval(() => {
        const d = Math.max(0, (player.powerSurgeExpires || 0) - Date.now());
        const m = Math.floor(d / 60000);
        const s = Math.floor((d % 60000) / 1000);
        $('#surgeTimer').textContent = `${m}:${String(s).padStart(2, '0')}`;
        if (d <= 0) { clearInterval(surgeInterval); surgeInterval = null; renderPowerSurge(); }
      }, 1000);
    } else {
      btn.style.display = '';
      activeEl.classList.add('hidden');
    }
  }

  async function buyPowerSurge() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    await stripePurchase({ purchaseType: 'power_surge' }, async () => {
      const res = await api('power-surge', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      renderPowerSurge();
      showBonus('⚡ POWER SURGE ACTIVATED! 2x entries for 1 hour!');
      SFX.jackpot();
    });
  }

  // ─── 4. Streak Saver ──────────────────────────────────────────────────
  function renderStreakSaver() {
    if (!player) return;
    const saver = $('#streakSaver');
    if (player.streak >= 3 && !player.streakShield) {
      saver.classList.remove('hidden');
      $('#saverStreakNum').textContent = player.streak;
    } else {
      saver.classList.add('hidden');
    }
  }

  async function buyStreakSaver() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    await stripePurchase({ purchaseType: 'streak_saver' }, async () => {
      const res = await api('streak-saver', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      renderStreakSaver();
      showBonus('🛡️ Streak PROTECTED! You won\'t lose it.');
      SFX.win();
    });
  }

  // ─── 5. All-In Pack ───────────────────────────────────────────────────
  async function buyAllIn() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    await stripePurchase({ purchaseType: 'all_in' }, async () => {
      const res = await api('all-in-pack', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus('🎯 ALL-IN! 5x entries in EVERY pot!');
      SFX.win();
      if (res.draws) {
        for (const [potId, draw] of Object.entries(res.draws)) {
          if (draw && draw.winner) {
            setTimeout(() => showWinner(draw.winner), 2000);
            checkNearMissWithCooldown(draw);
          }
        }
      }
    });
  }

  // ─── 6. Limited Edition Drop ──────────────────────────────────────────
  function renderLimitedDrop() {
    if (!gameState || !gameState.limitedDrop) return;
    const drop = gameState.limitedDrop;
    $('#limitedLabel').textContent = drop.label;
    $('#limitedSale').textContent = '$' + (drop.price / 100).toFixed(2);
    const normalPrice = Math.round(drop.entries * 0.70);
    $('#limitedOriginal').textContent = '$' + normalPrice.toFixed(2);
    const pct = (drop.remaining / drop.totalStock) * 100;
    const fill = $('#limitedStockFill');
    fill.style.width = pct + '%';
    if (pct < 20) fill.classList.add('low');
    else fill.classList.remove('low');
    const stockText = $('#limitedStockText');
    if (drop.remaining <= 0) {
      stockText.textContent = '⛔ SOLD OUT — Next drop coming!';
      stockText.style.color = '#ff4040';
      $('#btnLimitedBuy').disabled = true;
      $('#btnLimitedBuy').textContent = 'SOLD OUT';
    } else if (drop.remaining <= 5) {
      stockText.textContent = `🚨 ONLY ${drop.remaining} LEFT!`;
      stockText.style.color = '#ff4040';
      $('#btnLimitedBuy').disabled = false;
      $('#btnLimitedBuy').textContent = '🔥 GRAB BEFORE SOLD OUT';
    } else {
      stockText.textContent = `${drop.remaining} of ${drop.totalStock} left`;
      stockText.style.color = '#ff8040';
      $('#btnLimitedBuy').disabled = false;
      $('#btnLimitedBuy').textContent = '🔥 GRAB BEFORE SOLD OUT';
    }
    const viewers = limitedViewerCount;
    // Slowly drift the count every ~30 seconds via renderFomoOffers cycle
    if (Math.random() < 0.15) limitedViewerCount = Math.max(5, Math.min(25, limitedViewerCount + Math.floor(Math.random() * 5) - 2));
    $('#limitedBuyerText').textContent = `${viewers} people viewing this drop`;
  }

  async function buyLimited() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    await stripePurchase({ purchaseType: 'limited' }, async () => {
      const res = await api('limited-buy', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus(`💎 ${res.entries}x ENTRIES — Limited Drop! ${res.remaining} left!`);
      SFX.win();
      if (res.winnerDrawn && res.winnerDrawn.winner) {
        setTimeout(() => showWinner(res.winnerDrawn.winner), 2000);
      }
    });
  }

  // ─── 7. Mega Multiplier (rare popup) ──────────────────────────────────
  function maybeTriggerMegaMultiplier() {
    // 8% chance after each game, max once per session
    if (megaMultShown || !player) return;
    if (Math.random() > 0.08) return;
    megaMultShown = true;
    setTimeout(() => {
      SFX.jackpot();
      openModal('megaMultModal');
    }, 3000);
  }

  async function buyMegaMultiplier() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    closeModal('megaMultModal');
    SFX.click();
    await stripePurchase({ purchaseType: 'mega_multiplier' }, async () => {
      const res = await api('mega-multiplier', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      renderPowerSurge();
      showBonus('🌟 5× MEGA MULTIPLIER ACTIVATED! 30 minutes!');
      SFX.jackpotWin();
    });
  }

  // ─── Battle Pass ──────────────────────────────────────────────────────
  function renderBattlePass() {
    if (!gameState || !gameState.battlePass) return;
    var bp = gameState.battlePass;
    var section = $('#battlePassSection');
    if (!section) return;
    var seasonEl = $('#bpSeason');
    if (seasonEl) seasonEl.textContent = 'Season ' + bp.season;
    var timerEl = $('#bpTimer');
    if (timerEl) {
      var left = bp.endsAt - Date.now();
      if (left > 0) {
        var d = Math.floor(left / 86400000);
        var h = Math.floor((left % 86400000) / 3600000);
        timerEl.textContent = d + 'd ' + h + 'h left';
      } else { timerEl.textContent = 'Ending soon'; }
    }
    // Player XP
    var pBp = player && player.battlePass ? player.battlePass : null;
    var xp = pBp ? (pBp.xp || 0) : 0;
    var currentTier = 0;
    if (bp.tiers) {
      for (var i = 0; i < bp.tiers.length; i++) {
        if (xp >= bp.tiers[i].xpNeeded) currentTier = i + 1;
      }
    }
    var nextXp = (currentTier < bp.tiers.length) ? bp.tiers[currentTier].xpNeeded : bp.tiers[bp.tiers.length - 1].xpNeeded;
    var prevXp = currentTier > 0 ? bp.tiers[currentTier - 1].xpNeeded : 0;
    var pct = nextXp > prevXp ? Math.min(100, Math.round(((xp - prevXp) / (nextXp - prevXp)) * 100)) : 100;
    var xpFill = $('#bpXpFill');
    if (xpFill) xpFill.style.width = pct + '%';
    var xpText = $('#bpXpText');
    if (xpText) xpText.textContent = xp + ' / ' + nextXp + ' XP';
    // Render tiers
    var track = $('#bpTrack');
    if (track && bp.tiers) {
      var html = '';
      var isPremium = pBp && pBp.premium;
      var claimed = (pBp && pBp.claimed) ? pBp.claimed : [];
      for (var t = 0; t < bp.tiers.length; t++) {
        var tier = bp.tiers[t];
        var unlocked = xp >= tier.xpNeeded;
        var tierClaimed = claimed.indexOf(t) >= 0;
        var claimable = unlocked && !tierClaimed;
        var cls = 'bp-tier';
        if (unlocked) cls += ' bp-unlocked';
        if (t === currentTier && currentTier < bp.tiers.length) cls += ' bp-current';
        if (tierClaimed) cls += ' bp-claimed';
        if (claimable) cls += ' bp-claimable';
        html += '<div class="' + cls + '" data-bptier="' + t + '">';
        html += '<div class="bp-tier-num">T' + (t + 1) + '</div>';
        html += '<div class="bp-tier-free">' + (tier.free || '—') + '</div>';
        var premReward = tier.premium || '⭐';
        html += '<div class="bp-tier-premium' + (!isPremium ? ' bp-locked' : '') + '">' + premReward + '</div>';
        if (claimable) html += '<div class="bp-tier-claim">CLAIM</div>';
        if (tierClaimed) html += '<div class="bp-tier-check">✅</div>';
        html += '</div>';
      }
      track.innerHTML = html;
    }
    // Premium CTA
    var cta = $('#bpPremiumCta');
    if (cta) {
      if (pBp && pBp.premium) cta.classList.add('hidden');
      else cta.classList.remove('hidden');
    }
  }

  async function buyBattlePass() {
    if (!player) return;
    SFX.click();
    await stripePurchase({ purchaseType: 'battle_pass' }, async () => {
      var res = await api('battle-pass-buy', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      renderBattlePass();
      showBonus('⭐ PREMIUM BATTLE PASS UNLOCKED!');
      SFX.jackpotWin();
    });
  }

  async function claimBattlePassTier(tierIdx) {
    if (!player) return;
    SFX.click();
    var res = await api('battle-pass-claim', { playerId: player.id, tierIndex: tierIdx });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    fetchState();
    showBonus(res.rewardLabel ? ('🎖️ ' + res.rewardLabel) : '🎖️ Tier reward claimed!');
  }

  // ─── Tournament ───────────────────────────────────────────────────────
  function renderTournament() {
    if (!gameState || !gameState.tournament) return;
    var t = gameState.tournament;
    var section = $('#tournamentSection');
    if (!section) return;
    var titleEl = $('#tourneyTitle');
    if (titleEl) titleEl.textContent = t.title || 'HOURLY CHALLENGE';
    var timerEl = $('#tourneyTimer');
    if (timerEl) {
      var left = t.endsAt - Date.now();
      if (left > 0) {
        var m = Math.floor(left / 60000);
        var s = Math.floor((left % 60000) / 1000);
        timerEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      } else { timerEl.textContent = '00:00'; }
    }
    var prizeEl = $('#tourneyPrize');
    if (prizeEl) prizeEl.textContent = '$' + (t.prizePool / 100).toFixed(2);
    var feeEl = $('#tourneyFee');
    if (feeEl) feeEl.textContent = (t.entryFee / 100).toFixed(2);
    // Leaderboard
    var lbEl = $('#tourneyLeaderboard');
    if (lbEl && t.leaderboard) {
      var html = '';
      for (var i = 0; i < t.leaderboard.length && i < 5; i++) {
        var e = t.leaderboard[i];
        html += '<div class="tourney-lb-row">';
        html += '<span class="tourney-lb-rank">#' + (i + 1) + '</span>';
        html += '<span class="tourney-lb-name">' + escHtml(e.name) + '</span>';
        html += '<span class="tourney-lb-score">' + e.score + '</span>';
        html += '</div>';
      }
      lbEl.innerHTML = html || '<div style="font-size:.75rem;color:rgba(255,255,255,.4);padding:8px">No entries yet</div>';
    }
    // Check if player entered
    var entered = player && t.leaderboard && t.leaderboard.some(function(e) { return e.playerId === player.id; });
    var btnEnter = $('#btnTourneyEnter');
    var enteredDiv = $('#tourneyEntered');
    if (btnEnter) btnEnter.classList.toggle('hidden', !!entered);
    if (enteredDiv) enteredDiv.classList.toggle('hidden', !entered);
    if (entered && player) {
      var myEntry = t.leaderboard.find(function(e) { return e.playerId === player.id; });
      var scoreEl = $('#tourneyYourScore');
      if (scoreEl && myEntry) scoreEl.textContent = myEntry.score;
    }
  }

  async function enterTournament() {
    if (!player) return;
    SFX.click();
    await stripePurchase({ purchaseType: 'tournament' }, async () => {
      var res = await api('tournament-enter', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus('🏟️ Tournament entered! Play Deep Gold to set your score!');
    });
  }

  async function submitTournamentScore(score) {
    if (!player || !gameState || !gameState.tournament) return;
    var t = gameState.tournament;
    var entered = t.leaderboard && t.leaderboard.some(function(e) { return e.playerId === player.id; });
    if (!entered) return;
    var res = await api('tournament-score', { playerId: player.id, score: score, tournamentId: t.id });
    if (res.error) return;
    fetchState();
  }

  // ─── Urgency Bundles ──────────────────────────────────────────────────
  function renderUrgencyBundles() {
    if (!gameState) return;
    var bundles = gameState.urgencyBundles;
    var section = $('#urgencySection');
    if (!section) return;
    if (!bundles || bundles.length === 0) {
      section.classList.add('hidden');
      return;
    }
    var b = bundles[0]; // Show the most urgent one
    section.classList.remove('hidden');
    section.dataset.potId = b.potId;
    var lbl = $('#urgencyPotLabel');
    if (lbl) lbl.textContent = b.potLabel;
    var fill = $('#urgencyFill');
    if (fill) fill.textContent = b.fillPct + '% Full';
    var entries = $('#urgencyEntries');
    if (entries) entries.textContent = b.entries + 'x Entries';
    var orig = $('#urgencyOriginal');
    if (orig) orig.textContent = '$' + (b.basePrice / 100).toFixed(2);
    var sale = $('#urgencySale');
    if (sale) sale.textContent = '$' + (b.salePrice / 100).toFixed(2);
    var disc = $('#urgencyDiscount');
    if (disc) disc.textContent = b.discount + '% OFF';
    var barFill = $('#urgencyBarFill');
    if (barFill) barFill.style.width = b.fillPct + '%';
  }

  async function buyUrgencyBundle() {
    if (!player) return;
    var section = $('#urgencySection');
    var potId = section ? section.dataset.potId : currentPot;
    SFX.click();
    await stripePurchase({ purchaseType: 'urgency_buy', potId: potId, pendingData: { pot: potId } }, async () => {
      var res = await api('urgency-buy', { playerId: player.id, potId: potId });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus('⏰ Urgency bundle purchased! ' + res.entries + ' entries added!');
      SFX.jackpotWin();
    });
  }

  // ─── Lucky Boost ──────────────────────────────────────────────────────
  async function buyLuckyBoost() {
    if (!player) return;
    SFX.click();
    await stripePurchase({ purchaseType: 'lucky_boost' }, async () => {
      var res = await api('lucky-boost', { playerId: player.id });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      showBonus('🍀 Lucky Boost active! Your next entry gets priority placement!');
    });
  }

  // ─── Second Chance ────────────────────────────────────────────────────
  async function buySecondChance() {
    if (!player) return;
    SFX.click();
    await stripePurchase({ purchaseType: 'second_chance', potId: currentPot, pendingData: { pot: currentPot } }, async () => {
      var res = await api('second-chance', { playerId: player.id, potId: currentPot });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus('🔄 Second Chance entry added with priority!');
    });
  }

  // ─── Gift Entries ─────────────────────────────────────────────────────
  var giftQty = 3;
  function openGiftModal() {
    SFX.click();
    openModal('giftModal');
    updateGiftTotal();
  }
  function updateGiftTotal() {
    var prices = { 1: 100, 3: 285, 5: 450, 10: 850 };
    var price = prices[giftQty] || (giftQty * 100);
    var el = $('#giftTotal');
    if (el) el.textContent = '$' + (price / 100).toFixed(2);
  }
  async function sendGift() {
    if (!player) return;
    var name = ($('#giftRecipient') || {}).value || '';
    if (!name.trim()) { showBonus('Enter recipient name'); return; }
    var pot = ($('#giftPot') || {}).value || 'gold';
    SFX.click();
    await stripePurchase({
      purchaseType: 'gift_entries',
      quantity: giftQty,
      potId: pot,
      pendingData: { recipientName: name.trim(), qty: giftQty, pot: pot }
    }, async () => {
      var res = await api('gift-entries', { playerId: player.id, recipientName: name.trim(), quantity: giftQty, potId: pot });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      closeModal('giftModal');
      showBonus('🎁 Gifted ' + giftQty + ' entries to ' + escHtml(name.trim()) + '!');
      SFX.jackpotWin();
    });
  }

  // ─── Chat Cosmetics ──────────────────────────────────────────────────
  var cosmeticsType = 'name_color';
  function openCosmeticsModal() {
    SFX.click();
    openModal('cosmeticsModal');
    renderCosmeticsGrid();
  }
  function renderCosmeticsGrid() {
    if (!gameState || !gameState.chatCosmetics) return;
    var grid = $('#cosmeticsGrid');
    if (!grid) return;
    var cosmetics = gameState.chatCosmetics;
    var owned = (player && player.cosmetics) ? player.cosmetics : [];
    var equipped = (player && player.equippedCosmetics) ? player.equippedCosmetics : {};
    var html = '';
    for (var id in cosmetics) {
      var c = cosmetics[id];
      if (c.type !== cosmeticsType) continue;
      var isOwned = owned.indexOf(id) >= 0;
      var isEquipped = equipped[c.type] === id;
      var cls = 'cosmetic-item';
      if (isOwned) cls += ' cosmetic-owned';
      if (isEquipped) cls += ' cosmetic-equipped';
      html += '<div class="' + cls + '" data-cosid="' + id + '">';
      html += '<div class="cosmetic-preview">';
      if (c.type === 'name_color') html += '<span style="color:' + (c.value || '#fff') + ';font-weight:700;font-size:1rem">' + escHtml(c.label) + '</span>';
      else if (c.type === 'avatar_border') html += '<span style="border:3px solid ' + (c.value || '#fff') + ';border-radius:50%;width:28px;height:28px;display:inline-block"></span>';
      else if (c.type === 'title') html += '<span style="font-size:.7rem;color:#c4b5fd;font-weight:700">' + escHtml(c.value || c.label) + '</span>';
      else html += '<span style="font-size:1.2rem">' + (c.value || '✨') + '</span>';
      html += '</div>';
      html += '<div class="cosmetic-name">' + escHtml(c.label) + '</div>';
      if (isEquipped) html += '<div class="cosmetic-equipped-tag">EQUIPPED</div>';
      else if (isOwned) html += '<div class="cosmetic-owned-tag">OWNED — tap to equip</div>';
      else html += '<div class="cosmetic-price-tag">$' + (c.price / 100).toFixed(2) + '</div>';
      html += '</div>';
    }
    grid.innerHTML = html || '<div style="grid-column:1/-1;text-align:center;color:rgba(255,255,255,.4);padding:20px">No items in this category</div>';
  }
  async function handleCosmeticClick(cosmeticId) {
    if (!player || !gameState || !gameState.chatCosmetics) return;
    var c = gameState.chatCosmetics[cosmeticId];
    if (!c) return;
    var owned = (player.cosmetics || []).indexOf(cosmeticId) >= 0;
    if (owned) {
      // Equip/unequip
      var equipped = (player.equippedCosmetics || {})[c.type];
      var newVal = equipped === cosmeticId ? 'none' : cosmeticId;
      var res = await api('cosmetic-equip', { playerId: player.id, cosmeticId: newVal, cosmeticType: c.type });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderCosmeticsGrid();
      showBonus(newVal === 'none' ? 'Cosmetic unequipped' : '✨ Equipped!');
    } else {
      // Buy
      SFX.click();
      await stripePurchase({
        purchaseType: 'cosmetic_' + cosmeticId,
        pendingData: { cosmeticId: cosmeticId }
      }, async () => {
        var res = await api('cosmetic-buy', { playerId: player.id, cosmeticId: cosmeticId });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderCosmeticsGrid();
        showBonus('✨ ' + c.label + ' unlocked!');
        SFX.jackpotWin();
      });
    }
  }
  // ─── VIP Diamond perks display ────────────────────────────────────────
  function showDiamondPerks() {
    var el = $('#vipDiamondPerks');
    if (el) el.classList.toggle('hidden');
  }

  // ─── Render All FOMO Offers ───────────────────────────────────────────
  function renderFomoOffers() {
    renderLightningDeal();
    renderPowerSurge();
    renderStreakSaver();
    renderLimitedDrop();
    // Mystery cooldown check
    if (player && player.mysteryBoxCooldown > 0 && !mysteryCooldownInterval) {
      startMysteryCooldown();
    }
  }

  // ─── Render Player ──────────────────────────────────────────────────────
  function renderPlayer() {
    if (!player) return;
    // Streak
    $('#streakCount').textContent = player.streak || 0;
    if (player.streak >= 7) $('#streakBadge').classList.add('hot');
    else $('#streakBadge').classList.remove('hot');

    // Level
    if (player.levelInfo) {
      $('#levelIcon').textContent = player.levelInfo.icon;
      $('#levelName').textContent = player.levelInfo.name;
      $('#levelBadge').style.borderColor = player.levelInfo.color;
    }

    // Stats
    $('#yourBestScore').textContent = player.bestScore || 0;
    $('#yourReferrals').textContent = player.referralCount || 0;

    // Balance / Withdraw
    const balance = player.balance || 0;
    $('#balanceAmount').textContent = '$' + (balance / 100).toFixed(2);
    if (balance > 0) {
      $('#balanceCard').classList.add('has-balance');
      $('#balanceDetail').textContent = 'Total won: $' + ((player.totalWon || 0) / 100).toFixed(2);
      $('#btnWithdraw').classList.remove('hidden');
    } else {
      $('#balanceCard').classList.remove('has-balance');
      $('#balanceDetail').textContent = 'Win a pot to cash out!';
      $('#btnWithdraw').classList.add('hidden');
    }

    // Referral code
    if (player.referralCode) {
      $('#referralCode').value = player.referralCode;
    }

    // Ads remaining
    const today = new Date().toDateString();
    const adLimit = (player.vip && player.vipExpires > Date.now()) ? (player.vipTier === 'monthly' ? 15 : 10) : 5;
    const adsUsed = (player.lastAdWatch === today) ? (player.adsWatchedToday || 0) : 0;
    const adsLeft = Math.max(0, adLimit - adsUsed);
    $('#adsLeft').textContent = adsLeft;
    const adsMaxEl = $('#adsMax');
    if (adsMaxEl) adsMaxEl.textContent = adLimit;
    const adBtn = $('#btnWatchAd');
    if (adBtn) { if (adsLeft <= 0) adBtn.classList.add('disabled'); else adBtn.classList.remove('disabled'); }

    // Achievements
    renderAchievements();
    renderLevelProgress();
    renderMissions();
    renderMilestones();
    renderStarterOffer();
    renderGuidedFlow();
    renderReferralDashboard();
    // Spin wheel availability
    const spinAvail = $('#spinAvail');
    if (spinAvail) {
      if (player.lastSpin === today) {
        spinAvail.textContent = '';
        $('#btnSpinWheel').classList.add('disabled');
      } else {
        spinAvail.textContent = ' • READY';
        $('#btnSpinWheel').classList.remove('disabled');
      }
    }
  }

  // ─── Push Notifications ─────────────────────────────────────────────────
  async function subscribeToPush() {
    if (!player || !window._swReg || !('PushManager' in window)) return;
    try {
      const existing = await window._swReg.pushManager.getSubscription();
      if (existing) return; // already subscribed
      const res = await fetch('/api/vapid-public-key');
      const { key } = await res.json();
      if (!key) return;
      const subscription = await window._swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await api('push-subscribe', { playerId: player.id, subscription });
    } catch (e) { /* push not supported or denied */ }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // ─── Referral Dashboard ────────────────────────────────────────────────
  async function renderReferralDashboard() {
    if (!player) return;
    const section = $('#referralDashboard');
    if (!section) return;
    try {
      const headers = { 'Authorization': 'Bearer ' + getAuthToken() };
      const res = await fetch('/api/referral-dashboard/' + player.id, { headers });
      if (!res.ok) return;
      const data = await res.json();
      $('#refDashCount').textContent = data.referralCount || 0;
      $('#refDashEntries').textContent = data.entriesEarned || 0;
      const list = $('#refDashList');
      if (data.referrals && data.referrals.length > 0) {
        list.innerHTML = data.referrals.slice(0, 10).map(r => {
          const d = new Date(r.date);
          const dateStr = d.toLocaleDateString();
          return `<div class="ref-row"><span class="ref-name">🤝 ${esc(r.name)}</span><span class="ref-date">${dateStr}</span><span class="ref-reward">+5 entries</span></div>`;
        }).join('');
      } else {
        list.innerHTML = '<div class="ref-empty">Share your code to start earning!</div>';
      }
    } catch (e) { /* silent */ }
  }

  // ─── Achievements ──────────────────────────────────────────────────────
  function renderAchievements() {
    const grid = $('#achievementsGrid');
    grid.innerHTML = '';
    for (const [key, ach] of Object.entries(ACHIEVEMENTS)) {
      const unlocked = player && player.achievements && player.achievements.includes(key);
      const el = document.createElement('div');
      el.className = 'achievement' + (unlocked ? ' unlocked' : '');
      el.innerHTML = `<div class="ach-icon">${ach.icon}</div><div class="ach-label">${ach.label}</div>${unlocked ? '<button class="ach-share-btn" data-ach="' + key + '">Share</button>' : ''}`;
      el.title = ach.desc;
      if (unlocked) {
        el.querySelector('.ach-share-btn').addEventListener('click', (e) => { e.stopPropagation(); shareAchievement(key); });
      }
      grid.appendChild(el);
    }
  }

  // ─── Level Progress ─────────────────────────────────────────────────────
  function renderLevelProgress() {
    if (!player || !player.levelProgress) return;
    const lp = player.levelProgress;
    const LEVEL_NAMES = [
      { icon: '🪙', name: 'STARTER' }, { icon: '🥉', name: 'BRONZE' },
      { icon: '🥈', name: 'SILVER' }, { icon: '🥇', name: 'GOLD' },
      { icon: '⚡', name: 'PLATINUM' }, { icon: '💎', name: 'DIAMOND' },
    ];
    const curr = LEVEL_NAMES[lp.level] || LEVEL_NAMES[0];
    const next = LEVEL_NAMES[lp.level + 1];
    $('#levelProgCurrent').textContent = `${curr.icon} ${curr.name}`;
    if (next && lp.level < 5) {
      $('#levelProgNext').textContent = `Next: ${next.icon} ${next.name}`;
      $('#levelProgSub').textContent = `$${(player.totalSpent / 100).toFixed(0)} / $${(lp.nextThreshold / 100).toFixed(0)} spent`;
    } else {
      $('#levelProgNext').textContent = 'MAX LEVEL';
      $('#levelProgSub').textContent = '🏆 You are DIAMOND tier!';
    }
    $('#levelProgFill').style.width = lp.progress + '%';
  }

  // ─── Daily Missions ────────────────────────────────────────────────────
  function renderMissions() {
    if (!player || !player.missions) return;
    const list = $('#missionsList');
    list.innerHTML = '';
    player.missions.forEach((m, i) => {
      const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
      const complete = m.progress >= m.target;
      const card = document.createElement('div');
      card.className = 'mission-card' + (complete ? ' complete' : '') + (m.claimed ? ' claimed' : '');
      card.innerHTML = `
        <div class="mission-info">
          <div class="mission-label">${esc(m.label)}</div>
          <div class="mission-progress-wrap">
            <div class="mission-bar"><div class="mission-bar-fill" style="width:${pct}%"></div></div>
            <span class="mission-bar-text">${Math.min(m.progress, m.target)}/${m.target}</span>
          </div>
        </div>
        <div class="mission-reward">+${m.reward} 🎟️</div>
        ${complete && !m.claimed ? `<button class="btn-claim-mission" data-idx="${i}">CLAIM</button>` : ''}
        ${m.claimed ? '<span style="color:var(--green);font-size:0.8rem;font-weight:700">✓</span>' : ''}
      `;
      list.appendChild(card);
    });

    // Bind claim buttons
    $$('.btn-claim-mission').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const res = await api('claim-mission', { playerId: player.id, missionIndex: idx });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderMissions();
        renderPlayer();
        showBonus(`🎯 +${res.reward} ENTRIES from mission!`);
        SFX.win();
      });
    });
  }

  // ─── Milestones ────────────────────────────────────────────────────────
  function renderMilestones() {
    if (!player || !player.availableMilestones) return;
    const list = $('#milestonesList');
    list.innerHTML = '';
    for (const m of player.availableMilestones) {
      const card = document.createElement('div');
      card.className = 'milestone-card' + (m.unlocked ? ' unlocked' : '') + (m.claimed ? ' claimed' : '');
      card.innerHTML = `
        ${!m.unlocked ? '<div class="milestone-lock">🔒</div>' : ''}
        <div class="milestone-games">${m.games}</div>
        <div class="milestone-label">games</div>
        <div class="milestone-reward">+${m.reward} 🎟️</div>
        ${m.unlocked && !m.claimed ? `<button class="btn-claim-milestone" data-games="${m.games}">CLAIM</button>` : ''}
        ${m.claimed ? '<span style="color:var(--green);font-size:0.7rem;font-weight:700">✓ Claimed</span>' : ''}
      `;
      list.appendChild(card);
    }

    // Bind claim buttons
    $$('.btn-claim-milestone').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const games = parseInt(btn.dataset.games);
        const res = await api('claim-milestone', { playerId: player.id, games });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderMilestones();
        renderPlayer();
        showBonus(`🏅 +${res.reward} ENTRIES from milestone!`);
        SFX.win();
      });
    });
  }

  // ─── Hot Streak ─────────────────────────────────────────────────────────
  function renderHotStreak() {
    const bar = $('#hotStreakBar');
    if (sessionGamesPlayed >= 3) {
      bar.classList.remove('hidden');
      $('#hotStreakText').textContent = `HOT STREAK — ${sessionGamesPlayed} games this session! Keep it up! 🔥`;
    } else {
      bar.classList.add('hidden');
    }
  }

  // ─── Session Timer & Rewards ────────────────────────────────────────────
  function startSessionTimer() {
    sessionStartTime = Date.now();
    sessionRewardTimers = { 5: false, 15: false, 30: false };
    // Reset based on server data
    if (player && player.sessionRewardsClaimed) {
      for (const k of Object.keys(player.sessionRewardsClaimed)) {
        if (sessionRewardTimers.hasOwnProperty(k)) sessionRewardTimers[k] = true;
      }
    }
    if (sessionTimerInterval) clearInterval(sessionTimerInterval);
    sessionTimerInterval = setInterval(updateSessionTimer, 1000);
    updateSessionTimer();
  }

  let claimingSessionReward = false;

  async function updateSessionTimer() {
    const elapsed = Date.now() - sessionStartTime;
    const totalMins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    $('#sessionTimeLabel').textContent = `${totalMins}:${String(secs).padStart(2, '0')}`;

    // Update dots
    const checkpoints = [5, 15, 30];
    for (const min of checkpoints) {
      const dot = $(`.sr-dot[data-min="${min}"]`);
      if (!dot) continue;
      if (sessionRewardTimers[min]) {
        dot.classList.add('earned');
        dot.classList.remove('ready');
      } else if (totalMins >= min && !claimingSessionReward) {
        dot.classList.add('ready');
        dot.classList.remove('earned');
        // Auto-claim with guard
        if (player) {
          claimingSessionReward = true;
          sessionRewardTimers[min] = true;
          try {
            const res = await api('session-reward', { playerId: player.id, minutes: min });
            if (res.success) {
              player = res.player;
              dot.classList.remove('ready');
              dot.classList.add('earned');
              renderPlayer();
              showBonus(`⏱️ +${res.reward} ENTRIES for playing ${res.label}!`);
              SFX.bonus();
            } else {
              dot.classList.remove('ready');
              dot.classList.add('earned');
            }
          } finally {
            claimingSessionReward = false;
          }
        }
      }
    }
  }

  // ─── Live Ticker ────────────────────────────────────────────────────────
  function renderLiveTicker() {
    if (!gameState || !gameState.liveFeed || gameState.liveFeed.length === 0) return;
    let html = '';
    for (const e of gameState.liveFeed) {
      if (e.type === 'play') {
        const paidIcon = (e.entryType === 'free' || e.entryType === 'daily' || e.entryType === 'wheel' || e.entryType === 'ad') ? '🪙' : '💸';
        html += `<span class="tick-item${paidIcon === '💸' ? ' tick-paid' : ''}">${paidIcon} <b>${esc(e.name)}</b> entered ${esc(e.pot)}${e.qty > 1 ? ` (${e.qty}x)` : ''}</span>`;
      } else if (e.type === 'winner') {
        html += `<span class="tick-item tick-winner">🏆 <b>${esc(e.name)}</b> won $${esc(e.prize)}!</span>`;
      } else if (e.type === 'daily') {
        html += `<span class="tick-item">🎁 <b>${esc(e.name)}</b> claimed daily (${e.streak} streak)</span>`;
      } else if (e.type === 'wheel') {
        html += `<span class="tick-item">🎰 <b>${esc(e.name)}</b> spun: ${esc(e.prize)}</span>`;
      } else if (e.type === 'join') {
        html += `<span class="tick-item">👋 <b>${esc(e.name)}</b> joined!</span>`;
      } else if (e.type === 'referral') {
        html += `<span class="tick-item">🤝 <b>${esc(e.name)}</b> got referral bonus!</span>`;
      } else if (e.type === 'share') {
        html += `<span class="tick-item">📣 <b>${esc(e.name)}</b> shared & earned!</span>`;
      } else if (e.type === 'ad') {
        html += `<span class="tick-item">📺 <b>${esc(e.name)}</b> watched ad for ${esc(e.pot)}</span>`;
      } else if (e.type === 'flash') {
        html += `<span class="tick-item tick-flash">⚡ FLASH POT — $${esc(e.prize)} up for grabs!</span>`;
      } else if (e.type === 'flash_entry') {
        html += `<span class="tick-item tick-flash">⚡ <b>${esc(e.name)}</b> entered Flash Pot${e.qty > 1 ? ` (${e.qty}x)` : ''}!</span>`;
      } else if (e.type === 'vip') {
        html += `<span class="tick-item tick-vip">👑 <b>${esc(e.name)}</b> went VIP!</span>`;
      } else if (e.type === 'mission') {
        html += `<span class="tick-item tick-mission">🎯 <b>${esc(e.name)}</b> completed: ${esc(e.mission)}</span>`;
      } else if (e.type === 'milestone') {
        html += `<span class="tick-item tick-milestone">🏅 <b>${esc(e.name)}</b> reached ${esc(e.milestone)}!</span>`;
      } else if (e.type === 'jackpot') {
        html += `<span class="tick-item tick-jackpot">💎 ${esc(e.label)} — $${esc(e.prize)} JACKPOT IS LIVE!</span>`;
      } else if (e.type === 'jackpot_entry') {
        html += `<span class="tick-item tick-jackpot">💎 <b>${esc(e.name)}</b> entered ${esc(e.label)}${e.qty > 1 ? ` (${e.qty}x)` : ''}</span>`;
      } else if (e.type === 'jackpot_winner') {
        html += `<span class="tick-item tick-jackpot-winner">💎🏆 <b>${esc(e.name)}</b> WON $${esc(e.prize)} JACKPOT!</span>`;
      } else if (e.type === 'mystery_box') {
        html += `<span class="tick-item tick-mystery">🎁 <b>${esc(e.name)}</b> opened ${esc(e.rarity)} box — +${e.entries} entries!</span>`;
      } else if (e.type === 'lightning') {
        html += `<span class="tick-item tick-lightning">⚡ <b>${esc(e.name)}</b> grabbed ${e.discount}% OFF deal!</span>`;
      } else if (e.type === 'power_surge') {
        html += `<span class="tick-item tick-surge">⚡ <b>${esc(e.name)}</b> activated POWER SURGE!</span>`;
      } else if (e.type === 'all_in') {
        html += `<span class="tick-item tick-allin">🎯 <b>${esc(e.name)}</b> went ALL-IN on every pot!</span>`;
      } else if (e.type === 'limited_drop') {
        html += `<span class="tick-item tick-limited">🔥 <b>${esc(e.name)}</b> grabbed Limited Drop — ${e.remaining} left!</span>`;
      } else if (e.type === 'mega_mult') {
        html += `<span class="tick-item tick-mega">🌟 <b>${esc(e.name)}</b> activated 5× MEGA MULTIPLIER!</span>`;
      } else if (e.type === 'donate') {
        html += `<span class="tick-item tick-donate">💚 <b>${esc(e.name)}</b> donated $${(e.amount / 100).toFixed(0)} to the launch fund!</span>`;
      }
    }
    // Duplicate content for seamless looping
    const doubled = html + html;
    // Populate all 4 border ticker tracks
    const top = document.getElementById('tickerTrackTop');
    const bottom = document.getElementById('tickerTrackBottom');
    const left = document.getElementById('tickerTrackLeft');
    const right = document.getElementById('tickerTrackRight');
    if (top) top.innerHTML = doubled;
    if (bottom) bottom.innerHTML = doubled;
    if (left) left.innerHTML = doubled;
    if (right) right.innerHTML = doubled;
  }

  // ─── Leaderboard ───────────────────────────────────────────────────────
  function renderLeaderboard() {
    if (!gameState || !gameState.leaderboard || gameState.leaderboard.length === 0) return;
    const podiumEl = $('#leaderboardPodium');
    const listEl = $('#leaderboardList');
    const medals = ['🥇', '🥈', '🥉'];
    const pClass = ['lb-p1', 'lb-p2', 'lb-p3'];
    const top3 = gameState.leaderboard.slice(0, 3);
    const rest = gameState.leaderboard.slice(3);

    // Podium cards (1st in center via CSS order)
    if (podiumEl) {
      podiumEl.innerHTML = top3.map((p, i) => `
        <div class="lb-podium-card ${pClass[i]}${player && p.name === player.name ? ' lb-you' : ''}">
          <span class="lb-podium-medal">${medals[i]}</span>
          <span class="lb-podium-name">${esc(p.name)}</span>
          <span class="lb-podium-entries">${formatNum(p.entries)}</span>
          <span class="lb-podium-level">${p.levelInfo ? p.levelInfo.icon + ' ' + p.levelInfo.name : ''}</span>
        </div>
      `).join('');
    }

    // Remaining rows
    if (listEl) {
      listEl.innerHTML = rest.map((p, i) => `
        <div class="lb-row${player && p.name === player.name ? ' lb-you' : ''}">
          <span class="lb-rank">${i + 4}</span>
          <span class="lb-name">${p.levelInfo ? p.levelInfo.icon : ''} ${esc(p.name)}</span>
          <span class="lb-entries">${formatNum(p.entries)} entries</span>
          <span class="lb-streak">🔥${p.streak || 0}</span>
        </div>
      `).join('');
    }
  }

  // ─── Winners List ──────────────────────────────────────────────────────
  function renderWinnersList() {
    if (!gameState || !gameState.recentWinners || gameState.recentWinners.length === 0) return;
    const el = $('#winnersList');
    el.innerHTML = gameState.recentWinners.slice(-8).reverse().map((w, i) => {
      const potRaw = (w.pot || '').toUpperCase();
      let potKey = 'gold';
      if (potRaw.includes('MINI')) potKey = 'mini';
      else if (potRaw.includes('MEGA')) potKey = 'mega';
      else if (potRaw.includes('FLASH')) potKey = 'flash';
      else if (potRaw.includes('JACKPOT')) potKey = 'jackpot';
      const initials = esc(w.name).slice(0, 2).toUpperCase();
      const prizeClass = (potKey === 'mega' ? ' prize-mega' : potKey === 'jackpot' ? ' prize-jackpot' : '');
      const potIcons = { mini: '🥉', gold: '🥇', mega: '💎', flash: '⚡', jackpot: '👑' };
      return `
      <div class="winner-item pot-${potKey}" style="animation-delay:${i * 0.06}s">
        <div class="winner-left">
          <div class="winner-avatar av-${potKey}">${initials}</div>
          <div class="winner-details">
            <span class="winner-details-name">${esc(w.name)}</span>
            <span class="winner-pot-badge badge-${potKey}">${potIcons[potKey] || '🏆'} ${esc(w.pot)}</span>
          </div>
        </div>
        <div class="winner-right">
          <span class="winner-prize-amount${prizeClass}">$${esc(w.prize)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ─── Winner Modal ──────────────────────────────────────────────────────
  function showWinner(info) {
    $('#winnerName').textContent = info.name;
    $('#winnerPrize').textContent = '$' + info.prize;
    $('#winnerRound').textContent = info.round;
    // Show share buttons if the winner is the current player
    const isMe = player && info.name === player.name;
    const shareRow = $('#winnerShareRow');
    if (shareRow) shareRow.classList.toggle('hidden', !isMe);
    if (isMe) {
      window._lastWinPrize = info.prize;
      window._lastWinPot = info.pot || '';
    }
    openModal('winnerModal');
    spawnConfetti();
    SFX.win();
  }

  function spawnConfetti() {
    const container = $('#confetti');
    container.innerHTML = '';
    const colors = ['#f0c040', '#ff6090', '#60c0ff', '#40e070', '#b060ff', '#ff8040'];
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('div');
      c.className = 'confetti-piece';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[Math.floor(Math.random() * colors.length)];
      c.style.animationDelay = Math.random() * 2 + 's';
      c.style.animationDuration = (2 + Math.random() * 3) + 's';
      container.appendChild(c);
    }
  }

  // ─── Sharing ────────────────────────────────────────────────────────────
  function getReferralUrl() {
    const base = window.location.origin + window.location.pathname;
    return player && player.referralCode ? base + '?ref=' + player.referralCode : base;
  }

  function shareApp() {
    const refUrl = getReferralUrl();
    const text = `I'm playing GOLDPOT — real cash prizes every day! 🏆💰 Join free & we both get bonus entries!`;
    if (navigator.share) {
      navigator.share({ title: 'GOLDPOT — Win Real Cash', text, url: refUrl }).catch(() => {});
    } else {
      shareVia('twitter');
    }
  }

  async function shareVia(platform) {
    const refUrl = getReferralUrl();
    const text = encodeURIComponent(`I'm playing GOLDPOT — real cash prizes every day! 🏆💰 Join free & we both get bonus entries!`);
    const url = encodeURIComponent(refUrl);
    if (platform === 'twitter') {
      window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank', 'noopener');
    } else if (platform === 'sms') {
      window.open(`sms:?body=${text}%20${url}`, '_self');
    } else if (platform === 'link') {
      copyReferral();
    }

    // Reward 1 free entry per platform per day
    if (player) {
      const res = await api('share-reward', { playerId: player.id, platform });
      if (res.success) {
        player = res.player;
        renderPlayer();
        showBonus('📣 +1 FREE ENTRY for sharing!');
      } else if (res.alreadyClaimed) {
        showBonus('Already earned today\'s share bonus for this!');
      }
    }
  }

  function copyReferral() {
    const refUrl = getReferralUrl();
    navigator.clipboard.writeText(refUrl).then(() => {
      const btn = $('#btnCopy');
      btn.textContent = 'COPIED!';
      setTimeout(() => { btn.textContent = 'COPY LINK'; }, 2000);
    }).catch(() => {});
  }

  // ─── Winner Share (viral explosion) ────────────────────────────────────
  function shareWin(platform, prize, pot) {
    const refUrl = getReferralUrl();
    const msg = `I just won $${prize} on GOLDPOT! 🏆💰 Real cash, real winners. Join free & get bonus entries!`;
    if (platform === 'twitter') {
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(msg)}&url=${encodeURIComponent(refUrl)}`, '_blank', 'noopener');
    } else if (platform === 'sms') {
      window.open(`sms:?body=${encodeURIComponent(msg + ' ' + refUrl)}`, '_self');
    } else if (platform === 'native') {
      if (navigator.share) navigator.share({ title: 'I WON on GOLDPOT!', text: msg, url: refUrl }).catch(() => {});
      else shareWin('twitter', prize, pot);
    } else if (platform === 'copy') {
      navigator.clipboard.writeText(msg + ' ' + refUrl).then(() => showBonus('Copied! Now paste it everywhere 🚀')).catch(() => {});
    }
  }

  // ─── Achievement Share ─────────────────────────────────────────────────
  function shareAchievement(achKey) {
    const ach = ACHIEVEMENTS[achKey];
    if (!ach) return;
    const refUrl = getReferralUrl();
    const msg = `${ach.icon} I just unlocked "${ach.label}" on GOLDPOT! ${ach.desc}. Play for free!`;
    if (navigator.share) {
      navigator.share({ title: 'GOLDPOT Achievement', text: msg, url: refUrl }).catch(() => {});
    } else {
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(msg)}&url=${encodeURIComponent(refUrl)}`, '_blank', 'noopener');
    }
  }

  // ─── Modals ──────────────────────────────────────────────────────────────
  function showNameModal() {
    // Reset onboarding to step 1
    $('#onboardStep1').classList.remove('hidden');
    $('#onboardStep2').classList.add('hidden');
    $$('.onboard-step').forEach(s => {
      s.classList.remove('done');
      if (s.dataset.step === '1') { s.classList.add('active'); s.querySelector('span').textContent = '1'; }
      else s.classList.remove('active');
    });
    // Q45: reset progress dots
    updateOnboardDots(1);
    selectedPayMethod = null;
    $$('#onboardPaymentGrid .pay-option').forEach(o => o.classList.remove('selected'));
    const cardForm = $('#cardForm');
    if (cardForm) cardForm.classList.add('hidden');
    openModal('nameModal');
    // Auto-fill referral code from URL ?ref= param
    if (window._pendingRefCode) {
      const refInput = $('#refCodeInput');
      if (refInput) refInput.value = window._pendingRefCode;
    }
    setTimeout(() => $('#playerNameInput').focus(), 300);
  }

  let _modalReturnFocus = null;
  // Q25: track open modal stack to prevent stacking
  let _openModalId = null;
  // Q29-30: modals that should NOT close on backdrop click
  const _criticalModals = ['ageModal', 'nameModal', 'checkoutModal', 'withdrawModal'];

  function openModal(id) {
    // Q25: close existing modal before opening another (unless same)
    if (_openModalId && _openModalId !== id) {
      const prev = $('#' + _openModalId);
      if (prev) prev.classList.add('hidden');
    }
    _modalReturnFocus = document.activeElement;
    _openModalId = id;
    const m = $('#' + id);
    m.classList.remove('hidden');
    // Q31: auto-popup class for server-triggered FOMO modals
    const autoPopupModals = ['nearMissModal', 'doubleDownModal', 'jackpotAnnounceModal', 'mysteryRevealModal', 'megaMultModal', 'flashPotModal', 'lightningDealModal', 'powerSurgeModal'];
    if (autoPopupModals.includes(id)) m.classList.add('auto-popup');
    else m.classList.remove('auto-popup');
    // Q26: add bottom-sheet class on mobile
    if (window.innerWidth <= 600) {
      const content = m.querySelector('.modal-content');
      if (content) content.classList.add('bottom-sheet');
    }
    // Focus first focusable element inside modal
    const focusable = m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) setTimeout(() => focusable[0].focus(), 80);
  }
  function closeModal(id) {
    const m = $('#' + id);
    if (m) {
      m.classList.add('hidden');
      const content = m.querySelector('.modal-content');
      if (content) content.classList.remove('bottom-sheet');
    }
    _openModalId = null;
    if (_modalReturnFocus) { try { _modalReturnFocus.focus(); } catch(e){} _modalReturnFocus = null; }
  }

  // Escape key closes open modals (except critical ones)
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _openModalId && !_criticalModals.includes(_openModalId)) {
      closeModal(_openModalId);
    }
  });

  // Q29-30: backdrop click to close (except critical modals)
  document.addEventListener('click', function(e) {
    if (!_openModalId) return;
    const m = $('#' + _openModalId);
    if (!m || m.classList.contains('hidden')) return;
    // Only close if clicking the modal overlay itself, not its content
    if (e.target === m && !_criticalModals.includes(_openModalId)) {
      const closeBtn = m.querySelector('.btn-skip, .checkout-close, [data-dismiss], .offer-dismiss, #btnNewRound, #btnJpWinnerClose, #btnMysteryClose, #btnMegaMultSkip, #btnNearMissDismiss, #btnJpAnnounceDismiss, #btnDdSkip, #btnCloseWithdraw, .modal-close-btn');
      if (closeBtn) closeBtn.click();
      else m.classList.add('hidden');
    }
  });

  // Global: trap focus inside open modals & close on Escape
  document.addEventListener('keydown', function(e) {
    const openM = document.querySelector('.modal:not(.hidden)');
    if (!openM) return;
    if (e.key === 'Escape') {
      // find a dismiss/close/skip button
      const closeBtn = openM.querySelector('.btn-skip, .checkout-close, [data-dismiss], .offer-dismiss, #btnNewRound, #btnJpWinnerClose, #btnMysteryClose, #btnMegaMultSkip, #btnNearMissDismiss, #btnJpAnnounceDismiss, #btnDdSkip, #btnCloseWithdraw');
      if (closeBtn) closeBtn.click();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = [...openM.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  });

  // ─── Bonus Popup ────────────────────────────────────────────────────────
  function showBonus(text) {
    const popup = $('#bonusPopup');
    $('#bonusText').textContent = text;
    popup.classList.remove('hidden');
    popup.classList.add('show');
    SFX.bonus();
    const rect = popup.getBoundingClientRect();
    burstGoldParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 12);
    setTimeout(() => {
      popup.classList.remove('show');
      setTimeout(() => popup.classList.add('hidden'), 400);
    }, 2500);
  }

  // ─── Comeback Bonus ────────────────────────────────────────────────────
  async function checkComebackBonus() {
    if (!player || !player.lastPlayedAt) return;
    const hoursAway = (Date.now() - player.lastPlayedAt) / 3600000;
    if (hoursAway < 48) return;
    const daysAway = Math.floor(hoursAway / 24);
    const bonus = Math.min(5, daysAway);
    try {
      const res = await api('comeback-bonus', { playerId: player.id });
      if (res.success) {
        player = res.player;
        renderPlayer();
        setTimeout(() => {
          showBonus(`🎁 WELCOME BACK! +${res.bonus} FREE ENTRIES!`);
        }, 1500);
        setTimeout(() => {
          showBonus(`We missed you! ${daysAway} days away = ${res.bonus} bonus entries 💛`);
        }, 4500);
      }
    } catch {}
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ─── Offer Dismiss Buttons ──────────────────────────────────────────────
  function initOfferDismiss() {
    // Restore dismissed state from sessionStorage
    const dismissed = JSON.parse(sessionStorage.getItem('goldpot_dismissed_offers') || '[]');
    dismissed.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('offer-dismissed');
    });
    // Delegate click handler for all dismiss buttons — Q7: smooth animation
    document.addEventListener('click', e => {
      const btn = e.target.closest('.offer-dismiss');
      if (!btn) return;
      const targetId = btn.getAttribute('data-dismiss');
      if (!targetId) return;
      const el = document.getElementById(targetId);
      if (el) {
        el.classList.add('offer-dismissing');
        el.addEventListener('animationend', () => {
          el.classList.add('offer-dismissed');
          el.classList.remove('offer-dismissing');
        }, { once: true });
      }
      const list = JSON.parse(sessionStorage.getItem('goldpot_dismissed_offers') || '[]');
      if (!list.includes(targetId)) list.push(targetId);
      sessionStorage.setItem('goldpot_dismissed_offers', JSON.stringify(list));
    });
  }

  // ─── Button Ripple Effect ────────────────────────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn, .btn-premium, .btn-checkout, .pay-option, .withdraw-option');
    if (!btn) return;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    const rect = btn.getBoundingClientRect();
    ripple.style.left = (e.clientX - rect.left) + 'px';
    ripple.style.top = (e.clientY - rect.top) + 'px';
    btn.style.position = btn.style.position || 'relative';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  // ─── Gold Particle Burst ───────────────────────────────────────────────
  function burstGoldParticles(x, y, count) {
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'gold-particle';
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.setProperty('--px', (Math.random() - 0.5) * 200 + 'px');
      p.style.setProperty('--py', -(Math.random() * 150 + 50) + 'px');
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 900);
    }
  }

  // ─── Live Chat — Left Sidebar Feed ──────────────────────────────────────
  let chatOpen = true;
  let chatUnread = 0;
  let chatReactTarget = null; // msgId currently showing reaction popup
  let typingTimeout = null;
  let typingIndicatorTimeout = null;
  let chatSoundEnabled = true;
  let chatReplyTarget = null; // { id, name, text } of message being replied to
  let chatOnlineUsers = [];   // list of online user names for @mention
  let chatMentionIdx = -1;    // active autocomplete index
  let chatMentionQuery = '';  // current @query
  let chatAutoScroll = true;  // smart auto-scroll
  const CHAT_COLORS = ['#f0c040','#60c0ff','#ff6090','#40e070','#b060ff','#ff8040','#40d0d0','#e060e0'];
  const REACT_EMOJIS = ['🔥','😂','❤️','👀','🏆','💰','🎉','👑','💎','⚡','🤑','🙌'];

  // Border style maps for avatar border cosmetics
  const AVATAR_BORDERS = {
    fire: '2px solid #ff4500',
    ice: '2px solid #60e0ff',
    gold: '2px solid #f0c040',
  };
  const AVATAR_SHADOWS = {
    fire: '0 0 10px rgba(255,69,0,0.6)',
    ice: '0 0 10px rgba(96,224,255,0.6)',
    gold: '0 0 10px rgba(240,192,64,0.6)',
  };

  // Chat notification sound (short blip) — uses shared AudioContext
  function chatNotifSound() {
    if (!chatSoundEnabled || !soundEnabled) return;
    try {
      const ctx = getAudio();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* ignore audio errors */ }
  }

  function getChatColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return CHAT_COLORS[Math.abs(h) % CHAT_COLORS.length];
  }

  function formatChatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function buildReactionsHtml(msgId, reactions) {
    if (!reactions || Object.keys(reactions).length === 0) return '';
    let html = '<div class="chat-reactions">';
    for (const [emoji, users] of Object.entries(reactions)) {
      const isMine = player && Array.isArray(users) && users.includes(player.id);
      html += '<button class="chat-reaction' + (isMine ? ' mine' : '') + '" data-msgid="' + msgId + '" data-emoji="' + emoji + '">' +
        '<span class="chat-reaction-emoji">' + emoji + '</span>' +
        '<span class="chat-reaction-count">' + (Array.isArray(users) ? users.length : users) + '</span>' +
      '</button>';
    }
    html += '</div>';
    return html;
  }

  // Highlight @mentions in message text
  function highlightMentions(text) {
    return text.replace(/@(\w{1,20})/g, function(match, name) {
      const isMe = player && player.name && player.name.toLowerCase() === name.toLowerCase();
      return '<span class="chat-mention' + (isMe ? ' chat-mention-me' : '') + '">' + match + '</span>';
    });
  }

  // Text formatting: **bold**, *italic*, `code`, ~~strikethrough~~
  function formatChatText(html) {
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    return html;
  }

  function renderChatMsg(msg) {
    const container = $('#chatMessages');
    if (!container) return;
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'chat-msg';
    // Apply message effect cosmetic
    if (msg.cosmetics && msg.cosmetics.msgEffect) {
      el.classList.add('chat-effect-' + msg.cosmetics.msgEffect);
    }
    // Command & action subtypes
    if (msg.subtype === 'command') el.classList.add('chat-msg-command');
    if (msg.subtype === 'action') el.classList.add('chat-msg-action');
    el.dataset.msgid = msg.id;
    if (msg.playerId) el.dataset.playerid = msg.playerId;

    const color = (msg.cosmetics && msg.cosmetics.nameColor) ? msg.cosmetics.nameColor : getChatColor(msg.name);
    const initials = msg.name.slice(0, 2).toUpperCase();
    const levelClass = msg.level >= 5 ? ' high' : '';
    const nameClass = msg.vip ? ' vip' : '';
    const vipBadge = msg.vip ? '<span class="chat-msg-vip-badge">VIP</span>' : '';
    const titleBadge = (msg.cosmetics && msg.cosmetics.title) ? '<span class="chat-msg-title">' + escapeHtml(msg.cosmetics.title) + '</span>' : '';

    // Avatar border cosmetic
    let avatarStyle = 'background:' + color;
    if (msg.cosmetics && msg.cosmetics.avatarBorder) {
      const bv = msg.cosmetics.avatarBorder;
      if (AVATAR_BORDERS[bv]) avatarStyle += ';border:' + AVATAR_BORDERS[bv] + ';box-shadow:' + (AVATAR_SHADOWS[bv] || '');
    }

    // Reply preview
    let replyHtml = '';
    if (msg.replyTo) {
      replyHtml = '<div class="chat-reply-preview" data-reply-to="' + msg.replyTo.id + '">' +
        '<span class="chat-reply-icon">↩</span>' +
        '<span class="chat-reply-name">' + escapeHtml(msg.replyTo.name) + '</span> ' +
        '<span class="chat-reply-text">' + escapeHtml(msg.replyTo.text) + '</span>' +
      '</div>';
    }

    // GIF
    let gifHtml = '';
    if (msg.gif) {
      gifHtml = '<div class="chat-gif"><img src="' + escapeHtml(msg.gif) + '" alt="GIF" loading="lazy"></div>';
    }

    // Message text with @mentions highlighted and text formatting
    let msgTextHtml = highlightMentions(escapeHtml(msg.text));
    msgTextHtml = formatChatText(msgTextHtml);

    // Command icon prefix
    const cmdIcon = msg.subtype === 'command'
      ? '<span class="chat-cmd-icon">' + (msg.cmdType === 'coinflip' ? '🪙' : msg.cmdType === 'roll' ? '🎲' : msg.cmdType === '8ball' ? '🎱' : '⚡') + '</span> '
      : '';

    // Check if this is our own message  
    const isOwn = player && msg.playerId === player.id;

    // Name color style
    const nameStyle = (msg.cosmetics && msg.cosmetics.nameColor) ? ' style="color:' + msg.cosmetics.nameColor + '"' : '';

    el.innerHTML =
      '<div class="chat-avatar" style="' + avatarStyle + '">' + initials + '</div>' +
      '<div class="chat-msg-body">' +
        replyHtml +
        '<div class="chat-msg-header">' +
          '<span class="chat-msg-name' + nameClass + '"' + nameStyle + '>' + escapeHtml(msg.name) + '</span>' +
          '<span class="chat-msg-level' + levelClass + '">LV' + (msg.level || 1) + '</span>' +
          vipBadge + titleBadge +
          '<span class="chat-msg-time">' + formatChatTime(msg.ts) + '</span>' +
        '</div>' +
        '<div class="chat-msg-text">' + cmdIcon + msgTextHtml + '</div>' +
        gifHtml +
        buildReactionsHtml(msg.id, msg.reactions) +
      '</div>' +
      '<div class="chat-msg-actions">' +
        '<button class="chat-action-btn chat-reply-btn" data-msgid="' + msg.id + '" data-name="' + escapeHtml(msg.name) + '" data-text="' + escapeHtml((msg.text || '').slice(0, 60)) + '" title="Reply">↩</button>' +
        '<button class="chat-react-trigger" data-msgid="' + msg.id + '" title="React">😀</button>' +
        (isOwn ? '<button class="chat-action-btn chat-delete-btn" data-msgid="' + msg.id + '" title="Delete">✕</button>' : '') +
      '</div>';

    // Check smart scroll before appending
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

    container.appendChild(el);

    // Smart auto-scroll
    if (wasAtBottom || (player && msg.playerId === player.id)) {
      container.scrollTop = container.scrollHeight;
      hideScrollFAB();
    } else {
      showScrollFAB();
    }

    while (container.children.length > 100) container.removeChild(container.firstChild);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  var escHtml = escapeHtml;

  function handleChatMessage(msg) {
    renderChatMsg(msg);
    // Sound notification for messages from others
    if (player && msg.playerId !== player.id) {
      chatNotifSound();
      // Extra highlight if mentioned
      if (msg.text && player.name && msg.text.toLowerCase().includes('@' + player.name.toLowerCase())) {
        const msgEl = document.querySelector('.chat-msg[data-msgid="' + msg.id + '"]');
        if (msgEl) msgEl.classList.add('chat-msg-mentioned');
      }
    }
    if (!chatOpen) {
      chatUnread++;
      updateChatBadge();
    }
  }

  function handleChatHistory(messages) {
    const container = $('#chatMessages');
    if (!container) return;
    container.innerHTML = '';
    if (!messages || messages.length === 0) {
      container.innerHTML = '<div class="chat-empty">No messages yet — say hi! 👋</div>';
      return;
    }
    for (const msg of messages) renderChatMsg(msg);
  }

  function handleChatDelete(data) {
    const msgEl = document.querySelector('.chat-msg[data-msgid="' + data.msgId + '"]');
    if (msgEl) {
      msgEl.style.transition = 'opacity 0.3s, transform 0.3s';
      msgEl.style.opacity = '0';
      msgEl.style.transform = 'translateX(-20px)';
      setTimeout(function() { msgEl.remove(); }, 300);
    }
  }

  // ─── Chat Polls ───
  function handleChatPoll(data) {
    const container = $('#chatMessages');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-poll-card';
    el.dataset.pollid = data.pollId;

    const timeLeft = Math.max(0, Math.ceil((data.endsAt - Date.now()) / 1000));
    let optionsHtml = '';
    for (let i = 0; i < data.options.length; i++) {
      optionsHtml += '<button class="chat-poll-option" data-option="' + escapeHtml(data.options[i]) + '">' +
        '<span class="chat-poll-option-label">' + escapeHtml(data.options[i]) + '</span>' +
        '<span class="chat-poll-option-bar"><span class="chat-poll-option-fill" style="width:0%"></span></span>' +
        '<span class="chat-poll-option-count">0</span>' +
      '</button>';
    }

    el.innerHTML =
      '<div class="chat-poll-header">' +
        '<span class="chat-poll-icon">📊</span>' +
        '<span class="chat-poll-question">' + escapeHtml(data.question) + '</span>' +
        '<span class="chat-poll-by">by ' + escapeHtml(data.creatorName) + '</span>' +
      '</div>' +
      '<div class="chat-poll-options">' + optionsHtml + '</div>' +
      '<div class="chat-poll-footer">' +
        '<span class="chat-poll-timer">⏱ ' + timeLeft + 's remaining</span>' +
        '<span class="chat-poll-total">0 votes</span>' +
      '</div>';

    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    container.appendChild(el);
    if (wasAtBottom) container.scrollTop = container.scrollHeight;

    // Countdown timer
    const timerEl = el.querySelector('.chat-poll-timer');
    const pollInterval = setInterval(function() {
      const rem = Math.max(0, Math.ceil((data.endsAt - Date.now()) / 1000));
      if (timerEl) timerEl.textContent = '⏱ ' + rem + 's remaining';
      if (rem <= 0) clearInterval(pollInterval);
    }, 1000);
  }

  function handleChatPollUpdate(data) {
    const card = document.querySelector('.chat-poll-card[data-pollid="' + data.pollId + '"]');
    if (!card) return;
    const total = Object.values(data.votes).reduce(function(a, b) { return a + b; }, 0);
    const options = card.querySelectorAll('.chat-poll-option');
    options.forEach(function(opt) {
      const label = opt.dataset.option;
      const count = data.votes[label] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const fill = opt.querySelector('.chat-poll-option-fill');
      const countEl = opt.querySelector('.chat-poll-option-count');
      if (fill) fill.style.width = pct + '%';
      if (countEl) countEl.textContent = count;
    });
    const totalEl = card.querySelector('.chat-poll-total');
    if (totalEl) totalEl.textContent = total + ' vote' + (total !== 1 ? 's' : '');
  }

  function handleChatPollEnd(data) {
    const card = document.querySelector('.chat-poll-card[data-pollid="' + data.pollId + '"]');
    if (card) {
      card.classList.add('chat-poll-ended');
      const timer = card.querySelector('.chat-poll-timer');
      if (timer) timer.textContent = '✅ Poll ended';
      // Update final results
      const total = Object.values(data.results).reduce(function(a, b) { return a + b; }, 0);
      const options = card.querySelectorAll('.chat-poll-option');
      options.forEach(function(opt) {
        const label = opt.dataset.option;
        const count = data.results[label] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const fill = opt.querySelector('.chat-poll-option-fill');
        const countEl = opt.querySelector('.chat-poll-option-count');
        if (fill) fill.style.width = pct + '%';
        if (countEl) countEl.textContent = count;
        opt.disabled = true;
      });
      // Highlight winner
      let maxCount = 0, winnerOpt = null;
      options.forEach(function(opt) {
        const c = data.results[opt.dataset.option] || 0;
        if (c > maxCount) { maxCount = c; winnerOpt = opt; }
      });
      if (winnerOpt) winnerOpt.classList.add('chat-poll-winner');
    }
  }

  // ─── Entry Rain ───
  function handleChatRain(data) {
    // Insert rain announcement in chat
    const container = $('#chatMessages');
    if (container) {
      const el = document.createElement('div');
      el.className = 'chat-rain-msg';
      el.innerHTML =
        '<div class="chat-rain-icon">🌧️✨</div>' +
        '<div class="chat-rain-info">' +
          '<strong>' + escapeHtml(data.name) + '</strong> made it rain!' +
          '<div class="chat-rain-detail">' + data.totalGiven + ' entries shared with ' + data.recipientCount + ' players (' + data.perPerson + ' each)</div>' +
        '</div>';
      const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
      container.appendChild(el);
      if (wasAtBottom) container.scrollTop = container.scrollHeight;
    }
    // Full-screen rain animation
    showRainAnimation(data.recipientCount);
    // Refresh player state to update entries
    fetchState();
  }

  function showRainAnimation(count) {
    var overlay = document.createElement('div');
    overlay.className = 'chat-rain-overlay';
    document.body.appendChild(overlay);
    var symbols = ['🪙', '💰', '✨', '⭐', '💎'];
    var particles = Math.min(count * 5, 60);
    for (var i = 0; i < particles; i++) {
      var coin = document.createElement('span');
      coin.className = 'chat-rain-coin';
      coin.textContent = symbols[Math.floor(Math.random() * symbols.length)];
      coin.style.left = (Math.random() * 100) + '%';
      coin.style.animationDelay = (Math.random() * 1.5) + 's';
      coin.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
      coin.style.fontSize = (16 + Math.random() * 20) + 'px';
      overlay.appendChild(coin);
    }
    setTimeout(function() { overlay.remove(); }, 4000);
  }

  // ─── Chat Error Toast ───
  function handleChatError(data) {
    var toast = document.createElement('div');
    toast.className = 'chat-error-toast';
    toast.textContent = data.text;
    // Show on body so it's visible even when chat sidebar is collapsed
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('visible'); }, 10);
    setTimeout(function() {
      toast.classList.remove('visible');
      setTimeout(function() { toast.remove(); }, 300);
    }, 3500);
  }

  // ─── Slash Command Hints ───
  function showSlashHints(input) {
    var val = input.value;
    var dropdown = $('#chatSlashHints');
    if (!dropdown) return;
    if (!val.startsWith('/') || val.includes(' ')) {
      dropdown.classList.add('hidden');
      return;
    }
    var query = val.slice(1).toLowerCase();
    var cmds = [
      { cmd: '/coinflip', desc: 'Flip a coin', icon: '🪙' },
      { cmd: '/roll', desc: 'Roll dice (1-100)', icon: '🎲' },
      { cmd: '/8ball', desc: 'Ask the magic 8-ball', icon: '🎱' },
      { cmd: '/me', desc: 'Action message', icon: '💬' },
      { cmd: '/shrug', desc: 'Append ¯\\_(ツ)_/¯', icon: '🤷' },
      { cmd: '/poll', desc: 'Create a poll', icon: '📊' },
      { cmd: '/rain', desc: 'Rain entries on chat', icon: '🌧️' },
    ];
    var filtered = cmds.filter(function(c) { return c.cmd.indexOf('/' + query) === 0; });
    if (filtered.length === 0) { dropdown.classList.add('hidden'); return; }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      html += '<div class="chat-slash-item" data-cmd="' + filtered[i].cmd + '">' +
        '<span class="chat-slash-icon">' + filtered[i].icon + '</span>' +
        '<span class="chat-slash-cmd">' + filtered[i].cmd + '</span>' +
        '<span class="chat-slash-desc">' + filtered[i].desc + '</span>' +
      '</div>';
    }
    dropdown.innerHTML = html;
    dropdown.classList.remove('hidden');
  }

  function handleChatReaction(data) {
    const msgEl = document.querySelector('.chat-msg[data-msgid="' + data.msgId + '"]');
    if (!msgEl) return;
    const body = msgEl.querySelector('.chat-msg-body');
    if (!body) return;
    // Remove existing reactions container
    const old = body.querySelector('.chat-reactions');
    if (old) old.remove();
    // Build and insert new reactions
    const html = buildReactionsHtml(data.msgId, data.reactions);
    if (html) body.insertAdjacentHTML('beforeend', html);
    // Float animation on the emoji
    if (data.emoji) {
      const floater = document.createElement('span');
      floater.className = 'chat-reaction-float';
      floater.textContent = data.emoji;
      floater.style.left = '50%';
      floater.style.bottom = '0';
      msgEl.appendChild(floater);
      setTimeout(() => floater.remove(), 1200);
    }
  }

  function handleChatTyping(data) {
    if (player && data.playerId === player.id) return;
    const typingEl = $('#chatTyping');
    const typingText = $('#chatTypingText');
    if (!typingEl || !typingText) return;
    typingText.textContent = escapeHtml(data.name) + ' is typing...';
    typingEl.classList.remove('hidden');
    clearTimeout(typingIndicatorTimeout);
    typingIndicatorTimeout = setTimeout(() => {
      typingEl.classList.add('hidden');
    }, 3000);
  }

  function updateChatBadge() {
    const badge = $('#chatBadge');
    if (!badge) return;
    if (chatUnread > 0) {
      badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    // Q41: also update bottom nav badge
    updateChatNavBadge();
    // Q40: update chat bubble badge
    const bubbleBadge = document.querySelector('.chat-bubble-badge');
    if (bubbleBadge) {
      if (chatUnread > 0) {
        bubbleBadge.textContent = chatUnread > 99 ? '99+' : chatUnread;
        bubbleBadge.classList.remove('hidden');
      } else {
        bubbleBadge.classList.add('hidden');
      }
    }
  }

  function sendChatMessage(text) {
    if (!ws || ws.readyState !== 1) return;
    if (!text || text.length < 1) return;
    const payload = { type: 'chat', text: text };
    if (chatReplyTarget) {
      payload.replyTo = chatReplyTarget.id;
      clearReply();
    }
    ws.send(JSON.stringify(payload));
  }

  function sendChatGif(gifUrl, caption) {
    if (!ws || ws.readyState !== 1) return;
    const payload = { type: 'chat', text: caption || '🎬 GIF', gif: gifUrl };
    if (chatReplyTarget) {
      payload.replyTo = chatReplyTarget.id;
      clearReply();
    }
    ws.send(JSON.stringify(payload));
  }

  function sendChatReaction(msgId, emoji) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat_react', msgId: msgId, emoji: emoji }));
  }

  function sendChatDelete(msgId) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat_delete', msgId: msgId }));
  }

  function sendTyping() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat_typing' }));
  }

  function requestOnlineUsers() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat_online' }));
  }

  // ─── Reply system ───
  function setReply(msgId, name, text) {
    chatReplyTarget = { id: msgId, name: name, text: text };
    var bar = $('#chatReplyBar');
    if (bar) {
      bar.querySelector('.chat-reply-bar-name').textContent = name;
      bar.querySelector('.chat-reply-bar-text').textContent = text;
      bar.classList.remove('hidden');
    }
    var input = $('#chatInput');
    if (input) input.focus();
  }

  function clearReply() {
    chatReplyTarget = null;
    var bar = $('#chatReplyBar');
    if (bar) bar.classList.add('hidden');
  }

  // ─── Scroll FAB (new messages indicator) ───
  function showScrollFAB() {
    var fab = $('#chatScrollFab');
    if (fab) fab.classList.remove('hidden');
  }

  function hideScrollFAB() {
    var fab = $('#chatScrollFab');
    if (fab) fab.classList.add('hidden');
  }

  function scrollChatToBottom() {
    var container = $('#chatMessages');
    if (container) container.scrollTop = container.scrollHeight;
    hideScrollFAB();
  }

  // ─── @Mention Autocomplete ───
  function updateMentionAutocomplete(input) {
    var val = input.value;
    var cursorPos = input.selectionStart;
    // Find @word at cursor
    var beforeCursor = val.slice(0, cursorPos);
    var match = beforeCursor.match(/@(\w*)$/);
    var dropdown = $('#chatMentionDropdown');
    if (!dropdown) return;

    if (!match) {
      dropdown.classList.add('hidden');
      chatMentionIdx = -1;
      chatMentionQuery = '';
      return;
    }

    chatMentionQuery = match[1].toLowerCase();
    var filtered = chatOnlineUsers.filter(function(u) {
      return u.toLowerCase().indexOf(chatMentionQuery) === 0 && (!player || u !== player.name);
    }).slice(0, 6);

    if (filtered.length === 0) {
      if (chatMentionQuery.length > 0) {
        dropdown.innerHTML = '<div class="chat-mention-empty">No matching users</div>';
        dropdown.classList.remove('hidden');
      } else {
        dropdown.classList.add('hidden');
      }
      chatMentionIdx = -1;
      return;
    }

    chatMentionIdx = Math.min(chatMentionIdx, filtered.length - 1);
    if (chatMentionIdx < 0) chatMentionIdx = 0;

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      html += '<div class="chat-mention-item' + (i === chatMentionIdx ? ' active' : '') + '" data-name="' + escapeHtml(filtered[i]) + '">' +
        '<span class="chat-mention-avatar" style="background:' + getChatColor(filtered[i]) + '">' + filtered[i].slice(0, 2).toUpperCase() + '</span>' +
        '<span>' + escapeHtml(filtered[i]) + '</span>' +
      '</div>';
    }
    dropdown.innerHTML = html;
    dropdown.classList.remove('hidden');
  }

  function applyMention(input, name) {
    var val = input.value;
    var cursorPos = input.selectionStart;
    var beforeCursor = val.slice(0, cursorPos);
    var afterCursor = val.slice(cursorPos);
    var replaced = beforeCursor.replace(/@\w*$/, '@' + name + ' ');
    input.value = replaced + afterCursor;
    input.selectionStart = input.selectionEnd = replaced.length;
    var dropdown = $('#chatMentionDropdown');
    if (dropdown) dropdown.classList.add('hidden');
    chatMentionIdx = -1;
    input.focus();
  }

  // ─── GIF Picker ───
  let gifSearchTimeout = null;
  const TENOR_KEY = 'AIzaSyC_qG39G2OBLaaFq8kSJR3Hkz9JCq_hABM'; // public Tenor API v2 key

  function openGifPicker() {
    var picker = $('#chatGifPicker');
    if (picker) {
      picker.classList.toggle('hidden');
      if (!picker.classList.contains('hidden')) {
        var searchInput = picker.querySelector('.chat-gif-search');
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        loadTrendingGifs();
      }
    }
  }

  function loadTrendingGifs() {
    var grid = $('#chatGifGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="chat-gif-loading">Loading trending GIFs...</div>';
    fetch('https://tenor.googleapis.com/v2/featured?key=' + encodeURIComponent(TENOR_KEY) + '&limit=20&media_filter=tinygif')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        renderGifResults(data.results || []);
      })
      .catch(function() {
        grid.innerHTML = '<div class="chat-gif-loading">Could not load GIFs<br><button class="chat-gif-retry">Retry</button></div>';
        var retryBtn = grid.querySelector('.chat-gif-retry');
        if (retryBtn) retryBtn.addEventListener('click', loadTrendingGifs);
      });
  }

  function searchGifs(query) {
    var grid = $('#chatGifGrid');
    if (!grid) return;
    if (!query || query.length < 2) { loadTrendingGifs(); return; }
    grid.innerHTML = '<div class="chat-gif-loading">Searching...</div>';
    fetch('https://tenor.googleapis.com/v2/search?key=' + encodeURIComponent(TENOR_KEY) + '&q=' + encodeURIComponent(query) + '&limit=20&media_filter=tinygif')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        renderGifResults(data.results || []);
      })
      .catch(function() {
        grid.innerHTML = '<div class="chat-gif-loading">Search failed<br><button class="chat-gif-retry">Retry</button></div>';
        var retryBtn = grid.querySelector('.chat-gif-retry');
        if (retryBtn) retryBtn.addEventListener('click', function() { searchGifs(document.querySelector('.chat-gif-search')?.value); });
      });
  }

  function renderGifResults(results) {
    var grid = $('#chatGifGrid');
    if (!grid) return;
    if (results.length === 0) {
      grid.innerHTML = '<div class="chat-gif-loading">No GIFs found</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < results.length; i++) {
      var gif = results[i];
      var url = gif.media_formats && gif.media_formats.tinygif ? gif.media_formats.tinygif.url : '';
      var fullUrl = gif.media_formats && gif.media_formats.gif ? gif.media_formats.gif.url : url;
      if (url) {
        html += '<img class="chat-gif-item" src="' + escapeHtml(url) + '" data-full="' + escapeHtml(fullUrl) + '" alt="GIF" loading="lazy">';
      }
    }
    grid.innerHTML = html;
  }

  function showReactPopup(msgId, triggerEl) {
    // Close any existing popup
    closeReactPopup();
    chatReactTarget = msgId;
    const popup = document.createElement('div');
    popup.className = 'chat-react-popup';
    popup.id = 'chatReactPopup';
    for (var i = 0; i < REACT_EMOJIS.length; i++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = REACT_EMOJIS[i];
      btn.dataset.emoji = REACT_EMOJIS[i];
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        sendChatReaction(msgId, this.dataset.emoji);
        closeReactPopup();
      });
      popup.appendChild(btn);
    }
    triggerEl.parentElement.appendChild(popup);
  }

  function closeReactPopup() {
    chatReactTarget = null;
    var popup = document.getElementById('chatReactPopup');
    if (popup) popup.remove();
  }

  function initChat() {
    var sidebar = $('#chatSidebar');
    var collapseBtn = $('#chatCollapse');
    var expandBtn = $('#chatExpandBtn');
    var form = $('#chatForm');
    var input = $('#chatInput');
    var emojiToggle = $('#chatEmojiToggle');
    var emojiPicker = $('#chatEmojiPicker');
    if (!sidebar) return;

    // Collapse / expand — Q4: 300px, Q38: fullscreen mobile, Q40: bubble
    if (collapseBtn) collapseBtn.addEventListener('click', function() {
      chatOpen = false;
      sidebar.classList.add('collapsed');
      if (expandBtn) expandBtn.classList.remove('hidden');
      // Q40: show chat bubble on mobile
      var bubble = $('#chatBubble');
      if (bubble && window.innerWidth <= 600) bubble.classList.remove('hidden');
      document.body.style.paddingLeft = window.innerWidth > 600 ? '20px' : '0';
    });
    if (expandBtn) expandBtn.addEventListener('click', function() {
      chatOpen = true;
      sidebar.classList.remove('collapsed');
      expandBtn.classList.add('hidden');
      var bubble = $('#chatBubble');
      if (bubble) bubble.classList.add('hidden');
      chatUnread = 0;
      updateChatBadge();
      document.body.style.paddingLeft = window.innerWidth > 600 ? '300px' : '0';
      var container = $('#chatMessages');
      if (container) container.scrollTop = container.scrollHeight;
    });
    // Q40: chat bubble opens chat
    var chatBubbleBtn = $('#chatBubble');
    if (chatBubbleBtn) chatBubbleBtn.addEventListener('click', function() {
      chatOpen = true;
      sidebar.classList.remove('collapsed');
      chatBubbleBtn.classList.add('hidden');
      if (expandBtn) expandBtn.classList.add('hidden');
      chatUnread = 0;
      updateChatBadge();
      var container = $('#chatMessages');
      if (container) container.scrollTop = container.scrollHeight;
    });

    // Submit message — Q34: blur input on mobile to dismiss keyboard
    if (form) form.addEventListener('submit', function(e) {
      e.preventDefault();
      if (!input) return;
      var text = input.value.trim();
      if (!text) return;
      sendChatMessage(text);
      input.value = '';
      // Q34: dismiss keyboard on mobile after send
      if (window.innerWidth <= 600) input.blur();
      var dropdown = $('#chatMentionDropdown');
      if (dropdown) dropdown.classList.add('hidden');
    });

    // Typing indicator + @mention autocomplete
    if (input) {
      input.addEventListener('input', function() {
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(function() { sendTyping(); }, 400);
        updateMentionAutocomplete(input);
        showSlashHints(input);
      });

      input.addEventListener('keydown', function(e) {
        var dropdown = $('#chatMentionDropdown');
        if (!dropdown || dropdown.classList.contains('hidden')) return;
        var items = dropdown.querySelectorAll('.chat-mention-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          chatMentionIdx = Math.min(chatMentionIdx + 1, items.length - 1);
          items.forEach(function(it, i) { it.classList.toggle('active', i === chatMentionIdx); });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          chatMentionIdx = Math.max(chatMentionIdx - 1, 0);
          items.forEach(function(it, i) { it.classList.toggle('active', i === chatMentionIdx); });
        } else if (e.key === 'Tab' || e.key === 'Enter') {
          if (chatMentionIdx >= 0 && items[chatMentionIdx]) {
            e.preventDefault();
            applyMention(input, items[chatMentionIdx].dataset.name);
          }
        } else if (e.key === 'Escape') {
          dropdown.classList.add('hidden');
          chatMentionIdx = -1;
        }
      });
    }

    // Emoji toggle
    if (emojiToggle && emojiPicker) {
      emojiToggle.addEventListener('click', function() {
        emojiPicker.classList.toggle('hidden');
      });
    }

    // Emoji buttons insert into input
    if (emojiPicker && input) {
      emojiPicker.addEventListener('click', function(e) {
        var btn = e.target.closest('.chat-emoji-btn');
        if (!btn) return;
        var emoji = btn.dataset.emoji;
        if (!emoji) return;
        input.value += emoji;
        input.focus();
      });
    }

    // Sound toggle
    var soundToggle = $('#chatSoundToggle');
    if (soundToggle) {
      soundToggle.addEventListener('click', function() {
        chatSoundEnabled = !chatSoundEnabled;
        soundToggle.textContent = chatSoundEnabled ? '🔔' : '🔕';
        soundToggle.title = chatSoundEnabled ? 'Mute notifications' : 'Unmute notifications';
      });
    }

    // Reply bar close
    var replyClose = $('#chatReplyClose');
    if (replyClose) replyClose.addEventListener('click', clearReply);

    // Scroll FAB
    var scrollFab = $('#chatScrollFab');
    if (scrollFab) scrollFab.addEventListener('click', scrollChatToBottom);

    // Smart scroll detection
    var feed = $('#chatMessages');
    if (feed) {
      feed.addEventListener('scroll', function() {
        var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
        if (atBottom) hideScrollFAB();
      });
    }

    // GIF picker
    var gifToggle = $('#chatGifToggle');
    if (gifToggle) gifToggle.addEventListener('click', openGifPicker);

    var gifSearchInput = document.querySelector('.chat-gif-search');
    if (gifSearchInput) {
      gifSearchInput.addEventListener('input', function() {
        clearTimeout(gifSearchTimeout);
        var q = this.value.trim();
        gifSearchTimeout = setTimeout(function() { searchGifs(q); }, 400);
      });
    }

    // GIF grid click
    var gifGrid = $('#chatGifGrid');
    if (gifGrid) {
      gifGrid.addEventListener('click', function(e) {
        var img = e.target.closest('.chat-gif-item');
        if (!img) return;
        var fullUrl = img.dataset.full || img.src;
        sendChatGif(fullUrl, '');
        var picker = $('#chatGifPicker');
        if (picker) picker.classList.add('hidden');
      });
    }

    // @Mention dropdown click
    var mentionDropdown = $('#chatMentionDropdown');
    if (mentionDropdown) {
      mentionDropdown.addEventListener('click', function(e) {
        var item = e.target.closest('.chat-mention-item');
        if (item && input) {
          applyMention(input, item.dataset.name);
        }
      });
    }

    // Delegate: reaction trigger, reply, delete buttons & reaction pills
    document.addEventListener('click', function(e) {
      // Reply button
      var replyBtn = e.target.closest('.chat-reply-btn');
      if (replyBtn) {
        e.stopPropagation();
        setReply(replyBtn.dataset.msgid, replyBtn.dataset.name, replyBtn.dataset.text);
        return;
      }
      // Delete button
      var deleteBtn = e.target.closest('.chat-delete-btn');
      if (deleteBtn) {
        e.stopPropagation();
        sendChatDelete(deleteBtn.dataset.msgid);
        return;
      }
      // Reaction trigger (emoji face on hover)
      var trigger = e.target.closest('.chat-react-trigger');
      if (trigger) {
        e.stopPropagation();
        var mid = trigger.dataset.msgid;
        if (chatReactTarget === mid) { closeReactPopup(); return; }
        showReactPopup(mid, trigger);
        return;
      }
      // Reaction pill click (toggle own reaction)
      var pill = e.target.closest('.chat-reaction');
      if (pill) {
        e.stopPropagation();
        sendChatReaction(pill.dataset.msgid, pill.dataset.emoji);
        return;
      }
      // Click on reply preview scrolls to original
      var replyPreview = e.target.closest('.chat-reply-preview');
      if (replyPreview) {
        var origId = replyPreview.dataset.replyTo;
        var origMsg = document.querySelector('.chat-msg[data-msgid="' + origId + '"]');
        if (origMsg) {
          origMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
          origMsg.classList.add('chat-msg-highlight');
          setTimeout(function() { origMsg.classList.remove('chat-msg-highlight'); }, 1500);
        }
        return;
      }
      // Click elsewhere closes popup
      closeReactPopup();
    });

    // Poll vote clicks
    document.addEventListener('click', function(e) {
      var opt = e.target.closest('.chat-poll-option');
      if (opt && !opt.disabled) {
        var card = opt.closest('.chat-poll-card');
        if (card && !card.classList.contains('chat-poll-ended')) {
          var pollId = card.dataset.pollid;
          var option = opt.dataset.option;
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'chat_poll_vote', pollId: pollId, option: option }));
          }
          // Visual feedback
          card.querySelectorAll('.chat-poll-option').forEach(function(o) { o.classList.remove('chat-poll-voted'); });
          opt.classList.add('chat-poll-voted');
        }
      }
    });

    // Slash hint click
    var slashHints = $('#chatSlashHints');
    if (slashHints) {
      slashHints.addEventListener('click', function(e) {
        var item = e.target.closest('.chat-slash-item');
        if (item && input) {
          input.value = item.dataset.cmd + ' ';
          input.focus();
          slashHints.classList.add('hidden');
        }
      });
    }

    // Periodically refresh online users for @mention
    requestOnlineUsers();
    setInterval(requestOnlineUsers, 15000);
  }

  // ─── PVP DUEL ARENA ────────────────────────────────────────────────────
  let activeDuelId = null;
  let duelSelectedStake = 100;
  let duelSelectedBoosts = [];
  let duelGameInstance = null;
  let duelData = { active: [], recentResults: [], stats: {}, stakes: {}, boosts: {} };

  function initDuelUI() {
    // Create duel button
    const createBtn = $('#btnCreateDuel');
    if (createBtn) createBtn.addEventListener('click', handleCreateDuel);
    // Duel ready button
    const readyBtn = $('#btnDuelReady');
    if (readyBtn) readyBtn.addEventListener('click', handleDuelReady);
    // Result modal close
    const closeBtn = $('#btnDuelResultClose');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      $('#duelResultModal').classList.add('hidden');
      leaveDuelLiveView();
    });
    // Rematch
    const rematchBtn = $('#btnDuelRematch');
    if (rematchBtn) rematchBtn.addEventListener('click', handleDuelRematch);
    // Tip buttons
    const tipP1 = $('#btnDuelTipP1');
    const tipP2 = $('#btnDuelTipP2');
    if (tipP1) tipP1.addEventListener('click', () => handleDuelTip('p1'));
    if (tipP2) tipP2.addEventListener('click', () => handleDuelTip('p2'));
  }

  function renderDuelStakeSelector(stakes) {
    const el = $('#duelStakeSelector');
    if (!el) return;
    el.innerHTML = '';
    for (const [amount, cfg] of Object.entries(stakes)) {
      const btn = document.createElement('button');
      btn.className = 'duel-stake-btn' + (parseInt(amount) === duelSelectedStake ? ' active' : '');
      btn.textContent = cfg.label;
      btn.dataset.stake = amount;
      btn.addEventListener('click', () => {
        duelSelectedStake = parseInt(amount);
        el.querySelectorAll('.duel-stake-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.stake) === duelSelectedStake));
      });
      el.appendChild(btn);
    }
  }

  function renderDuelBoostSelector(boosts) {
    const el = $('#duelBoostSelector');
    if (!el) return;
    el.innerHTML = '';
    for (const [id, cfg] of Object.entries(boosts)) {
      const btn = document.createElement('button');
      btn.className = 'duel-boost-btn' + (duelSelectedBoosts.includes(id) ? ' active' : '');
      btn.textContent = `${cfg.label} $${(cfg.price / 100).toFixed(2)}`;
      btn.title = cfg.desc;
      btn.addEventListener('click', () => {
        if (duelSelectedBoosts.includes(id)) {
          duelSelectedBoosts = duelSelectedBoosts.filter(b => b !== id);
          btn.classList.remove('active');
        } else {
          duelSelectedBoosts.push(id);
          btn.classList.add('active');
        }
      });
      el.appendChild(btn);
    }
  }

  function renderDuelList(duels) {
    const el = $('#duelList');
    if (!el) return;
    if (!duels || duels.length === 0) {
      el.innerHTML = '<div class="duel-empty">No open duels — be the first to create one!</div>';
      return;
    }
    el.innerHTML = duels.filter(d => d.status === 'waiting').map(d => {
      const age = Math.floor((Date.now() - d.createdAt) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
      const boostStr = (d.creatorBoosts || []).map(b => {
        if (b === 'shield') return '🛡️';
        if (b === 'score_boost') return '⚡';
        if (b === 'lucky_dig') return '🍀';
        return '';
      }).join(' ');
      return `<div class="duel-list-item" data-duel-id="${d.id}">
        <div>
          <span class="duel-li-creator">${escapeHtml(d.creatorName)}</span>
          ${boostStr ? `<span class="duel-li-boosts">${boostStr}</span>` : ''}
          <span class="duel-li-time">${ageStr}</span>
        </div>
        <div style="display:flex;align-items:center;gap:.6rem">
          <span class="duel-li-stake">${d.stakeLabel}</span>
          <button class="btn-gold duel-join-btn" onclick="window._joinDuel('${d.id}',${d.stake})">⚔️ JOIN</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderDuelHistory(results) {
    const el = $('#duelHistory');
    if (!el) return;
    if (!results || results.length === 0) {
      el.innerHTML = '<div class="duel-empty">No results yet</div>';
      return;
    }
    el.innerHTML = results.slice().reverse().map(r => {
      return `<div class="duel-history-item">
        <span class="duel-hi-winner">🏆 ${escapeHtml(r.winnerName)}</span>
        <span class="duel-hi-score">${r.winnerScore} - ${r.loserScore}</span>
        <span class="duel-hi-loser">${escapeHtml(r.loserName)}</span>
        <span class="duel-hi-prize">+$${(r.prize / 100).toFixed(2)}</span>
      </div>`;
    }).join('');
  }

  function renderDuelRecord() {
    if (!player || !player.duelRecord) return;
    const r = player.duelRecord;
    const wins = $('#drWins'); if (wins) wins.textContent = r.wins || 0;
    const losses = $('#drLosses'); if (losses) losses.textContent = r.losses || 0;
    const streak = $('#drStreak'); if (streak) streak.textContent = r.streak || 0;
    const best = $('#drBest'); if (best) best.textContent = r.bestStreak || 0;
    const earned = $('#drEarned'); if (earned) earned.textContent = ((r.totalWon || 0) / 100).toFixed(2);
  }

  function renderDuels(data) {
    if (data) duelData = data;
    const d = duelData;
    if (!d) return;
    // Stats bar
    const td = $('#duelTotalDuels'); if (td) td.textContent = (d.stats && d.stats.totalDuels) || 0;
    const tw = $('#duelTotalWagered'); if (tw) tw.textContent = ((d.stats && d.stats.totalWagered || 0) / 100).toFixed(0);
    const ac = $('#duelActiveCt'); if (ac) ac.textContent = (d.active || []).length;
    // Selectors
    if (d.stakes) renderDuelStakeSelector(d.stakes);
    if (d.boosts) renderDuelBoostSelector(d.boosts);
    // List
    renderDuelList(d.active || []);
    // History
    renderDuelHistory(d.recentResults || []);
    // Record
    renderDuelRecord();
    // Check if we're in an active duel
    if (activeDuelId && d.active) {
      const myDuel = d.active.find(du => du.id === activeDuelId);
      if (myDuel && myDuel.status !== 'waiting') {
        enterDuelLiveView(myDuel);
      }
    }
  }

  async function fetchDuels() {
    const res = await api('duels');
    if (res && !res.error) renderDuels(res);
  }

  async function handleCreateDuel() {
    if (!player) return;
    await stripePurchase({ purchaseType: 'duel_create', pendingData: { stake: duelSelectedStake, boosts: duelSelectedBoosts } }, async () => {
      const res = await api('duel-create', { playerId: player.id, stake: duelSelectedStake, boosts: duelSelectedBoosts });
      if (res.error) { showError(res.error); return; }
      if (res.player) { player = res.player; renderPlayer(); }
      if (res.duelId) {
        activeDuelId = res.duelId;
        showBonus('⚔️ Duel created! Waiting for opponent...');
        fetchDuels();
      }
    });
  }

  window._joinDuel = async function(duelId, stake) {
    if (!player) return;
    await stripePurchase({ purchaseType: 'duel_join', pendingData: { duelId, stake, boosts: duelSelectedBoosts } }, async () => {
      const res = await api('duel-join', { playerId: player.id, duelId, boosts: duelSelectedBoosts });
      if (res.error) { showError(res.error); return; }
      if (res.player) { player = res.player; renderPlayer(); }
      if (res.duel) {
        activeDuelId = res.duel.id;
        showBonus('⚔️ Duel joined! Get ready...');
        enterDuelLiveView(res.duel);
      }
    });
  };

  function enterDuelLiveView(duel) {
    const liveView = $('#duelLiveView');
    if (!liveView) return;
    liveView.classList.remove('hidden');
    activeDuelId = duel.id;
    // Hide create card while in duel
    const createCard = document.querySelector('.duel-create-card');
    if (createCard) createCard.style.display = 'none';
    // Set player names
    const p1Name = $('#duelP1Name');
    const p2Name = $('#duelP2Name');
    if (p1Name) p1Name.textContent = duel.creatorName || 'Player 1';
    if (p2Name) p2Name.textContent = duel.opponentName || 'Waiting...';
    // Stake
    const stakeEl = $('#duelLiveStake');
    if (stakeEl) stakeEl.textContent = `${duel.stakeLabel} vs ${duel.stakeLabel}`;
    // Boosts
    const p1Boosts = $('#duelP1Boosts');
    const p2Boosts = $('#duelP2Boosts');
    if (p1Boosts) p1Boosts.textContent = (duel.creatorBoosts || []).map(b => b === 'shield' ? '🛡️' : b === 'score_boost' ? '⚡' : '🍀').join(' ');
    if (p2Boosts) p2Boosts.textContent = (duel.opponentBoosts || []).map(b => b === 'shield' ? '🛡️' : b === 'score_boost' ? '⚡' : '🍀').join(' ');
    // Scores
    const s1 = $('#duelP1Score'); if (s1) s1.textContent = duel.creatorScore || '0';
    const s2 = $('#duelP2Score'); if (s2) s2.textContent = duel.opponentScore || '0';
    // Spectators
    const specEl = $('#duelLiveSpectators');
    if (specEl) specEl.textContent = duel.spectators || 0;
    // Ready status
    const p1Ready = $('#duelP1Ready');
    const p2Ready = $('#duelP2Ready');
    if (p1Ready) p1Ready.classList.toggle('hidden', !duel.creatorReady);
    if (p2Ready) p2Ready.classList.toggle('hidden', !duel.opponentReady);
    // Show ready button if this is my duel and status is active
    const readyBtn = $('#btnDuelReady');
    const isMyDuel = player && (duel.creatorId === player.id || duel.opponentId === player.id);
    const amReady = player && ((duel.creatorId === player.id && duel.creatorReady) || (duel.opponentId === player.id && duel.opponentReady));
    if (readyBtn) readyBtn.classList.toggle('hidden', !isMyDuel || duel.status !== 'active' || amReady);
    // Show tip buttons if spectating
    const tipP1 = $('#btnDuelTipP1');
    const tipP2 = $('#btnDuelTipP2');
    if (tipP1) {
      tipP1.classList.toggle('hidden', isMyDuel);
      tipP1.textContent = `💰 Tip ${duel.creatorName} ($0.50)`;
    }
    if (tipP2) {
      tipP2.classList.toggle('hidden', isMyDuel || !duel.opponentName);
      tipP2.textContent = `💰 Tip ${duel.opponentName || 'Player 2'} ($0.50)`;
    }
    // If spectating, send WS
    if (!isMyDuel && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'duel_spectate', duelId: duel.id }));
    }
  }

  function leaveDuelLiveView() {
    const liveView = $('#duelLiveView');
    if (liveView) liveView.classList.add('hidden');
    const createCard = document.querySelector('.duel-create-card');
    if (createCard) createCard.style.display = '';
    if (activeDuelId && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'duel_leave_spectate', duelId: activeDuelId }));
    }
    // Stop duel game if running
    if (duelGameInstance) {
      duelGameInstance.stop();
      duelGameInstance = null;
    }
    activeDuelId = null;
    fetchDuels();
  }

  async function handleDuelReady() {
    if (!player || !activeDuelId) return;
    const res = await api('duel-ready', { playerId: player.id, duelId: activeDuelId });
    if (res.error) { showError(res.error); return; }
    const readyBtn = $('#btnDuelReady');
    if (readyBtn) readyBtn.classList.add('hidden');
    showBonus('✅ You are READY!');
  }

  function startDuelGame(duel) {
    const isCreator = player && duel.creatorId === player.id;
    const canvasId = isCreator ? 'duelCanvas1' : 'duelCanvas2';
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    duelGameInstance = new GoldPotGame(canvas, {
      onScore: (score) => {
        const scoreEl = isCreator ? $('#duelP1Score') : $('#duelP2Score');
        if (scoreEl) scoreEl.textContent = score;
      },
      onEnd: async (finalScore) => {
        // Submit score to server
        const res = await api('duel-score', { playerId: player.id, duelId: duel.id, score: finalScore });
        if (res.error) showError(res.error);
      },
      onTick: (score) => {
        // Real-time score broadcast
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'duel_score_update', duelId: duel.id, playerId: player.id, score }));
        }
      },
    });
    duelGameInstance.start();
  }

  async function handleDuelTip(target) {
    if (!player || !activeDuelId) return;
    const duel = (duelData.active || []).find(d => d.id === activeDuelId);
    if (!duel) return;
    const targetPlayerId = target === 'p1' ? duel.creatorId : duel.opponentId;
    await stripePurchase({ purchaseType: 'duel_tip', pendingData: { duelId: activeDuelId, targetPlayerId } }, async () => {
      const res = await api('duel-tip', { playerId: player.id, duelId: activeDuelId, targetPlayerId });
      if (res.error) { showError(res.error); return; }
      if (res.player) { player = res.player; renderPlayer(); }
      showBonus('💰 Tip sent!');
    });
  }

  async function handleDuelRematch() {
    $('#duelResultModal').classList.add('hidden');
    leaveDuelLiveView();
    // Pre-select same stake and create new duel
    handleCreateDuel();
  }

  function showDuelResult(duel) {
    const modal = $('#duelResultModal');
    if (!modal) return;
    const isWinner = player && duel.winnerId === player.id;
    const isTie = duel.winnerName === 'TIE';
    const icon = $('#duelResultIcon');
    const title = $('#duelResultTitle');
    if (icon) icon.textContent = isTie ? '🤝' : isWinner ? '🏆' : '💀';
    if (title) {
      title.textContent = isTie ? 'TIE!' : isWinner ? 'VICTORY!' : 'DEFEAT';
      title.className = 'duel-result-title' + (isTie ? ' tie' : isWinner ? '' : ' defeat');
    }
    const n1 = $('#drpName1'); if (n1) n1.textContent = duel.creatorName;
    const n2 = $('#drpName2'); if (n2) n2.textContent = duel.opponentName;
    const s1 = $('#drpScore1'); if (s1) s1.textContent = duel.creatorScore || 0;
    const s2 = $('#drpScore2'); if (s2) s2.textContent = duel.opponentScore || 0;
    const prizeEl = $('#duelResultPrize');
    if (prizeEl) {
      if (isTie) {
        prizeEl.textContent = 'Refunded!';
        prizeEl.className = 'duel-result-prize';
      } else if (isWinner) {
        prizeEl.textContent = `+$${(duel.prize / 100).toFixed(2)}`;
        prizeEl.className = 'duel-result-prize';
      } else {
        prizeEl.textContent = `-${duel.stakeLabel}`;
        prizeEl.className = 'duel-result-prize loss';
      }
    }
    modal.classList.remove('hidden');
    // Stop game
    if (duelGameInstance) { duelGameInstance.stop(); duelGameInstance = null; }
  }

  // Handle duel WebSocket messages
  function handleDuelWS(msg) {
    if (msg.type === 'duel_created' || msg.type === 'duel_matched') {
      fetchDuels();
      if (msg.duel && msg.duel.status === 'active') {
        const isMyDuel = player && (msg.duel.creatorId === player.id || msg.duel.opponentId === player.id);
        if (isMyDuel) enterDuelLiveView(msg.duel);
      }
    } else if (msg.type === 'duel_ready') {
      if (msg.duelId === activeDuelId) {
        const p1Ready = $('#duelP1Ready');
        const p2Ready = $('#duelP2Ready');
        if (p1Ready) p1Ready.classList.toggle('hidden', !msg.creatorReady);
        if (p2Ready) p2Ready.classList.toggle('hidden', !msg.opponentReady);
      }
    } else if (msg.type === 'duel_start') {
      if (msg.duelId === activeDuelId) {
        const cd = $('#duelCountdown');
        const cdNum = $('#duelCountdownNum');
        if (cd) cd.classList.remove('hidden');
        let count = 3;
        if (cdNum) cdNum.textContent = count;
        const cdInterval = setInterval(() => {
          count--;
          if (cdNum) cdNum.textContent = count;
          if (count <= 0) {
            clearInterval(cdInterval);
            if (cd) cd.classList.add('hidden');
            // Start the game for participants
            const duel = (duelData.active || []).find(d => d.id === activeDuelId);
            const isMyDuel = player && duel && (duel.creatorId === player.id || duel.opponentId === player.id);
            if (isMyDuel && duel) startDuelGame(duel);
          }
        }, 1000);
      }
    } else if (msg.type === 'duel_score_update') {
      if (msg.duelId === activeDuelId) {
        // Update displayed scores
        const duel = (duelData.active || []).find(d => d.id === activeDuelId);
        if (duel) {
          if (msg.playerId === duel.creatorId) {
            const s1 = $('#duelP1Score'); if (s1) s1.textContent = msg.score;
          } else {
            const s2 = $('#duelP2Score'); if (s2) s2.textContent = msg.score;
          }
        }
      }
    } else if (msg.type === 'duel_finished') {
      if (msg.duel) {
        const isMyDuel = player && (msg.duel.creatorId === player.id || msg.duel.opponentId === player.id);
        if (isMyDuel || msg.duel.id === activeDuelId) {
          showDuelResult(msg.duel);
          // Refresh player data
          fetchState();
        }
        fetchDuels();
      }
    } else if (msg.type === 'duel_tip') {
      if (msg.duelId === activeDuelId) {
        showBonus(`💰 ${msg.tipper} tipped ${msg.target}!`);
      }
    } else if (msg.type === 'duel_challenge') {
      // Someone challenged us
      if (player && msg.targetName === player.name) {
        showBonus(`⚔️ ${msg.from} challenged you to a ${msg.stakeLabel} duel!`);
      }
    } else if (msg.type === 'duel_spectate_joined') {
      if (msg.duel) enterDuelLiveView(msg.duel);
    }
  }

  // ─── GOLDPOT LIVE — Streaming ──────────────────────────────────────────
  let activeStreamId = null;
  let myStreamId = null;
  let streamFrameInterval = null;
  let streamData = null; // cache of stream config (superChats, gifts, etc.)

  function initStreamUI() {
    const btnGoLive = $('#btnGoLive');
    const btnEnd = $('#btnEndStream');
    const btnLeave = $('#btnLeaveStream');
    const btnSub = $('#btnStreamSub');

    if (btnGoLive) btnGoLive.onclick = handleGoLive;
    if (btnEnd) btnEnd.onclick = handleEndStream;
    if (btnLeave) btnLeave.onclick = leaveStreamView;
    if (btnSub) btnSub.onclick = handleStreamSubscribe;
  }

  async function fetchStreams() {
    const res = await api('streams');
    if (res && !res.error) {
      streamData = res;
      renderStreams(res);
    }
  }

  function renderStreams(data) {
    if (!data) return;
    streamData = data;
    const liveCt = $('#streamLiveCt');
    const totalSC = $('#streamTotalSC');
    const totalGifts = $('#streamTotalGifts');
    const totalRev = $('#streamTotalRevenue');
    const stats = data.stats || {};
    if (liveCt) liveCt.textContent = (data.live || data.streams || []).length;
    if (totalSC) totalSC.textContent = formatNum(stats.totalSuperChats || 0);
    if (totalGifts) totalGifts.textContent = formatNum(stats.totalGifts || 0);
    if (totalRev) totalRev.textContent = ((stats.totalRevenue || 0) / 100).toFixed(0);

    const list = $('#streamList');
    if (!list) return;
    const streams = data.live || data.streams || [];
    if (streams.length === 0) {
      list.innerHTML = '<div class="stream-empty">No streams live yet — be the first to go live!</div>';
      return;
    }
    list.innerHTML = streams.map(s => {
      const upMins = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 60000) : 0;
      const upStr = upMins >= 60 ? `${Math.floor(upMins/60)}h ${upMins%60}m` : `${upMins}m`;
      return `
      <div class="stream-item" data-stream-id="${s.id}">
        <div class="stream-item-info">
          <div class="stream-item-name">${esc(s.streamerName)} <span class="stream-item-badge">LIVE</span> <span class="stream-item-uptime">⏱ ${upStr}</span></div>
          <div class="stream-item-title">${esc(s.title)}</div>
          <div class="stream-item-meta">
            <span>👁️ ${s.viewers}</span>
            <span>💬 ${s.superChats}</span>
            <span>🎁 ${s.gifts}</span>
          </div>
        </div>
        <button class="stream-item-watch" data-stream-id="${s.id}">▶ WATCH</button>
      </div>
    `}).join('');
    list.querySelectorAll('.stream-item-watch').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        watchStream(btn.dataset.streamId);
      };
    });
    list.querySelectorAll('.stream-item').forEach(item => {
      item.onclick = () => watchStream(item.dataset.streamId);
    });
  }

  async function handleGoLive() {
    if (!player) return;
    const title = ($('#streamTitleInput') || {}).value || `${player.name}'s Stream`;
    const res = await api('stream-start', { playerId: player.id, title });
    if (res.error) { showBonus(res.error); return; }
    myStreamId = res.streamId;
    activeStreamId = res.streamId;
    showBonus('🔴 You are LIVE! Start playing to stream.');
    $('#btnGoLive').classList.add('hidden');
    $('#btnEndStream').classList.remove('hidden');
    // Enter viewer as streamer
    enterStreamView(res.stream, true);
    fetchStreams();
  }

  async function handleEndStream() {
    if (!myStreamId) return;
    const res = await api('stream-end', { playerId: player.id, streamId: myStreamId });
    if (res.error) { showBonus(res.error); return; }
    const earnings = ((res.earnings || 0) / 100).toFixed(2);
    showBonus(`⏹️ Stream ended! You earned $${earnings}`);
    stopStreamBroadcast();
    myStreamId = null;
    activeStreamId = null;
    $('#btnGoLive').classList.remove('hidden');
    $('#btnEndStream').classList.add('hidden');
    $('#streamViewer').classList.add('hidden');
    $('#streamStreamerBar').classList.add('hidden');
    if (res.player) { player = res.player; renderPlayer(); }
    fetchStreams();
  }

  function watchStream(streamId) {
    if (activeStreamId === streamId) return;
    if (activeStreamId) leaveStreamView();
    activeStreamId = streamId;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'stream_watch', streamId }));
    }
  }

  function leaveStreamView() {
    if (activeStreamId && ws && ws.readyState === 1 && activeStreamId !== myStreamId) {
      ws.send(JSON.stringify({ type: 'stream_leave' }));
    }
    if (activeStreamId !== myStreamId) {
      activeStreamId = null;
    }
    $('#streamViewer').classList.add('hidden');
    stopStreamBroadcast();
    stopStreamUptime();
  }

  function enterStreamView(stream, isStreamer) {
    const viewer = $('#streamViewer');
    if (!viewer) return;
    viewer.classList.remove('hidden');
    $('#streamViewerTitle').textContent = `${stream.streamerName} — ${stream.title}`;
    $('#streamViewerCount').textContent = stream.viewers || 0;

    // Clear previous chat/SC feeds
    const chatList = $('#streamChatList');
    if (chatList) chatList.innerHTML = '';
    const scList = $('#streamSCList');
    if (scList) scList.innerHTML = '';

    // Render SC tiers
    renderStreamSCTiers(stream.id);
    // Render gift grid
    renderStreamGiftGrid(stream.id);
    // Render hype train
    updateStreamHype(stream);
    // Render top gifters
    renderStreamTopGifters(stream.topGifters || []);

    // Start uptime counter
    startStreamUptime(stream.startedAt || Date.now());

    // Wire chat input
    const chatInput = $('#streamChatInput');
    const chatSendBtn = $('#btnStreamChatSend');
    if (chatInput) {
      chatInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendStreamChat(); } };
    }
    if (chatSendBtn) chatSendBtn.onclick = sendStreamChat;

    if (isStreamer) {
      $('#streamStreamerBar').classList.remove('hidden');
      $('#btnLeaveStream').classList.add('hidden');
      startStreamBroadcast();
    } else {
      $('#streamStreamerBar').classList.add('hidden');
      $('#btnLeaveStream').classList.remove('hidden');
    }
  }

  function renderStreamViewer(stream) {
    if (!stream || stream.id !== activeStreamId) return;
    const vc = $('#streamViewerCount');
    if (vc) vc.textContent = stream.viewers || 0;
    updateStreamHype(stream);
    renderStreamTopGifters(stream.topGifters || []);
    if (myStreamId === stream.id) {
      const el = $('#streamMyEarnings');
      if (el) el.textContent = ((stream.totalEarned * 0.7) / 100).toFixed(2);
      const vw = $('#streamMyViewers');
      if (vw) vw.textContent = stream.viewers || 0;
      const sb = $('#streamMySubs');
      if (sb) sb.textContent = stream.subscribers || 0;
    }
  }

  function renderStreamSCTiers(streamId) {
    const container = $('#streamSCTiers');
    if (!container || !streamData) return;
    const chats = streamData.superChats || {};
    container.innerHTML = Object.entries(chats).map(([tier, sc]) => `
      <button class="stream-sc-tier-btn" style="border-color:${sc.color};color:${sc.color}" data-tier="${tier}" data-stream="${streamId}">
        ${sc.label} $${(sc.price / 100).toFixed(2)}
      </button>
    `).join('');
    container.querySelectorAll('.stream-sc-tier-btn').forEach(btn => {
      btn.onclick = () => handleSuperChat(btn.dataset.stream, btn.dataset.tier);
    });
  }

  function renderStreamGiftGrid(streamId) {
    const container = $('#streamGiftGrid');
    if (!container || !streamData) return;
    const gifts = streamData.gifts || {};
    const emojiMap = { coin: '🪙', pickaxe: '⛏️', treasure: '💎', dynamite: '🧨', goldbar: '🏆', jackpot: '🎰' };
    container.innerHTML = Object.entries(gifts).map(([id, gift]) => `
      <div class="stream-gift-btn" data-gift="${id}" data-stream="${streamId}">
        <span class="stream-gift-emoji">${emojiMap[id] || '🎁'}</span>
        <span class="stream-gift-label">${gift.label.split(' ')[0]}</span>
        <span class="stream-gift-price">$${(gift.price / 100).toFixed(2)}</span>
      </div>
    `).join('');
    container.querySelectorAll('.stream-gift-btn').forEach(btn => {
      btn.onclick = () => handleStreamGift(btn.dataset.stream, btn.dataset.gift);
    });
  }

  function renderStreamTopGifters(gifters) {
    const container = $('#streamTopGifters');
    if (!container) return;
    if (!gifters || gifters.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:.75rem;font-style:italic">No gifters yet</div>';
      return;
    }
    const ranks = ['👑', '🥈', '🥉'];
    container.innerHTML = gifters.slice(0, 5).map((g, i) => `
      <div class="stream-top-item">
        <span class="stream-top-rank">${ranks[i] || (i + 1)}</span>
        <span class="stream-top-name">${esc(g.name)}</span>
        <span class="stream-top-amount">$${(g.total / 100).toFixed(2)}</span>
      </div>
    `).join('');
  }

  function updateStreamHype(stream) {
    const levelEl = $('#streamHypeLevel');
    const fillEl = $('#streamHypeFill');
    const rewardEl = $('#streamHypeReward');
    if (!levelEl) return;
    const level = stream.hypeLevel || 0;
    const progress = stream.hypeProgress || 0;
    const goal = stream.hypeGoal || 5;
    levelEl.textContent = level;
    fillEl.style.width = Math.min(100, Math.round((progress / goal) * 100)) + '%';
    const levels = streamData?.hypeLevels || [];
    const current = levels[Math.min(level, levels.length - 1)];
    if (rewardEl && current) rewardEl.textContent = current.reward;
  }

  function addSuperChatToFeed(sc) {
    const list = $('#streamSCList');
    if (!list) return;
    const div = document.createElement('div');
    div.className = 'stream-sc-msg sc-entrance';
    div.style.borderColor = sc.color;
    const ts = sc.timestamp ? formatChatTime(sc.timestamp) : '';
    div.innerHTML = `<span class="sc-tier" style="background:${sc.color}">${esc(sc.tier?.toUpperCase() || '')}</span><span class="sc-sender">${esc(sc.sender)}</span>${esc(sc.message || '')}<span class="sc-time">${ts}</span>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    // Limit
    while (list.children.length > 50) list.removeChild(list.firstChild);
  }

  // Free chat message feed
  function addChatToFeed(chat) {
    const list = $('#streamChatList');
    if (!list) return;
    const div = document.createElement('div');
    div.className = 'stream-chat-msg' + (chat.isSystem ? ' system-msg' : '') + ' sc-entrance';
    const ts = chat.timestamp ? formatChatTime(chat.timestamp) : '';
    div.innerHTML = `<span class="chat-sender">${esc(chat.sender)}</span>${esc(chat.message)}<span class="sc-time">${ts}</span>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    while (list.children.length > 80) list.removeChild(list.firstChild);
  }

  function sendStreamChat() {
    const input = $('#streamChatInput');
    if (!input || !input.value.trim()) return;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'stream_chat', message: input.value.trim() }));
    input.value = '';
  }

  function formatChatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Stream uptime counter
  let streamUptimeInterval = null;
  function startStreamUptime(startedAt) {
    const el = $('#streamUptime');
    if (!el) return;
    if (streamUptimeInterval) clearInterval(streamUptimeInterval);
    function update() {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      el.textContent = h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
    }
    update();
    streamUptimeInterval = setInterval(update, 1000);
  }
  function stopStreamUptime() {
    if (streamUptimeInterval) { clearInterval(streamUptimeInterval); streamUptimeInterval = null; }
  }

  function showStreamGiftAnimation(gift) {
    const overlay = $('#streamGiftOverlay');
    if (!overlay) return;
    const emojiMap = { coin: '🪙', pickaxe: '⛏️', treasure: '💎', dynamite: '🧨', goldbar: '🏆', jackpot: '🎰' };
    overlay.textContent = emojiMap[gift.giftId] || '🎁';
    overlay.classList.remove('active');
    void overlay.offsetWidth; // reflow
    overlay.classList.add('active');
    setTimeout(() => overlay.classList.remove('active'), 1000);
  }

  function handleSuperChat(streamId, tier) {
    const msgEl = $('#streamSCInput');
    const message = (msgEl && msgEl.value) ? msgEl.value.trim() : '';
    stripePurchase(
      { purchaseType: 'super_chat_' + tier, pendingData: { streamId, message } },
      async () => {
        const res = await api('stream-superchat', { playerId: player.id, streamId, tier, message });
        if (res.error) { showBonus(res.error); return; }
        showBonus('💬 Super Chat sent!');
        if (res.stream) renderStreamViewer(res.stream);
        if (msgEl) msgEl.value = '';
      }
    );
  }

  function handleStreamGift(streamId, giftId) {
    stripePurchase(
      { purchaseType: 'stream_gift_' + giftId, pendingData: { streamId } },
      async () => {
        const res = await api('stream-gift', { playerId: player.id, streamId, giftId });
        if (res.error) { showBonus(res.error); return; }
        showBonus('🎁 Gift sent!');
        if (res.stream) renderStreamViewer(res.stream);
      }
    );
  }

  function handleStreamSubscribe() {
    if (!activeStreamId) return;
    const subBtn = $('#btnStreamSub');
    stripePurchase(
      { purchaseType: 'stream_subscribe', pendingData: { streamId: activeStreamId } },
      async () => {
        const res = await api('stream-subscribe', { playerId: player.id, streamId: activeStreamId });
        if (res.error) { showBonus(res.error); return; }
        showBonus('⭐ Subscribed!');
        if (subBtn) { subBtn.textContent = '⭐ SUBSCRIBED'; subBtn.disabled = true; subBtn.classList.add('subscribed'); }
        if (res.stream) renderStreamViewer(res.stream);
      }
    );
  }

  // Stream broadcasting — streamer sends canvas frames via WS
  function startStreamBroadcast() {
    if (streamFrameInterval) clearInterval(streamFrameInterval);
    // Broadcast every 200ms (5fps) — low bandwidth canvas snapshots
    streamFrameInterval = setInterval(() => {
      if (!myStreamId || !ws || ws.readyState !== 1) return;
      const canvas = document.querySelector('#gameCanvas');
      if (!canvas) return;
      try {
        const frame = canvas.toDataURL('image/jpeg', 0.3);
        const scoreEl = $('#mineGold');
        ws.send(JSON.stringify({ type: 'stream_frame', streamId: myStreamId, frame, score: scoreEl ? scoreEl.textContent : '0' }));
      } catch {}
    }, 500);
    // Tell server we're playing
    api('stream-playing', { playerId: player.id, streamId: myStreamId, isPlaying: true });
  }

  function stopStreamBroadcast() {
    if (streamFrameInterval) {
      clearInterval(streamFrameInterval);
      streamFrameInterval = null;
    }
  }

  // WS handler for stream messages
  function handleStreamWS(msg) {
    if (msg.type === 'stream_started') {
      fetchStreams();
    } else if (msg.type === 'stream_ended') {
      if (msg.streamId === activeStreamId && msg.streamId !== myStreamId) {
        showBonus(`📺 ${msg.streamerName}'s stream has ended`);
        leaveStreamView();
      }
      fetchStreams();
    } else if (msg.type === 'stream_joined') {
      if (msg.stream) enterStreamView(msg.stream, false);
      if (msg.superChats) {
        msg.superChats.forEach(sc => addSuperChatToFeed(sc));
      }
      if (msg.chatHistory) {
        msg.chatHistory.forEach(c => addChatToFeed(c));
      }
    } else if (msg.type === 'stream_frame') {
      // Draw received frame on viewer canvas
      if (activeStreamId && activeStreamId !== myStreamId) {
        const canvas = $('#streamCanvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const img = new Image();
          img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          img.src = msg.frame;
        }
        const scoreOv = $('#streamScoreOverlay');
        if (scoreOv) scoreOv.textContent = 'Score: ' + (msg.score || '0');
        // Update viewer count + hype from piggybacked data
        if (msg.viewers !== undefined) {
          const vc = $('#streamViewerCount');
          if (vc) vc.textContent = msg.viewers;
        }
        if (msg.hypeLevel !== undefined) {
          const levelEl = $('#streamHypeLevel');
          if (levelEl) levelEl.textContent = msg.hypeLevel;
          if (msg.hypeProgress !== undefined && msg.hypeGoal) {
            const fillEl = $('#streamHypeFill');
            if (fillEl) fillEl.style.width = Math.min(100, Math.round((msg.hypeProgress / msg.hypeGoal) * 100)) + '%';
          }
        }
      }
    } else if (msg.type === 'stream_superchat') {
      if (msg.streamId === activeStreamId) {
        addSuperChatToFeed(msg.superChat);
        const levelEl = $('#streamHypeLevel');
        if (levelEl) levelEl.textContent = msg.hypeLevel || 0;
        // Update hype fill bar
        if (msg.hypeProgress !== undefined) {
          const fillEl = $('#streamHypeFill');
          const goal = msg.hypeGoal || 5;
          if (fillEl) fillEl.style.width = Math.min(100, Math.round((msg.hypeProgress / goal) * 100)) + '%';
        }
      }
    } else if (msg.type === 'stream_gift') {
      if (msg.streamId === activeStreamId && msg.gift) {
        showStreamGiftAnimation(msg.gift);
        showBonus(`🎁 ${msg.gift.sender} sent ${msg.gift.label}!`);
        // Update hype
        const levelEl = $('#streamHypeLevel');
        if (levelEl) levelEl.textContent = msg.hypeLevel || 0;
        if (msg.hypeProgress !== undefined) {
          const fillEl = $('#streamHypeFill');
          const goal = msg.hypeGoal || 5;
          if (fillEl) fillEl.style.width = Math.min(100, Math.round((msg.hypeProgress / goal) * 100)) + '%';
        }
      }
    } else if (msg.type === 'stream_subscribe') {
      if (msg.streamId === activeStreamId) {
        showBonus(`⭐ ${msg.subscriber} subscribed!`);
        addChatToFeed({ sender: '⭐', message: `${msg.subscriber} just subscribed!`, timestamp: Date.now(), isSystem: true });
      }
    } else if (msg.type === 'stream_hype_level') {
      if (msg.streamId === activeStreamId) {
        showBonus(`🔥 HYPE TRAIN LEVEL ${msg.level}! ${msg.reward}`);
        const levelEl = $('#streamHypeLevel');
        if (levelEl) levelEl.textContent = msg.level;
        const fillEl = $('#streamHypeFill');
        if (fillEl) fillEl.style.width = '0%'; // Reset for next level
      }
    } else if (msg.type === 'stream_viewer_count') {
      if (msg.streamId === activeStreamId) {
        const vc = $('#streamViewerCount');
        if (vc) vc.textContent = msg.viewers || 0;
        const mv = $('#streamMyViewers');
        if (mv) mv.textContent = msg.viewers || 0;
      }
    } else if (msg.type === 'stream_chat') {
      if (msg.streamId === activeStreamId && msg.chat) {
        addChatToFeed(msg.chat);
      }
    }
  }

  // ─── Q50: Reconnect Banner Helpers ─────────────────────────────────────
  function showReconnectBanner() {
    let b = $('#reconnectBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'reconnectBanner';
      b.className = 'reconnect-banner';
      b.innerHTML = '<span class="spinner"></span> Reconnecting…';
      document.body.appendChild(b);
    }
    b.classList.remove('hidden');
  }
  function hideReconnectBanner() {
    const b = $('#reconnectBanner');
    if (b) b.classList.add('hidden');
  }

  // ─── Q6: Advanced Actions Toggle ──────────────────────────────────────
  function setupAdvancedActions() {
    const btn = $('#btnShowMoreActions');
    const panel = $('#advancedActions');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      const expanded = panel.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', expanded);
      btn.textContent = expanded ? '▲ Fewer options' : '▼ More options';
    });

    // Fix 1: Bundle group toggle
    const bundleBtn = $('#btnShowBundles');
    const bundlePanel = $('#bundleGroup');
    if (bundleBtn && bundlePanel) {
      bundleBtn.addEventListener('click', () => {
        const exp = bundlePanel.classList.toggle('expanded');
        bundleBtn.classList.toggle('expanded', exp);
        bundleBtn.setAttribute('aria-expanded', exp);
      });
    }
  }

  // ─── Fix 2: Offer Rotation — show max 2 offers at a time ─────────────
  function rotateOffers() {
    const offerIds = [
      'lightningSection', 'mysterySection', 'surgeSection',
      'allinSection', 'limitedSection', 'streakSaver'
    ];
    const dismissed = JSON.parse(sessionStorage.getItem('goldpot_dismissed_offers') || '[]');
    const visible = [];
    for (const id of offerIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      // Skip locked, dismissed, or hidden sections
      if (el.classList.contains('section-locked') || el.classList.contains('offer-dismissed') || el.classList.contains('hidden')) {
        el.classList.add('offer-rotated-hidden');
        continue;
      }
      if (dismissed.includes(id)) {
        el.classList.add('offer-rotated-hidden');
        continue;
      }
      if (visible.length < 2) {
        el.classList.remove('offer-rotated-hidden');
        visible.push(id);
      } else {
        el.classList.add('offer-rotated-hidden');
      }
    }
  }

  // ─── Fix 6: Modal Upsell Cooldown — prevent back-to-back popups ──────
  let _lastModalUpsellTime = 0;
  const MODAL_UPSELL_COOLDOWN = 30000; // 30 seconds between upsell modals

  const _origShowDoubleDown = typeof showDoubleDown === 'function' ? showDoubleDown : null;

  function showDoubleDownWithCooldown(qty) {
    const now = Date.now();
    if (now - _lastModalUpsellTime < MODAL_UPSELL_COOLDOWN) return;
    _lastModalUpsellTime = now;
    showDoubleDown(qty);
  }

  function checkNearMissWithCooldown(drawResult) {
    const now = Date.now();
    if (now - _lastModalUpsellTime < MODAL_UPSELL_COOLDOWN) return;
    _lastModalUpsellTime = now;
    checkNearMiss(drawResult);
  }

  // ─── Q41: Chat Unread Badge on Bottom Nav ─────────────────────────────
  function updateChatNavBadge() {
    let badge = document.querySelector('.bnav-chat-badge');
    const socialBtn = document.querySelector('.bottom-nav-btn[data-tab="social"]');
    if (!socialBtn) return;
    if (chatUnread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'bnav-chat-badge';
        socialBtn.appendChild(badge);
      }
      badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
    } else if (badge) {
      badge.remove();
    }
  }

  // ─── Q47: Skeleton Loading on Tab Switch ──────────────────────────────
  function showTabSkeleton(tabName) {
    const panel = document.querySelector(`.tab-panel[data-panel="${CSS.escape(tabName)}"]`);
    if (!panel) return;
    // Don't add skeleton if panel already has content visible
    if (panel.querySelector('.skeleton')) return;
    const skel = document.createElement('div');
    skel.className = 'skeleton';
    skel.style.height = '120px';
    skel.style.borderRadius = '12px';
    skel.style.marginBottom = '12px';
    panel.prepend(skel);
    setTimeout(() => skel.remove(), 600);
  }

  // ─── Q45: Onboarding Progress Dots ────────────────────────────────────
  function updateOnboardDots(step) {
    const dots = document.querySelectorAll('.onboard-progress-dot');
    dots.forEach((d, i) => {
      d.classList.toggle('active', i < step);
    });
  }

  // ─── Launch ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
