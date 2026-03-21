const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Headers ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ─── HTTPS Redirect (production) ────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// ─── Rate Limiter ───────────────────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const key = ip + ':' + req.path;
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || now > entry.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Clean up stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, 300000);

// ─── Input Sanitizer ────────────────────────────────────────────────────────
function sanitizeString(str, maxLen = 30) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"'/]/g, '').trim().slice(0, maxLen);
}

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory Store ────────────────────────────────────────────────────────
const state = {
  pots: {
    mini:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 2500,  round: 1, winner: null, label: 'MINI POT',  color: '#60c0ff', deadline: Date.now() + 2 * 3600000 },
    gold:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 10000, round: 1, winner: null, label: 'GOLD POT',  color: '#f0c040', deadline: Date.now() + 6 * 3600000 },
    mega:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 50000, round: 1, winner: null, label: 'MEGA POT',  color: '#ff6090', deadline: Date.now() + 24 * 3600000 },
  },
  houseCut: 0.18,
  players: new Map(),
  recentWinners: [],
  onlineCount: 0,
  liveFeed: [],
  leaderboard: [],
  analytics: [],
  bundles: {
    1:  { price: 100,  label: '$1',   savings: null },
    5:  { price: 400,  label: '$4',   savings: '20% OFF' },
    10: { price: 700,  label: '$7',   savings: '30% OFF' },
    25: { price: 1500, label: '$15',  savings: '40% OFF' },
    50: { price: 2500, label: '$25',  savings: '50% OFF' },
    100: { price: 4000, label: '$40', savings: '60% OFF' },
  },
};

function trackEvent(event, data = {}) {
  state.analytics.unshift({ event, ...data, timestamp: Date.now() });
  if (state.analytics.length > 1000) state.analytics.pop();
}

function getAnalyticsSummary(hours = 24) {
  const cutoff = Date.now() - hours * 3600000;
  const events = state.analytics.filter(e => e.timestamp >= cutoff);
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;
  return { hours, totalEvents: events.length, counts, latest: events.slice(0, 40) };
}

setInterval(() => {
  const base = Math.max(80, getTotalEntries() * 2);
  state.onlineCount = base + Math.floor(Math.random() * 300);
}, 5000);
state.onlineCount = 234;

// ─── Fake Names Pool ────────────────────────────────────────────────────────
const FAKE_NAMES = [
  'Jake_TX', 'SarahNYC', 'Mike_LA', 'EmmaChicago', 'Chris_FL',
  'Ava_OH', 'LiamATL', 'Sophia_WA', 'NoahDEN', 'OliviaAZ',
  'Ethan_OR', 'MiaPHL', 'DanielNC', 'IsabellaMA', 'MatthewTN',
  'AmandaMI', 'JoseCA', 'EmilyNV', 'TylerGA', 'BrooklynNJ',
  'QuinnUT', 'RyanVA', 'ZoeyCO', 'MasonPA', 'HarperMN',
  'LucasIN', 'LilyMO', 'LoganSC', 'ChloeAL', 'JacksonWI',
];
const FAKE_LEVELS = [
  { level: 0, name: 'STARTER', icon: '🪙', color: '#888' },
  { level: 1, name: 'BRONZE', icon: '🥉', color: '#d0a060' },
  { level: 2, name: 'SILVER', icon: '🥈', color: '#c0c0d0' },
  { level: 3, name: 'GOLD', icon: '🥇', color: '#f0c040' },
];
function pickFakeName() { return FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)]; }
function pickFakeLevel() { return FAKE_LEVELS[Math.floor(Math.random() * FAKE_LEVELS.length)]; }

// ─── Pre-Seed Pots & Activity ───────────────────────────────────────────────
(function seedActivity() {
  // Pre-fill pots so they don't look empty
  state.pots.mini.pot = 800 + crypto.randomInt(0, 600); // $8-$14
  state.pots.gold.pot = 2500 + crypto.randomInt(0, 3000); // $25-$55
  state.pots.mega.pot = 8000 + crypto.randomInt(0, 15000); // $80-$230
  state.pots.mini.totalEntries = 38 + crypto.randomInt(0, 40);
  state.pots.gold.totalEntries = 120 + crypto.randomInt(0, 100);
  state.pots.mega.totalEntries = 45 + crypto.randomInt(0, 60);

  // Pre-seed live feed
  const feedTypes = ['play', 'join', 'daily', 'wheel'];
  for (let i = 0; i < 12; i++) {
    const name = pickFakeName();
    const type = feedTypes[crypto.randomInt(0, feedTypes.length)];
    const pot = ['MINI POT', 'GOLD POT', 'MEGA POT'][crypto.randomInt(0, 3)];
    const ev = { type, name, timestamp: Date.now() - crypto.randomInt(0, 300000) };
    if (type === 'play') { ev.pot = pot; ev.qty = [1,1,5,10][crypto.randomInt(0,4)]; ev.type = 'play'; }
    if (type === 'daily') { ev.streak = crypto.randomInt(1, 12); ev.bonus = crypto.randomInt(1, 4); }
    if (type === 'wheel') { ev.prize = ['1 Free Entry', '2 Free Entries', '5 Free Entries!', '2x Next Play'][crypto.randomInt(0, 4)]; }
    state.liveFeed.push(ev);
  }

  // Pre-seed leaderboard
  for (let i = 0; i < 8; i++) {
    state.leaderboard.push({
      name: pickFakeName(), entries: 80 - i * 8 + crypto.randomInt(0, 10),
      streak: crypto.randomInt(1, 15), level: pickFakeLevel().level, levelInfo: pickFakeLevel(),
    });
  }
  state.leaderboard.sort((a, b) => b.entries - a.entries);

  // Pre-seed recent winners
  const pastWinners = [
    { name: 'Jake_TX', prize: '20.50', pot: 'MINI POT', round: 4 },
    { name: 'SarahNYC', prize: '82.00', pot: 'GOLD POT', round: 2 },
    { name: 'NoahDEN', prize: '410.00', pot: 'MEGA POT', round: 1 },
    { name: 'MiaPHL', prize: '20.50', pot: 'MINI POT', round: 5 },
    { name: 'Chris_FL', prize: '82.00', pot: 'GOLD POT', round: 3 },
  ];
  for (const w of pastWinners) {
    state.recentWinners.push({ ...w, potId: 'gold', timestamp: Date.now() - crypto.randomInt(60000, 3600000) });
  }
})();

// ─── Limited Edition Drop (scarcity) ────────────────────────────────────────
state.limitedDrop = {
  entries: 30, price: 1500, remaining: 50, totalStock: 50,
  label: 'EXCLUSIVE DROP — 30x Entries', resetAt: Date.now() + 2 * 3600000,
};
function ensureLimitedDrop() {
  if (Date.now() > state.limitedDrop.resetAt) {
    const entries = [20, 30, 40, 50][crypto.randomInt(0, 4)];
    const stock = 30 + crypto.randomInt(0, 31);
    const price = Math.round(entries * 70 * 0.7);
    state.limitedDrop = {
      entries, price, remaining: stock, totalStock: stock,
      label: `EXCLUSIVE DROP — ${entries}x Entries`, resetAt: Date.now() + 2 * 3600000,
    };
  }
}

// ─── Simulated Bot Activity (trickle fake entries) ──────────────────────────
setInterval(() => {
  const potKeys = ['mini', 'gold', 'mega'];
  const pk = potKeys[Math.floor(Math.random() * potKeys.length)];
  const potData = state.pots[pk];
  const name = pickFakeName();
  const qty = [1, 1, 1, 5, 10][Math.floor(Math.random() * 5)];
  const cents = qty * 82; // after house cut
  potData.pot += cents;
  potData.totalEntries += qty;
  addFeedEvent('play', { name, pot: potData.label, qty, type: 'premium' });

  // Occasionally add fake leaderboard entries
  const existing = state.leaderboard.find(l => l.name === name);
  if (existing) { existing.entries += qty; }
  else if (state.leaderboard.length < 10) {
    state.leaderboard.push({ name, entries: qty, streak: Math.floor(Math.random() * 8) + 1, level: pickFakeLevel().level, levelInfo: pickFakeLevel() });
  }
  state.leaderboard.sort((a, b) => b.entries - a.entries);
  state.leaderboard = state.leaderboard.slice(0, 10);
}, 8000 + Math.floor(Math.random() * 7000));

// Occasional fake join events
setInterval(() => {
  addFeedEvent('join', { name: pickFakeName() });
}, 15000 + Math.floor(Math.random() * 20000));

// Drain limited stock slowly (scarcity simulation)
setInterval(() => {
  ensureLimitedDrop();
  if (state.limitedDrop.remaining > 3) {
    state.limitedDrop.remaining--;
    addFeedEvent('limited_drop', { name: pickFakeName(), entries: state.limitedDrop.entries, remaining: state.limitedDrop.remaining });
  }
}, 25000 + Math.floor(Math.random() * 35000));

// ─── Diamond Jackpot System ─────────────────────────────────────────────────
const JACKPOT_TIERS = [
  { key: 'silver',   label: '💰 SILVER JACKPOT',   prize: 100000,   threshold: 122000,   color: '#c0c0e0', entryPrice: 200,  duration: 12 * 3600000, weight: 40 },
  { key: 'gold',     label: '🏆 GOLD JACKPOT',     prize: 1000000,  threshold: 1220000,  color: '#f0c040', entryPrice: 300,  duration: 24 * 3600000, weight: 30 },
  { key: 'platinum', label: '⚡ PLATINUM JACKPOT',  prize: 5000000,  threshold: 6100000,  color: '#e0e0f0', entryPrice: 500,  duration: 48 * 3600000, weight: 20 },
  { key: 'diamond',  label: '💎 DIAMOND JACKPOT',   prize: 25000000, threshold: 30500000, color: '#b0e0ff', entryPrice: 500,  duration: 72 * 3600000, weight: 10 },
];

state.jackpot = null;

function pickJackpotTier() {
  const totalW = JACKPOT_TIERS.reduce((s, t) => s + t.weight, 0);
  let r = crypto.randomInt(0, totalW);
  for (const t of JACKPOT_TIERS) { r -= t.weight; if (r < 0) return t; }
  return JACKPOT_TIERS[0];
}

function createJackpot() {
  const tier = pickJackpotTier();
  state.jackpot = {
    tier: tier.key, label: tier.label, prize: tier.prize,
    pot: 0, entries: [], totalEntries: 0,
    deadline: Date.now() + tier.duration,
    threshold: tier.threshold, entryPrice: tier.entryPrice,
    color: tier.color, active: true, winner: null,
  };
  // Pre-seed with fake entries to build excitement
  const seedCount = tier.key === 'diamond' ? 200 : tier.key === 'platinum' ? 150 : tier.key === 'gold' ? 100 : 50;
  const seedPot = Math.floor(tier.threshold * (0.05 + Math.random() * 0.15));
  state.jackpot.pot = seedPot;
  for (let i = 0; i < seedCount; i++) {
    state.jackpot.entries.push({ playerId: 'bot_jp_' + i, timestamp: Date.now() - crypto.randomInt(0, 300000), type: 'bot' });
    state.jackpot.totalEntries++;
  }
  addFeedEvent('jackpot', { label: tier.label, prize: (tier.prize / 100).toFixed(0) });
}

// First jackpot after 3 minutes, then every 30-60 min cycle check
setTimeout(() => {
  createJackpot();
  setInterval(() => {
    if (!state.jackpot || !state.jackpot.active) createJackpot();
  }, 30 * 60000 + Math.floor(Math.random() * 30 * 60000));
}, 3 * 60000);

// Check jackpot expiry every 15 seconds
setInterval(() => {
  if (state.jackpot && state.jackpot.active && Date.now() > state.jackpot.deadline) {
    if (state.jackpot.entries.length > 0) {
      const idx = crypto.randomInt(0, state.jackpot.entries.length);
      const winner = state.jackpot.entries[idx];
      const wp = state.players.get(winner.playerId);
      const name = wp ? wp.name : pickFakeName();
      // Timer expiry: pay out what's actually in the pot, not the fixed prize
      const actualPrize = state.jackpot.pot;
      const prizeDisplay = (actualPrize / 100).toLocaleString('en-US');
      state.jackpot.winner = { name, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
      state.jackpot.active = false;
      if (wp) wp.totalWon += actualPrize;
      state.recentWinners.push({ name, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
      addFeedEvent('jackpot_winner', { name, prize: prizeDisplay, label: state.jackpot.label });
    } else {
      state.jackpot.active = false;
    }
  }
}, 15000);

// Jackpot bot activity — heavier fake entry trickle for excitement
setInterval(() => {
  if (!state.jackpot || !state.jackpot.active) return;
  const name = pickFakeName();
  const qty = [1, 1, 1, 2, 3, 5][Math.floor(Math.random() * 6)];
  const addPot = qty * state.jackpot.entryPrice * (1 - state.houseCut);
  state.jackpot.pot += Math.floor(addPot);
  state.jackpot.totalEntries += qty;
  for (let i = 0; i < qty; i++) {
    state.jackpot.entries.push({ playerId: 'bot_jp_' + Date.now() + '_' + i, timestamp: Date.now(), type: 'bot' });
  }
  addFeedEvent('jackpot_entry', { name, qty, label: state.jackpot.label });

  // Check if threshold reached → draw
  if (state.jackpot.pot >= state.jackpot.threshold) {
    // Draw winner
    const idx = crypto.randomInt(0, state.jackpot.entries.length);
    const winner = state.jackpot.entries[idx];
    const wp = state.players.get(winner.playerId);
    const wname = wp ? wp.name : pickFakeName();
    const prizeDisplay = (state.jackpot.prize / 100).toLocaleString('en-US');
    state.jackpot.winner = { name: wname, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
    state.jackpot.active = false;
    if (wp) wp.totalWon += state.jackpot.prize;
    state.recentWinners.push({ name: wname, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
    addFeedEvent('jackpot_winner', { name: wname, prize: prizeDisplay, label: state.jackpot.label });
  }
}, 12000 + Math.floor(Math.random() * 8000));

// ─── Flash Pot System ───────────────────────────────────────────────────────
state.flashPot = null;

function createFlashPot() {
  const duration = 5 * 60 * 1000; // 5 minutes
  state.flashPot = {
    pot: 0, entries: [], totalEntries: 0,
    deadline: Date.now() + duration, label: '⚡ FLASH POT',
    color: '#ff8040', active: true,
  };
  // Pre-seed with some fake entries
  for (let i = 0; i < 5 + Math.floor(Math.random() * 10); i++) {
    state.flashPot.entries.push({ playerId: 'bot_' + i, timestamp: Date.now(), type: 'bot' });
    state.flashPot.totalEntries++;
  }
  addFeedEvent('flash', { prize: 'growing' });
}

// Create first flash pot after 2 minutes, then every 15-25 min
setTimeout(() => {
  createFlashPot();
  setInterval(() => {
    if (!state.flashPot || !state.flashPot.active) createFlashPot();
  }, 15 * 60000 + Math.floor(Math.random() * 10 * 60000));
}, 2 * 60000);

// Check flash pot expiry every 10 seconds
setInterval(() => {
  if (state.flashPot && state.flashPot.active && Date.now() > state.flashPot.deadline) {
    // Draw flash pot winner
    if (state.flashPot.entries.length > 0) {
      const idx = crypto.randomInt(0, state.flashPot.entries.length);
      const winner = state.flashPot.entries[idx];
      const wp = state.players.get(winner.playerId);
      const name = wp ? wp.name : pickFakeName();
      const prize = (state.flashPot.pot / 100).toFixed(2);
      state.flashPot.winner = { name, prize, timestamp: Date.now() };
      state.flashPot.active = false;
      if (wp) wp.totalWon += state.flashPot.pot;
      state.recentWinners.push({ name, prize, pot: '⚡ FLASH', round: 0, timestamp: Date.now() });
      addFeedEvent('winner', { name, prize, pot: '⚡ FLASH POT' });
    } else {
      state.flashPot.active = false;
    }
  }
}, 10000);

// ─── Helpers ────────────────────────────────────────────────────────────────
function generatePlayerId() { return crypto.randomUUID(); }

function getTotalEntries() {
  return Object.values(state.pots).reduce((s, p) => s + p.totalEntries, 0);
}

function drawWinner(potData) {
  if (potData.entries.length === 0) return null;
  return potData.entries[crypto.randomInt(0, potData.entries.length)];
}

function addFeedEvent(type, data) {
  state.liveFeed.unshift({ type, ...data, timestamp: Date.now() });
  if (state.liveFeed.length > 30) state.liveFeed.pop();
}

function updateLeaderboard() {
  state.leaderboard = Array.from(state.players.values())
    .filter(p => p.totalEntries > 0)
    .sort((a, b) => b.totalEntries - a.totalEntries)
    .slice(0, 10)
    .map(p => ({ name: p.name, entries: p.totalEntries, streak: p.streak, level: p.level, levelInfo: p.levelInfo }));
}

function getPlayerLevel(totalSpent) {
  if (totalSpent >= 50000) return { level: 5, name: 'DIAMOND', icon: '💎', color: '#b0e0ff' };
  if (totalSpent >= 20000) return { level: 4, name: 'PLATINUM', icon: '⚡', color: '#e0e0f0' };
  if (totalSpent >= 10000) return { level: 3, name: 'GOLD', icon: '🥇', color: '#f0c040' };
  if (totalSpent >= 5000)  return { level: 2, name: 'SILVER', icon: '🥈', color: '#c0c0d0' };
  if (totalSpent >= 1000)  return { level: 1, name: 'BRONZE', icon: '🥉', color: '#d0a060' };
  return { level: 0, name: 'STARTER', icon: '🪙', color: '#888' };
}

function updateStreak(player) {
  const now = Date.now();
  const hoursSince = (now - (player.lastPlayedAt || 0)) / 3600000;
  if (hoursSince < 48) {
    const lastDay = new Date(player.lastPlayedAt || 0).toDateString();
    if (lastDay !== new Date(now).toDateString()) player.streak++;
  } else {
    player.streak = player.streakShield ? player.streak : 1;
    player.streakShield = false;
  }
  if (player.streak > player.bestStreak) player.bestStreak = player.streak;
  player.lastPlayedAt = now;
}

function checkAchievements(player, gameScore) {
  const checks = [
    [gameScore >= 50, 'gold_fingers'],
    [player.gamesPlayed >= 100, 'veteran'],
    [player.streak >= 7, 'dedicated'],
    [player.streak >= 30, 'unstoppable'],
    [player.totalSpent >= 10000, 'whale'],
  ];
  for (const [cond, key] of checks) {
    if (cond && !player.achievements.includes(key)) player.achievements.push(key);
  }
}

// ─── Missions System ───────────────────────────────────────────────────────
const MISSION_TEMPLATES = [
  { type: 'play_games', target: 3, label: 'Play 3 games', reward: 2 },
  { type: 'play_games', target: 5, label: 'Play 5 games', reward: 3 },
  { type: 'score_high', target: 30, label: 'Score 30+ in mini-game', reward: 3 },
  { type: 'score_high', target: 50, label: 'Score 50+ in mini-game', reward: 5 },
  { type: 'enter_pots', target: 2, label: 'Enter 2 different pots', reward: 2 },
  { type: 'buy_bundle', target: 5, label: 'Buy a 5x+ bundle', reward: 3 },
  { type: 'watch_ads', target: 3, label: 'Watch 3 ads', reward: 2 },
  { type: 'daily_bonus', target: 1, label: 'Claim daily bonus', reward: 1 },
  { type: 'combo_reach', target: 10, label: 'Get 10x combo', reward: 3 },
  { type: 'share', target: 1, label: 'Share with a friend', reward: 2 },
];

function generateMissions() {
  const shuffled = [...MISSION_TEMPLATES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map(t => ({ ...t, progress: 0, claimed: false }));
}

function ensureMissions(player) {
  const today = new Date().toDateString();
  if (player.missionsDate !== today) {
    player.missions = generateMissions();
    player.missionsDate = today;
  }
}

function updateMissionProgress(player, type, value) {
  if (!player.missions) return;
  for (const m of player.missions) {
    if (m.claimed) continue;
    if (m.type === type) {
      if (type === 'score_high' || type === 'combo_reach' || type === 'enter_pots') {
        m.progress = Math.max(m.progress, value);
      } else {
        m.progress += value;
      }
    }
  }
}

// ─── Milestone System ───────────────────────────────────────────────────────
const MILESTONES = [
  { games: 10,  reward: 3,  label: '10 Games Played' },
  { games: 25,  reward: 5,  label: '25 Games Played' },
  { games: 50,  reward: 8,  label: '50 Games Played' },
  { games: 100, reward: 12, label: '100 Games Played' },
  { games: 250, reward: 20, label: '250 Games Played' },
  { games: 500, reward: 35, label: '500 Games Played' },
];

// ─── Level Thresholds for progress bar ──────────────────────────────────────
const LEVEL_THRESHOLDS = [0, 1000, 5000, 10000, 20000, 50000];

function getLevelProgress(totalSpent) {
  const info = getPlayerLevel(totalSpent);
  const currentIdx = info.level;
  if (currentIdx >= 5) return { ...info, progress: 100, nextThreshold: 50000, currentThreshold: 50000 };
  const currentThreshold = LEVEL_THRESHOLDS[currentIdx];
  const nextThreshold = LEVEL_THRESHOLDS[currentIdx + 1];
  const progress = Math.min(100, Math.round(((totalSpent - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  return { ...info, progress, nextThreshold, currentThreshold };
}

function sanitizePlayer(player) {
  ensureMissions(player);
  // Generate lightning deal if needed
  if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
    player.lightningDeal = generateLightningDeal();
  }
  return {
    ...player,
    yourOdds: Object.fromEntries(
      Object.entries(state.pots).map(([k, p]) => [k, p.totalEntries > 0 ? ((player.entries[k] || 0) / p.totalEntries * 100).toFixed(2) : '0.00'])
    ),
    levelProgress: getLevelProgress(player.totalSpent),
    availableMilestones: MILESTONES.map(m => ({ ...m, unlocked: player.gamesPlayed >= m.games, claimed: player.claimedMilestones.includes(m.games) })),
    powerSurgeActive: player.powerSurgeExpires > Date.now(),
    powerSurgeExpires: player.powerSurgeExpires,
    mysteryBoxCooldown: Math.max(0, 180000 - (Date.now() - (player.lastMysteryBox || 0))),
  };
}

// ─── API Routes ─────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  const pots = {};
  for (const [key, p] of Object.entries(state.pots)) {
    const pctFull = Math.min(100, Math.round((p.pot / p.drawThreshold) * 100));
    pots[key] = { pot: p.pot, potDisplay: (p.pot / 100).toFixed(2), totalEntries: p.totalEntries, round: p.round, drawThreshold: p.drawThreshold, label: p.label, color: p.color, winner: p.winner, deadline: p.deadline, pctFull };
  }
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ pots, onlineCount: state.onlineCount, recentWinners: state.recentWinners.slice(-10), liveFeed: state.liveFeed.slice(0, 15), leaderboard: state.leaderboard, bundles: state.bundles, serverTime: Date.now(), serverPort: activePort, serverUrl, limitedDrop: (ensureLimitedDrop(), { entries: state.limitedDrop.entries, price: state.limitedDrop.price, remaining: state.limitedDrop.remaining, totalStock: state.limitedDrop.totalStock, label: state.limitedDrop.label, resetAt: state.limitedDrop.resetAt }), flashPot: state.flashPot ? { pot: state.flashPot.pot, prize: state.flashPot.pot, totalEntries: state.flashPot.totalEntries, deadline: state.flashPot.deadline, active: state.flashPot.active, label: state.flashPot.label, color: state.flashPot.color, winner: state.flashPot.winner || null } : null, jackpot: state.jackpot ? { tier: state.jackpot.tier, label: state.jackpot.label, prize: state.jackpot.prize, pot: state.jackpot.pot, totalEntries: state.jackpot.totalEntries, deadline: state.jackpot.deadline, threshold: state.jackpot.threshold, entryPrice: state.jackpot.entryPrice, color: state.jackpot.color, active: state.jackpot.active, winner: state.jackpot.winner || null, pctFull: Math.min(100, Math.round((state.jackpot.pot / state.jackpot.threshold) * 100)) } : null });
});

app.post('/api/track-event', rateLimit(10000, 20), (req, res) => {
  const event = sanitizeString(String(req.body.event || ''), 50);
  if (!event) return res.status(400).json({ error: 'Missing event' });
  trackEvent(event, { playerId: req.body.playerId || null, data: req.body.data || {} });
  res.json({ ok: true });
});

app.get('/api/metrics', (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
  res.json(getAnalyticsSummary(hours));
});

app.post('/api/register', rateLimit(60000, 5), (req, res) => {
  const id = generatePlayerId();
  const rawName = sanitizeString(req.body.name, 20);
  const player = {
    id, name: rawName || `Player_${id.slice(0, 6)}`,
    entries: { mini: 0, gold: 0, mega: 0, jackpot: 0 }, totalEntries: 0, freeEntryUsed: {},
    referralCode: id.slice(0, 8).toUpperCase(), referredBy: req.body.referralCode || null, referralCount: 0,
    createdAt: Date.now(), lastPlayedAt: Date.now(), lastDailyBonus: null, lastSpin: null,
    streak: 0, bestStreak: 0, streakShield: false, nextMultiplier: 1,
    totalSpent: 0, totalWon: 0, gamesPlayed: 0, bestScore: 0,
    level: 0, levelInfo: getPlayerLevel(0), achievements: [],
    paymentMethod: null,
    sharesToday: {},  // { 'twitter': '2026-03-21', 'sms': '2026-03-21' }
    lastAdWatch: null, adsWatchedToday: 0,
    vip: false, vipExpires: null, vipTier: null,
    // Missions
    missions: [], missionsDate: null,
    // Milestones
    claimedMilestones: [],
    // Session rewards
    sessionRewardsClaimed: {}, sessionRewardsDate: null,
    // FOMO features
    lastMysteryBox: 0, lightningDeal: null, powerSurgeExpires: 0,
    // First-purchase funnel
    firstPurchaseAt: null,
    starterOfferClaimed: false,
    firstPurchaseBoostUsed: false,
  };
  state.players.set(id, player);

  if (req.body.referralCode) {
    for (const [, p] of state.players) {
      if (p.referralCode === req.body.referralCode) {
        for (let i = 0; i < 2; i++) {
          state.pots.gold.entries.push({ playerId: p.id, timestamp: Date.now(), type: 'referral' });
          state.pots.gold.totalEntries++;
        }
        p.entries.gold += 2; p.totalEntries += 2; p.referralCount++;
        addFeedEvent('referral', { name: p.name });
        break;
      }
    }
  }
  addFeedEvent('join', { name: player.name });
  trackEvent('register_completed', { playerId: player.id, referred: !!player.referredBy });
  res.json({ player: sanitizePlayer(player) });
});

app.post('/api/starter-offer-claim', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.starterOfferClaimed) return res.status(400).json({ error: 'Starter offer already used' });

  const potId = req.body.potId || 'gold';
  const potData = state.pots[potId];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });

  const cost = 249;
  const qty = 3;
  const houseTake = Math.floor(cost * state.houseCut);

  player.totalSpent += cost;
  player.gamesPlayed += 1;
  player.totalEntries += qty;
  player.entries[potId] = (player.entries[potId] || 0) + qty;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  player.starterOfferClaimed = true;
  if (!player.firstPurchaseAt) player.firstPurchaseAt = Date.now();

  potData.pot += cost - houseTake;
  for (let i = 0; i < qty; i++) {
    potData.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'starter_offer' });
  }
  potData.totalEntries += qty;

  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('play', { name: player.name, pot: potData.label, qty, type: 'starter_offer' });
  trackEvent('starter_offer_claimed', { playerId: player.id, potId, cost, qty });

  let winnerDrawn = null;
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(potId);
  res.json({ success: true, qty, cost, player: sanitizePlayer(player), winnerDrawn });
});

app.post('/api/free-entry', rateLimit(60000, 10), (req, res) => {
  const { playerId, potId } = req.body;
  const pot = potId || 'gold';
  const player = state.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  const freeKey = `${pot}_${potData.round}`;
  if (player.freeEntryUsed[freeKey]) return res.status(400).json({ error: 'Free entry already used this round' });

  player.freeEntryUsed[freeKey] = true;
  player.entries[pot] = (player.entries[pot] || 0) + 1;
  player.totalEntries++; player.gamesPlayed++;
  potData.entries.push({ playerId, timestamp: Date.now(), type: 'free' });
  potData.totalEntries++;
  updateStreak(player);
  addFeedEvent('play', { name: player.name, pot: potData.label, type: 'free' });
  res.json({ success: true, player: sanitizePlayer(player) });
});

app.post('/api/premium-entry', (req, res) => {
  const { playerId, quantity, potId, gameScore } = req.body;
  const pot = potId || 'gold';
  const qty = Math.min(Math.max(1, parseInt(quantity) || 1), 50);
  const player = state.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });

  const bundle = state.bundles[qty];
  const totalCents = bundle ? bundle.price : qty * 100;
  const houseTake = Math.floor(totalCents * state.houseCut);
  potData.pot += totalCents - houseTake;

  let bonusEntries = 0;
  if (gameScore >= 50) bonusEntries = 3;
  else if (gameScore >= 30) bonusEntries = 2;
  else if (gameScore >= 15) bonusEntries = 1;

  // Apply multiplier
  const mult = player.nextMultiplier || 1;
  const totalQty = (qty + bonusEntries) * mult;
  player.nextMultiplier = 1;

  player.entries[pot] = (player.entries[pot] || 0) + totalQty;
  player.totalEntries += totalQty; player.totalSpent += totalCents; player.gamesPlayed++;
  if (!player.firstPurchaseAt) player.firstPurchaseAt = Date.now();
  if (gameScore > player.bestScore) player.bestScore = gameScore;

  for (let i = 0; i < totalQty; i++) potData.entries.push({ playerId, timestamp: Date.now(), type: 'premium' });
  potData.totalEntries += totalQty;

  player.levelInfo = getPlayerLevel(player.totalSpent); player.level = player.levelInfo.level;
  updateStreak(player); checkAchievements(player, gameScore); updateLeaderboard();
  addFeedEvent('play', { name: player.name, pot: potData.label, qty: totalQty, type: 'premium' });

  // Mission tracking
  ensureMissions(player);
  updateMissionProgress(player, 'play_games', 1);
  updateMissionProgress(player, 'score_high', gameScore || 0);
  if (qty >= 5) updateMissionProgress(player, 'buy_bundle', 1);
  // Track pots entered today
  const potsEntered = new Set();
  for (const [k] of Object.entries(player.entries)) { if (player.entries[k] > 0) potsEntered.add(k); }
  updateMissionProgress(player, 'enter_pots', potsEntered.size);

  let winnerDrawn = null;
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(pot);

  trackEvent('premium_entry_completed', {
    playerId,
    pot,
    qty,
    totalQty,
    totalCents,
    gameScore: gameScore || 0,
  });

  res.json({ success: true, bonusEntries, multiplier: mult, player: sanitizePlayer(player), potDisplay: (potData.pot / 100).toFixed(2), winnerDrawn });
});

app.post('/api/daily-bonus', rateLimit(60000, 3), (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const today = new Date().toDateString();
  if (player.lastDailyBonus === today) return res.status(400).json({ error: 'Already claimed today' });

  player.lastDailyBonus = today;
  updateStreak(player);
  let bonus = player.streak >= 7 ? 3 : player.streak >= 3 ? 2 : 1;
  // VIP bonus multiplier
  if (player.vip && player.vipExpires > Date.now()) {
    bonus *= (player.vipTier === 'monthly' ? 3 : 2);
  }
  player.entries.gold = (player.entries.gold || 0) + bonus;
  player.totalEntries += bonus;
  for (let i = 0; i < bonus; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'daily' });
  state.pots.gold.totalEntries += bonus;
  addFeedEvent('daily', { name: player.name, streak: player.streak, bonus });
  ensureMissions(player);
  updateMissionProgress(player, 'daily_bonus', 1);
  res.json({ success: true, bonusEntries: bonus, streak: player.streak, player: sanitizePlayer(player) });
});

app.post('/api/spin-wheel', rateLimit(60000, 3), (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const today = new Date().toDateString();
  if (player.lastSpin === today) return res.status(400).json({ error: 'Already spun today' });
  player.lastSpin = today;

  const outcomes = [
    { weight: 30, type: 'entry', value: 1, label: '1 Free Entry' },
    { weight: 25, type: 'entry', value: 2, label: '2 Free Entries' },
    { weight: 15, type: 'entry', value: 3, label: '3 Free Entries' },
    { weight: 10, type: 'entry', value: 5, label: '5 Free Entries!' },
    { weight: 8,  type: 'multiplier', value: 2, label: '2x Next Play' },
    { weight: 5,  type: 'entry', value: 10, label: '10 FREE ENTRIES!' },
    { weight: 4,  type: 'streak_shield', value: 1, label: 'Streak Shield 🛡️' },
    { weight: 3,  type: 'entry', value: 25, label: '🎉 JACKPOT 25 ENTRIES' },
  ];
  const total = outcomes.reduce((s, o) => s + o.weight, 0);
  let r = crypto.randomInt(0, total), result = outcomes[0];
  for (const o of outcomes) { r -= o.weight; if (r < 0) { result = o; break; } }

  if (result.type === 'entry') {
    player.entries.gold = (player.entries.gold || 0) + result.value;
    player.totalEntries += result.value;
    for (let i = 0; i < result.value; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'wheel' });
    state.pots.gold.totalEntries += result.value;
  } else if (result.type === 'multiplier') { player.nextMultiplier = result.value; }
  else if (result.type === 'streak_shield') { player.streakShield = true; }

  addFeedEvent('wheel', { name: player.name, prize: result.label });
  res.json({ success: true, result, player: sanitizePlayer(player) });
});

// ─── Watch Ad for Entry ─────────────────────────────────────────────────
app.post('/api/watch-ad', rateLimit(30000, 5), (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const today = new Date().toDateString();
  if (player.lastAdWatch !== today) { player.lastAdWatch = today; player.adsWatchedToday = 0; }
  const adLimit = (player.vip && player.vipExpires > Date.now()) ? (player.vipTier === 'monthly' ? 15 : 10) : 5;
  if (player.adsWatchedToday >= adLimit) return res.status(400).json({ error: `Max ${adLimit} ad entries per day` });

  player.adsWatchedToday++;
  const pot = req.body.potId || 'gold';
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  player.entries[pot] = (player.entries[pot] || 0) + 1;
  player.totalEntries++;
  potData.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'ad' });
  potData.totalEntries++;
  addFeedEvent('ad', { name: player.name, pot: potData.label });
  ensureMissions(player);
  updateMissionProgress(player, 'watch_ads', 1);
  res.json({ success: true, adsLeft: adLimit - player.adsWatchedToday, adLimit, player: sanitizePlayer(player) });
});

app.post('/api/share-reward', rateLimit(60000, 5), (req, res) => {
  const { playerId, platform } = req.body;
  const allowed = ['twitter', 'sms', 'link'];
  if (!allowed.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
  const player = state.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const today = new Date().toDateString();
  if (player.sharesToday[platform] === today) {
    return res.json({ success: false, alreadyClaimed: true, player: sanitizePlayer(player) });
  }

  player.sharesToday[platform] = today;
  player.entries.gold = (player.entries.gold || 0) + 1;
  player.totalEntries++;
  state.pots.gold.entries.push({ playerId, timestamp: Date.now(), type: 'share' });
  state.pots.gold.totalEntries++;
  addFeedEvent('share', { name: player.name, platform });
  ensureMissions(player);
  updateMissionProgress(player, 'share', 1);
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── VIP Pass ───────────────────────────────────────────────────────────────
const VIP_TIERS = {
  weekly:  { price: 499,  label: '$4.99/week',  duration: 7 * 24 * 3600000, perks: '2x daily bonus, 10 ads/day, streak shield, VIP badge' },
  monthly: { price: 1499, label: '$14.99/month', duration: 30 * 24 * 3600000, perks: '3x daily bonus, 15 ads/day, streak shield, VIP badge, 5 free entries/day' },
};

app.post('/api/vip-subscribe', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const tier = VIP_TIERS[req.body.tier];
  if (!tier) return res.status(400).json({ error: 'Invalid VIP tier' });

  player.vip = true;
  player.vipTier = req.body.tier;
  player.vipExpires = Date.now() + tier.duration;
  player.totalSpent += tier.price;
  player.streakShield = true;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('vip', { name: player.name, tier: req.body.tier });
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── Double Down (post-purchase upsell) ─────────────────────────────────
app.post('/api/double-down', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const pot = req.body.potId || 'gold';
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  const qty = Math.min(Math.max(1, parseInt(req.body.originalQty) || 1), 100);
  const firstPurchaseBoost = req.body.firstPurchaseBoost === true && !player.firstPurchaseBoostUsed;
  const bonusQty = firstPurchaseBoost ? Math.max(1, Math.ceil(qty * 0.2)) : 0;
  const finalQty = qty + bonusQty;

  // Double entries for 50% of original price
  const halfPrice = Math.ceil((state.bundles[qty] ? state.bundles[qty].price : qty * 100) * 0.5);
  const houseTake = Math.floor(halfPrice * state.houseCut);
  potData.pot += halfPrice - houseTake;

  player.entries[pot] = (player.entries[pot] || 0) + finalQty;
  player.totalEntries += finalQty;
  player.totalSpent += halfPrice;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  for (let i = 0; i < finalQty; i++) potData.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'double_down' });
  potData.totalEntries += finalQty;
  if (firstPurchaseBoost) player.firstPurchaseBoostUsed = true;
  updateLeaderboard();
  addFeedEvent('play', { name: player.name, pot: potData.label, qty: finalQty, type: 'double_down' });
  trackEvent('double_down_completed', { playerId: player.id, pot, qty, bonusQty, firstPurchaseBoost, price: halfPrice });

  let winnerDrawn = null;
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(pot);
  res.json({ success: true, qty: finalQty, bonusQty, price: halfPrice, player: sanitizePlayer(player), winnerDrawn });
});

// ─── Jackpot Entry ──────────────────────────────────────────────────────────
app.post('/api/jackpot-entry', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!state.jackpot || !state.jackpot.active) return res.status(400).json({ error: 'No active jackpot' });
  if (Date.now() > state.jackpot.deadline) return res.status(400).json({ error: 'Jackpot expired' });

  const qty = Math.min(Math.max(1, parseInt(req.body.quantity) || 1), 50);
  const totalCents = qty * state.jackpot.entryPrice;
  const houseTake = Math.floor(totalCents * state.houseCut);
  state.jackpot.pot += totalCents - houseTake;

  player.totalSpent += totalCents;
  player.entries.jackpot = (player.entries.jackpot || 0) + qty;
  player.totalEntries += qty;
  player.gamesPlayed++;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;

  for (let i = 0; i < qty; i++) {
    state.jackpot.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'premium' });
  }
  state.jackpot.totalEntries += qty;
  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('jackpot_entry', { name: player.name, qty, label: state.jackpot.label });

  // Check if threshold reached
  let winnerDrawn = null;
  if (state.jackpot.pot >= state.jackpot.threshold) {
    const idx = crypto.randomInt(0, state.jackpot.entries.length);
    const winner = state.jackpot.entries[idx];
    const wp = state.players.get(winner.playerId);
    const name = wp ? wp.name : pickFakeName();
    const prizeDisplay = (state.jackpot.prize / 100).toLocaleString('en-US');
    state.jackpot.winner = { name, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
    state.jackpot.active = false;
    if (wp) wp.totalWon += state.jackpot.prize;
    state.recentWinners.push({ name, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
    addFeedEvent('jackpot_winner', { name, prize: prizeDisplay, label: state.jackpot.label });
    winnerDrawn = state.jackpot.winner;
    // Reset player jackpot entries
    for (const [, p] of state.players) { p.entries.jackpot = 0; }
  }

  res.json({ success: true, totalEntries: state.jackpot.totalEntries, qty, cost: totalCents, player: sanitizePlayer(player), winnerDrawn });
});

// ─── Flash Pot Entry ────────────────────────────────────────────────────────
app.post('/api/flash-entry', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!state.flashPot || !state.flashPot.active) return res.status(400).json({ error: 'No active flash pot' });
  if (Date.now() > state.flashPot.deadline) return res.status(400).json({ error: 'Flash pot expired' });

  const qty = Math.min(Math.max(1, parseInt(req.body.quantity) || 1), 10);
  const isFree = req.body.free === true;
  if (!isFree) {
    // $0.50 per flash entry — 18% house cut, rest goes to pot
    const cost = qty * 50;
    const houseTake = Math.floor(cost * state.houseCut);
    state.flashPot.pot += cost - houseTake;
    player.totalSpent += cost;
    player.levelInfo = getPlayerLevel(player.totalSpent);
    player.level = player.levelInfo.level;
  }

  for (let i = 0; i < qty; i++) {
    state.flashPot.entries.push({ playerId: player.id, timestamp: Date.now(), type: isFree ? 'free' : 'premium' });
  }
  state.flashPot.totalEntries += qty;
  player.totalEntries += qty; player.gamesPlayed++;
  addFeedEvent('flash_entry', { name: player.name, qty });
  res.json({ success: true, totalEntries: state.flashPot.totalEntries, player: sanitizePlayer(player) });
});

app.post('/api/draw', (req, res) => {
  res.json(performDraw(req.body.potId || 'gold'));
});

function performDraw(potId) {
  const potData = state.pots[potId];
  const entry = drawWinner(potData);
  if (!entry) return { winner: null, nearMisses: [] };
  const wp = state.players.get(entry.playerId);
  const info = { name: wp ? wp.name : 'Anonymous', prize: (potData.pot / 100).toFixed(2), round: potData.round, pot: potData.label, potId, timestamp: Date.now() };
  if (wp) { wp.totalWon += potData.pot; if (!wp.achievements.includes('winner')) wp.achievements.push('winner'); }
  state.recentWinners.push(info); potData.winner = info;
  addFeedEvent('winner', { name: info.name, prize: info.prize, pot: potData.label });

  // Near-miss: find players who were close (had entries but didn't win)
  const nearMisses = [];
  const playerEntryCount = {};
  for (const e of potData.entries) {
    if (e.playerId !== entry.playerId) playerEntryCount[e.playerId] = (playerEntryCount[e.playerId] || 0) + 1;
  }
  const sorted = Object.entries(playerEntryCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [pid, count] of sorted) {
    const p = state.players.get(pid);
    if (p) nearMisses.push({ playerId: pid, name: p.name, entries: count, awayBy: Math.max(1, Math.ceil(count * 0.3)) });
  }

  // Reset pot + set new deadline
  potData.pot = 0; potData.round++; potData.entries = []; potData.totalEntries = 0;
  const deadlines = { mini: 2 * 3600000, gold: 6 * 3600000, mega: 24 * 3600000 };
  potData.deadline = Date.now() + (deadlines[potId] || 6 * 3600000);
  for (const [, p] of state.players) { p.entries[potId] = 0; }
  return { winner: info, nearMisses };
}

app.get('/api/player/:id', (req, res) => {
  const player = state.players.get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json(sanitizePlayer(player));
});

// ─── Payment Method ─────────────────────────────────────────────────────
const VALID_METHODS = ['apple_pay', 'google_pay', 'card', 'cashapp', 'paypal', 'venmo'];
const METHOD_LABELS = {
  apple_pay: { icon: ' Pay', label: 'Apple Pay' },
  google_pay: { icon: 'G Pay', label: 'Google Pay' },
  card: { icon: '💳', label: 'Card' },
  cashapp: { icon: '$', label: 'Cash App' },
  paypal: { icon: 'P', label: 'PayPal' },
  venmo: { icon: 'V', label: 'Venmo' },
};

app.post('/api/payment-method', (req, res) => {
  const { playerId, method, cardLast4 } = req.body;
  const player = state.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });

  const info = { ...METHOD_LABELS[method], method };
  if (method === 'card' && cardLast4) {
    info.label = `Card ····${String(cardLast4).slice(-4)}`;
  }
  player.paymentMethod = info;
  trackEvent('payment_method_saved', { playerId, method });
  res.json({ success: true, paymentMethod: info, player: sanitizePlayer(player) });
});

// ─── Claim Mission Reward ────────────────────────────────────────────────
app.post('/api/claim-mission', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const idx = parseInt(req.body.missionIndex);
  ensureMissions(player);
  if (idx < 0 || idx >= player.missions.length) return res.status(400).json({ error: 'Invalid mission' });
  const m = player.missions[idx];
  if (m.claimed) return res.status(400).json({ error: 'Already claimed' });
  if (m.progress < m.target) return res.status(400).json({ error: 'Not complete yet' });
  m.claimed = true;
  player.entries.gold = (player.entries.gold || 0) + m.reward;
  player.totalEntries += m.reward;
  for (let i = 0; i < m.reward; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'mission' });
  state.pots.gold.totalEntries += m.reward;
  addFeedEvent('mission', { name: player.name, mission: m.label, reward: m.reward });
  res.json({ success: true, reward: m.reward, player: sanitizePlayer(player) });
});

// ─── Claim Milestone Reward ─────────────────────────────────────────────
app.post('/api/claim-milestone', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const games = parseInt(req.body.games);
  const milestone = MILESTONES.find(m => m.games === games);
  if (!milestone) return res.status(400).json({ error: 'Invalid milestone' });
  if (player.gamesPlayed < games) return res.status(400).json({ error: 'Not reached yet' });
  if (player.claimedMilestones.includes(games)) return res.status(400).json({ error: 'Already claimed' });
  player.claimedMilestones.push(games);
  player.entries.gold = (player.entries.gold || 0) + milestone.reward;
  player.totalEntries += milestone.reward;
  for (let i = 0; i < milestone.reward; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'milestone' });
  state.pots.gold.totalEntries += milestone.reward;
  addFeedEvent('milestone', { name: player.name, milestone: milestone.label, reward: milestone.reward });
  res.json({ success: true, reward: milestone.reward, player: sanitizePlayer(player) });
});

// ─── Session Time Reward ────────────────────────────────────────────────
const SESSION_REWARDS = [
  { minutes: 5,  reward: 1,  label: '5 min' },
  { minutes: 15, reward: 2,  label: '15 min' },
  { minutes: 30, reward: 5,  label: '30 min' },
];

app.post('/api/session-reward', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const minutes = parseInt(req.body.minutes);
  const sr = SESSION_REWARDS.find(s => s.minutes === minutes);
  if (!sr) return res.status(400).json({ error: 'Invalid session reward' });
  const today = new Date().toDateString();
  if (player.sessionRewardsDate !== today) { player.sessionRewardsClaimed = {}; player.sessionRewardsDate = today; }
  if (player.sessionRewardsClaimed[minutes]) return res.status(400).json({ error: 'Already claimed' });
  player.sessionRewardsClaimed[minutes] = true;
  player.entries.gold = (player.entries.gold || 0) + sr.reward;
  player.totalEntries += sr.reward;
  for (let i = 0; i < sr.reward; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'session' });
  state.pots.gold.totalEntries += sr.reward;
  res.json({ success: true, reward: sr.reward, label: sr.label, player: sanitizePlayer(player) });
});

// ─── Report combo for missions ──────────────────────────────────────────
app.post('/api/report-combo', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const combo = parseInt(req.body.combo) || 0;
  ensureMissions(player);
  updateMissionProgress(player, 'combo_reach', combo);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── FOMO EXCLUSIVE OFFERS ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── Lightning Deal Generator ───────────────────────────────────────────
function generateLightningDeal() {
  const deals = [
    { qty: 10, normalPrice: 700, label: '10x Entries' },
    { qty: 25, normalPrice: 1500, label: '25x Entries' },
    { qty: 50, normalPrice: 2500, label: '50x Entries' },
    { qty: 100, normalPrice: 4000, label: '100x Entries' },
  ];
  const deal = deals[crypto.randomInt(0, deals.length)];
  const discount = 30 + crypto.randomInt(0, 41); // 30-70% off
  const salePrice = Math.max(100, Math.round(deal.normalPrice * (1 - discount / 100)));
  return { ...deal, discount, salePrice, deadline: Date.now() + 90000, id: crypto.randomUUID() };
}

// ─── 1. MYSTERY BOX ────────────────────────────────────────────────────
const MYSTERY_TIERS = {
  bronze: { price: 300, label: '$3 BRONZE BOX', common: [1,5], rare: [10,25], legendary: [50,50] },
  silver: { price: 500, label: '$5 SILVER BOX', common: [3,10], rare: [15,40], legendary: [75,75] },
  gold:   { price: 1000, label: '$10 GOLD BOX', common: [5,15], rare: [25,60], legendary: [100,100] },
};

app.post('/api/mystery-box', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const tier = MYSTERY_TIERS[req.body.tier];
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (Date.now() - (player.lastMysteryBox || 0) < 180000) {
    const wait = Math.ceil((180000 - (Date.now() - player.lastMysteryBox)) / 1000);
    return res.status(400).json({ error: `Cooldown: ${wait}s remaining` });
  }
  player.lastMysteryBox = Date.now();
  player.totalSpent += tier.price;
  const roll = Math.random();
  let rarity, entries;
  if (roll < 0.05) {
    rarity = 'LEGENDARY'; entries = tier.legendary[0] + crypto.randomInt(0, Math.max(1, tier.legendary[1] - tier.legendary[0] + 1));
  } else if (roll < 0.30) {
    rarity = 'RARE'; entries = tier.rare[0] + crypto.randomInt(0, Math.max(1, tier.rare[1] - tier.rare[0] + 1));
  } else {
    rarity = 'COMMON'; entries = tier.common[0] + crypto.randomInt(0, Math.max(1, tier.common[1] - tier.common[0] + 1));
  }
  player.entries.gold = (player.entries.gold || 0) + entries;
  player.totalEntries += entries;
  for (let i = 0; i < entries; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'mystery' });
  state.pots.gold.totalEntries += entries;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  const houseTake = Math.floor(tier.price * state.houseCut);
  state.pots.gold.pot += (tier.price - houseTake);
  addFeedEvent('mystery_box', { name: player.name, rarity, entries, tier: tier.label });
  let winnerDrawn = null;
  if (state.pots.gold.pot >= state.pots.gold.drawThreshold) winnerDrawn = performDraw('gold');
  res.json({ success: true, rarity, entries, tier: tier.label, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 2. LIGHTNING DEAL ──────────────────────────────────────────────────
app.post('/api/lightning-deal', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
    player.lightningDeal = generateLightningDeal();
  }
  res.json({ deal: player.lightningDeal });
});

app.post('/api/lightning-buy', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
    return res.status(400).json({ error: 'Deal expired! New one coming...' });
  }
  const deal = player.lightningDeal;
  const qty = deal.qty;
  const cost = deal.salePrice;
  const potId = req.body.potId || 'gold';
  const pot = state.pots[potId];
  if (!pot) return res.status(400).json({ error: 'Invalid pot' });
  const houseTake = Math.floor(cost * state.houseCut);
  player.totalSpent += cost;
  player.entries[potId] = (player.entries[potId] || 0) + qty;
  player.totalEntries += qty;
  player.gamesPlayed += qty;
  for (let i = 0; i < qty; i++) pot.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'lightning' });
  pot.totalEntries += qty;
  pot.pot += (cost - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  player.lightningDeal = null;
  addFeedEvent('lightning', { name: player.name, qty, discount: deal.discount });
  let winnerDrawn = null;
  if (pot.pot >= pot.drawThreshold) winnerDrawn = performDraw(potId);
  res.json({ success: true, qty, cost, discount: deal.discount, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 3. POWER SURGE (2x for 1 hour) ─────────────────────────────────────
app.post('/api/power-surge', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.powerSurgeExpires > Date.now()) return res.status(400).json({ error: 'Power Surge already active!' });
  const cost = 299;
  player.totalSpent += cost;
  player.powerSurgeExpires = Date.now() + 3600000;
  player.nextMultiplier = Math.max(player.nextMultiplier || 1, 2);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('power_surge', { name: player.name });
  res.json({ success: true, expires: player.powerSurgeExpires, player: sanitizePlayer(player) });
});

// ─── 4. STREAK SAVER ────────────────────────────────────────────────────
app.post('/api/streak-saver', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.streak < 3) return res.status(400).json({ error: 'Streak too low (need 3+)' });
  if (player.streakShield) return res.status(400).json({ error: 'Streak already protected!' });
  const cost = 199;
  player.totalSpent += cost;
  player.streakShield = true;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── 5. ALL-IN PACK ─────────────────────────────────────────────────────
app.post('/api/all-in-pack', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  const cost = 500;
  const entriesPerPot = 5;
  const houseTake = Math.floor(cost * state.houseCut);
  const netPerPot = Math.floor((cost - houseTake) / 3);
  player.totalSpent += cost;
  for (const potId of ['mini', 'gold', 'mega']) {
    player.entries[potId] = (player.entries[potId] || 0) + entriesPerPot;
    player.totalEntries += entriesPerPot;
    const p = state.pots[potId];
    for (let i = 0; i < entriesPerPot; i++) p.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'allin' });
    p.totalEntries += entriesPerPot;
    p.pot += netPerPot;
  }
  player.gamesPlayed += 15;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('all_in', { name: player.name });
  let draws = {};
  for (const potId of ['mini', 'gold', 'mega']) {
    if (state.pots[potId].pot >= state.pots[potId].drawThreshold) draws[potId] = performDraw(potId);
  }
  res.json({ success: true, totalEntries: 15, cost, player: sanitizePlayer(player), draws });
});

// ─── 6. LIMITED EDITION DROP ─────────────────────────────────────────────
app.post('/api/limited-buy', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  ensureLimitedDrop();
  if (state.limitedDrop.remaining <= 0) return res.status(400).json({ error: 'SOLD OUT! Next drop coming soon...' });
  const drop = state.limitedDrop;
  state.limitedDrop.remaining--;
  const cost = drop.price;
  const qty = drop.entries;
  const houseTake = Math.floor(cost * state.houseCut);
  player.totalSpent += cost;
  player.entries.gold = (player.entries.gold || 0) + qty;
  player.totalEntries += qty;
  player.gamesPlayed += qty;
  for (let i = 0; i < qty; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'limited' });
  state.pots.gold.totalEntries += qty;
  state.pots.gold.pot += (cost - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('limited_drop', { name: player.name, entries: qty, remaining: state.limitedDrop.remaining });
  let winnerDrawn = null;
  if (state.pots.gold.pot >= state.pots.gold.drawThreshold) winnerDrawn = performDraw('gold');
  res.json({ success: true, entries: qty, cost, remaining: state.limitedDrop.remaining, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 7. MEGA MULTIPLIER (rare offer) ────────────────────────────────────
app.post('/api/mega-multiplier', (req, res) => {
  const player = state.players.get(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  const cost = 499;
  player.totalSpent += cost;
  player.nextMultiplier = 5;
  player.powerSurgeExpires = Math.max(player.powerSurgeExpires || 0, Date.now() + 1800000); // 30 min
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('mega_mult', { name: player.name });
  res.json({ success: true, multiplier: 5, expires: player.powerSurgeExpires, player: sanitizePlayer(player) });
});

// ─── Legal Pages ────────────────────────────────────────────────────────────
const legalPage = (title, content) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — GoldPot</title><link rel="stylesheet" href="/css/style.css"><style>body{padding:20px;max-width:700px;margin:0 auto}.legal-back{color:var(--gold);text-decoration:none;font-size:0.85rem}.legal-back:hover{text-decoration:underline}h1{font-family:var(--font-display);color:var(--gold);font-size:1.5rem;margin:20px 0 16px}h2{color:var(--white);font-size:1rem;margin:18px 0 8px}p,li{font-size:0.82rem;line-height:1.6;color:var(--text2);margin-bottom:8px}ul{padding-left:20px}</style></head><body><a href="/" class="legal-back">← Back to GoldPot</a>${content}<p style="margin-top:30px;font-size:0.7rem;color:var(--text3)">Last updated: March 2026 · © 2026 GoldPot Inc.</p></body></html>`;

app.get('/rules', (req, res) => {
  res.send(legalPage('Official Rules', `
    <h1>OFFICIAL RULES</h1>
    <h2>1. Eligibility</h2><p>Open to legal residents of the 50 United States and D.C., 18 years of age or older. Void where prohibited by law.</p>
    <h2>2. No Purchase Necessary</h2><p>A purchase will NOT increase your chances of winning. Free method of entry available via the "FREE ENTRY" button.</p>
    <h2>3. Entry Period</h2><p>Each pot round begins when the previous round ends and continues until the pot reaches its draw threshold or the countdown timer expires.</p>
    <h2>4. How to Enter</h2>
    <ul><li><b>Free Entry:</b> One free entry per pot per round via the Free Entry button.</li><li><b>Premium Entry:</b> Play the Deep Gold mini-game for $1 per entry (bundle discounts available).</li><li><b>Bonus Entries:</b> Earned via daily login, spin wheel, ad viewing, referrals, and session rewards.</li></ul>
    <h2>5. Drawing & Winner Selection</h2><p>Winners are selected by computerized random drawing from all eligible entries. Each entry has an equal chance of being selected regardless of entry method.</p>
    <h2>6. Prizes</h2><p>Prize amounts vary by pot type. The prize equals the total pot value after the 18% operational fee. Prizes over $600 are subject to IRS reporting (Form 1099).</p>
    <h2>7. Winner Notification</h2><p>Winners will be notified via the platform and must provide valid identification and tax information to claim prizes.</p>
    <h2>8. General Conditions</h2><p>Sponsor reserves the right to cancel, suspend, or modify the sweepstakes if fraud or technical issues compromise integrity.</p>
    <h2>9. Sponsor</h2><p>GoldPot Inc. · Contact: support@goldpot.com</p>
  `));
});

app.get('/privacy', (req, res) => {
  res.send(legalPage('Privacy Policy', `
    <h1>PRIVACY POLICY</h1>
    <h2>Information We Collect</h2><p>We collect your display name, gameplay activity, and payment method selection. We do not store credit card numbers or bank information directly.</p>
    <h2>How We Use Information</h2>
    <ul><li>To operate the sweepstakes and determine winners</li><li>To personalize your experience (streaks, levels, achievements)</li><li>To communicate with winners about prize fulfillment</li><li>To prevent fraud and enforce our terms</li></ul>
    <h2>Data Sharing</h2><p>We do not sell your personal information. We may share data with payment processors to complete transactions and with law enforcement if required by law.</p>
    <h2>Data Retention</h2><p>Account data is retained while your account is active. You may request deletion by contacting support@goldpot.com.</p>
    <h2>Children's Privacy</h2><p>GoldPot is not intended for anyone under 18. We do not knowingly collect information from minors.</p>
    <h2>Contact</h2><p>Questions about this policy: support@goldpot.com</p>
  `));
});

app.get('/terms', (req, res) => {
  res.send(legalPage('Terms of Service', `
    <h1>TERMS OF SERVICE</h1>
    <h2>1. Acceptance</h2><p>By using GoldPot, you agree to these terms. If you do not agree, do not use the service.</p>
    <h2>2. Eligibility</h2><p>You must be 18 years or older and a US resident to use GoldPot. By creating an account, you confirm you meet these requirements.</p>
    <h2>3. Account</h2><p>You are responsible for maintaining your account security. Each person may only maintain one account.</p>
    <h2>4. Payments & Refunds</h2><p>All purchases are final. Entry fees are non-refundable. The 18% operational fee funds platform maintenance, prize insurance, and operations.</p>
    <h2>5. Fair Play</h2><p>Automated entries, multiple accounts, collusion, or any form of fraud will result in immediate account termination and forfeiture of entries and prizes.</p>
    <h2>6. Prize Claims</h2><p>Winners must claim prizes within 30 days. Unclaimed prizes are forfeited. Winners are responsible for all applicable taxes.</p>
    <h2>7. Limitation of Liability</h2><p>GoldPot is provided "as is." We are not liable for technical issues, service interruptions, or any indirect damages arising from use of the platform.</p>
    <h2>8. Modifications</h2><p>We may update these terms at any time. Continued use after changes constitutes acceptance.</p>
    <h2>9. Contact</h2><p>support@goldpot.com</p>
  `));
});

// Serve Deep Gold game
app.get('/goldmine', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'goldmine.html')); });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

let activePort = Number(PORT) || 3000;
let server;

function startServer(port) {
  server = app.listen(port, '0.0.0.0', () => {
    activePort = port;
    console.log(`\n  🏆 GOLDPOT is live on port ${activePort}\n`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.log(`\n  ⚠️ Port ${port} is busy, trying ${nextPort}...\n`);
      setTimeout(() => startServer(nextPort), 200);
      return;
    }
    throw err;
  });
}

startServer(activePort);
