/* ═══════════════════════════════════════════════════════════════════════════
   DEEP GOLD — Digging Game Engine
   "How deep will you dig before greed consumes you?"
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const LAYER_H = 48;
const DEPTH_PER_DIG = 3;
const CAMERA_RATIO = 0.32;
const DIG_ANIM_MS = 300;

// ─── Biomes ─────────────────────────────────────────────────────────────────
const BIOMES = [
  { name: 'TOPSOIL',        minD: 0,   bg1: '#4a3520', bg2: '#3a2510', accent: '#6B4423', textCol: '#d4a574' },
  { name: 'BEDROCK',        minD: 50,  bg1: '#38384a', bg2: '#282838', accent: '#5a5a7a', textCol: '#9090b0' },
  { name: 'CRYSTAL CAVERN', minD: 150, bg1: '#281548', bg2: '#1a0e30', accent: '#9050e0', textCol: '#c080ff' },
  { name: 'MAGMA ZONE',     minD: 300, bg1: '#481510', bg2: '#300a05', accent: '#ff4020', textCol: '#ff8060' },
  { name: 'EARTH\'S CORE',  minD: 500, bg1: '#3a3010', bg2: '#282008', accent: '#f0c040', textCol: '#ffe080' },
];

function getBiome(depth) {
  for (let i = BIOMES.length - 1; i >= 0; i--) {
    if (depth >= BIOMES[i].minD) return BIOMES[i];
  }
  return BIOMES[0];
}

function getMultiplier(depth) {
  if (depth >= 500) return 10;
  if (depth >= 300) return 5;
  if (depth >= 150) return 3;
  if (depth >= 50) return 2;
  return 1;
}

// ─── Tile Generation ────────────────────────────────────────────────────────
const TILE_VIS = {
  rock:       { icon: '',   color: '#666',    glow: false },
  gold_small: { icon: '✦',  color: '#f0c040', glow: true },
  gold_large: { icon: '🪙', color: '#ffd700', glow: true },
  gem:        { icon: '💎', color: '#e060ff', glow: true },
  diamond:    { icon: '💠', color: '#60d0ff', glow: true },
  star:       { icon: '⭐', color: '#fff8a0', glow: true },
  dynamite:   { icon: '💥', color: '#ff3030', glow: true },
};

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function generateTile(depth) {
  const d = Math.min(depth, 700);
  const r = Math.random();

  // Cumulative probabilities — danger + reward increase with depth
  const pDyn   = 0.04 + (d / 700) * 0.21;
  const pStar  = pDyn + 0.004 + (d / 700) * 0.026;
  const pDia   = pStar + 0.018 + (d / 700) * 0.042;
  const pGem   = pDia + 0.055 + (d / 700) * 0.065;
  const pGoldL = pGem + 0.10 + (d / 700) * 0.02;
  const pGoldS = pGoldL + 0.22 - (d / 700) * 0.10;

  const mult = getMultiplier(depth);

  if (r < pDyn)   return { type: 'dynamite', value: 0, mult };
  if (r < pStar)  return { type: 'star',     value: randInt(75, 100) * mult, mult };
  if (r < pDia)   return { type: 'diamond',  value: randInt(25, 50)  * mult, mult };
  if (r < pGem)   return { type: 'gem',      value: randInt(10, 20)  * mult, mult };
  if (r < pGoldL) return { type: 'gold_large', value: randInt(4, 8)  * mult, mult };
  if (r < pGoldS) return { type: 'gold_small', value: randInt(1, 3)  * mult, mult };
  return { type: 'rock', value: 0, mult };
}

// ─── Sound Engine ───────────────────────────────────────────────────────────
class MineSoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
  }

  init() {
    if (this.ready) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ready = true;
    } catch (_) {}
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  play(type) {
    if (this.muted || !this.ctx) return;
    this.resume();
    const t = this.ctx.currentTime;
    try { this['_' + type]?.(t); } catch (_) {}
  }

  // Helper: create oscillator with gain envelope
  _osc(freq, type, start, dur, vol) {
    const o = this.ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.12, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(start);
    o.stop(start + dur);
  }

  _noise(start, dur, vol, freq) {
    const len = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = freq || 800;
    flt.Q.value = 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.2, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(flt).connect(g).connect(this.ctx.destination);
    src.start(start);
    src.stop(start + dur);
  }

  _dig(t) {
    this._noise(t, 0.1, 0.25, 900);
    this._osc(120, 'sine', t, 0.12, 0.15);
  }

  _gold_small(t) {
    this._osc(880, 'sine', t, 0.15, 0.12);
    this._osc(1100, 'sine', t + 0.07, 0.12, 0.10);
  }

  _gold_large(t) {
    [660, 880, 1100].forEach((f, i) => this._osc(f, 'sine', t + i * 0.06, 0.25, 0.10));
  }

  _gem(t) {
    [1047, 1319, 1568, 1760].forEach((f, i) => this._osc(f, 'triangle', t + i * 0.05, 0.35, 0.08));
  }

  _diamond(t) {
    [880, 1100, 1320, 1540, 1760].forEach((f, i) => this._osc(f, 'sine', t + i * 0.06, 0.5, 0.07));
  }

  _star(t) {
    [523, 659, 784, 1047, 1319].forEach((f, i) => {
      this._osc(f, 'sine', t + i * 0.09, 0.6, 0.10);
    });
    this._osc(2093, 'triangle', t + 0.3, 0.7, 0.04);
  }

  _dynamite(t) {
    // Deep boom + explosion noise
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(3000, t);
    flt.frequency.exponentialRampToValueAtTime(80, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(flt).connect(g).connect(this.ctx.destination);
    src.start(t);
    src.stop(t + 0.5);
    // Bass thud
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(20, t + 0.3);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.5, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g2).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.4);
  }

  _cashout(t) {
    [1318, 1568, 2093].forEach((f, i) => this._osc(f, 'sine', t + i * 0.07, 0.25, 0.12));
  }

  _gameover(t) {
    [523, 440, 349, 262].forEach((f, i) => this._osc(f, 'sine', t + i * 0.22, 0.4, 0.10));
  }

  _biome(t) {
    this._osc(440, 'sine', t, 0.5, 0.06);
    this._osc(660, 'sine', t + 0.1, 0.5, 0.06);
    this._osc(880, 'triangle', t + 0.2, 0.4, 0.04);
  }

  _record(t) {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this._osc(f, 'square', t + i * 0.1, 0.3, 0.06));
  }

  _shield(t) {
    this._osc(1047, 'sine', t, 0.3, 0.1);
    this._osc(1319, 'triangle', t + 0.1, 0.3, 0.08);
  }
}

// ─── Main Game Class ────────────────────────────────────────────────────────
class DeepGoldGame {
  constructor() {
    this.canvas = document.getElementById('mineCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.sound = new MineSoundEngine();
    this.dpr = window.devicePixelRatio || 1;

    // Game state
    this.phase = 'menu';
    this.depth = 0;
    this.gold = 0;
    this.banked = 0;
    this.lives = 3;
    this.hasShield = false;
    this.totalDigs = 0;
    this.combo = 0;

    // Layers
    this.layers = [];
    this.currentIndex = 0;
    this.scrollTarget = 0;
    this.scrollCurrent = 0;

    // Visual FX
    this.digAnim = null;
    this.particles = [];
    this.floatTexts = [];
    this.rings = [];
    this.ambientParticles = [];
    this.shakeI = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.flashAlpha = 0;
    this.flashColor = '#fff';

    // Mine map for sharing
    this.mineMap = [];

    // Records (localStorage)
    this.bestDepth = parseInt(localStorage.getItem('dg_bestDepth')) || 0;
    this.bestGold = parseInt(localStorage.getItem('dg_bestGold')) || 0;
    this.totalGames = parseInt(localStorage.getItem('dg_totalGames')) || 0;

    // Sizing
    this.w = 0;
    this.h = 0;
    this.lastTime = 0;

    this._resize();
    this._setupInput();
    this._setupButtons();
    this._updateRecords();

    requestAnimationFrame(t => this._loop(t));
  }

  // ─── Setup ──────────────────────────────────────────────────────────
  _resize() {
    const wrap = this.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _setupInput() {
    const digHandler = (e) => {
      if (this.phase !== 'playing') return;
      e.preventDefault();
      this.dig();
    };
    this.canvas.addEventListener('click', digHandler);
    this.canvas.addEventListener('touchstart', digHandler, { passive: false });
    window.addEventListener('resize', () => {
      if (this.phase === 'playing') this._resize();
    });
  }

  _setupButtons() {
    document.getElementById('btnStart').onclick = () => this.startGame();
    document.getElementById('btnPlayAgain').onclick = () => this.startGame();
    document.getElementById('btnCashOut').onclick = () => this.cashOut();
    document.getElementById('btnDig').onclick = () => this.dig();
    document.getElementById('btnShare').onclick = () => this.share();
    document.getElementById('muteToggle').onclick = () => this.toggleMute();
    const btnContinue = document.getElementById('btnContinue');
    if (btnContinue) {
      btnContinue.onclick = () => this.continueGame();
    }
  }

  // ─── Game Flow ──────────────────────────────────────────────────────
  startGame() {
    this.sound.init();
    this.sound.resume();

    this.phase = 'playing';
    this.depth = 0;
    this.gold = 0;
    this.banked = 0;
    this.lives = 3;
    this.hasShield = false;
    this.totalDigs = 0;
    this.combo = 0;
    this.layers = [];
    this.currentIndex = 0;
    this.scrollTarget = 0;
    this.scrollCurrent = 0;
    this.digAnim = null;
    this.particles = [];
    this.floatTexts = [];
    this.rings = [];
    this.ambientParticles = [];
    this.shakeI = 0;
    this.flashAlpha = 0;
    this.mineMap = [];
    this.continuesUsed = 0;

    // Generate initial layers
    for (let i = 0; i < 40; i++) {
      this.layers.push({
        depth: i * DEPTH_PER_DIG,
        ...generateTile(i * DEPTH_PER_DIG),
        revealed: false,
        index: i,
      });
    }

    this._showScreen('game');
    this._resize();
    this._updateHUD();
  }

  dig() {
    if (this.phase !== 'playing' || this.digAnim) return;
    if (this.currentIndex >= this.layers.length) return;

    const layer = this.layers[this.currentIndex];
    layer.revealed = true;
    this.totalDigs++;
    this.depth = layer.depth;

    // Vibrate on mobile
    if (navigator.vibrate) navigator.vibrate(15);

    // Start dig animation
    this.digAnim = { startTime: performance.now(), index: this.currentIndex };
    this.sound.play('dig');

    // Process reveal after crack animation
    setTimeout(() => this._processReveal(layer), 200);

    // Smooth scroll down
    this.scrollTarget = this.currentIndex * LAYER_H;

    this.currentIndex++;

    // Generate ahead
    while (this.layers.length < this.currentIndex + 30) {
      const d = this.layers.length * DEPTH_PER_DIG;
      this.layers.push({
        depth: d,
        ...generateTile(d),
        revealed: false,
        index: this.layers.length,
      });
    }

    // Biome change?
    if (layer.depth > 0) {
      const prev = getBiome(layer.depth - DEPTH_PER_DIG);
      const curr = getBiome(layer.depth);
      if (prev !== curr) {
        this.sound.play('biome');
        this._flash(curr.accent);
        this.shakeI = 15;
        const bsy = this._layerY(layer.index) + LAYER_H / 2;
        this._spawnRing(this.w / 2, bsy, curr.accent);
        this._spawnParticles(this.w / 2, bsy, curr.accent, 35);
        this._spawnParticles(this.w / 2, bsy, curr.textCol, 18);
        this._addFloat(this.w / 2, bsy - 25, '⬇️ ' + curr.name, curr.textCol, 20);
      }
    }

    // Depth milestones
    if (layer.depth > 0 && layer.depth % 100 === 0) {
      const msy = this._layerY(layer.index) + LAYER_H / 2;
      this._spawnRing(this.w / 2, msy, '#f0c040');
      this._addFloat(this.w / 2, msy - 40, `📍 ${layer.depth}m DEEP!`, '#f0c040', 18);
    }

    this._updateHUD();
  }

  _processReveal(layer) {
    const vis = TILE_VIS[layer.type];
    const cx = this.w / 2;
    const sy = this._layerY(layer.index) + LAYER_H / 2;

    this.mineMap.push(layer.type);

    if (layer.type === 'dynamite') {
      if (this.combo >= 3) this._addFloat(cx, sy - 30, '💔 COMBO BREAK!', '#ff6060', 16);
      this.combo = 0;
      if (this.hasShield) {
        // Shield absorbs
        this.hasShield = false;
        document.getElementById('shieldBadge').classList.add('hidden');
        this.sound.play('shield');
        this._flash('#60ffe0');
        this._spawnRing(cx, sy, '#60ffe0');
        this._spawnParticles(cx, sy, '#60ffe0', 28);
        this._addFloat(cx, sy - 10, '🛡️ BLOCKED!', '#60ffe0', 24);
      } else {
        this.sound.play('dynamite');
        this.lives--;
        const lost = this.gold;
        this.gold = 0;
        this.shakeI = 28;
        this._flash('#ff3030');
        this._spawnRing(cx, sy, '#ff3030');
        this._spawnParticles(cx, sy, '#ff3030', 40);
        this._spawnParticles(cx, sy, '#ff6020', 22);
        if (lost > 0) {
          this._addFloat(cx, sy - 10, `−${lost} GOLD LOST!`, '#ff4040', 24);
        } else {
          this._addFloat(cx, sy - 10, '💥 BOOM!', '#ff4040', 26);
        }
        // Update danger vignette
        if (this.lives <= 1 && this.lives > 0) {
          document.getElementById('dangerVignette').classList.add('active');
        }
        if (this.lives <= 0) {
          setTimeout(() => this.gameOver(), 700);
        }
      }
    } else if (layer.type === 'rock') {
      if (this.combo >= 3) this._addFloat(cx, sy - 30, '💔 COMBO BREAK!', '#ff6060', 14);
      this.combo = 0;
      this._spawnParticles(cx, sy, '#777', 6);
    } else if (layer.type === 'star') {
      this.combo++;
      this.gold += layer.value;
      this.hasShield = true;
      document.getElementById('shieldBadge').classList.remove('hidden');
      this.sound.play('star');
      this._flash('#fff8a0');
      this.shakeI = 12;
      this._spawnRing(cx, sy, '#fff8a0');
      this._spawnParticles(cx, sy, '#fff8a0', 50);
      this._spawnParticles(cx, sy, '#f0c040', 25);
      this._addFloat(cx, sy - 10, `⭐ +${layer.value} +🛡️`, '#fff8a0', 26);
    } else {
      // Gold / gem / diamond
      this.combo++;
      // Combo multiplier: 3-4 = 1.5x, 5-7 = 2x, 8+ = 3x
      const comboMult = this.combo >= 8 ? 3 : this.combo >= 5 ? 2 : this.combo >= 3 ? 1.5 : 1;
      const finalValue = Math.round(layer.value * comboMult);
      this.gold += finalValue;
      this.sound.play(layer.type);
      this.shakeI = Math.min(18, 3 + finalValue / 8);
      const pCount = layer.type === 'diamond' ? 35 : layer.type === 'gem' ? 24 : 14;
      this._spawnParticles(cx, sy, vis.color, pCount);
      // Combo milestone effects
      if (this.combo === 3 || this.combo === 5 || this.combo === 8 || this.combo === 12) {
        this._spawnRing(cx, sy, vis.color);
        this._spawnParticles(cx, sy, '#f0c040', 18);
        this._addFloat(cx, sy - 35, this.combo >= 8 ? `🔥 ${this.combo}x STREAK!` : `⚡ ${this.combo}x COMBO!`, '#f0c040', 20);
      }
      const comboStr = this.combo >= 8 ? ` 💥x${this.combo}` : this.combo >= 5 ? ` 🔥x${this.combo}` : this.combo >= 3 ? ` x${this.combo}` : '';
      this._addFloat(cx, sy - 10, `+${finalValue}${comboStr}`, vis.color, finalValue >= 50 ? 28 : 22);
    }

    this._updateHUD();

    // End dig animation lock
    setTimeout(() => { this.digAnim = null; }, 120);
  }

  cashOut() {
    if (this.phase !== 'playing' || this.gold <= 0) return;
    if (navigator.vibrate) navigator.vibrate([10, 30, 10]);
    this.sound.play('cashout');
    this.banked += this.gold;
    const cx = this.w / 2;
    const cy = this.h * 0.35;
    this._addFloat(cx, cy, `💰 BANKED ${this.gold}!`, '#40e070', 26);
    this._spawnParticles(cx, cy, '#40e070', 25);
    this._flash('#40e070');
    this.gold = 0;
    this._updateHUD();
  }

  gameOver() {
    this.phase = 'gameover';
    this.sound.play('gameover');
    this.totalGames++;
    document.getElementById('dangerVignette').classList.remove('active');
    document.getElementById('shieldBadge').classList.add('hidden');

    const totalGold = this.banked; // Only banked gold survives
    const entries = this._calcEntries(totalGold, this.depth);

    // Check records
    let newD = false, newG = false;
    if (this.depth > this.bestDepth) {
      this.bestDepth = this.depth;
      localStorage.setItem('dg_bestDepth', this.bestDepth);
      newD = true;
    }
    if (totalGold > this.bestGold) {
      this.bestGold = totalGold;
      localStorage.setItem('dg_bestGold', this.bestGold);
      newG = true;
    }
    localStorage.setItem('dg_totalGames', this.totalGames);

    if (newD || newG) this.sound.play('record');

    // Update game over screen
    document.getElementById('goDepth').textContent = this.depth + 'm';
    document.getElementById('goGold').textContent = totalGold;
    document.getElementById('goEntries').textContent = entries;

    const rec = document.getElementById('goRecord');
    if (newD && newG) {
      rec.innerHTML = '🏆 NEW DEPTH & GOLD RECORD!';
      rec.className = 'go-record new-record';
    } else if (newD) {
      rec.innerHTML = '🏆 NEW DEPTH RECORD!';
      rec.className = 'go-record new-record';
    } else if (newG) {
      rec.innerHTML = '🏆 NEW GOLD RECORD!';
      rec.className = 'go-record new-record';
    } else {
      rec.innerHTML = `Best: ${this.bestDepth}m · ${this.bestGold} gold`;
      rec.className = 'go-record';
    }

    this._buildMineMap();
    this._showScreen('gameover');

    // Show continue option only if player had banked gold (worth saving)
    const continueEl = document.getElementById('goContinue');
    if (continueEl) {
      // Max 2 continues per game, and must have banked gold worth saving
      continueEl.style.display = (this.continuesUsed < 2 && totalGold > 0) ? 'block' : 'none';
      // Escalate price each continue ($0.99 → $1.99)
      const price = this.continuesUsed === 0 ? '0.99' : '1.99';
      const btnC = document.getElementById('btnContinue');
      if (btnC) btnC.textContent = `⛏️ CONTINUE — $${price}`;
    }
  }

  continueGame() {
    // In a real integration, this would trigger a Stripe checkout.
    // For now, simulate the purchase and resume game.
    this.continuesUsed = (this.continuesUsed || 0) + 1;
    this.phase = 'playing';
    this.lives = 1; // Restore 1 life
    // Keep banked gold — that's the whole point
    this.gold = 0;
    this.sound.play('cashout');
    this._updateHUD();
    this._showScreen('game');

    // Spawn a celebratory "CONTINUED" effect
    const cx = this.w / 2;
    const cy = this.h * 0.4;
    this._addFloat(cx, cy, '⛏️ CONTINUE!', '#f0c040', 28);
    this._spawnParticles(cx, cy, '#f0c040', 20);
    this._flash('#f0c040');
  }

  _calcEntries(gold, depth) {
    // Graduated: every 200 gold past 500 adds +1 more entry
    // Depth bonus: 300m +1, 500m +2, 700m +3
    // Min 1 entry for any completed game
    let e = 0;
    if (gold >= 500) e = 5 + Math.floor((gold - 500) / 200);
    else if (gold >= 300) e = 3;
    else if (gold >= 150) e = 2;
    else if (gold >= 50) e = 1;
    else if (gold > 0) e = 1; // min 1 for any gold banked
    if (depth >= 700) e += 3;
    else if (depth >= 500) e += 2;
    else if (depth >= 300) e += 1;
    return e;
  }

  // ─── Mine Map (Wordle-style shareable grid) ─────────────────────────
  _buildMineMap() {
    const container = document.getElementById('goMineMap');
    const em = {
      rock: '⬛', gold_small: '🟨', gold_large: '🟡',
      gem: '🟣', diamond: '🔷', star: '⭐', dynamite: '💥'
    };
    let map = '';
    for (let i = 0; i < this.mineMap.length; i++) {
      map += em[this.mineMap[i]] || '⬛';
      if ((i + 1) % 10 === 0 && i < this.mineMap.length - 1) map += '\n';
    }
    container.innerHTML = `<div class="minemap-label">YOUR MINE MAP</div><pre class="minemap-grid">${map}</pre>`;
  }

  share() {
    const em = {
      rock: '⬛', gold_small: '🟨', gold_large: '🟡',
      gem: '🟣', diamond: '🔷', star: '⭐', dynamite: '💥'
    };
    let map = '';
    for (let i = 0; i < this.mineMap.length; i++) {
      map += em[this.mineMap[i]] || '⬛';
      if ((i + 1) % 10 === 0 && i < this.mineMap.length - 1) map += '\n';
    }
    const text = `⛏️ DEEP GOLD ⛏️\nDepth: ${this.depth}m | Gold: ${this.banked}\n\n${map}\n\nCan you dig deeper?`;

    if (navigator.share) {
      navigator.share({ title: 'Deep Gold', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btnShare');
        btn.textContent = '✅ COPIED!';
        setTimeout(() => { btn.textContent = '📤 SHARE'; }, 2000);
      }).catch(() => {});
    }
  }

  toggleMute() {
    this.sound.muted = !this.sound.muted;
    document.getElementById('muteToggle').textContent = this.sound.muted ? '🔇' : '🔊';
  }

  // ─── HUD Updates ────────────────────────────────────────────────────
  _updateHUD() {
    document.getElementById('hudDepth').textContent = this.depth;
    document.getElementById('hudGold').textContent = this.gold;
    document.getElementById('hudBanked').textContent = this.banked;
    document.getElementById('hudMultiplier').textContent = '×' + getMultiplier(this.depth);
    document.getElementById('hudBiome').textContent = getBiome(this.depth).name;

    // HUD biome accent color
    const biome = getBiome(this.depth);
    document.getElementById('hudBiome').style.color = biome.textCol;
    document.getElementById('hudMultiplier').style.color = biome.textCol;
    document.getElementById('hudMultiplier').style.textShadow = `0 0 12px ${biome.accent}60`;

    // Hearts
    let hearts = '';
    for (let i = 0; i < 3; i++) hearts += i < this.lives ? '❤️' : '🖤';
    document.getElementById('hudHearts').textContent = hearts;

    // Gold color — orange when at risk
    const goldWrap = document.getElementById('hudGoldWrap');
    if (this.gold > 50) goldWrap.classList.add('at-risk');
    else goldWrap.classList.remove('at-risk');

    // Cash out button
    const btn = document.getElementById('btnCashOut');
    const amt = document.getElementById('cashOutAmount');
    btn.disabled = this.gold <= 0;
    amt.textContent = this.gold;

    btn.classList.remove('pulsing', 'pulsing-intense');
    if (this.gold >= 100) btn.classList.add('pulsing-intense');
    else if (this.gold >= 30) btn.classList.add('pulsing');
  }

  _updateRecords() {
    const div = document.getElementById('menuRecords');
    if (this.totalGames > 0) {
      div.innerHTML = `
        <div class="record-item">🏆 Best Depth: <b>${this.bestDepth}m</b></div>
        <div class="record-item">💰 Best Gold: <b>${this.bestGold}</b></div>
        <div class="record-item">⛏️ Games Played: <b>${this.totalGames}</b></div>`;
    }
  }

  _showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const ids = { menu: 'menuScreen', game: 'gameScreen', gameover: 'gameOverScreen' };
    document.getElementById(ids[name]).classList.add('active');
    if (name === 'menu') this._updateRecords();
  }

  // ─── Render Loop ────────────────────────────────────────────────────
  _loop(timestamp) {
    const dt = Math.min((timestamp - (this.lastTime || timestamp)) / 1000, 0.05);
    this.lastTime = timestamp;

    if (this.phase === 'playing' || this.phase === 'gameover') {
      this._update(dt);
      this._render();
    }

    requestAnimationFrame(t => this._loop(t));
  }

  _update(dt) {
    // Smooth scroll
    this.scrollCurrent += (this.scrollTarget - this.scrollCurrent) * Math.min(1, dt * 12);

    // Shake decay
    if (this.shakeI > 0) {
      this.shakeX = (Math.random() - 0.5) * this.shakeI;
      this.shakeY = (Math.random() - 0.5) * this.shakeI;
      this.shakeI *= 0.85;
      if (this.shakeI < 0.3) { this.shakeI = 0; this.shakeX = 0; this.shakeY = 0; }
    }

    // Flash decay
    if (this.flashAlpha > 0) {
      this.flashAlpha -= dt * 3.5;
      if (this.flashAlpha < 0) this.flashAlpha = 0;
    }

    // Particles with air resistance
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vx *= (1 - 1.5 * dt);
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy += 2.0 * dt * 60;
      if (p.rotation !== undefined) p.rotation += p.spin * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // Expanding rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.radius += (r.maxRadius - r.radius) * dt * 6;
      r.life -= dt;
      if (r.life <= 0) this.rings.splice(i, 1);
    }

    // Float texts with deceleration
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      const prog = 1 - f.life / f.maxLife;
      f.y -= dt * 50 * (1 - prog * 0.6);
      f.life -= dt;
      if (f.life <= 0) this.floatTexts.splice(i, 1);
    }

    // Ambient floating particles
    if (this.phase === 'playing' && Math.random() < dt * 2) this._spawnAmbientParticles();
    for (let i = this.ambientParticles.length - 1; i >= 0; i--) {
      const a = this.ambientParticles[i];
      a.x += a.vx * dt * 60; a.y += a.vy * dt * 60;
      a.x += Math.sin(performance.now() / 1000 + i) * 0.15;
      a.life -= dt;
      if (a.life <= 0) this.ambientParticles.splice(i, 1);
    }
  }

  _render() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);

    // Gradient background with vignette
    const biome = getBiome(this.depth);
    const bgGrd = ctx.createLinearGradient(0, 0, 0, h);
    bgGrd.addColorStop(0, biome.bg1);
    bgGrd.addColorStop(1, biome.bg2);
    ctx.fillStyle = bgGrd;
    ctx.fillRect(-20, -20, w + 40, h + 40);

    // Vignette — stronger for depth illusion
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, w * 0.85);
    vig.addColorStop(0, 'transparent');
    vig.addColorStop(0.7, 'rgba(0,0,0,0.15)');
    vig.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vig;
    ctx.fillRect(-20, -20, w + 40, h + 40);

    // Volumetric light shaft from top
    const shaftW = 80 + Math.sin(performance.now() / 3000) * 20;
    const shaftX = w / 2 + Math.sin(performance.now() / 5000) * 30;
    const shaft = ctx.createLinearGradient(0, 0, 0, h * 0.7);
    shaft.addColorStop(0, `rgba(240,220,180,${0.04 + Math.sin(performance.now() / 2000) * 0.02})`);
    shaft.addColorStop(0.5, 'rgba(240,220,180,0.01)');
    shaft.addColorStop(1, 'transparent');
    ctx.fillStyle = shaft;
    ctx.beginPath();
    ctx.moveTo(shaftX - shaftW / 2, 0);
    ctx.lineTo(shaftX - shaftW * 1.5, h * 0.7);
    ctx.lineTo(shaftX + shaftW * 1.5, h * 0.7);
    ctx.lineTo(shaftX + shaftW / 2, 0);
    ctx.closePath();
    ctx.fill();

    this._renderLayers();
    this._renderParticles();
    this._renderFloatTexts();

    // Depth fog at bottom edge
    const depthFog = ctx.createLinearGradient(0, h - 60, 0, h);
    depthFog.addColorStop(0, 'transparent');
    depthFog.addColorStop(1, biome.bg2 + 'cc');
    ctx.fillStyle = depthFog;
    ctx.fillRect(0, h - 60, w, 60);

    // Flash overlay with radial burst
    if (this.flashAlpha > 0) {
      const fGrd = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, w);
      fGrd.addColorStop(0, this.flashColor);
      fGrd.addColorStop(1, 'transparent');
      ctx.globalAlpha = this.flashAlpha * 0.3;
      ctx.fillStyle = fGrd;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // Combo meter bar
    if (this.combo >= 2 && this.phase === 'playing') {
      const meterW = Math.min(1, this.combo / 12) * (w - 40);
      const meterColor = this.combo >= 8 ? '#ff4040' : this.combo >= 5 ? '#ff8040' : '#f0c040';
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(20, h - 14, w - 40, 6);
      const mGrd = ctx.createLinearGradient(20, 0, 20 + meterW, 0);
      mGrd.addColorStop(0, meterColor);
      mGrd.addColorStop(1, meterColor + '80');
      ctx.fillStyle = mGrd;
      ctx.fillRect(20, h - 14, meterW, 6);
      ctx.globalAlpha = 0.8;
      ctx.font = '700 10px Inter';
      ctx.fillStyle = meterColor;
      ctx.textAlign = 'right';
      ctx.fillText(`${this.combo}x`, w - 22, h - 7);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  _renderLayers() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    const camY = this.scrollCurrent - h * CAMERA_RATIO;
    const topIdx = Math.max(0, Math.floor(camY / LAYER_H) - 1);
    const botIdx = Math.min(this.layers.length + 8, Math.ceil((camY + h) / LAYER_H) + 1);

    for (let i = topIdx; i < botIdx; i++) {
      const sy = i * LAYER_H - camY;
      if (sy > h + 10 || sy + LAYER_H < -10) continue;

      if (i < this.layers.length) {
        this._renderLayer(this.layers[i], sy, i);
      } else {
        // Deep unknown earth
        const d = i * DEPTH_PER_DIG;
        const b = getBiome(d);
        ctx.fillStyle = b.bg1;
        ctx.fillRect(0, sy, w, LAYER_H);
        const darkn = Math.min(0.65, (i - this.currentIndex) * 0.08);
        ctx.fillStyle = `rgba(0,0,0,${darkn})`;
        ctx.fillRect(0, sy, w, LAYER_H);
        // Subtle grid line
        ctx.strokeStyle = 'rgba(255,255,255,0.015)';
        ctx.beginPath();
        ctx.moveTo(0, sy + LAYER_H);
        ctx.lineTo(w, sy + LAYER_H);
        ctx.stroke();
      }
    }
  }

  _renderLayer(layer, sy, index) {
    const ctx = this.ctx;
    const w = this.w;
    const biome = getBiome(layer.depth);
    const isCurrent = index === this.currentIndex;
    const lh = LAYER_H;

    if (!layer.revealed) {
      // ── Unrevealed: 3D earth block ──

      // Base fill
      ctx.fillStyle = biome.bg1;
      ctx.fillRect(0, sy, w, lh);

      // Top highlight edge (3D bevel)
      const topGrd = ctx.createLinearGradient(0, sy, 0, sy + 8);
      topGrd.addColorStop(0, 'rgba(255,255,255,0.07)');
      topGrd.addColorStop(1, 'transparent');
      ctx.fillStyle = topGrd;
      ctx.fillRect(0, sy, w, 8);

      // Bottom shadow edge (3D bevel)
      const botGrd = ctx.createLinearGradient(0, sy + lh - 6, 0, sy + lh);
      botGrd.addColorStop(0, 'transparent');
      botGrd.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = botGrd;
      ctx.fillRect(0, sy + lh - 6, w, 6);

      // Earth texture: rock clusters with 3D shading
      const seed = layer.index * 137 + 42;
      for (let j = 0; j < 10; j++) {
        const rx = ((seed * (j + 1) * 7 + 11) % 200) / 200 * w;
        const ry = ((seed * (j + 1) * 13 + 7) % 100) / 100 * (lh - 4) + 2;
        const rs = 3 + ((seed * (j + 1) * 3) % 7);
        // Rock shadow
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath(); ctx.arc(rx + 1, sy + ry + 1, rs, 0, Math.PI * 2); ctx.fill();
        // Rock body
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.beginPath(); ctx.arc(rx, sy + ry, rs, 0, Math.PI * 2); ctx.fill();
        // Rock highlight
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath(); ctx.arc(rx - 1, sy + ry - 1, rs * 0.6, 0, Math.PI * 2); ctx.fill();
      }

      // Stone vein lines (geological strata)
      ctx.strokeStyle = 'rgba(255,255,255,0.025)';
      ctx.lineWidth = 1;
      const veinY1 = sy + ((seed * 11) % lh);
      ctx.beginPath();
      ctx.moveTo(0, veinY1);
      ctx.quadraticCurveTo(w * 0.3, veinY1 + 4, w * 0.6, veinY1 - 2);
      ctx.quadraticCurveTo(w * 0.8, veinY1 + 3, w, veinY1 + 1);
      ctx.stroke();

      // Mineral sparkles
      if (Math.sin(seed * 0.7) > 0.3) {
        const sparkT = performance.now() / 1500 + seed;
        const sparkAlpha = 0.08 + Math.sin(sparkT) * 0.06;
        ctx.fillStyle = `rgba(240,220,180,${sparkAlpha})`;
        const sx1 = ((seed * 17) % 200) / 200 * w;
        const sy1 = ((seed * 23) % 100) / 100 * lh;
        ctx.beginPath(); ctx.arc(sx1, sy + sy1, 1.5, 0, Math.PI * 2); ctx.fill();
      }

      // Side shadow gradient for tunnel depth illusion
      const leftShad = ctx.createLinearGradient(0, sy, 30, sy);
      leftShad.addColorStop(0, 'rgba(0,0,0,0.12)');
      leftShad.addColorStop(1, 'transparent');
      ctx.fillStyle = leftShad;
      ctx.fillRect(0, sy, 30, lh);
      const rightShad = ctx.createLinearGradient(w - 30, sy, w, sy);
      rightShad.addColorStop(0, 'transparent');
      rightShad.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = rightShad;
      ctx.fillRect(w - 30, sy, 30, lh);

      // Current layer: animated gold glow border
      if (isCurrent && this.phase === 'playing') {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        // Outer glow
        ctx.shadowColor = `rgba(240,192,64,${0.3 + pulse * 0.4})`;
        ctx.shadowBlur = 12;
        ctx.strokeStyle = `rgba(240,192,64,${0.3 + pulse * 0.5})`;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(2, sy + 2, w - 4, lh - 4);
        ctx.shadowBlur = 0;

        // Animated pickaxe with bounce
        const bounce = Math.sin(performance.now() / 200) * 3;
        ctx.fillStyle = `rgba(240,192,64,${0.4 + pulse * 0.5})`;
        ctx.font = '700 14px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⛏️  TAP TO DIG', w / 2, sy + lh / 2 + bounce);
      }

      // Depth fog
      if (index > this.currentIndex) {
        const fog = Math.min(0.8, (index - this.currentIndex) * 0.10);
        ctx.fillStyle = `rgba(0,0,0,${fog})`;
        ctx.fillRect(0, sy, w, lh);
      }

    } else {
      // ── Revealed: 3D opened tile ──
      const vis = TILE_VIS[layer.type];

      // Background with inner shadow
      ctx.fillStyle = layer.type === 'dynamite' ? '#150404' : biome.bg2;
      ctx.fillRect(0, sy, w, lh);

      // Top inner shadow (looks carved in)
      const innerTop = ctx.createLinearGradient(0, sy, 0, sy + 10);
      innerTop.addColorStop(0, 'rgba(0,0,0,0.3)');
      innerTop.addColorStop(1, 'transparent');
      ctx.fillStyle = innerTop;
      ctx.fillRect(0, sy, w, 10);

      // Bottom inner highlight
      const innerBot = ctx.createLinearGradient(0, sy + lh - 5, 0, sy + lh);
      innerBot.addColorStop(0, 'transparent');
      innerBot.addColorStop(1, 'rgba(255,255,255,0.03)');
      ctx.fillStyle = innerBot;
      ctx.fillRect(0, sy + lh - 5, w, 5);

      // Side shadows for depth
      const lSh = ctx.createLinearGradient(0, sy, 20, sy);
      lSh.addColorStop(0, 'rgba(0,0,0,0.2)');
      lSh.addColorStop(1, 'transparent');
      ctx.fillStyle = lSh;
      ctx.fillRect(0, sy, 20, lh);
      const rSh = ctx.createLinearGradient(w - 20, sy, w, sy);
      rSh.addColorStop(0, 'transparent');
      rSh.addColorStop(1, 'rgba(0,0,0,0.2)');
      ctx.fillStyle = rSh;
      ctx.fillRect(w - 20, sy, 20, lh);

      // Glow for valuable finds — volumetric light
      if (vis.glow && layer.type !== 'rock') {
        // Outer glow ring
        const grd = ctx.createRadialGradient(w / 2, sy + lh / 2, 0, w / 2, sy + lh / 2, lh * 2.5);
        grd.addColorStop(0, vis.color + '55');
        grd.addColorStop(0.3, vis.color + '22');
        grd.addColorStop(0.6, vis.color + '0a');
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(0, sy, w, lh);

        // Inner bright core
        const core = ctx.createRadialGradient(w / 2, sy + lh / 2, 0, w / 2, sy + lh / 2, lh * 0.8);
        core.addColorStop(0, vis.color + '30');
        core.addColorStop(1, 'transparent');
        ctx.fillStyle = core;
        ctx.fillRect(0, sy, w, lh);

        // Pulsing for high value
        if (layer.value >= 20) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
          ctx.globalAlpha = pulse * 0.15;
          const pGrd = ctx.createRadialGradient(w / 2, sy + lh / 2, 0, w / 2, sy + lh / 2, lh);
          pGrd.addColorStop(0, vis.color);
          pGrd.addColorStop(1, 'transparent');
          ctx.fillStyle = pGrd;
          ctx.fillRect(0, sy, w, lh);
          ctx.globalAlpha = 1;
        }

        // Light rays from center
        const rayT = performance.now() / 2000;
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = vis.color;
        for (let r = 0; r < 6; r++) {
          const ang = rayT + (r / 6) * Math.PI * 2;
          const rayLen = lh * 1.5;
          ctx.save();
          ctx.translate(w / 2, sy + lh / 2);
          ctx.rotate(ang);
          ctx.fillRect(-1, 0, 2, rayLen);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // Dynamite: pulsing red embers
      if (layer.type === 'dynamite') {
        ctx.fillStyle = 'rgba(255,40,40,0.08)';
        ctx.fillRect(0, sy, w, lh);
        // Scattered embers
        const et = performance.now() / 800;
        for (let e = 0; e < 4; e++) {
          const ex = w * 0.2 + (e / 4) * w * 0.6;
          const ey = sy + lh * 0.3 + Math.sin(et + e * 2) * 6;
          const ea = 0.15 + Math.sin(et * 2 + e) * 0.1;
          ctx.fillStyle = `rgba(255,100,20,${ea})`;
          ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Icon with shadow & glow
      if (vis.icon) {
        ctx.save();
        // Icon shadow
        ctx.shadowColor = vis.glow ? vis.color + '80' : 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = vis.glow ? 16 : 4;
        ctx.shadowOffsetY = vis.glow ? 0 : 2;
        ctx.font = '28px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(vis.icon, w / 2, sy + lh / 2);
        ctx.restore();
      }

      // Value badge with glow
      if (layer.value > 0) {
        ctx.save();
        ctx.shadowColor = vis.color + '60';
        ctx.shadowBlur = 8;
        ctx.font = '700 12px Inter';
        ctx.fillStyle = vis.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('+' + layer.value, w / 2 + 24, sy + lh / 2 + 1);
        ctx.restore();
      }

      // Rock: detailed crack patterns
      if (layer.type === 'rock') {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        const s = layer.index * 37;
        // Main crack
        ctx.beginPath();
        ctx.moveTo(w * 0.15, sy + ((s * 3) % lh));
        ctx.quadraticCurveTo(w * 0.35, sy + lh * 0.4, w * 0.5, sy + lh * 0.5);
        ctx.quadraticCurveTo(w * 0.65, sy + lh * 0.6, w * 0.85, sy + ((s * 7) % lh));
        ctx.stroke();
        // Secondary crack
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.beginPath();
        ctx.moveTo(w * 0.4, sy + 4);
        ctx.quadraticCurveTo(w * 0.55, sy + lh * 0.3, w * 0.3, sy + lh - 4);
        ctx.stroke();
        // Pebble details
        for (let p = 0; p < 3; p++) {
          const px = ((s * (p + 3) * 11) % 200) / 200 * (w - 40) + 20;
          const py = ((s * (p + 3) * 17) % 100) / 100 * (lh - 8) + 4;
          ctx.fillStyle = 'rgba(255,255,255,0.02)';
          ctx.beginPath(); ctx.arc(px, sy + py, 4 + (s * p) % 4, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Multiplier label with glow
      const m = getMultiplier(layer.depth);
      if (m > 1) {
        ctx.save();
        ctx.shadowColor = 'rgba(240,192,64,0.3)';
        ctx.shadowBlur = 6;
        ctx.font = '600 9px Inter';
        ctx.fillStyle = `rgba(240,192,64,0.35)`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`\u00d7${m}`, 6, sy + 4);
        ctx.restore();
      }

      // Biome transition label
      if (layer.index > 0 && layer.index < this.layers.length) {
        const prevD = (layer.index - 1) * DEPTH_PER_DIG;
        const prevB = getBiome(prevD);
        const curB = getBiome(layer.depth);
        if (prevB.name !== curB.name) {
          ctx.font = '700 10px Inter';
          ctx.fillStyle = curB.accent;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText('━━ ' + curB.name + ' ━━', w / 2, sy + 3);
        }
      }
    }

    // Grid line
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, sy + LAYER_H);
    ctx.lineTo(w, sy + LAYER_H);
    ctx.stroke();

    // Dig animation cracks
    if (this.digAnim && this.digAnim.index === index) {
      const elapsed = performance.now() - this.digAnim.startTime;
      const p = Math.min(1, elapsed / DIG_ANIM_MS);

      if (p < 0.7) {
        const crackP = p / 0.7;
        ctx.strokeStyle = `rgba(255,255,255,${crackP * 0.5})`;
        ctx.lineWidth = 2;
        const cx = w / 2;
        const cy = sy + LAYER_H / 2;
        for (let c = 0; c < 6; c++) {
          const angle = (c / 6) * Math.PI * 2 + layer.index * 0.5;
          const len = crackP * LAYER_H * 0.7;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
          ctx.stroke();
        }
      }
    }
  }

  _renderParticles() {
    const ctx = this.ctx;
    const camY = this.scrollCurrent - this.h * CAMERA_RATIO;

    // Ambient particles with soft bloom glow
    for (const a of this.ambientParticles) {
      const la = Math.max(0, Math.min(1, a.life / a.maxLife));
      const ax = a.x, ay = a.y - camY;
      // Outer bloom
      ctx.globalAlpha = a.alpha * la * 0.2;
      const bg = ctx.createRadialGradient(ax, ay, 0, ax, ay, a.size * 4);
      bg.addColorStop(0, a.color); bg.addColorStop(1, 'transparent');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(ax, ay, a.size * 4, 0, Math.PI * 2); ctx.fill();
      // Core
      ctx.globalAlpha = a.alpha * la;
      ctx.fillStyle = a.color;
      ctx.beginPath(); ctx.arc(ax, ay, a.size, 0, Math.PI * 2); ctx.fill();
    }

    // Expanding rings with double-ring + glow
    for (const r of this.rings) {
      const a = Math.max(0, r.life / r.maxLife);
      // Outer glow ring
      ctx.globalAlpha = a * 0.15;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 8 * a;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2); ctx.stroke();
      // Main ring
      ctx.globalAlpha = a * 0.5;
      ctx.lineWidth = 2.5 * a;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2); ctx.stroke();
      // Inner ring
      ctx.globalAlpha = a * 0.25;
      ctx.lineWidth = 1.5 * a;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.radius * 0.7, 0, Math.PI * 2); ctx.stroke();
    }

    // Main particles with bloom and metallic sheen
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.maxLife);
      const sz = p.size * (0.3 + a * 0.7);

      // Bloom glow behind particle
      if (a > 0.2) {
        ctx.globalAlpha = a * 0.12;
        const pg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, sz * 3.5);
        pg.addColorStop(0, p.color); pg.addColorStop(0.5, p.color + '40'); pg.addColorStop(1, 'transparent');
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz * 3.5, 0, Math.PI * 2); ctx.fill();
      }

      ctx.globalAlpha = a;
      if (p.shape === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation || 0);
        // 5-point star with inner/outer radius
        ctx.beginPath();
        for (let j = 0; j < 10; j++) {
          const ang = (j * Math.PI) / 5 - Math.PI / 2;
          const r2 = j % 2 === 0 ? sz : sz * 0.4;
          const method = j === 0 ? 'moveTo' : 'lineTo';
          ctx[method](Math.cos(ang) * r2, Math.sin(ang) * r2);
        }
        ctx.closePath();
        // Metallic fill gradient
        const sg = ctx.createLinearGradient(-sz, -sz, sz, sz);
        sg.addColorStop(0, '#fff'); sg.addColorStop(0.3, p.color); sg.addColorStop(1, p.color);
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.restore();
      } else {
        // Circle with highlight
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz, 0, Math.PI * 2); ctx.fill();
        // Specular highlight
        ctx.globalAlpha = a * 0.6;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x - sz * 0.25, p.y - sz * 0.25, sz * 0.35, 0, Math.PI * 2); ctx.fill();
      }

      // Motion trail
      if (a > 0.4 && (Math.abs(p.vx) > 1 || Math.abs(p.vy) > 1)) {
        ctx.globalAlpha = a * 0.08;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x - p.vx * 0.5, p.y - p.vy * 0.5, sz * 0.7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(p.x - p.vx, p.y - p.vy, sz * 0.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderFloatTexts() {
    const ctx = this.ctx;
    for (const f of this.floatTexts) {
      const a = Math.max(0, Math.min(1, f.life / f.maxLife));
      const prog = 1 - f.life / f.maxLife;
      const scale = prog < 0.1 ? prog / 0.1 : prog < 0.2 ? 1 + (0.2 - prog) * 3 : 1.0 - (prog - 0.2) * 0.3;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.scale(scale, scale);

      // Outer bloom glow
      ctx.font = `800 ${f.size}px Inter`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 20;
      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);

      // Main text with stroke for depth
      ctx.globalAlpha = a;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = f.color + '80';
      ctx.shadowBlur = 8;
      ctx.fillText(f.text, 0, 0);

      // Color overlay
      ctx.globalAlpha = a * 0.6;
      ctx.shadowBlur = 0;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);

      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ─── FX Helpers ─────────────────────────────────────────────────────
  _layerY(layerIndex) {
    const camY = this.scrollCurrent - this.h * CAMERA_RATIO;
    return layerIndex * LAYER_H - camY;
  }

  _spawnParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 2.5 + Math.random() * 6;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.5,
        life: 0.5 + Math.random() * 0.7,
        maxLife: 1.1,
        size: 2.5 + Math.random() * 4.5,
        color,
        shape: Math.random() > 0.4 ? 'star' : 'circle',
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 10,
      });
    }
  }

  _spawnRing(x, y, color) {
    this.rings.push({ x, y, color, radius: 5, maxRadius: 130, life: 0.6, maxLife: 0.6 });
  }

  _spawnAmbientParticles() {
    if (this.ambientParticles.length > 20) return;
    const x = Math.random() * this.w;
    const camY = this.scrollCurrent - this.h * CAMERA_RATIO;
    const y = camY + Math.random() * this.h;
    const biome = getBiome(this.depth);
    this.ambientParticles.push({
      x, y, vx: (Math.random() - 0.5) * 0.3, vy: -0.2 - Math.random() * 0.3,
      life: 3 + Math.random() * 3, maxLife: 5, size: 1 + Math.random() * 2,
      color: biome.accent, alpha: 0.15 + Math.random() * 0.15,
    });
  }

  _addFloat(x, y, text, color, size) {
    this.floatTexts.push({
      x, y, text, color,
      size: size || 18,
      life: 1.4,
      maxLife: 1.4,
    });
  }

  _flash(color) {
    this.flashColor = color;
    this.flashAlpha = 1;
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  window.deepGold = new DeepGoldGame();
});

})();
