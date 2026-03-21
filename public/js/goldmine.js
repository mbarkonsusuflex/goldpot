/* ═══════════════════════════════════════════════════════════════════════════
   DEEP GOLD — Digging Game Engine
   "How deep will you dig before greed consumes you?"
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const LAYER_H = 54;
const DEPTH_PER_DIG = 3;
const CAMERA_RATIO = 0.35;
const DIG_ANIM_MS = 350;

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
class SoundEngine {
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
    this.sound = new SoundEngine();
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
    this.shakeI = 0;
    this.flashAlpha = 0;
    this.mineMap = [];

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
      }
    }

    this._updateHUD();
  }

  _processReveal(layer) {
    const vis = TILE_VIS[layer.type];
    const cx = this.w / 2;
    const sy = this._layerY(layer.index) + LAYER_H / 2;

    this.mineMap.push(layer.type);

    if (layer.type === 'dynamite') {
      this.combo = 0;
      if (this.hasShield) {
        // Shield absorbs
        this.hasShield = false;
        document.getElementById('shieldBadge').classList.add('hidden');
        this.sound.play('shield');
        this._flash('#60ffe0');
        this._spawnParticles(cx, sy, '#60ffe0', 20);
        this._addFloat(cx, sy - 10, '🛡️ BLOCKED!', '#60ffe0', 24);
      } else {
        this.sound.play('dynamite');
        this.lives--;
        const lost = this.gold;
        this.gold = 0;
        this.shakeI = 22;
        this._flash('#ff3030');
        this._spawnParticles(cx, sy, '#ff3030', 35);
        this._spawnParticles(cx, sy, '#ff6020', 20);
        if (lost > 0) {
          this._addFloat(cx, sy - 10, `−${lost} GOLD LOST!`, '#ff4040', 22);
        } else {
          this._addFloat(cx, sy - 10, '💥 BOOM!', '#ff4040', 24);
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
      this.combo = 0;
      this._spawnParticles(cx, sy, '#777', 4);
    } else if (layer.type === 'star') {
      this.combo++;
      this.gold += layer.value;
      this.hasShield = true;
      document.getElementById('shieldBadge').classList.remove('hidden');
      this.sound.play('star');
      this._flash('#fff8a0');
      this._spawnParticles(cx, sy, '#fff8a0', 45);
      this._spawnParticles(cx, sy, '#f0c040', 20);
      this._addFloat(cx, sy - 10, `⭐ +${layer.value} +🛡️`, '#fff8a0', 24);
    } else {
      // Gold / gem / diamond
      this.combo++;
      this.gold += layer.value;
      this.sound.play(layer.type);
      const pCount = layer.type === 'diamond' ? 28 : layer.type === 'gem' ? 20 : 10;
      this._spawnParticles(cx, sy, vis.color, pCount);
      const comboStr = this.combo >= 8 ? ` 💥x${this.combo}` : this.combo >= 5 ? ` 🔥x${this.combo}` : this.combo >= 3 ? ` x${this.combo}` : '';
      this._addFloat(cx, sy - 10, `+${layer.value}${comboStr}`, vis.color, layer.value >= 50 ? 26 : 20);
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
  }

  _calcEntries(gold, depth) {
    let e = 0;
    if (gold >= 500) e = 5;
    else if (gold >= 300) e = 3;
    else if (gold >= 150) e = 2;
    else if (gold >= 50) e = 1;
    if (depth >= 500) e += 2;
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
      this.shakeI *= 0.88;
      if (this.shakeI < 0.3) { this.shakeI = 0; this.shakeX = 0; this.shakeY = 0; }
    }

    // Flash decay
    if (this.flashAlpha > 0) {
      this.flashAlpha -= dt * 3.5;
      if (this.flashAlpha < 0) this.flashAlpha = 0;
    }

    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy += 2.5 * dt * 60; // gravity
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // Float texts
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      f.y -= dt * 50;
      f.life -= dt;
      if (f.life <= 0) this.floatTexts.splice(i, 1);
    }
  }

  _render() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);

    // Background
    const biome = getBiome(this.depth);
    ctx.fillStyle = biome.bg2;
    ctx.fillRect(-20, -20, w + 40, h + 40);

    this._renderLayers();
    this._renderParticles();
    this._renderFloatTexts();

    // Screen flash
    if (this.flashAlpha > 0) {
      ctx.globalAlpha = this.flashAlpha * 0.25;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, w, h);
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

    if (!layer.revealed) {
      // ── Unrevealed ──
      ctx.fillStyle = biome.bg1;
      ctx.fillRect(0, sy, w, LAYER_H);

      // Earth texture dots (seeded random)
      const seed = layer.index * 137 + 42;
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      for (let j = 0; j < 6; j++) {
        const rx = ((seed * (j + 1) * 7 + 11) % 200) / 200 * w;
        const ry = ((seed * (j + 1) * 13 + 7) % 100) / 100 * LAYER_H;
        const rs = 2 + ((seed * (j + 1) * 3) % 8);
        ctx.beginPath();
        ctx.arc(rx, sy + ry, rs, 0, Math.PI * 2);
        ctx.fill();
      }

      // Current layer: pulsing gold border
      if (isCurrent && this.phase === 'playing') {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        ctx.strokeStyle = `rgba(240,192,64,${0.25 + pulse * 0.45})`;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(1, sy + 1, w - 2, LAYER_H - 2);

        // Tap hint
        ctx.fillStyle = `rgba(240,192,64,${0.35 + pulse * 0.45})`;
        ctx.font = '700 13px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⛏️  TAP TO DIG', w / 2, sy + LAYER_H / 2);
      }

      // Depth fog for layers below current
      if (index > this.currentIndex) {
        const fog = Math.min(0.6, (index - this.currentIndex) * 0.1);
        ctx.fillStyle = `rgba(0,0,0,${fog})`;
        ctx.fillRect(0, sy, w, LAYER_H);
      }

    } else {
      // ── Revealed ──
      const vis = TILE_VIS[layer.type];

      // Background
      ctx.fillStyle = layer.type === 'dynamite' ? '#150404' : biome.bg2;
      ctx.fillRect(0, sy, w, LAYER_H);

      // Glow for valuable finds
      if (vis.glow && layer.type !== 'rock') {
        const grd = ctx.createRadialGradient(w / 2, sy + LAYER_H / 2, 0, w / 2, sy + LAYER_H / 2, LAYER_H * 1.8);
        grd.addColorStop(0, vis.color + '22');
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(0, sy, w, LAYER_H);
      }

      // Dynamite debris overlay
      if (layer.type === 'dynamite') {
        ctx.fillStyle = 'rgba(255,40,40,0.08)';
        ctx.fillRect(0, sy, w, LAYER_H);
      }

      // Icon
      if (vis.icon) {
        ctx.font = '26px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(vis.icon, w / 2, sy + LAYER_H / 2);
      }

      // Value badge
      if (layer.value > 0) {
        ctx.font = '700 11px Inter';
        ctx.fillStyle = vis.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('+' + layer.value, w / 2 + 22, sy + LAYER_H / 2 + 1);
      }

      // Rock cracks
      if (layer.type === 'rock') {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        const s = layer.index * 37;
        ctx.beginPath();
        ctx.moveTo(w * 0.2, sy + ((s * 3) % LAYER_H));
        ctx.lineTo(w * 0.5, sy + LAYER_H * 0.5);
        ctx.lineTo(w * 0.8, sy + ((s * 7) % LAYER_H));
        ctx.stroke();
      }

      // Multiplier label
      const m = getMultiplier(layer.depth);
      if (m > 1) {
        ctx.font = '600 9px Inter';
        ctx.fillStyle = `rgba(240,192,64,0.3)`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`×${m}`, 6, sy + 4);
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
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.3 + a * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _renderFloatTexts() {
    const ctx = this.ctx;
    for (const f of this.floatTexts) {
      const a = Math.max(0, Math.min(1, f.life / f.maxLife));
      ctx.globalAlpha = a;
      ctx.font = `800 ${f.size}px Inter`;
      ctx.fillStyle = f.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Shadow for readability
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
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
      this.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 7,
        vy: (Math.random() - 1) * 5,
        life: 0.3 + Math.random() * 0.5,
        maxLife: 0.7,
        size: 2 + Math.random() * 4,
        color,
      });
    }
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
