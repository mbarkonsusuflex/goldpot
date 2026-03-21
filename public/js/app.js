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
  let countdownInterval = null;
  let flashCountdownInterval = null;
  let soundEnabled = true;
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

  // ─── Sound Engine (Web Audio API — no files needed) ──────────────────────
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx) audioCtx = new AudioCtx();
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

  // ─── DOM Refs ───────────────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ─── API Helpers ────────────────────────────────────────────────────────
  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch('/api/' + path, opts);
    return res.json();
  }

  // ─── Init ───────────────────────────────────────────────────────────────
  async function init() {
    // Fast splash — get users to action quickly
    setTimeout(() => {
      $('#splash').classList.add('fade-out');
      setTimeout(() => {
        $('#splash').classList.add('hidden');
        const stored = localStorage.getItem('goldpot_player_id');
        if (stored) {
          loadPlayer(stored);
        } else {
          showNameModal();
        }
      }, 300);
    }, 1000);

    setupCanvas();
    setupEvents();
    setupCardFormatting();
  }

  function setupCanvas() {
    game = new GoldPotGame($('#gameCanvas'));

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
      lastGameScore = score;
      isPlaying = false;
      $('#gameOverlay').classList.remove('active');
      $('#mineCashoutWrap').classList.remove('active');
      $('#gameStartOverlay').classList.remove('hidden');
      const banked = parseInt($('#mineBanked').textContent) || 0;
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

  function setupEvents() {
    // ── Onboarding Step 1: Name → Step 2: Payment ──
    $('#btnJoin').addEventListener('click', async () => {
      const name = $('#playerNameInput').value.trim();
      const ref = $('#refCodeInput').value.trim().toUpperCase();
      if (!name) { $('#playerNameInput').focus(); return; }
      // Register immediately
      const data = await api('register', { name, referralCode: ref || undefined });
      player = data.player;
      localStorage.setItem('goldpot_player_id', player.id);
      // Move to Step 2: payment
      $('#onboardStep1').classList.add('hidden');
      $('#onboardStep2').classList.remove('hidden');
      $$('.onboard-step').forEach(s => {
        if (s.dataset.step === '1') { s.classList.remove('active'); s.classList.add('done'); s.querySelector('span').textContent = '✓'; }
        if (s.dataset.step === '2') s.classList.add('active');
      });
    });

    $('#playerNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btnJoin').click();
    });

    // ── Onboarding Step 2: Payment method selection ──
    setupPaymentGrid('onboardPaymentGrid', 'cardForm');

    $('#btnSavePayment').addEventListener('click', async () => {
      if (!selectedPayMethod) { showBonus('Pick a payment method'); return; }
      await savePaymentMethod('cardNumber', 'cardExpiry', 'cardCvc', 'cardZip');
      closeModal('nameModal');
      showApp();
      showBonus('🎉 You\'re all set! Start playing!');
    });

    $('#btnSkipPayment').addEventListener('click', () => {
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
      $('#cardFormModal').classList.add('hidden');
      openModal('paymentModal');
    });

    setupPaymentGrid('paymentGrid', 'cardFormModal');

    $('#btnUpdatePayment').addEventListener('click', async () => {
      if (!selectedPayMethod) { showBonus('Pick a payment method'); return; }
      await savePaymentMethod('cardNumberModal', 'cardExpiryModal', 'cardCvcModal', 'cardZipModal');
      closeModal('paymentModal');
      showBonus('💳 Payment updated!');
    });

    $('#btnClosePayment').addEventListener('click', () => closeModal('paymentModal'));

    // ── Checkout sheet ──
    $('#checkoutClose').addEventListener('click', () => hideCheckout());
    $('#btnCheckoutConfirm').addEventListener('click', () => {
      hideCheckout();
      startGame(pendingPurchaseQty);
    });

    // Pot tabs
    $$('.pot-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentPot = tab.dataset.pot;
        $$('.pot-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderPot();
      });
    });

    // Premium play — show checkout confirmation
    $('#btnPremium').addEventListener('click', () => showCheckout(1));

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
      renderPlayer();
      showBonus(`🎁 +${res.bonusEntries} BONUS (${res.streak} day streak!)`);
      $('#btnDailyBonus').classList.add('claimed');
      $('#btnDailyBonus').textContent = 'CLAIMED ✓';
    });

    // Spin wheel
    $('#btnSpinWheel').addEventListener('click', () => openModal('wheelModal'));

    $('#btnDoSpin').addEventListener('click', async () => {
      if (!player) return;
      const btn = $('#btnDoSpin');
      btn.disabled = true;
      btn.textContent = 'SPINNING...';
      const wheel = $('#spinWheel');
      // Animate spin
      const extraSpins = 5 + Math.random() * 3;
      const targetAngle = extraSpins * 360;
      wheel.style.transition = 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
      wheel.style.transform = `rotate(${targetAngle}deg)`;

      const res = await api('spin-wheel', { playerId: player.id });
      await new Promise(r => setTimeout(r, 4200));

      if (res.error) {
        $('#wheelResult').textContent = res.error;
        $('#wheelResult').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'SPIN!';
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        return;
      }

      player = res.player;
      renderPlayer();
      $('#wheelResult').textContent = `🎉 ${res.result.label}`;
      $('#wheelResult').classList.remove('hidden');
      btn.textContent = 'CLOSE';
      btn.disabled = false;
      btn.onclick = () => {
        closeModal('wheelModal');
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        btn.textContent = 'SPIN!';
        $('#wheelResult').classList.add('hidden');
        btn.onclick = null;
        // Re-bind
        setupSpinButton();
      };
    });

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

    // Winner modal
    $('#btnNewRound').addEventListener('click', () => closeModal('winnerModal'));

    // Mute toggle
    $('#muteBtn').addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      $('#muteBtn').textContent = soundEnabled ? '🔊' : '🔇';
      SFX.click();
    });

    // Flash pot entry
    $('#btnFlashEnter').addEventListener('click', async () => {
      if (!player) return;
      SFX.flash();
      const res = await api('flash-entry', { playerId: player.id, quantity: 1, free: false });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      showBonus('⚡ Entered FLASH POT!');
      fetchState();
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

    // Jackpot announce modal
    $('#btnJpAnnouncePlay').addEventListener('click', () => {
      closeModal('jackpotAnnounceModal');
      const banner = $('#jackpotBanner');
      if (!banner.classList.contains('hidden')) {
        banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        const res = await api('vip-subscribe', { playerId: player.id, tier: btn.dataset.tier });
        if (res.error) { showBonus(res.error); return; }
        player = res.player;
        renderPlayer();
        renderVipStatus();
        showBonus('👑 VIP Pass Activated!');
        SFX.win();
      });
    });

    // Double Down
    $('#btnDoubleDown').addEventListener('click', async () => {
      if (!player) return;
      closeModal('doubleDownModal');
      const res = await api('double-down', { playerId: player.id, potId: currentPot, originalQty: pendingDoubleDownQty });
      if (res.error) { showBonus(res.error); return; }
      player = res.player;
      renderPlayer();
      fetchState();
      showBonus(`⚡ +${res.qty} DOUBLE DOWN ENTRIES!`);
      if (res.winnerDrawn && res.winnerDrawn.winner) {
        setTimeout(() => showWinner(res.winnerDrawn.winner), 1500);
        checkNearMiss(res.winnerDrawn);
      }
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
  }

  function setupSpinButton() {
    $('#btnDoSpin').addEventListener('click', async () => {
      if (!player) return;
      const btn = $('#btnDoSpin');
      btn.disabled = true;
      btn.textContent = 'SPINNING...';
      const wheel = $('#spinWheel');
      const extraSpins = 5 + Math.random() * 3;
      const targetAngle = extraSpins * 360;
      wheel.style.transition = 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
      wheel.style.transform = `rotate(${targetAngle}deg)`;

      const res = await api('spin-wheel', { playerId: player.id });
      await new Promise(r => setTimeout(r, 4200));

      if (res.error) {
        $('#wheelResult').textContent = res.error;
        $('#wheelResult').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'SPIN!';
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        return;
      }

      player = res.player;
      renderPlayer();
      $('#wheelResult').textContent = `🎉 ${res.result.label}`;
      $('#wheelResult').classList.remove('hidden');
      btn.textContent = 'CLOSE';
      btn.disabled = false;
      btn.onclick = () => {
        closeModal('wheelModal');
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        btn.textContent = 'SPIN!';
        $('#wheelResult').classList.add('hidden');
        btn.onclick = null;
        setupSpinButton();
      };
    }, { once: true });
  }

  // ─── Payment Helpers ─────────────────────────────────────────────────────
  const PAY_ICONS = {
    apple_pay: ' Pay', google_pay: 'G Pay', card: '💳',
    cashapp: '$', paypal: 'P', venmo: 'V'
  };

  function setupPaymentGrid(gridId, cardFormId) {
    $$(`#${gridId} .pay-option`).forEach(opt => {
      opt.addEventListener('click', () => {
        selectedPayMethod = opt.dataset.method;
        $$(`#${gridId} .pay-option`).forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const cf = $(`#${cardFormId}`);
        if (selectedPayMethod === 'card') {
          cf.classList.remove('hidden');
        } else {
          cf.classList.add('hidden');
        }
      });
    });
  }

  async function savePaymentMethod(numId, expId, cvcId, zipId) {
    let cardLast4 = null;
    if (selectedPayMethod === 'card') {
      const num = $(`#${numId}`).value.replace(/\s/g, '');
      if (num.length >= 4) cardLast4 = num.slice(-4);
    }
    const res = await api('payment-method', { playerId: player.id, method: selectedPayMethod, cardLast4 });
    if (res.player) player = res.player;
    if (res.paymentMethod) player.paymentMethod = res.paymentMethod;
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
    const bundle = gameState && gameState.bundles ? gameState.bundles[qty] : null;
    const price = bundle ? (bundle.price / 100).toFixed(2) : (qty * 1).toFixed(2);
    const pot = gameState ? gameState.pots[currentPot] : null;
    const potLabel = pot ? pot.label : currentPot.toUpperCase();
    const savings = bundle && bundle.savings ? bundle.savings : '';

    $('#checkoutItem').textContent = `${qty}x Entries — ${potLabel}`;
    $('#checkoutPrice').textContent = `$${price}`;
    $('#checkoutSavings').textContent = savings ? `You save ${savings.replace(' OFF', '')}` : '';
    $('#checkoutSavings').style.display = savings ? 'block' : 'none';

    const pm = player.paymentMethod;
    $('#checkoutPayIcon').textContent = pm.icon || '💳';
    $('#checkoutPayLabel').textContent = `Pay $${price} with ${pm.label}`;

    $('#checkoutSheet').classList.remove('hidden');
  }

  function hideCheckout() {
    $('#checkoutSheet').classList.add('hidden');
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
  async function watchAd() {
    if (!player) return;
    const btn = $('#btnWatchAd');
    btn.classList.add('watching');

    // Show ad overlay
    const overlay = $('#adOverlay');
    const fill = $('#adTimerFill');
    const skipText = $('#adSkipText');
    const closeBtn = $('#adClose');
    overlay.classList.remove('hidden');
    closeBtn.classList.remove('visible');
    fill.style.width = '0%';

    // 5-second countdown
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
          // Claim the entry
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

    $('#cdHours').textContent = String(hours).padStart(2, '0');
    $('#cdMins').textContent = String(mins).padStart(2, '0');
    $('#cdSecs').textContent = String(secs).padStart(2, '0');

    const wrap = $('#countdownWrap');
    if (diff < 600000) { // Under 10 minutes = urgent
      wrap.classList.add('urgent');
      if (secs % 2 === 0) SFX.urgentTick();
    } else {
      wrap.classList.remove('urgent');
    }
  }

  // ─── Near-Miss ──────────────────────────────────────────────────────────
  function checkNearMiss(drawResult) {
    if (!drawResult || !drawResult.nearMisses || !player) return;
    const myMiss = drawResult.nearMisses.find(m => m.playerId === player.id);
    if (myMiss) {
      setTimeout(() => {
        $('#nearMissText').textContent = `You had ${myMiss.entries} entries — just ~${myMiss.awayBy} more could have won it! The ${drawResult.winner.name} took home $${drawResult.winner.prize}.`;
        openModal('nearMissModal');
      }, 4000); // Show after winner celebration
    }
  }

  // ─── Game Flow ──────────────────────────────────────────────────────────
  function startGame(quantity) {
    if (!player || isPlaying) return;
    isPlaying = true;
    lastGameScore = 0;
    $('#gameOverlay').classList.add('active');
    $('#gameStartOverlay').classList.add('hidden');
    $('#mineGold').textContent = '0';
    $('#mineBanked').textContent = '0';
    game.start();

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
        if (res.bonusEntries > 0) showBonus(`🎯 +${res.bonusEntries} BONUS ENTRIES!`);
        if (res.multiplier > 1) setTimeout(() => showBonus(`⚡ ${res.multiplier}x MULTIPLIER APPLIED!`), 1500);
        if (res.winnerDrawn && res.winnerDrawn.winner) {
          setTimeout(() => showWinner(res.winnerDrawn.winner), 2000);
          checkNearMiss(res.winnerDrawn);
        }
        // Show Play Again button
        $('#btnPlayAgain').classList.remove('hidden');
        // Trigger Double Down upsell (after 2 seconds)
        pendingDoubleDownQty = quantity;
        setTimeout(() => showDoubleDown(quantity), 2500);
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
      if (data.error) { localStorage.removeItem('goldpot_player_id'); showNameModal(); return; }
      player = data;
      showApp();
    } catch {
      showNameModal();
    }
  }

  // ─── Show App ───────────────────────────────────────────────────────────
  function showApp() {
    $('#app').classList.remove('hidden');
    renderPlayer();
    renderPayButton();
    fetchState();
    pollTimer = setInterval(fetchState, 5000);
    startSessionTimer();
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
    $('#onlineCount').textContent = formatNum(gameState.onlineCount);
  }

  // ─── Double Down Upsell ──────────────────────────────────────────────
  function showDoubleDown(qty) {
    if (!player || !gameState) return;
    const bundle = gameState.bundles[qty];
    const originalPrice = bundle ? bundle.price : qty * 100;
    const halfPrice = Math.ceil(originalPrice * 0.5);
    $('#ddQty').textContent = qty;
    $('#ddPrice').textContent = '$' + (halfPrice / 100).toFixed(2);
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
      bar.className = 'pot-urgency urgency-critical';
      text.textContent = '🚨 LAST CHANCE — POT DRAWING SOON!';
    } else if (pot.pctFull >= 75) {
      bar.classList.remove('hidden');
      bar.className = 'pot-urgency urgency-high';
      text.textContent = `🔥 POT ${pot.pctFull}% FULL — GET IN NOW!`;
    } else {
      bar.classList.add('hidden');
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

    // Update action button
    const btn = $('#btnPremium');
    btn.querySelector('.btn-label').textContent = `PLAY & ENTER ${pot.label}`;

    // Update your stats
    if (player) {
      const entries = player.entries[currentPot] || 0;
      $('#yourEntries').textContent = entries;
      const odds = player.yourOdds ? player.yourOdds[currentPot] : '0.00';
      $('#yourOdds').textContent = parseFloat(odds).toFixed(1) + '%';
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
    const res = await api('jackpot-entry', { playerId: player.id, quantity: qty });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    fetchState();
    showBonus(`💎 ${qty}x JACKPOT ENTRY!`);
    if (res.winnerDrawn) {
      setTimeout(() => showJackpotWinner(res.winnerDrawn), 1500);
    }
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
    const res = await api('mystery-box', { playerId: player.id, tier });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    fetchState();
    // Show reveal modal
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
  function renderLightningDeal() {
    if (!player || !player.lightningDeal) return;
    const deal = player.lightningDeal;
    const section = $('#lightningSection');
    const diff = Math.max(0, deal.deadline - Date.now());

    if (diff <= 0) {
      // Deal expired, fetch new one
      api('lightning-deal', { playerId: player.id }).then(res => {
        if (res.deal) { player.lightningDeal = res.deal; renderLightningDeal(); }
      });
      return;
    }

    section.classList.remove('hidden');
    $('#lightningDiscount').textContent = `${deal.discount}% OFF`;
    $('#lightningDetail').textContent = deal.label;
    $('#lightningOriginal').textContent = `$${(deal.normalPrice / 100).toFixed(2)}`;
    $('#lightningSale').textContent = `$${(deal.salePrice / 100).toFixed(2)}`;

    // Timer
    if (lightningInterval) clearInterval(lightningInterval);
    lightningInterval = setInterval(() => {
      const d = Math.max(0, deal.deadline - Date.now());
      const m = Math.floor(d / 60000);
      const s = Math.floor((d % 60000) / 1000);
      $('#lightningTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
      const pct = (d / 90000) * 100;
      $('#lightningTimerFill').style.width = pct + '%';
      if (d <= 0) {
        clearInterval(lightningInterval);
        lightningInterval = null;
        // Auto-refresh deal
        api('lightning-deal', { playerId: player.id }).then(res => {
          if (res.deal) { player.lightningDeal = res.deal; renderLightningDeal(); }
        });
      }
    }, 1000);
  }

  async function buyLightningDeal() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.flash();
    const res = await api('lightning-buy', { playerId: player.id, potId: currentPot });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    fetchState();
    showBonus(`⚡ ${res.qty}x ENTRIES at ${res.discount}% OFF!`);
    SFX.win();
    if (res.winnerDrawn && res.winnerDrawn.winner) {
      setTimeout(() => showWinner(res.winnerDrawn.winner), 2000);
      checkNearMiss(res.winnerDrawn);
    }
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
    const res = await api('power-surge', { playerId: player.id });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    renderPowerSurge();
    showBonus('⚡ POWER SURGE ACTIVATED! 2x entries for 1 hour!');
    SFX.jackpot();
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
    const res = await api('streak-saver', { playerId: player.id });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    renderStreakSaver();
    showBonus('🛡️ Streak PROTECTED! You won\'t lose it.');
    SFX.win();
  }

  // ─── 5. All-In Pack ───────────────────────────────────────────────────
  async function buyAllIn() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
    const res = await api('all-in-pack', { playerId: player.id });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    fetchState();
    showBonus('🎯 ALL-IN! 5x entries in EVERY pot!');
    SFX.win();
    // Check draws
    if (res.draws) {
      for (const [potId, draw] of Object.entries(res.draws)) {
        if (draw && draw.winner) {
          setTimeout(() => showWinner(draw.winner), 2000);
          checkNearMiss(draw);
        }
      }
    }
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
    // Fake viewers
    const viewers = 8 + Math.floor(Math.random() * 15);
    $('#limitedBuyerText').textContent = `${viewers} people viewing this drop`;
  }

  async function buyLimited() {
    if (!player) return;
    if (!player.paymentMethod) { $('#paymentBtn').click(); showBonus('Add payment first'); return; }
    SFX.click();
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
    const res = await api('mega-multiplier', { playerId: player.id });
    if (res.error) { showBonus(res.error); return; }
    player = res.player;
    renderPlayer();
    renderPowerSurge();
    showBonus('🌟 5× MEGA MULTIPLIER ACTIVATED! 30 minutes!');
    SFX.jackpotWin();
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

    // Referral code
    if (player.referralCode) {
      $('#referralCode').value = player.referralCode;
    }

    // Achievements
    renderAchievements();
    renderLevelProgress();
    renderMissions();
    renderMilestones();
  }

  // ─── Achievements ──────────────────────────────────────────────────────
  function renderAchievements() {
    const grid = $('#achievementsGrid');
    grid.innerHTML = '';
    for (const [key, ach] of Object.entries(ACHIEVEMENTS)) {
      const unlocked = player && player.achievements && player.achievements.includes(key);
      const el = document.createElement('div');
      el.className = 'achievement' + (unlocked ? ' unlocked' : '');
      el.innerHTML = `<div class="ach-icon">${ach.icon}</div><div class="ach-label">${ach.label}</div>`;
      el.title = ach.desc;
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

  // ─── Milestones ─────────────────────────────────────────────────────────
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
      const mult = sessionGamesPlayed >= 10 ? 5 : sessionGamesPlayed >= 7 ? 4 : sessionGamesPlayed >= 5 ? 3 : 2;
      bar.classList.remove('hidden');
      $('#hotStreakText').textContent = `HOT STREAK x${mult} — ${sessionGamesPlayed} games this session!`;
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
      } else if (totalMins >= min) {
        dot.classList.add('ready');
        dot.classList.remove('earned');
        // Auto-claim
        if (player) {
          sessionRewardTimers[min] = true;
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
        }
      }
    }
  }

  // ─── Live Ticker ────────────────────────────────────────────────────────
  function renderLiveTicker() {
    if (!gameState || !gameState.liveFeed || gameState.liveFeed.length === 0) return;
    const track = $('#tickerTrack');
    let html = '';
    for (const e of gameState.liveFeed) {
      if (e.type === 'play') {
        html += `<span class="tick-item">🪙 <b>${esc(e.name)}</b> entered ${esc(e.pot)}${e.qty > 1 ? ` (${e.qty}x)` : ''}</span>`;
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
      }
    }
    // Duplicate for seamless scroll
    track.innerHTML = html + html;
  }

  // ─── Leaderboard ───────────────────────────────────────────────────────
  function renderLeaderboard() {
    if (!gameState || !gameState.leaderboard || gameState.leaderboard.length === 0) return;
    const el = $('#leaderboardList');
    const medals = ['🥇', '🥈', '🥉'];
    el.innerHTML = gameState.leaderboard.map((p, i) => `
      <div class="lb-row${player && p.name === player.name ? ' lb-you' : ''}">
        <span class="lb-rank">${medals[i] || (i + 1)}</span>
        <span class="lb-name">${p.levelInfo ? p.levelInfo.icon : ''} ${esc(p.name)}</span>
        <span class="lb-entries">${formatNum(p.entries)} entries</span>
        <span class="lb-streak">🔥${p.streak || 0}</span>
      </div>
    `).join('');
  }

  // ─── Winners List ──────────────────────────────────────────────────────
  function renderWinnersList() {
    if (!gameState || !gameState.recentWinners || gameState.recentWinners.length === 0) return;
    const el = $('#winnersList');
    el.innerHTML = gameState.recentWinners.slice(-8).reverse().map(w => `
      <div class="winner-row">
        <span class="winner-icon">🏆</span>
        <span class="winner-info"><b>${esc(w.name)}</b> won <span class="prize">$${esc(w.prize)}</span></span>
        <span class="winner-pot">${esc(w.pot)}</span>
      </div>
    `).join('');
  }

  // ─── Winner Modal ──────────────────────────────────────────────────────
  function showWinner(info) {
    $('#winnerName').textContent = info.name;
    $('#winnerPrize').textContent = '$' + info.prize;
    $('#winnerRound').textContent = info.round;
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
  function shareApp() {
    const text = `I'm playing GOLDPOT — America's national pot game! 🏆 The pot is growing every minute. Join with my code: ${player ? player.referralCode : ''}`;
    if (navigator.share) {
      navigator.share({ title: 'GOLDPOT', text, url: window.location.href }).catch(() => {});
    } else {
      shareVia('twitter');
    }
  }

  async function shareVia(platform) {
    const text = encodeURIComponent(`I'm playing GOLDPOT — America's national pot game! 🏆 Use my code: ${player ? player.referralCode : ''}`);
    const url = encodeURIComponent(window.location.href);
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
    const code = player ? player.referralCode : '';
    navigator.clipboard.writeText(code).then(() => {
      const btn = $('#btnCopy');
      btn.textContent = 'COPIED!';
      setTimeout(() => { btn.textContent = 'COPY'; }, 2000);
    }).catch(() => {});
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
    selectedPayMethod = null;
    $$('#onboardPaymentGrid .pay-option').forEach(o => o.classList.remove('selected'));
    $('#cardForm').classList.add('hidden');
    openModal('nameModal');
    setTimeout(() => $('#playerNameInput').focus(), 300);
  }

  function openModal(id) { $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#' + id).classList.add('hidden'); }

  // ─── Bonus Popup ────────────────────────────────────────────────────────
  function showBonus(text) {
    const popup = $('#bonusPopup');
    $('#bonusText').textContent = text;
    popup.classList.remove('hidden');
    popup.classList.add('show');
    SFX.bonus();
    setTimeout(() => {
      popup.classList.remove('show');
      setTimeout(() => popup.classList.add('hidden'), 400);
    }, 2500);
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

  // ─── Launch ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
