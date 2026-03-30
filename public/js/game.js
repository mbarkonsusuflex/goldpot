/* ═══════════════════════════════════════════════════════════════════════════
   DEEP GOLD — Mine Game Engine (Embedded in GoldPot app)
   Replaces coin-tap. Risk/reward depth mining game.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

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
  constructor() { this.ctx = null; this.muted = false; this.ready = false; }

  init() {
    if (this.ready) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ready = true; } catch (_) {}
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  play(type) {
    if (this.muted || !this.ctx) return;
    this.resume();
    const t = this.ctx.currentTime;
    try { this['_' + type]?.(t); } catch (_) {}
  }

  _osc(freq, type, start, dur, vol) {
    const o = this.ctx.createOscillator();
    o.type = type || 'sine'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.12, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(start); o.stop(start + dur);
  }

  _noise(start, dur, vol, freq) {
    const len = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const flt = this.ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = freq || 800; flt.Q.value = 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.2, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(flt).connect(g).connect(this.ctx.destination);
    src.start(start); src.stop(start + dur);
  }

  _dig(t) { this._noise(t, 0.1, 0.25, 900); this._osc(120, 'sine', t, 0.12, 0.15); }

  _gold_small(t) { this._osc(880, 'sine', t, 0.15, 0.12); this._osc(1100, 'sine', t + 0.07, 0.12, 0.10); }

  _gold_large(t) { [660, 880, 1100].forEach((f, i) => this._osc(f, 'sine', t + i * 0.06, 0.25, 0.10)); }

  _gem(t) { [1047, 1319, 1568, 1760].forEach((f, i) => this._osc(f, 'triangle', t + i * 0.05, 0.35, 0.08)); }

  _diamond(t) { [880, 1100, 1320, 1540, 1760].forEach((f, i) => this._osc(f, 'sine', t + i * 0.06, 0.5, 0.07)); }

  _star(t) {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this._osc(f, 'sine', t + i * 0.09, 0.6, 0.10));
    this._osc(2093, 'triangle', t + 0.3, 0.7, 0.04);
  }

  _dynamite(t) {
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const flt = this.ctx.createBiquadFilter(); flt.type = 'lowpass';
    flt.frequency.setValueAtTime(3000, t); flt.frequency.exponentialRampToValueAtTime(80, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(flt).connect(g).connect(this.ctx.destination); src.start(t); src.stop(t + 0.5);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(20, t + 0.3);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.5, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g2).connect(this.ctx.destination); o.start(t); o.stop(t + 0.4);
  }

  _cashout(t) { [1318, 1568, 2093].forEach((f, i) => this._osc(f, 'sine', t + i * 0.07, 0.25, 0.12)); }

  _gameover(t) { [523, 440, 349, 262].forEach((f, i) => this._osc(f, 'sine', t + i * 0.22, 0.4, 0.10)); }

  _biome(t) { this._osc(440, 'sine', t, 0.5, 0.06); this._osc(660, 'sine', t + 0.1, 0.5, 0.06); this._osc(880, 'triangle', t + 0.2, 0.4, 0.04); }

  _shield(t) { this._osc(1047, 'sine', t, 0.3, 0.1); this._osc(1319, 'triangle', t + 0.1, 0.3, 0.08); }
}

// ─── GoldPotGame (Deep Gold Mine) ───────────────────────────────────────────
class GoldPotGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sound = new MineSoundEngine();
    this.dpr = window.devicePixelRatio || 1;

    // Callbacks for app.js integration (same interface contract)
    this.onScore = null;   // Called with current gold total on each dig
    this.onEnd = null;     // Called when game ends (all lives lost or cash-out)
    this.onTick = null;    // Called each frame with {depth, lives, gold, banked, biome, multiplier}
    this.onCombo = null;   // Called on combos

    this.running = false;
    this._reset();

    this.w = 0;
    this.h = 0;
    this.lastTime = 0;

    this._resize();
    this._bindInput();

    // Render loop (always running for smooth visuals)
    requestAnimationFrame(t => this._loop(t));
  }

  _reset() {
    this.depth = 0;
    this.gold = 0;
    this.banked = 0;
    this.lives = 3;
    this.hasShield = false;
    this.combo = 0;
    this.maxCombo = 0;
    this.totalDigs = 0;
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
    this.shakeX = 0;
    this.shakeY = 0;
    this.flashAlpha = 0;
    this.flashColor = '#fff';
    this.mineMap = [];
    this.cashedOut = false;
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    if (this.w <= 0 || this.h <= 0) return;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _bindInput() {
    const digHandler = (e) => {
      if (!this.running) return;
      e.preventDefault();
      this.dig();
    };
    this.canvas.addEventListener('click', digHandler);
    this.canvas.addEventListener('touchstart', digHandler, { passive: false });
    window.addEventListener('resize', () => this._resize());
  }

  // ─── Public API (called by app.js) ────────────────────────────────────
  start() {
    this.sound.init();
    this.sound.resume();
    this.running = true;
    this._reset();

    // Generate initial layers
    for (let i = 0; i < 40; i++) {
      this.layers.push({
        depth: i * DEPTH_PER_DIG,
        ...generateTile(i * DEPTH_PER_DIG),
        revealed: false,
        index: i,
      });
    }

    this._resize();
    this._emitTick();
  }

  stop() {
    this.running = false;
  }

  cashOut() {
    if (!this.running || this.gold <= 0) return;
    if (navigator.vibrate) navigator.vibrate([10, 30, 10]);
    this.sound.play('cashout');
    this.banked += this.gold;
    const cx = this.w / 2;
    const cy = this.h * 0.35;
    this._addFloat(cx, cy, `💰 BANKED ${this.gold}!`, '#40e070', 22);
    this._spawnParticles(cx, cy, '#40e070', 20);
    this._flash('#40e070');
    this.gold = 0;
    this._emitTick();
  }

  endAndScore() {
    // Called when player cashes out final or loses — ends game, reports score
    this.running = false;
    const score = this._calcScore();
    if (this.onEnd) this.onEnd(score);
  }

  _calcScore() {
    // Score = banked gold + depth bonus → maps to bonus entries
    // Graduated: every 100 gold beyond 500 adds +1 more entry-equivalent
    // Depth bonus: 300m = +1, 500m = +2, 700m = +3
    const g = this.banked;
    const d = this.depth;
    // Base score from gold
    let score;
    if (g >= 500) score = 50 + Math.floor((g - 500) / 100) * 5;
    else if (g >= 300) score = 35 + Math.floor((g - 300) / 50);
    else if (g >= 150) score = 20 + Math.floor((g - 150) / 15);
    else if (g >= 50) score = 10 + Math.floor((g - 50) / 10);
    else score = Math.max(1, Math.floor(g / 4)); // min 1 if any gold
    // Depth bonus
    if (d >= 700) score += 15;
    else if (d >= 500) score += 10;
    else if (d >= 300) score += 5;
    return score;
  }

  getMineMap() {
    const em = {
      rock: '⬛', gold_small: '🟨', gold_large: '🟡',
      gem: '🟣', diamond: '🔷', star: '⭐', dynamite: '💥'
    };
    let map = '';
    for (let i = 0; i < this.mineMap.length; i++) {
      map += em[this.mineMap[i]] || '⬛';
      if ((i + 1) % 10 === 0 && i < this.mineMap.length - 1) map += '\n';
    }
    return map;
  }

  setMuted(m) { this.sound.muted = m; }

  // ─── Core Dig ─────────────────────────────────────────────────────────
  dig() {
    if (!this.running || this.digAnim) return;
    if (this.currentIndex >= this.layers.length) return;

    const layer = this.layers[this.currentIndex];
    layer.revealed = true;
    this.totalDigs++;
    this.depth = layer.depth;
    if (navigator.vibrate) navigator.vibrate(15);

    this.digAnim = { startTime: performance.now(), index: this.currentIndex };
    this.sound.play('dig');

    setTimeout(() => this._processReveal(layer), 180);

    this.scrollTarget = this.currentIndex * LAYER_H;
    this.currentIndex++;

    // Generate ahead
    while (this.layers.length < this.currentIndex + 30) {
      const d = this.layers.length * DEPTH_PER_DIG;
      this.layers.push({ depth: d, ...generateTile(d), revealed: false, index: this.layers.length });
    }

    // Biome change?
    if (layer.depth > 0) {
      const prev = getBiome(layer.depth - DEPTH_PER_DIG);
      const curr = getBiome(layer.depth);
      if (prev !== curr) {
        this.sound.play('biome');
        this._flash(curr.accent);
        this.shakeI = 15;
        // Celebration ring burst
        const bsy = this._layerScreenY(layer.index) + LAYER_H / 2;
        this._spawnRing(this.w / 2, bsy, curr.accent);
        this._spawnParticles(this.w / 2, bsy, curr.accent, 30);
        this._spawnParticles(this.w / 2, bsy, curr.textCol, 15);
        this._addFloat(this.w / 2, bsy - 25, '⬇️ ' + curr.name, curr.textCol, 18);
      }
    }

    // Depth milestones
    if (layer.depth > 0 && layer.depth % 100 === 0) {
      const msy = this._layerScreenY(layer.index) + LAYER_H / 2;
      this._spawnRing(this.w / 2, msy, '#f0c040');
      this._addFloat(this.w / 2, msy - 40, `📍 ${layer.depth}m DEEP!`, '#f0c040', 16);
    }

    this._emitTick();
  }

  _processReveal(layer) {
    const vis = TILE_VIS[layer.type];
    const cx = this.w / 2;
    const sy = this._layerScreenY(layer.index) + LAYER_H / 2;

    this.mineMap.push(layer.type);

    if (layer.type === 'dynamite') {
      if (this.combo >= 3) this._addFloat(cx, sy - 30, '💔 COMBO BREAK!', '#ff6060', 16);
      this.combo = 0;
      if (this.hasShield) {
        this.hasShield = false;
        this.sound.play('shield');
        this._flash('#60ffe0');
        this._spawnRing(cx, sy, '#60ffe0');
        this._spawnParticles(cx, sy, '#60ffe0', 24);
        this._addFloat(cx, sy - 10, '🛡️ BLOCKED!', '#60ffe0', 22);
      } else {
        this.sound.play('dynamite');
        this.lives--;
        const lost = this.gold;
        this.gold = 0;
        this.shakeI = 28;
        this._flash('#ff3030');
        this._spawnRing(cx, sy, '#ff3030');
        this._spawnParticles(cx, sy, '#ff3030', 35);
        this._spawnParticles(cx, sy, '#ff6020', 20);
        if (lost > 0) this._addFloat(cx, sy - 10, `−${lost} GOLD LOST!`, '#ff4040', 22);
        else this._addFloat(cx, sy - 10, '💥 BOOM!', '#ff4040', 24);
        if (this.lives <= 0) {
          setTimeout(() => this.endAndScore(), 700);
        }
      }
    } else if (layer.type === 'rock') {
      if (this.combo >= 3) this._addFloat(cx, sy - 30, '💔 COMBO BREAK!', '#ff6060', 14);
      this.combo = 0;
      this._spawnParticles(cx, sy, '#777', 6);
    } else if (layer.type === 'star') {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.gold += layer.value;
      this.hasShield = true;
      this.sound.play('star');
      this._flash('#fff8a0');
      this.shakeI = 12;
      this._spawnRing(cx, sy, '#fff8a0');
      this._spawnParticles(cx, sy, '#fff8a0', 40);
      this._spawnParticles(cx, sy, '#f0c040', 20);
      this._addFloat(cx, sy - 10, `⭐ +${layer.value} +🛡️`, '#fff8a0', 24);
      if (this.onScore) this.onScore(this.gold + this.banked);
      if (this.onCombo && this.combo >= 3) this.onCombo(this.combo);
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      // Combo multiplier: 3-4 = 1.5x, 5-7 = 2x, 8+ = 3x
      const comboMult = this.combo >= 8 ? 3 : this.combo >= 5 ? 2 : this.combo >= 3 ? 1.5 : 1;
      const finalValue = Math.round(layer.value * comboMult);
      this.gold += finalValue;
      this.sound.play(layer.type);
      // Scale shake by value
      this.shakeI = Math.min(18, 3 + finalValue / 8);
      const pCount = layer.type === 'diamond' ? 30 : layer.type === 'gem' ? 22 : 12;
      this._spawnParticles(cx, sy, vis.color, pCount);
      // Combo milestone: expanding ring + extra burst
      if (this.combo === 3 || this.combo === 5 || this.combo === 8 || this.combo === 12) {
        this._spawnRing(cx, sy, vis.color);
        this._spawnParticles(cx, sy, '#f0c040', 15);
        this._addFloat(cx, sy - 35, this.combo >= 8 ? `🔥 ${this.combo}x STREAK!` : `⚡ ${this.combo}x COMBO!`, '#f0c040', 18);
      }
      const comboStr = this.combo >= 8 ? ` 💥x${this.combo}` : this.combo >= 5 ? ` 🔥x${this.combo}` : this.combo >= 3 ? ` x${this.combo}` : '';
      this._addFloat(cx, sy - 10, `+${finalValue}${comboStr}`, vis.color, finalValue >= 50 ? 26 : 20);
      if (this.onScore) this.onScore(this.gold + this.banked);
      if (this.onCombo && this.combo >= 3) this.onCombo(this.combo);
    }

    this._emitTick();
    setTimeout(() => { this.digAnim = null; }, 100);
  }

  _emitTick() {
    if (this.onTick) {
      this.onTick({
        depth: this.depth,
        lives: this.lives,
        gold: this.gold,
        banked: this.banked,
        biome: getBiome(this.depth).name,
        multiplier: getMultiplier(this.depth),
        hasShield: this.hasShield,
        score: this._calcScore(),
      });
    }
  }

  // ─── Render Loop ──────────────────────────────────────────────────────
  _loop(timestamp) {
    const dt = Math.min((timestamp - (this.lastTime || timestamp)) / 1000, 0.05);
    this.lastTime = timestamp;

    if (this.running) {
      this._update(dt);
      this._render();
    }

    requestAnimationFrame(t => this._loop(t));
  }

  _update(dt) {
    this.scrollCurrent += (this.scrollTarget - this.scrollCurrent) * Math.min(1, dt * 12);

    if (this.shakeI > 0) {
      this.shakeX = (Math.random() - 0.5) * this.shakeI;
      this.shakeY = (Math.random() - 0.5) * this.shakeI;
      this.shakeI *= 0.88;
      if (this.shakeI < 0.3) { this.shakeI = 0; this.shakeX = 0; this.shakeY = 0; }
    }

    if (this.flashAlpha > 0) {
      this.flashAlpha -= dt * 3.5;
      if (this.flashAlpha < 0) this.flashAlpha = 0;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vx *= (1 - 1.5 * dt); // air resistance
      p.x += p.vx * dt * 60; p.y += p.vy * dt * 60; p.vy += 2.0 * dt * 60;
      if (p.rotation !== undefined) p.rotation += p.spin * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.radius += (r.maxRadius - r.radius) * dt * 6;
      r.life -= dt;
      if (r.life <= 0) this.rings.splice(i, 1);
    }

    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      const prog = 1 - f.life / f.maxLife;
      f.y -= dt * 45 * (1 - prog * 0.6); // decelerate as it rises
      f.life -= dt;
      if (f.life <= 0) this.floatTexts.splice(i, 1);
    }

    // Ambient floating particles
    if (Math.random() < dt * 2) this._spawnAmbientParticles();
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

    const biome = getBiome(this.depth);
    // Gradient background instead of flat
    const bgGrd = ctx.createLinearGradient(0, 0, 0, h);
    bgGrd.addColorStop(0, biome.bg1);
    bgGrd.addColorStop(1, biome.bg2);
    ctx.fillStyle = bgGrd;
    ctx.fillRect(-20, -20, w + 40, h + 40);

    // Subtle vignette overlay
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.9);
    vig.addColorStop(0, 'transparent');
    vig.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vig;
    ctx.fillRect(-20, -20, w + 40, h + 40);

    this._renderLayers();
    this._renderParticles();
    this._renderFloatTexts();

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

    // Combo meter bar at bottom of canvas
    if (this.combo >= 2 && this.running) {
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
      // Combo count label
      ctx.globalAlpha = 0.8;
      ctx.font = '700 9px Inter, sans-serif';
      ctx.fillStyle = meterColor;
      ctx.textAlign = 'right';
      ctx.fillText(`${this.combo}x`, w - 22, h - 8);
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
        const d = i * DEPTH_PER_DIG;
        const b = getBiome(d);
        ctx.fillStyle = b.bg1;
        ctx.fillRect(0, sy, w, LAYER_H);
        const darkn = Math.min(0.65, (i - this.currentIndex) * 0.08);
        ctx.fillStyle = `rgba(0,0,0,${darkn})`;
        ctx.fillRect(0, sy, w, LAYER_H);
        ctx.strokeStyle = 'rgba(255,255,255,0.015)';
        ctx.beginPath(); ctx.moveTo(0, sy + LAYER_H); ctx.lineTo(w, sy + LAYER_H); ctx.stroke();
      }
    }
  }

  _renderLayer(layer, sy, index) {
    const ctx = this.ctx;
    const w = this.w;
    const biome = getBiome(layer.depth);
    const isCurrent = index === this.currentIndex;

    if (!layer.revealed) {
      ctx.fillStyle = biome.bg1;
      ctx.fillRect(0, sy, w, LAYER_H);

      const seed = layer.index * 137 + 42;
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      for (let j = 0; j < 6; j++) {
        const rx = ((seed * (j + 1) * 7 + 11) % 200) / 200 * w;
        const ry = ((seed * (j + 1) * 13 + 7) % 100) / 100 * LAYER_H;
        const rs = 2 + ((seed * (j + 1) * 3) % 8);
        ctx.beginPath(); ctx.arc(rx, sy + ry, rs, 0, Math.PI * 2); ctx.fill();
      }

      if (isCurrent && this.running) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        ctx.strokeStyle = `rgba(240,192,64,${0.25 + pulse * 0.45})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(1, sy + 1, w - 2, LAYER_H - 2);
        ctx.fillStyle = `rgba(240,192,64,${0.35 + pulse * 0.45})`;
        ctx.font = '700 12px Inter, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⛏️  TAP TO DIG', w / 2, sy + LAYER_H / 2);
      }

      if (index > this.currentIndex) {
        const fog = Math.min(0.75, (index - this.currentIndex) * 0.12);
        ctx.fillStyle = `rgba(0,0,0,${fog})`;
        ctx.fillRect(0, sy, w, LAYER_H);
      }
    } else {
      const vis = TILE_VIS[layer.type];
      ctx.fillStyle = layer.type === 'dynamite' ? '#150404' : biome.bg2;
      ctx.fillRect(0, sy, w, LAYER_H);

      if (vis.glow && layer.type !== 'rock') {
        const grd = ctx.createRadialGradient(w / 2, sy + LAYER_H / 2, 0, w / 2, sy + LAYER_H / 2, LAYER_H * 2.2);
        grd.addColorStop(0, vis.color + '44');
        grd.addColorStop(0.4, vis.color + '18');
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(0, sy, w, LAYER_H);
        // Pulsing glow for high-value items
        if (layer.value >= 20) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
          ctx.globalAlpha = pulse * 0.12;
          ctx.fillStyle = vis.color;
          ctx.fillRect(0, sy, w, LAYER_H);
          ctx.globalAlpha = 1;
        }
      }

      if (layer.type === 'dynamite') {
        ctx.fillStyle = 'rgba(255,40,40,0.08)';
        ctx.fillRect(0, sy, w, LAYER_H);
      }

      if (vis.icon) {
        ctx.font = '22px serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(vis.icon, w / 2, sy + LAYER_H / 2);
      }

      if (layer.value > 0) {
        ctx.font = '700 10px Inter, sans-serif';
        ctx.fillStyle = vis.color;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + layer.value, w / 2 + 20, sy + LAYER_H / 2 + 1);
      }

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

      const m = getMultiplier(layer.depth);
      if (m > 1) {
        ctx.font = '600 9px Inter, sans-serif';
        ctx.fillStyle = 'rgba(240,192,64,0.3)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`×${m}`, 6, sy + 4);
      }

      // Biome transition label
      if (layer.index > 0) {
        const prevD = (layer.index - 1) * DEPTH_PER_DIG;
        const curB = getBiome(layer.depth);
        if (getBiome(prevD).name !== curB.name) {
          ctx.font = '700 9px Inter, sans-serif';
          ctx.fillStyle = curB.accent;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText('━━ ' + curB.name + ' ━━', w / 2, sy + 3);
        }
      }
    }

    // Grid line
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, sy + LAYER_H); ctx.lineTo(w, sy + LAYER_H); ctx.stroke();

    // Dig anim crack lines
    if (this.digAnim && this.digAnim.index === index) {
      const elapsed = performance.now() - this.digAnim.startTime;
      const p = Math.min(1, elapsed / DIG_ANIM_MS);
      if (p < 0.7) {
        const crackP = p / 0.7;
        ctx.strokeStyle = `rgba(255,255,255,${crackP * 0.5})`;
        ctx.lineWidth = 2;
        const cx = w / 2, cy = sy + LAYER_H / 2;
        for (let c = 0; c < 6; c++) {
          const angle = (c / 6) * Math.PI * 2 + layer.index * 0.5;
          const len = crackP * LAYER_H * 0.7;
          ctx.beginPath(); ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
          ctx.stroke();
        }
      }
    }
  }

  _renderParticles() {
    const ctx = this.ctx;
    // Ambient particles (behind everything)
    for (const a of this.ambientParticles) {
      const la = Math.max(0, Math.min(1, a.life / a.maxLife));
      ctx.globalAlpha = a.alpha * la;
      ctx.fillStyle = a.color;
      const camY = this.scrollCurrent - this.h * CAMERA_RATIO;
      ctx.beginPath(); ctx.arc(a.x, a.y - camY, a.size, 0, Math.PI * 2); ctx.fill();
    }
    // Expanding rings
    for (const r of this.rings) {
      const a = Math.max(0, r.life / r.maxLife);
      ctx.globalAlpha = a * 0.4;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2 * a;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2); ctx.stroke();
    }
    // Main particles
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const sz = p.size * (0.3 + a * 0.7);
      if (p.shape === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation || 0);
        ctx.beginPath();
        for (let j = 0; j < 5; j++) {
          const ang = (j * 4 * Math.PI) / 5 - Math.PI / 2;
          const method = j === 0 ? 'moveTo' : 'lineTo';
          ctx[method](Math.cos(ang) * sz, Math.sin(ang) * sz);
        }
        ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, sz, 0, Math.PI * 2); ctx.fill();
      }
      // Glow trail
      if (a > 0.3) {
        ctx.globalAlpha = a * 0.15;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz * 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderFloatTexts() {
    const ctx = this.ctx;
    for (const f of this.floatTexts) {
      const a = Math.max(0, Math.min(1, f.life / f.maxLife));
      const prog = 1 - f.life / f.maxLife;
      // Scale: pop in then settle
      const scale = prog < 0.15 ? 0.5 + (prog / 0.15) * 0.7 : 1.2 - prog * 0.25;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.scale(scale, scale);
      ctx.font = `800 ${f.size}px Inter, sans-serif`;
      ctx.fillStyle = f.color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = f.color + '80';
      ctx.shadowBlur = 12;
      ctx.fillText(f.text, 0, 0);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4;
      ctx.fillText(f.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  _layerScreenY(layerIndex) {
    const camY = this.scrollCurrent - this.h * CAMERA_RATIO;
    return layerIndex * LAYER_H - camY;
  }

  _spawnParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 2 + Math.random() * 5;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        life: 0.4 + Math.random() * 0.6,
        maxLife: 0.9,
        size: 2 + Math.random() * 4,
        color,
        shape: Math.random() > 0.5 ? 'star' : 'circle',
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 8,
      });
    }
  }

  _spawnRing(x, y, color) {
    this.rings.push({ x, y, color, radius: 5, maxRadius: 120, life: 0.6, maxLife: 0.6 });
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
    this.floatTexts.push({ x, y, text, color, size: size || 16, life: 1.3, maxLife: 1.3 });
  }

  _flash(color) {
    this.flashColor = color;
    this.flashAlpha = 1;
  }
}

window.GoldPotGame = GoldPotGame;

})();
