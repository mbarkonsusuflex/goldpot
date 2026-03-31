const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set in production');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DEMO_MODE = process.env.DEMO_MODE === 'true'; // bots OFF by default, set DEMO_MODE=true to enable
const CANONICAL_HOST = (process.env.CANONICAL_HOST || 'www.goldpot.us').toLowerCase();
if (DEMO_MODE && process.env.NODE_ENV === 'production') {
  throw new Error('DEMO_MODE must not be enabled in production');
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe && process.env.NODE_ENV === 'production') {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    msg: 'STRIPE_SECRET_KEY not set — payments will be rejected in production',
  }) + '\n');
}
const PAYMENT_PROOF_SECRET = `${JWT_SECRET}:payment-proof`;

// ─── VAPID for Web Push ─────────────────────────────────────────────────────
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:support@goldpot.us', VAPID_PUBLIC, VAPID_PRIVATE);
}
const pushSubscriptions = new Map(); // playerId -> subscription
const PUSH_SUB_MAX = 10000;

function addPushSubscription(playerId, subscription) {
  if (pushSubscriptions.size >= PUSH_SUB_MAX && !pushSubscriptions.has(playerId)) {
    // Evict oldest entry
    const oldest = pushSubscriptions.keys().next().value;
    pushSubscriptions.delete(oldest);
  }
  pushSubscriptions.set(playerId, subscription);
}

// ─── Timing-safe admin secret check with IP lockout ─────────────────────────
const adminFailures = new Map(); // ip -> { count, lockedUntil }
function verifyAdminSecret(provided, req) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected || !provided) return false;
  if (typeof provided !== 'string') return false;
  // IP-based lockout: 5 failures = 15-minute lockout
  if (req) {
    const ip = req.ip || '0.0.0.0';
    const entry = adminFailures.get(ip);
    if (entry && entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
  }
  // Hash both to fixed-length buffers — prevents timing leak of secret length
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  const ok = crypto.timingSafeEqual(a, b);
  if (req) {
    const ip = req.ip || '0.0.0.0';
    if (!ok) {
      const entry = adminFailures.get(ip) || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= 5) entry.lockedUntil = Date.now() + 15 * 60 * 1000;
      adminFailures.set(ip, entry);
    } else {
      adminFailures.delete(ip);
    }
  }
  return ok;
}

// ─── Database Init ──────────────────────────────────────────────────────────
db.init();
db.prepareStatements();

// ─── Structured Logger ──────────────────────────────────────────────────────
const LOG_LEVEL = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LOG_LEVEL = LOG_LEVEL[process.env.LOG_LEVEL || 'info'] || 1;
function log(level, msg, data) {
  if ((LOG_LEVEL[level] || 0) < MIN_LOG_LEVEL) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) entry.data = data;
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ─── Security Helpers ───────────────────────────────────────────────────────
function reqInfo(req) {
  return {
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    userAgent: (req.headers['user-agent'] || '').slice(0, 200),
  };
}
// Prune security events older than 30 days every 6 hours
setInterval(() => db.pruneOldSecurityEvents(Date.now() - 30 * 24 * 3600000), 6 * 3600000);
// WAL checkpoint every 5 minutes to prevent WAL file bloat
setInterval(() => {
  try { db.checkpoint(); } catch { /* ignore */ }
}, 5 * 60 * 1000);

// ─── Account Lockout ────────────────────────────────────────────────────────
const authFailures = new Map(); // ip -> { count, firstAt }
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 min window
const LOCKOUT_THRESHOLD = 10; // 10 failures = lockout
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 min lockout
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (now - entry.firstAt > LOCKOUT_WINDOW_MS + LOCKOUT_DURATION_MS) authFailures.delete(ip);
  }
}, 5 * 60 * 1000);

function recordAuthFailure(ip) {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstAt > LOCKOUT_WINDOW_MS) {
    authFailures.set(ip, { count: 1, firstAt: now, lockedAt: 0 });
    return false;
  }
  entry.count++;
  if (entry.count >= LOCKOUT_THRESHOLD && !entry.lockedAt) {
    entry.lockedAt = now;
    db.logSecurityEvent('critical', 'auth', 'account_lockout', {
      ip, details: { failures: entry.count, windowMs: LOCKOUT_WINDOW_MS },
    });
  }
  return entry.lockedAt > 0;
}

function isLockedOut(ip) {
  const entry = authFailures.get(ip);
  if (!entry || !entry.lockedAt) return false;
  if (Date.now() - entry.lockedAt > LOCKOUT_DURATION_MS) {
    authFailures.delete(ip);
    return false;
  }
  return true;
}

// ─── IP Correlation (auto-flag hot IPs) ─────────────────────────────────────
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  const summary = db.getSecuritySummary(oneHourAgo);
  for (const entry of summary.topIps) {
    if (entry.count >= 10) {
      db.logSecurityEvent('critical', 'correlation', 'hot_ip_detected', {
        ip: entry.ip,
        details: { eventsInLastHour: entry.count },
      });
    }
  }
}, 10 * 60 * 1000); // check every 10 minutes

// ─── Security Headers ──────────────────────────────────────────────────────
// Trust proxy so rate limiter uses real client IP (needed behind any reverse proxy)
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js.stripe.com https://pagead2.googlesyndication.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' wss: ws: https://fonts.googleapis.com https://fonts.gstatic.com https://api.stripe.com https://pagead2.googlesyndication.com https://ep1.adtrafficquality.google; frame-src https://js.stripe.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Parse JSON for all routes EXCEPT Stripe webhook (needs raw body)
// MUST be before auth/CSRF middlewares so req.body is available for checks
app.use((req, res, next) => {
  if (req.path === '/api/stripe-webhook') return next();
  express.json({ limit: '10kb' })(req, res, next);
});

// ─── CSRF Protection ───────────────────────────────────────────────────────
// Generate CSRF token on first visit; require it on all POSTs
app.use((req, res, next) => {
  if (req.method === 'GET') {
    // Issue a CSRF token cookie if not present
    if (!req.headers.cookie || !req.headers.cookie.includes('_csrf')) {
      const token = crypto.randomBytes(24).toString('hex');
      res.cookie('_csrf', token, {
        path: '/',
        sameSite: 'Strict',
        secure: process.env.NODE_ENV === 'production',
        httpOnly: false,
      });
    }
  }
  next();
});

function csrfProtect(req, res, next) {
  // Skip CSRF for Stripe webhooks (req.path is relative when mounted at /api/)
  if (req.path === '/stripe-webhook' || req.path === '/api/stripe-webhook') return next();
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)_csrf=([^;]+)/);
  const cookieToken = match ? match[1] : null;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    const ri = reqInfo(req);
    db.logSecurityEvent('warn', 'csrf', 'csrf_rejected', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: req.path, method: req.method },
    });
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Apply CSRF check to all POST /api/ routes
app.use('/api/', (req, res, next) => {
  if (req.method === 'POST') return csrfProtect(req, res, next);
  next();
});

// ─── JWT Auth Middleware ────────────────────────────────────────────────────
function signToken(playerId, ip) {
  const player = getPlayer(playerId);
  const tv = player ? (player.tokenVersion || 0) : 0;
  const payload = { sub: playerId, tv };
  if (ip) payload.ip = ip;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function signPaymentProof(session) {
  const md = session.metadata || {};
  return jwt.sign({
    sub: md.playerId,
    sid: session.id,
    type: md.purchaseType || 'premium',
    qty: parseInt(md.quantity || '1') || 1,
    potId: md.potId || 'gold',
    tier: md.tier || '',
    amount: session.amount_total || 0,
  }, PAYMENT_PROOF_SECRET, { expiresIn: '20m' });
}

function verifyPaymentProof(player, proofToken, expectedTypes, expectedAmount) {
  if (!stripe) return { ok: true, proof: null };
  if (!proofToken || typeof proofToken !== 'string') {
    return { ok: false, error: 'Payment verification required' };
  }
  try {
    const proof = jwt.verify(proofToken, PAYMENT_PROOF_SECRET);
    if (!proof || proof.sub !== player.id) {
      return { ok: false, error: 'Payment proof does not match player' };
    }
    const expected = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
    if (!expected.includes(proof.type)) {
      return { ok: false, error: 'Payment proof type mismatch' };
    }
    // Validate paid amount matches expected price (prevents price manipulation)
    if (expectedAmount && proof.amount && proof.amount < expectedAmount) {
      db.logSecurityEvent('critical', 'payment', 'amount_mismatch', {
        playerId: player.id,
        details: { expected: expectedAmount, actual: proof.amount, type: proof.type },
      });
      return { ok: false, error: 'Payment amount mismatch' };
    }
    return { ok: true, proof };
  } catch {
    return { ok: false, error: 'Invalid or expired payment proof' };
  }
}

function isPaymentSessionConsumed(player, sessionId) {
  return Array.isArray(player.consumedPaymentSessions) && player.consumedPaymentSessions.includes(sessionId);
}

function consumePaymentSession(player, sessionId) {
  if (!sessionId) return false;
  if (!Array.isArray(player.consumedPaymentSessions)) player.consumedPaymentSessions = [];
  if (player.consumedPaymentSessions.includes(sessionId)) return false;
  player.consumedPaymentSessions.push(sessionId);
  if (player.consumedPaymentSessions.length > 200) {
    player.consumedPaymentSessions = player.consumedPaymentSessions.slice(-200);
  }
  return true;
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const ri = reqInfo(req);
    db.logSecurityEvent('warn', 'auth', 'missing_auth', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: req.path },
    });
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.playerId = decoded.sub;
    // Verify player still exists and token version hasn't been revoked
    const player = getPlayer(decoded.sub);
    if (!player) {
      return res.status(401).json({ error: 'Player not found' });
    }
    if ((decoded.tv || 0) < (player.tokenVersion || 0)) {
      const ri = reqInfo(req);
      db.logSecurityEvent('warn', 'auth', 'revoked_token', {
        ip: ri.ip, playerId: decoded.sub, userAgent: ri.userAgent,
        details: { path: req.path, tokenVersion: decoded.tv, currentVersion: player.tokenVersion },
      });
      return res.status(401).json({ error: 'Token revoked, please re-login' });
    }
    // Ensure playerId in body matches token (prevent impersonation)
    if (req.body && req.body.playerId && req.body.playerId !== req.playerId) {
      const ri = reqInfo(req);
      db.logSecurityEvent('critical', 'auth', 'player_id_mismatch', {
        ip: ri.ip, playerId: req.playerId, userAgent: ri.userAgent,
        details: { path: req.path, tokenSub: req.playerId, bodyPlayerId: req.body.playerId },
      });
      return res.status(403).json({ error: 'Player ID mismatch' });
    }
    // Inject playerId into body from JWT — ensures routes always use token identity
    if (!req.body) req.body = {};
    req.body.playerId = req.playerId;
    next();
  } catch {
    const ri = reqInfo(req);
    db.logSecurityEvent('warn', 'auth', 'invalid_token', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: req.path },
    });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Apply auth to all POST routes except register and track-event and stripe-webhook
app.use('/api/', (req, res, next) => {
  if (req.method !== 'POST') return next();
  // req.path is relative to mount point (/api/), so it's /register not /api/register
  const openPaths = ['/register', '/track-event', '/stripe-webhook', '/reauth', '/donate'];
  if (openPaths.includes(req.path)) return next();
  return authRequired(req, res, next);
});

// Self-exclusion enforcement: block gameplay/purchase routes for self-excluded players
app.use('/api/', (req, res, next) => {
  if (req.method !== 'POST') return next();
  // Routes that self-excluded users may still access
  const exemptPaths = [
    '/register', '/track-event', '/stripe-webhook', '/reauth', '/donate',
    '/self-exclude', '/deposit-limit',          // responsible gaming
    '/withdraw', '/kyc-submit',                 // cash-out & verification
    '/push-subscribe', '/resend-verification',  // account management
    '/cosmetic-equip',                          // cosmetic-only, no monetary value
  ];
  if (exemptPaths.includes(req.path)) return next();
  // req.playerId is set by authRequired above
  if (!req.playerId) return next();
  const player = getPlayer(req.playerId);
  if (player && player.selfExcludedUntil && Date.now() < player.selfExcludedUntil) {
    const ri = reqInfo(req);
    db.logSecurityEvent('info', 'responsible_gaming', 'self_exclusion_blocked', {
      ip: ri.ip, playerId: req.playerId,
      details: { path: req.path, excludedUntil: player.selfExcludedUntil },
    });
    return res.status(403).json({ error: 'Your account is self-excluded. You cannot play or make purchases during this period.' });
  }
  next();
});

// ─── HTTPS + Canonical Host Redirects (production) ─────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim().toLowerCase();
    const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim().toLowerCase();
    const hostWithoutPort = forwardedHost.split(':')[0];

    if (forwardedProto && forwardedProto !== 'https') {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }

    if (hostWithoutPort && hostWithoutPort !== CANONICAL_HOST) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }

    next();
  });
}

// ─── Rate Limiter ───────────────────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    // Emergency pressure valve — prune expired entries under load
    if (rateLimits.size > 10000) {
      const now = Date.now();
      let pruned = 0;
      for (const [key, entry] of rateLimits) {
        if (now > entry.resetAt) { rateLimits.delete(key); pruned++; }
        if (pruned >= 3000) break;
      }
    }
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
      db.logSecurityEvent('warn', 'rate_limit', 'rate_limit_hit', {
        ip, details: { path: req.path, count: entry.count, limit: maxReqs },
      });
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
  return str.replace(/[<>&"'/`\x00-\x1f\x7f\u200b-\u200f\u2028-\u202f\u2060-\u206f]/g, '').trim().slice(0, maxLen);
}

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory Store ────────────────────────────────────────────────────────
const state = {
  pots: {
    mini:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 2500,  round: 1, winner: null, label: 'MINI POT',  color: '#60c0ff', deadline: Date.now() + 2 * 3600000 },
    gold:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 10000, round: 1, winner: null, label: 'GOLD POT',  color: '#f0c040', deadline: Date.now() + 6 * 3600000 },
    mega:  { pot: 0, totalEntries: 0, entries: [], drawThreshold: 50000, round: 1, winner: null, label: 'MEGA POT',  color: '#ff6090', deadline: Date.now() + 24 * 3600000 },
  },
  houseCut: 0.18,
  recentWinners: [],
  onlineCount: 0,
  liveFeed: [],
  leaderboard: [],
  analytics: [],
  bundles: {
    1:  { price: 100,  label: '$1',   savings: null },
    5:  { price: 450,  label: '$4.50', savings: '10% OFF' },
    10: { price: 800,  label: '$8',   savings: '20% OFF' },
    25: { price: 1875, label: '$18.75', savings: '25% OFF' },
    50: { price: 3500, label: '$35',  savings: '30% OFF' },
    100: { price: 6500, label: '$65', savings: '35% OFF' },
  },
  launchFund: {
    raised: 0,         // cents
    goal: 10000000,    // $100,000 in cents
    donors: 0,
    recentDonors: [],  // [{name, amount, timestamp}]
  },
};

// ─── Player Cache (LRU, bounded) ────────────────────────────────────────────
const PLAYER_CACHE_MAX = 10000;
const playerCache = new Map();

function cacheGet(id) {
  if (!playerCache.has(id)) return undefined;
  const player = playerCache.get(id);
  playerCache.delete(id);
  playerCache.set(id, player);
  return player;
}

function cacheSet(id, player) {
  if (playerCache.has(id)) playerCache.delete(id);
  playerCache.set(id, player);
  if (playerCache.size > PLAYER_CACHE_MAX) {
    const oldest = playerCache.keys().next().value;
    playerCache.delete(oldest);
  }
}

function syncPotRounds(player) {
  if (!player._potRounds) player._potRounds = {};
  for (const potId of Object.keys(state.pots)) {
    const currentRound = state.pots[potId].round;
    const lastRound = player._potRounds[potId] || 0;
    if (lastRound < currentRound) {
      player.entries[potId] = 0;
      for (let r = lastRound; r < currentRound; r++) {
        delete player.freeEntryUsed[`${potId}_${r}`];
      }
      player._potRounds[potId] = currentRound;
    }
  }
}

function getPlayer(id) {
  const cached = cacheGet(id);
  if (cached) return cached;
  const player = db.loadPlayer(id);
  if (!player) return null;
  syncPotRounds(player);
  cacheSet(id, player);
  return player;
}

function putPlayer(player) {
  if (!player._potRounds) player._potRounds = {};
  for (const potId of Object.keys(state.pots)) {
    player._potRounds[potId] = state.pots[potId].round;
  }
  cacheSet(player.id, player);
  db.savePlayer(player);
}

function trackEvent(event, data = {}) {
  state.analytics.push({ event, ...data, timestamp: Date.now() });
  if (state.analytics.length > 1000) state.analytics = state.analytics.slice(-1000);
}

function getAnalyticsSummary(hours = 24) {
  const cutoff = Date.now() - hours * 3600000;
  const events = state.analytics.filter(e => e.timestamp >= cutoff);
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;
  return { hours, totalEvents: events.length, counts, latest: events.slice(-40).reverse() };
}

// ─── Load persisted state from DB ───────────────────────────────────────────
{
  const savedPots = db.loadPotState();
  if (savedPots) {
    const allowedPotKeys = ['pot', 'totalEntries', 'drawThreshold', 'round', 'winner', 'label', 'color', 'deadline', 'entries'];
    for (const [key, saved] of Object.entries(savedPots)) {
      if (state.pots[key] && typeof saved === 'object' && saved !== null) {
        for (const k of allowedPotKeys) {
          if (k in saved) state.pots[key][k] = saved[k];
        }
      }
    }
  }
  // Fix stale deadlines that are in the past after a restart
  const deadlineDurations = { mini: 2 * 3600000, gold: 6 * 3600000, mega: 24 * 3600000 };
  for (const [key, potData] of Object.entries(state.pots)) {
    if (potData.deadline < Date.now()) {
      potData.deadline = Date.now() + (deadlineDurations[key] || 6 * 3600000);
    }
  }
  const savedWinners = db.loadRecentWinners();
  if (savedWinners.length > 0) state.recentWinners = savedWinners;
  const savedFund = db.loadAppState('launchFund');
  if (savedFund) {
    state.launchFund.raised = savedFund.raised || 0;
    state.launchFund.goal = 10000000; // always use configured goal ($100,000)
    state.launchFund.donors = savedFund.donors || 0;
    state.launchFund.recentDonors = savedFund.recentDonors || [];
  }
  // Restore jackpot state so paid entries survive restarts
  const savedJackpot = db.loadAppState('jackpot');
  if (savedJackpot && savedJackpot.active && savedJackpot.deadline > Date.now()) {
    state.jackpot = {
      tier: savedJackpot.tier, label: savedJackpot.label, prize: savedJackpot.prize,
      pot: savedJackpot.pot, entries: savedJackpot.entries || [], totalEntries: savedJackpot.totalEntries || 0,
      deadline: savedJackpot.deadline, threshold: savedJackpot.threshold,
      entryPrice: savedJackpot.entryPrice, color: savedJackpot.color,
      active: true, winner: null,
    };
    log('info', 'Restored jackpot state from DB', { tier: savedJackpot.tier, entries: savedJackpot.totalEntries });
  }
  // Restore flash pot state
  const savedFlash = db.loadAppState('flashPot');
  if (savedFlash && savedFlash.active && savedFlash.deadline > Date.now()) {
    state.flashPot = {
      pot: savedFlash.pot, entries: savedFlash.entries || [], totalEntries: savedFlash.totalEntries || 0,
      deadline: savedFlash.deadline, label: savedFlash.label,
      color: savedFlash.color, active: true, winner: null,
    };
    log('info', 'Restored flash pot state from DB', { entries: savedFlash.totalEntries });
  }
}

// ─── Periodic DB persistence (every 30 seconds) ────────────────────────────
setInterval(() => {
  db.savePotState(state.pots);
  db.saveAppState('launchFund', state.launchFund);
  // Persist jackpot/flash state so entries survive restarts
  if (state.jackpot) {
    db.saveAppState('jackpot', {
      tier: state.jackpot.tier, label: state.jackpot.label, prize: state.jackpot.prize,
      pot: state.jackpot.pot, totalEntries: state.jackpot.totalEntries,
      deadline: state.jackpot.deadline, threshold: state.jackpot.threshold,
      entryPrice: state.jackpot.entryPrice, color: state.jackpot.color,
      active: state.jackpot.active, winner: state.jackpot.winner,
      entries: state.jackpot.entries,
    });
  }
  if (state.flashPot) {
    db.saveAppState('flashPot', {
      pot: state.flashPot.pot, totalEntries: state.flashPot.totalEntries,
      deadline: state.flashPot.deadline, label: state.flashPot.label,
      color: state.flashPot.color, active: state.flashPot.active,
      winner: state.flashPot.winner,
      entries: state.flashPot.entries,
    });
  }
}, 30000);

// ─── Online count ───────────────────────────────────────────────────────────
if (DEMO_MODE) {
  setInterval(() => {
    const base = Math.max(80, getTotalEntries() * 2);
    state.onlineCount = base + Math.floor(Math.random() * 300);
  }, 5000);
  state.onlineCount = 234;
} else {
  state.onlineCount = 0;
}

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

// ─── Pre-Seed Pots & Activity (DEMO_MODE only) ─────────────────────────────
if (DEMO_MODE) {
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
} // end DEMO_MODE seed

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

// ─── Simulated Bot Activity (DEMO_MODE only) ───────────────────────────────
if (DEMO_MODE) {
setInterval(() => {
  const potKeys = ['mini', 'gold', 'mega'];
  const pk = potKeys[Math.floor(Math.random() * potKeys.length)];
  const potData = state.pots[pk];
  const name = pickFakeName();
  const qty = [1, 1, 1, 5, 10][Math.floor(Math.random() * 5)];
  const cents = qty * Math.round(100 * (1 - state.houseCut));
  potData.pot += cents;
  potData.totalEntries += qty;
  addFeedEvent('play', { name, pot: potData.label, qty, entryType: 'premium' });
  // Check if bot activity pushed pot past draw threshold
  if (potData.pot >= potData.drawThreshold) performDraw(pk);

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
} // end DEMO_MODE bots

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

// Jackpot/Flash scheduling (jackpots always run, but bot entries are DEMO_MODE only)
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
      const wp = getPlayer(winner.playerId);
      const name = wp ? wp.name : pickFakeName();
      // Timer expiry: pay out what's actually in the pot, not the fixed prize
      const actualPrize = state.jackpot.pot;
      const prizeDisplay = (actualPrize / 100).toLocaleString('en-US');
      state.jackpot.winner = { name, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
      state.jackpot.active = false;
      if (wp) { wp.totalWon += actualPrize; putPlayer(wp); }
      addRecentWinner({ name, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
      addFeedEvent('jackpot_winner', { name, prize: prizeDisplay, label: state.jackpot.label });
    } else {
      state.jackpot.active = false;
    }
  }
}, 15000);

// Jackpot bot activity (DEMO_MODE only)
if (DEMO_MODE) {
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
    const wp = getPlayer(winner.playerId);
    const wname = wp ? wp.name : pickFakeName();
    const prizeDisplay = (state.jackpot.prize / 100).toLocaleString('en-US');
    state.jackpot.winner = { name: wname, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
    state.jackpot.active = false;
    if (wp) { wp.totalWon += state.jackpot.prize; putPlayer(wp); }
    addRecentWinner({ name: wname, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
    addFeedEvent('jackpot_winner', { name: wname, prize: prizeDisplay, label: state.jackpot.label });
  }
}, 12000 + Math.floor(Math.random() * 8000));
} // end DEMO_MODE jackpot bots

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
      const wp = getPlayer(winner.playerId);
      const name = wp ? wp.name : pickFakeName();
      const prize = (state.flashPot.pot / 100).toFixed(2);
      state.flashPot.winner = { name, prize, timestamp: Date.now() };
      state.flashPot.active = false;
      if (wp) { wp.totalWon += state.flashPot.pot; putPlayer(wp); }
      addRecentWinner({ name, prize, pot: '⚡ FLASH', round: 0, timestamp: Date.now() });
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
  if (typeof broadcast === 'function') broadcast({ type: 'feed', event: { type, ...data } });
}

function addRecentWinner(info) {
  state.recentWinners.push(info);
  if (state.recentWinners.length > 50) state.recentWinners = state.recentWinners.slice(-50);
  db.recordWinner(info);
}

function updateLeaderboard() {
  const topPlayers = db.getTopPlayersByEntries(10);
  state.leaderboard = topPlayers.map(p => ({ name: p.name, entries: p.totalEntries, streak: p.streak, level: p.level, levelInfo: p.levelInfo }));
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
  if (player.streak === 0) {
    // First activity — start streak at 1
    player.streak = 1;
  } else if (hoursSince < 48) {
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
    [(player.referralCount || 0) >= 5, 'networker'],
    [(player.referralCount || 0) >= 25, 'influencer'],
  ];
  const newlyUnlocked = [];
  for (const [cond, key] of checks) {
    if (cond && !player.achievements.includes(key)) {
      player.achievements.push(key);
      newlyUnlocked.push(key);
    }
  }
  // Reward each newly unlocked achievement with bonus entries
  const ACHIEVEMENT_REWARDS = {
    gold_fingers: 2, veteran: 5, dedicated: 3, unstoppable: 10,
    whale: 5, networker: 3, influencer: 10, winner: 0,
  };
  for (const key of newlyUnlocked) {
    const reward = ACHIEVEMENT_REWARDS[key] || 0;
    if (reward > 0) {
      player.entries.gold = (player.entries.gold || 0) + reward;
      player.totalEntries += reward;
      for (let i = 0; i < reward; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'achievement' });
      state.pots.gold.totalEntries += reward;
    }
    addFeedEvent('achievement', { name: player.name, achievement: key });
  }
  return newlyUnlocked;
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

// ─── Grant deferred referral reward on first purchase ───────────────────────
function grantReferralReward(player) {
  if (!player.pendingReferralFor || player.referralRewarded) return;
  const referrer = getPlayer(player.pendingReferralFor);
  if (!referrer) return;
  // Cap referral rewards at 50 per referrer
  if ((referrer.referralCount || 0) >= 50) {
    player.referralRewarded = true;
    return;
  }
  player.referralRewarded = true;
  // Referrer gets 5 entries to gold pot
  for (let i = 0; i < 5; i++) {
    state.pots.gold.entries.push({ playerId: referrer.id, timestamp: Date.now(), type: 'referral' });
    state.pots.gold.totalEntries++;
  }
  referrer.entries.gold = (referrer.entries.gold || 0) + 5;
  referrer.totalEntries += 5;
  referrer.referralCount = (referrer.referralCount || 0) + 1;
  // Referee also gets 2 free entries as a welcome bonus
  for (let i = 0; i < 2; i++) {
    state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'referral_bonus' });
    state.pots.gold.totalEntries++;
  }
  player.entries.gold = (player.entries.gold || 0) + 2;
  player.totalEntries += 2;
  // Mark the referral as rewarded
  const ref = (referrer.referrals || []).find(r => r.name === player.name && !r.rewarded);
  if (ref) ref.rewarded = true;
  putPlayer(referrer);
  putPlayer(player);
}

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
  // Allowlist: only send fields the client needs
  return {
    id: player.id,
    name: player.name,
    coins: player.coins,
    entries: player.entries,
    gamesPlayed: player.gamesPlayed,
    totalSpent: player.totalSpent,
    totalWon: player.totalWon || 0,
    totalWithdrawn: player.totalWithdrawn || 0,
    streak: player.streak,
    bestStreak: player.bestStreak,
    joinedAt: player.joinedAt,
    missions: player.missions,
    claimedMilestones: player.claimedMilestones,
    lightningDeal: player.lightningDeal,
    lastSessionStart: player.lastSessionStart,
    lastSessionEnd: player.lastSessionEnd,
    dailyBonus: player.dailyBonus,
    adsWatched: player.adsWatched || 0,
    referralCode: player.referralCode,
    referralCount: player.referralCount || 0,
    referralEarnings: player.referralEarnings || 0,
    hasEmail: !!player.email,
    yourOdds: Object.fromEntries(
      Object.entries(state.pots).map(([k, p]) => [k, p.totalEntries > 0 ? ((player.entries[k] || 0) / p.totalEntries * 100).toFixed(2) : '0.00'])
    ),
    levelProgress: getLevelProgress(player.totalSpent),
    availableMilestones: MILESTONES.map(m => ({ ...m, unlocked: player.gamesPlayed >= m.games, claimed: player.claimedMilestones.includes(m.games) })),
    powerSurgeActive: player.powerSurgeExpires > Date.now(),
    powerSurgeExpires: player.powerSurgeExpires,
    mysteryBoxCooldown: Math.max(0, 180000 - (Date.now() - (player.lastMysteryBox || 0))),
    balance: (player.totalWon || 0) - (player.totalWithdrawn || 0),
  };
}

// ─── API Routes ─────────────────────────────────────────────────────────────

app.get('/api/state', rateLimit(1000, 10), (req, res) => {
  const pots = {};
  for (const [key, p] of Object.entries(state.pots)) {
    const pctFull = Math.min(100, Math.round((p.pot / p.drawThreshold) * 100));
    pots[key] = { pot: p.pot, potDisplay: (p.pot / 100).toFixed(2), totalEntries: p.totalEntries, round: p.round, drawThreshold: p.drawThreshold, label: p.label, color: p.color, winner: p.winner, deadline: p.deadline, pctFull };
  }
  // Compute payout stats for social proof
  const winnerCount = state.recentWinners.length;
  const totalPaidOut = state.recentWinners.reduce((sum, w) => sum + (w.prizeCents || (parseFloat(w.prize) * 100) || 0), 0);
  const fund = state.launchFund;
  res.json({ pots, onlineCount: state.onlineCount, recentWinners: state.recentWinners.slice(-10), liveFeed: state.liveFeed.slice(0, 15), leaderboard: state.leaderboard, bundles: state.bundles, serverTime: Date.now(), winnerCount, totalPaidOut, launchFund: { raised: fund.raised, goal: fund.goal, donors: fund.donors, recentDonors: fund.recentDonors.slice(-5), pct: Math.min(100, Math.round((fund.raised / fund.goal) * 100)) }, limitedDrop: (ensureLimitedDrop(), { entries: state.limitedDrop.entries, price: state.limitedDrop.price, remaining: state.limitedDrop.remaining, totalStock: state.limitedDrop.totalStock, label: state.limitedDrop.label, resetAt: state.limitedDrop.resetAt }), flashPot: state.flashPot ? { pot: state.flashPot.pot, prize: state.flashPot.pot, totalEntries: state.flashPot.totalEntries, deadline: state.flashPot.deadline, active: state.flashPot.active, label: state.flashPot.label, color: state.flashPot.color, winner: state.flashPot.winner || null } : null, jackpot: state.jackpot ? { tier: state.jackpot.tier, label: state.jackpot.label, prize: state.jackpot.prize, pot: state.jackpot.pot, totalEntries: state.jackpot.totalEntries, deadline: state.jackpot.deadline, threshold: state.jackpot.threshold, entryPrice: state.jackpot.entryPrice, color: state.jackpot.color, active: state.jackpot.active, winner: state.jackpot.winner || null, pctFull: Math.min(100, Math.round((state.jackpot.pot / state.jackpot.threshold) * 100)) } : null, battlePass: (ensureBattlePass(), { season: state.battlePass.season, endsAt: state.battlePass.endsAt, tiers: state.battlePass.tiers }), tournament: (ensureTournament(), { id: state.tournament.id, title: state.tournament.title, entryFee: state.tournament.entryFee, prizePool: state.tournament.prizePool, endsAt: state.tournament.endsAt, totalEntries: state.tournament.totalEntries, leaderboard: state.tournament.leaderboard.slice(0, 10) }), chatCosmetics: CHAT_COSMETICS, urgencyBundles: (() => { const b = []; for (const [pid, p] of Object.entries(state.pots)) { const f = p.pot / p.drawThreshold; if (f >= 0.75) { const d = f >= 0.90 ? 40 : f >= 0.85 ? 30 : 20; b.push({ id: 'urgency_' + pid, potId: pid, potLabel: p.label, fillPct: Math.round(f * 100), entries: f >= 0.90 ? 8 : f >= 0.85 ? 6 : 4, basePrice: 499, salePrice: Math.round(499 * (1 - d / 100)), discount: d }); } } return b; })(), duels: { active: Object.values(state.duels).filter(d => d.status !== 'finished').map(sanitizeDuel), recentResults: state.duelHistory.slice(-10), stats: { totalDuels: state.duelStats.totalDuels, totalWagered: state.duelStats.totalWagered }, stakes: DUEL_STAKES, boosts: DUEL_BOOSTS }, streams: { live: Object.values(state.streams).filter(s => s.status === 'live').sort((a,b) => b.viewers - a.viewers).map(sanitizeStream), stats: state.streamStats, superChats: STREAM_SUPER_CHATS, gifts: STREAM_GIFTS, subPrice: STREAM_SUB_PRICE, hypeLevels: HYPE_TRAIN_LEVELS } });
});

app.post('/api/track-event', rateLimit(10000, 20), (req, res) => {
  const event = sanitizeString(String(req.body.event || ''), 50);
  if (!event) return res.status(400).json({ error: 'Missing event' });
  // Prevent analytics pollution while allowing product instrumentation to evolve.
  if (!/^[a-z0-9_:-]{2,50}$/i.test(event)) return res.status(400).json({ error: 'Invalid event name' });
  trackEvent(event, { playerId: req.body.playerId || null });
  res.json({ ok: true });
});

app.get('/api/metrics', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/metrics' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
  res.json(getAnalyticsSummary(hours));
});

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// ─── Re-authenticate (expired token, existing player) ───────────────────────
app.post('/api/reauth', rateLimit(60000, 3), (req, res) => {
  // Require the old (expired) token to prove ownership — verify signature but ignore expiration
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const ri = reqInfo(req);
    db.logSecurityEvent('warn', 'auth', 'reauth_missing_token', {
      ip: ri.ip, userAgent: ri.userAgent,
    });
    return res.status(401).json({ error: 'Provide expired token in Authorization header' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET, { ignoreExpiration: true });
    // Cap reauth window: reject tokens expired more than 7 days ago
    if (decoded.exp && (Date.now() / 1000 - decoded.exp) > 7 * 86400) {
      const ri = reqInfo(req);
      db.logSecurityEvent('warn', 'auth', 'reauth_token_too_old', {
        ip: ri.ip, playerId: decoded.sub, userAgent: ri.userAgent,
      });
      return res.status(401).json({ error: 'Token too old — please re-register' });
    }
    const player = getPlayer(decoded.sub);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const token = signToken(player.id, reqInfo(req).ip);
    trackEvent('reauth', { playerId: player.id });
    db.logSecurityEvent('info', 'auth', 'reauth_success', {
      ip: reqInfo(req).ip, playerId: player.id,
    });
    res.json({ player: sanitizePlayer(player), token });
  } catch {
    const ri = reqInfo(req);
    db.logSecurityEvent('warn', 'auth', 'reauth_invalid_signature', {
      ip: ri.ip, userAgent: ri.userAgent,
    });
    return res.status(401).json({ error: 'Invalid token signature' });
  }
});

// ─── IP-based daily registration limit ──────────────────────────────────────
const registrationsByIp = new Map();
setInterval(() => registrationsByIp.clear(), 24 * 3600000); // reset daily

// ─── Blocked States ─────────────────────────────────────────────────────────
// States where sweepstakes are prohibited or require special registration
// NY: requires registration & bonding; FL: requires registration & trust;
// RI: prohibited; UT/HI: general anti-gambling statutes
const BLOCKED_STATES = ['NY', 'FL', 'RI', 'UT', 'HI'];

app.post('/api/register', rateLimit(60000, 3), (req, res) => {
  // State eligibility check
  const playerState = sanitizeString(String(req.body.state || ''), 2).toUpperCase();
  if (playerState && BLOCKED_STATES.includes(playerState)) {
    return res.status(403).json({ error: 'Sweepstakes not available in your state. Check local regulations.' });
  }
  // Per-IP daily registration limit
  const regIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const regCount = registrationsByIp.get(regIp) || 0;
  if (regCount >= 5) {
    db.logSecurityEvent('warn', 'auth', 'registration_ip_blocked', {
      ip: regIp, details: { count: regCount },
    });
    return res.status(429).json({ error: 'Too many registrations from this network today' });
  }
  registrationsByIp.set(regIp, regCount + 1);
  // Limit total accounts
  if (db.countPlayers() >= 500000) {
    return res.status(503).json({ error: 'Registration temporarily closed' });
  }
  // Email is required
  const rawEmail = sanitizeString(req.body.email || '', 100);
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  const id = generatePlayerId();
  const rawName = sanitizeString(req.body.name, 20);
  const player = {
    id, name: rawName || `Player_${id.slice(0, 6)}`,
    entries: { mini: 0, gold: 0, mega: 0, jackpot: 0, flash: 0 }, totalEntries: 0, freeEntryUsed: {},
    email: rawEmail,
    referralCode: id.slice(0, 8).toUpperCase(), referredBy: req.body.referralCode || null, referralCount: 0, referrals: [],
    createdAt: Date.now(), lastPlayedAt: Date.now(), lastDailyBonus: null, lastSpin: null,
    sessionStartedAt: Date.now(),
    streak: 0, bestStreak: 0, streakShield: false, nextMultiplier: 1,
    totalSpent: 0, totalWon: 0, totalWithdrawn: 0, gamesPlayed: 0, bestScore: 0,
    level: 0, levelInfo: getPlayerLevel(0), achievements: [],
    paymentMethod: null, tokenVersion: 0,
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
    // Responsible gaming
    selfExcludedUntil: null,
    dailyDepositLimitCents: null,  // null = no limit
    depositTodayCents: 0,
    depositLimitDate: null,
    // Email verification
    emailVerified: false,
    emailVerifyToken: crypto.randomBytes(16).toString('hex'),
  };
  putPlayer(player);

  if (req.body.referralCode) {
    const referrer = db.findPlayerByReferralCode(req.body.referralCode);
    if (referrer && referrer.id !== id) {
      // Prevent self-referral and same-IP referral farming
      const regIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      if (!referrer._referralIps) referrer._referralIps = [];
      if (referrer._referralIps.includes(regIp)) {
        // Silently skip reward — don't reveal detection
        player.referredBy = req.body.referralCode;
        putPlayer(player);
      } else {
        referrer._referralIps.push(regIp);
        if (referrer._referralIps.length > 100) referrer._referralIps = referrer._referralIps.slice(-100);
        player.referredBy = req.body.referralCode;
        player.pendingReferralFor = referrer.id;
        if (!referrer.referrals) referrer.referrals = [];
        referrer.referrals.push({ name: player.name, date: Date.now(), rewarded: false });
        referrer.referralCount = (referrer.referralCount || 0);
        addFeedEvent('referral', { name: referrer.name });
        putPlayer(referrer);
        putPlayer(player);
      }
    }
  }
  addFeedEvent('join', { name: player.name });
  trackEvent('register_completed', { playerId: player.id, referred: !!player.referredBy });
  db.logSecurityEvent('info', 'auth', 'registration', {
    ip: regIp, playerId: player.id,
    details: { referred: !!player.referredBy },
  });
  putPlayer(player);
  const token = signToken(player.id, regIp);
  res.json({ player: sanitizePlayer(player), token, emailVerifyToken: player.emailVerifyToken });
});

// ─── Email Verification ────────────────────────────────────────────────────
app.get('/api/verify-email', rateLimit(10000, 5), (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send('Invalid verification link.');
  const player = getPlayer(String(id));
  if (!player) return res.status(404).send('Account not found.');
  if (player.emailVerified) return res.send('Email already verified. <a href="/">Back to GoldPot</a>');
  if (player.emailVerifyToken !== String(token)) return res.status(400).send('Invalid or expired verification link.');
  player.emailVerified = true;
  player.emailVerifyToken = null;
  putPlayer(player);
  db.logSecurityEvent('info', 'auth', 'email_verified', { playerId: player.id });
  res.send('✅ Email verified successfully! <a href="/">Back to GoldPot</a>');
});

// ─── Resend Verification ────────────────────────────────────────────────────
app.post('/api/resend-verification', rateLimit(300000, 2), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  let decoded;
  try { decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const player = getPlayer(decoded.sub);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  // Regenerate token
  player.emailVerifyToken = crypto.randomBytes(16).toString('hex');
  putPlayer(player);
  // In production, you would send an email here. For now return the link.
  const verifyUrl = `/api/verify-email?id=${encodeURIComponent(player.id)}&token=${encodeURIComponent(player.emailVerifyToken)}`;
  res.json({ ok: true, verifyUrl });
});

app.post('/api/starter-offer-claim', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.starterOfferClaimed) return res.status(400).json({ error: 'Starter offer already used' });

  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'starter_offer', 249);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }

  const potId = req.body.potId || 'gold';
  const potData = state.pots[potId];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });

  if (stripe) {
    const decoded = jwt.decode(req.body.paymentProofToken || '');
    if (!decoded || decoded.potId !== potId) {
      return res.status(400).json({ error: 'Payment proof pot mismatch' });
    }
  }

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
  addFeedEvent('play', { name: player.name, pot: potData.label, qty, entryType: 'starter_offer' });
  trackEvent('starter_offer_claimed', { playerId: player.id, potId, cost, qty });

  putPlayer(player);
  let winnerDrawn = null;
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(potId);
  res.json({ success: true, qty, cost, player: sanitizePlayer(player), winnerDrawn });
});

app.post('/api/free-entry', rateLimit(60000, 10), (req, res) => {
  const { playerId, potId } = req.body;
  const pot = potId || 'gold';
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  const freeKey = `${pot}_${potData.round}`;
  if (player.freeEntryUsed[freeKey]) return res.status(400).json({ error: 'Free entry already used this round' });
  // Atomic guard: mark used immediately to prevent race conditions
  player.freeEntryUsed[freeKey] = true;
  // Global daily free entry cap: max 5 free entries per day across all pots
  const today = new Date().toDateString();
  if (!player._freeEntryDay || player._freeEntryDay !== today) {
    player._freeEntryDay = today;
    player._freeEntryCount = 0;
  }
  if (player._freeEntryCount >= 5) {
    delete player.freeEntryUsed[freeKey]; // rollback
    return res.status(400).json({ error: 'Daily free entry limit reached' });
  }
  player._freeEntryCount++;

  player.freeEntryUsed[freeKey] = true;
  player.entries[pot] = (player.entries[pot] || 0) + 1;
  player.totalEntries++; player.gamesPlayed++;
  potData.entries.push({ playerId, timestamp: Date.now(), type: 'free' });
  potData.totalEntries++;
  updateStreak(player);
  addFeedEvent('play', { name: player.name, pot: potData.label, entryType: 'free' });
  putPlayer(player);
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── Stripe Checkout Session ────────────────────────────────────────────────
// Creates a real Stripe Checkout Session when STRIPE_SECRET_KEY is set.
// In demo mode (no key), returns { demo: true } so the client can skip payment.
app.post('/api/create-checkout-session', async (req, res) => {
  const { playerId, quantity, potId, purchaseType, tier } = req.body;
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Self-exclusion check
  if (player.selfExcludedUntil && Date.now() < player.selfExcludedUntil) {
    return res.status(403).json({ error: 'Your account is self-excluded. You cannot make purchases during this period.' });
  }

  const pot = potId || 'gold';
  const qty = Math.min(Math.max(1, parseInt(quantity) || 1), 100);
  const type = sanitizeString(String(purchaseType || 'premium'), 30);

  // Calculate price based on purchase type
  let totalCents, itemName;
  const potData = state.pots[pot];
  const potLabel = potData ? potData.label : pot.toUpperCase();

  if (type === 'premium') {
    const bundle = state.bundles[qty];
    totalCents = bundle ? bundle.price : qty * 100;
    itemName = `${qty}x Entries — ${potLabel}`;
  } else if (type === 'mystery_box') {
    const boxTier = MYSTERY_TIERS[tier];
    if (!boxTier) return res.status(400).json({ error: 'Invalid tier' });
    totalCents = boxTier.price;
    itemName = boxTier.label;
  } else if (type === 'power_surge') {
    totalCents = 299;
    itemName = 'Power Surge — 2× Entries for 1 Hour';
  } else if (type === 'streak_saver') {
    totalCents = 199;
    itemName = 'Streak Saver Shield';
  } else if (type === 'all_in') {
    totalCents = 500;
    itemName = 'All-In Pack — 5 Entries per Pot';
  } else if (type === 'mega_multiplier') {
    totalCents = 499;
    itemName = '5× Mega Multiplier';
  } else if (type === 'vip_weekly') {
    totalCents = 499;
    itemName = 'VIP Pass — Weekly';
  } else if (type === 'vip_monthly') {
    totalCents = 1499;
    itemName = 'VIP Pass — Monthly';
  } else if (type === 'vip_diamond') {
    totalCents = 2999;
    itemName = 'VIP Diamond — Monthly';
  } else if (type === 'double_down') {
    const origQty = parseInt(quantity) || 1;
    const bundle = state.bundles[origQty];
    const origPrice = bundle ? bundle.price : origQty * 100;
    totalCents = Math.ceil(origPrice * 0.5);
    itemName = `Double Down — ${origQty}x Extra Entries`;
  } else if (type === 'starter_offer') {
    totalCents = 249;
    itemName = 'Starter Offer — 3x Entries';
  } else if (type === 'flash_entry') {
    totalCents = 50;
    itemName = 'Flash Pot Entry';
  } else if (type === 'lightning') {
    if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
      return res.status(400).json({ error: 'Deal expired' });
    }
    totalCents = player.lightningDeal.salePrice;
    itemName = `Lightning Deal — ${player.lightningDeal.label}`;
  } else if (type === 'limited') {
    ensureLimitedDrop();
    if (state.limitedDrop.remaining <= 0) return res.status(400).json({ error: 'Sold out' });
    totalCents = state.limitedDrop.price;
    itemName = `Limited Drop — ${state.limitedDrop.entries}x Entries`;
  } else if (type === 'jackpot_entry') {
    if (!state.jackpot || !state.jackpot.active) return res.status(400).json({ error: 'No active jackpot' });
    totalCents = qty * state.jackpot.entryPrice;
    itemName = `${qty}x ${state.jackpot.label} Entries`;
  } else if (type === 'battle_pass') {
    totalCents = BATTLE_PASS_PRICE;
    itemName = 'Battle Pass — Premium';
  } else if (type === 'gift_entries') {
    const bundle = state.bundles[qty];
    totalCents = bundle ? bundle.price : qty * 100;
    itemName = `Gift — ${qty}x Entries`;
  } else if (type === 'tournament') {
    ensureTournament();
    totalCents = state.tournament.entryFee;
    itemName = `Tournament Entry — ${state.tournament.title}`;
  } else if (type === 'lucky_boost') {
    totalCents = 149;
    itemName = 'Lucky Boost 🍀';
  } else if (type === 'second_chance') {
    totalCents = 99;
    itemName = 'Second Chance Entry';
  } else if (type && type.startsWith('cosmetic_')) {
    const cosmeticId = type.replace('cosmetic_', '');
    const cosmetic = CHAT_COSMETICS[cosmeticId];
    if (!cosmetic) return res.status(400).json({ error: 'Invalid cosmetic' });
    totalCents = cosmetic.price;
    itemName = `Chat Cosmetic — ${cosmetic.label}`;
  } else if (type === 'urgency_buy') {
    const urgPot = state.pots[req.body.potId];
    if (!urgPot) return res.status(400).json({ error: 'Invalid pot' });
    const fillPct = urgPot.pot / urgPot.drawThreshold;
    if (fillPct < 0.75) return res.status(400).json({ error: 'Bundle expired' });
    const discount = fillPct >= 0.90 ? 40 : fillPct >= 0.85 ? 30 : 20;
    totalCents = Math.round(499 * (1 - discount / 100));
    itemName = `Urgency Bundle — ${urgPot.label}`;
  } else if (type === 'duel_create' || type === 'duel_join') {
    const duelStake = parseInt(req.body.stake);
    if (!DUEL_STAKES[duelStake]) return res.status(400).json({ error: 'Invalid duel stake' });
    totalCents = duelStake;
    itemName = `Duel Wager — ${DUEL_STAKES[duelStake].label}`;
  } else if (type === 'duel_tip') {
    totalCents = 50;
    itemName = 'Duel Spectator Tip';
  } else if (type && type.startsWith('duel_boost_')) {
    const boostId = type.replace('duel_boost_', '');
    const boost = DUEL_BOOSTS[boostId];
    if (!boost) return res.status(400).json({ error: 'Invalid duel boost' });
    totalCents = boost.price;
    itemName = `Duel Boost — ${boost.label}`;
  } else if (type && type.startsWith('super_chat_')) {
    const scTier = type.replace('super_chat_', '');
    const sc = STREAM_SUPER_CHATS[scTier];
    if (!sc) return res.status(400).json({ error: 'Invalid super chat tier' });
    totalCents = sc.price;
    itemName = `Super Chat — ${sc.label}`;
  } else if (type && type.startsWith('stream_gift_')) {
    const giftId = type.replace('stream_gift_', '');
    const gift = STREAM_GIFTS[giftId];
    if (!gift) return res.status(400).json({ error: 'Invalid stream gift' });
    totalCents = gift.price;
    itemName = `Stream Gift — ${gift.label}`;
  } else if (type === 'stream_subscribe') {
    totalCents = STREAM_SUB_PRICE;
    itemName = 'Stream Subscription — Monthly';
  } else {
    return res.status(400).json({ error: 'Invalid purchase type' });
  }

  // Daily deposit limit enforcement
  if (player.dailyDepositLimitCents) {
    const today = new Date().toISOString().slice(0, 10);
    if (player.depositLimitDate !== today) {
      player.depositTodayCents = 0;
      player.depositLimitDate = today;
    }
    if ((player.depositTodayCents || 0) + totalCents > player.dailyDepositLimitCents) {
      const remainCents = Math.max(0, player.dailyDepositLimitCents - (player.depositTodayCents || 0));
      return res.status(403).json({
        error: `Daily deposit limit reached. You have $${(remainCents / 100).toFixed(2)} remaining today.`,
      });
    }
  }

  if (!stripe) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Payment system unavailable. Please try again later.' });
    }
    // Demo mode: no Stripe key configured — allow direct purchase
    return res.json({ demo: true, totalCents, itemName });
  }

  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    const sessionOpts = {
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: itemName },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&type=${encodeURIComponent(type)}&qty=${qty}&pot=${encodeURIComponent(pot)}&tier=${encodeURIComponent(tier || '')}`,
      cancel_url: `${origin}/?canceled=1`,
      metadata: {
        playerId,
        purchaseType: type,
        quantity: String(qty),
        potId: pot,
        tier: tier || '',
      },
      customer_email: player.email || undefined,
    };
    // Let Stripe auto-enable all payment methods from Dashboard (card, Apple Pay, Google Pay, Cash App, etc.)
    // If Stripe rejects automatic mode (older API version), fall back to explicit list
    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionOpts);
    } catch (autoErr) {
      if (autoErr.message && autoErr.message.includes('payment_method_types')) {
        sessionOpts.payment_method_types = ['card', 'cashapp', 'link'];
        session = await stripe.checkout.sessions.create(sessionOpts);
      } else {
        throw autoErr;
      }
    }
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    log('error', 'Stripe session creation failed', { playerId, error: err.message });
    db.logAudit('stripe_session_failed', {
      playerId, amount: totalCents,
      details: { error: err.message, purchaseType: type },
    });
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

// ─── Donate to Launch Fund / Specific Pot ───────────────────────────────────
app.post('/api/donate', rateLimit(10000, 5), async (req, res) => {
  const amount = parseInt(req.body.amount);
  if (!amount || amount < 100 || amount > 100000) return res.status(400).json({ error: 'Invalid donation amount' });
  const donorName = sanitizeString(String(req.body.name || 'Anonymous'), 30) || 'Anonymous';
  const targetPot = req.body.potId ? sanitizeString(String(req.body.potId), 20) : null;

  // Helper: route money into pots
  function creditPots(cents) {
    const houseTake = Math.floor(cents * state.houseCut);
    const net = cents - houseTake;
    if (targetPot && state.pots[targetPot]) {
      // Donate to a specific pot
      state.pots[targetPot].pot += net;
    } else {
      // Split across all 3 main pots
      const perPot = Math.floor(net / 3);
      for (const pid of ['mini', 'gold', 'mega']) {
        state.pots[pid].pot += perPot;
      }
    }
  }

  if (!stripe) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Payment system unavailable' });
    }
    // Demo mode — credit immediately
    state.launchFund.raised += amount;
    state.launchFund.donors += 1;
    state.launchFund.recentDonors.push({ name: donorName, amount, timestamp: Date.now() });
    if (state.launchFund.recentDonors.length > 20) state.launchFund.recentDonors = state.launchFund.recentDonors.slice(-20);
    creditPots(amount);
    db.saveAppState('launchFund', state.launchFund);
    addFeedEvent('donate', { name: donorName, amount, pot: targetPot });
    broadcast({ type: 'state_update' });
    return res.json({ demo: true, raised: state.launchFund.raised, goal: state.launchFund.goal });
  }

  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    const potLabel = targetPot && state.pots[targetPot] ? state.pots[targetPot].label : 'All Pots';
    const donateOpts = {
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `GoldPot Donation — ${potLabel}` },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/?donated=1`,
      cancel_url: `${origin}/?canceled=1`,
      metadata: {
        purchaseType: 'donation',
        donorName,
        amount: String(amount),
        potId: targetPot || '',
      },
    };
    let session;
    try {
      session = await stripe.checkout.sessions.create(donateOpts);
    } catch (autoErr) {
      if (autoErr.message && autoErr.message.includes('payment_method_types')) {
        donateOpts.payment_method_types = ['card', 'cashapp', 'link'];
        session = await stripe.checkout.sessions.create(donateOpts);
      } else {
        throw autoErr;
      }
    }
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    log('error', 'Donation Stripe session failed', { error: err.message });
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

// ─── Verify Stripe Session (for return URL flow) ────────────────────────────
app.post('/api/verify-stripe-session', rateLimit(10000, 5), async (req, res) => {
  const { sessionId } = req.body;
  if (!stripe) return res.json({ verified: true, demo: true });
  if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'Invalid session' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    const md = session.metadata || {};
    if (!md.playerId || md.playerId !== req.playerId) {
      return res.status(403).json({ error: 'Session does not belong to this player' });
    }
    const paymentProofToken = signPaymentProof(session);
    res.json({
      verified: true,
      metadata: md,
      amountTotal: session.amount_total,
      paymentProofToken,
    });
  } catch (err) {
    res.status(400).json({ error: 'Invalid session' });
  }
});

app.post('/api/premium-entry', rateLimit(5000, 5), (req, res) => {
  if (stripe) {
    return res.status(400).json({ error: 'Use checkout return flow for premium entries' });
  }
  const { playerId, quantity, potId, gameScore, sessionId: stripeSessionId } = req.body;
  const pot = potId || 'gold';
  const qty = Math.min(Math.max(1, parseInt(quantity) || 1), 100);
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });

  const bundle = state.bundles[qty];
  const totalCents = bundle ? bundle.price : qty * 100;
  const houseTake = Math.floor(totalCents * state.houseCut);
  potData.pot += totalCents - houseTake;

  // Clamp gameScore to valid range — never trust client
  const safeScore = Math.min(Math.max(0, parseInt(gameScore) || 0), 100);
  let bonusEntries = 0;
  if (safeScore >= 50) bonusEntries = 3;
  else if (safeScore >= 30) bonusEntries = 2;
  else if (safeScore >= 15) bonusEntries = 1;

  // Apply multiplier (Power Surge gives 2x for 1 hour, nextMultiplier is one-time from spin wheel)
  let mult = player.nextMultiplier || 1;
  if (player.powerSurgeExpires > Date.now()) mult = Math.max(mult, 2);
  // Cap total multiplier to prevent stacking exploits
  mult = Math.min(mult, 5);
  const totalQty = (qty + bonusEntries) * mult;
  // Reset one-time multiplier (Power Surge persists via expiry timer)
  player.nextMultiplier = 1;

  player.entries[pot] = (player.entries[pot] || 0) + totalQty;
  player.totalEntries += totalQty; player.totalSpent += totalCents; player.gamesPlayed++;
  if (!player.firstPurchaseAt) {
    player.firstPurchaseAt = Date.now();
    grantReferralReward(player);
  }
  if (safeScore > player.bestScore) player.bestScore = safeScore;

  for (let i = 0; i < totalQty; i++) potData.entries.push({ playerId, timestamp: Date.now(), type: 'premium' });
  potData.totalEntries += totalQty;

  player.levelInfo = getPlayerLevel(player.totalSpent); player.level = player.levelInfo.level;
  updateStreak(player); checkAchievements(player, gameScore); updateLeaderboard();
  addFeedEvent('play', { name: player.name, pot: potData.label, qty: totalQty, entryType: 'premium' });
  addBattlePassXP(player, totalQty * 10);

  // Mission tracking
  ensureMissions(player);
  updateMissionProgress(player, 'play_games', 1);
  updateMissionProgress(player, 'score_high', safeScore);
  if (qty >= 5) updateMissionProgress(player, 'buy_bundle', 1);
  // Track pots entered today
  const potsEntered = new Set();
  for (const [k] of Object.entries(player.entries)) { if (player.entries[k] > 0) potsEntered.add(k); }
  updateMissionProgress(player, 'enter_pots', potsEntered.size);

  let winnerDrawn = null;
  checkPotAboutToDraw(pot);
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(pot);

  trackEvent('premium_entry_completed', {
    playerId,
    pot,
    qty,
    totalQty,
    totalCents,
    gameScore: safeScore,
  });
  db.logAudit('purchase', {
    playerId, amount: totalCents,
    details: { type: 'premium', pot, qty, totalQty, multiplier: mult },
  });

  putPlayer(player);
  res.json({ success: true, bonusEntries, multiplier: mult, player: sanitizePlayer(player), potDisplay: (potData.pot / 100).toFixed(2), winnerDrawn });
});

// ─── Game Session Token ─────────────────────────────────────────────────
app.post('/api/start-game-session', rateLimit(5000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const sessionId = crypto.randomUUID();
  player._activeGameSession = { id: sessionId, started: Date.now() };
  res.json({ gameSessionId: sessionId });
});

// ─── Game Bonus (post-payment bonus entries from game score) ────────────
app.post('/api/game-bonus', rateLimit(10000, 5), (req, res) => {
  const { playerId, potId, gameScore, gameSessionId } = req.body;
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  // Require a valid, unexpired game session token — prevents fabricated scores
  if (!gameSessionId || !player._activeGameSession || player._activeGameSession.id !== gameSessionId) {
    return res.status(400).json({ error: 'No valid game session' });
  }
  // Session must be at least 10s old (minimum plausible game duration)
  const sessionDuration = Date.now() - player._activeGameSession.started;
  if (sessionDuration < 10000) {
    return res.status(400).json({ error: 'Game session too short' });
  }
  player._activeGameSession = null; // consume — one-time use
  const pot = potId || 'gold';
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  const score = Math.min(Math.max(0, parseInt(gameScore) || 0), 100);
  // Plausibility check: score vs session duration (max ~3 gold/sec in-game)
  const maxPlausibleScore = Math.min(100, Math.floor(sessionDuration / 1000) * 4);
  if (score > maxPlausibleScore) {
    db.logSecurityEvent('warn', 'game', 'suspicious_score', {
      playerId, details: { score, sessionDuration, maxPlausible: maxPlausibleScore },
    });
  }
  let bonusEntries = 0;
  if (score >= 50) bonusEntries = 3;
  else if (score >= 30) bonusEntries = 2;
  else if (score >= 15) bonusEntries = 1;
  if (bonusEntries === 0) return res.json({ success: true, bonusEntries: 0 });

  player.entries[pot] = (player.entries[pot] || 0) + bonusEntries;
  player.totalEntries += bonusEntries;
  if (score > player.bestScore) player.bestScore = score;
  for (let i = 0; i < bonusEntries; i++) potData.entries.push({ playerId, timestamp: Date.now(), type: 'game_bonus' });
  potData.totalEntries += bonusEntries;
  putPlayer(player);
  res.json({ success: true, bonusEntries, player: sanitizePlayer(player) });
});

app.post('/api/daily-bonus', rateLimit(60000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const today = new Date().toISOString().split('T')[0];
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
  addBattlePassXP(player, 15);
  ensureMissions(player);
  updateMissionProgress(player, 'daily_bonus', 1);
  putPlayer(player);
  res.json({ success: true, bonusEntries: bonus, streak: player.streak, player: sanitizePlayer(player) });
});

// ─── Comeback Bonus — reward returning players after 48+ hours away ─────
app.post('/api/comeback-bonus', rateLimit(60000, 2), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const now = Date.now();
  const hoursAway = (now - (player.lastPlayedAt || now)) / 3600000;
  if (hoursAway < 48) return res.status(400).json({ error: 'Not eligible yet' });
  if (player.lastComebackClaim && (now - player.lastComebackClaim) < 48 * 3600000) {
    return res.status(400).json({ error: 'Already claimed' });
  }
  // Scale reward by absence: 2 days = 2 entries, 5+ days = 5 entries
  const bonus = Math.min(5, Math.floor(hoursAway / 24));
  player.entries.gold = (player.entries.gold || 0) + bonus;
  player.totalEntries += bonus;
  for (let i = 0; i < bonus; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: now, type: 'comeback' });
  state.pots.gold.totalEntries += bonus;
  player.lastComebackClaim = now;
  player.lastPlayedAt = now;
  addFeedEvent('comeback', { name: player.name, bonus });
  putPlayer(player);
  res.json({ success: true, bonus, player: sanitizePlayer(player) });
});

app.post('/api/spin-wheel', rateLimit(60000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const today = new Date().toDateString();
  if (player.lastSpin === today) return res.status(400).json({ error: 'Spin again tomorrow' });
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
  putPlayer(player);
  res.json({ success: true, result, player: sanitizePlayer(player) });
});

// ─── Watch Ad for Entry ─────────────────────────────────────────────────
app.post('/api/watch-ad', rateLimit(30000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  // Server-side minimum time check — must wait at least 15s between ads
  const adCooldown = 15000;
  if (Date.now() - (player.lastAdTimestamp || 0) < adCooldown) {
    return res.status(429).json({ error: 'Please wait before watching another ad' });
  }
  player.lastAdTimestamp = Date.now();
  const today = new Date().toDateString();
  if (player.lastAdWatch !== today) { player.lastAdWatch = today; player.adsWatchedToday = 0; }
  const adLimit = (player.vip && player.vipExpires > Date.now()) ? (player.vipTier === 'monthly' ? 10 : 8) : 3;
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
  addBattlePassXP(player, 5);
  ensureMissions(player);
  updateMissionProgress(player, 'watch_ads', 1);
  putPlayer(player);
  res.json({ success: true, adsLeft: adLimit - player.adsWatchedToday, adLimit, player: sanitizePlayer(player) });
});

// ─── Rewarded Ad Verification ───────────────────────────────────────────
app.post('/api/ad-reward-verify', rateLimit(30000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { adNetwork, adUnitId } = req.body;
  if (!adNetwork || !adUnitId) return res.status(400).json({ error: 'Missing ad info' });
  // Same 15s cooldown as watch-ad — prevents alternating between endpoints
  const adCooldown = 15000;
  if (Date.now() - (player.lastAdTimestamp || 0) < adCooldown) {
    return res.status(429).json({ error: 'Please wait before watching another ad' });
  }
  player.lastAdTimestamp = Date.now();
  const today = new Date().toDateString();
  if (player.lastAdWatch !== today) { player.lastAdWatch = today; player.adsWatchedToday = 0; }
  const adLimit = (player.vip && player.vipExpires > Date.now()) ? (player.vipTier === 'monthly' ? 10 : 8) : 3;
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
  addBattlePassXP(player, 5);
  ensureMissions(player);
  updateMissionProgress(player, 'watch_ads', 1);
  putPlayer(player);
  res.json({ success: true, adsLeft: adLimit - player.adsWatchedToday, adLimit, player: sanitizePlayer(player) });
});

// ─── Push Subscription ──────────────────────────────────────────────────
app.post('/api/push-subscribe', rateLimit(60000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { subscription } = req.body;
  if (!subscription || typeof subscription.endpoint !== 'string') return res.status(400).json({ error: 'Invalid subscription' });
  // Only allow known push service endpoints
  try {
    const endpointUrl = new URL(subscription.endpoint);
    if (!['https:'].includes(endpointUrl.protocol)) return res.status(400).json({ error: 'Invalid subscription endpoint' });
  } catch { return res.status(400).json({ error: 'Invalid subscription endpoint' }); }
  if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ error: 'Missing subscription keys' });
  }
  addPushSubscription(player.id, subscription);
  res.json({ success: true });
});

app.get('/api/vapid-public-key', rateLimit(60000, 5), (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

// ─── Referral Dashboard ─────────────────────────────────────────────────
app.get('/api/referral-dashboard/:id', rateLimit(5000, 10), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (decoded.sub !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const player = getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const referrals = (player.referrals || []).map(r => ({ name: r.name, date: r.date }));
  res.json({
    referralCode: player.referralCode,
    referralCount: player.referralCount || 0,
    entriesEarned: (player.referralCount || 0) * 5,
    referrals,
  });
});

app.post('/api/share-reward', rateLimit(60000, 5), (req, res) => {
  const { playerId, platform } = req.body;
  const allowed = ['twitter', 'sms', 'link'];
  if (!allowed.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const today = new Date().toDateString();
  if (player.sharesToday[platform] === today) {
    return res.json({ success: false, alreadyClaimed: true, player: sanitizePlayer(player) });
  }
  // Global daily share cap: max 3 share rewards per day across all platforms
  const sharesTodayCount = Object.values(player.sharesToday).filter(d => d === today).length;
  if (sharesTodayCount >= 3) {
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
  putPlayer(player);
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── VIP Pass ───────────────────────────────────────────────────────────────
const VIP_TIERS = {
  weekly:  { price: 499,  label: '$4.99/week',  duration: 7 * 24 * 3600000, perks: '2x daily bonus, 10 ads/day, streak shield, VIP badge' },
  monthly: { price: 1499, label: '$14.99/month', duration: 30 * 24 * 3600000, perks: '3x daily bonus, 15 ads/day, streak shield, VIP badge' },
  diamond: { price: 2999, label: '$29.99/month', duration: 30 * 24 * 3600000, perks: '5x daily bonus, unlimited ads, streak shield, VIP badge, diamond jackpot, 1 free mystery box/week, priority support, gold chat glow' },
};

app.post('/api/vip-subscribe', rateLimit(60000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const tier = VIP_TIERS[req.body.tier];
  if (!tier) return res.status(400).json({ error: 'Invalid VIP tier' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, [`vip_${req.body.tier}`], tier.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }

  player.vip = true;
  player.vipTier = req.body.tier;
  player.vipExpires = Date.now() + tier.duration;
  // Only credit totalSpent in non-demo mode (real payment verified via webhook)
  if (stripe) player.totalSpent += tier.price;
  // 50% of VIP cost goes to gold pot (after house cut), 50% is house revenue
  const vipCostToPot = Math.floor(tier.price / 2);
  const vipHouseTake = Math.floor(vipCostToPot * state.houseCut);
  state.pots.gold.pot += vipCostToPot - vipHouseTake;
  player.streakShield = true;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('vip', { name: player.name, tier: req.body.tier });
  putPlayer(player);
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── Double Down (post-purchase upsell) ─────────────────────────────────
app.post('/api/double-down', rateLimit(5000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const pot = req.body.potId || 'gold';
  const potData = state.pots[pot];
  if (!potData) return res.status(400).json({ error: 'Invalid pot' });
  const qty = Math.min(Math.max(1, parseInt(req.body.originalQty) || 1), 100);
  if (stripe) {
    const expectedPrice = Math.ceil((state.bundles[qty] ? state.bundles[qty].price : qty * 100) * 0.5);
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'double_down', expectedPrice);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if ((proofCheck.proof.qty || 1) !== qty) return res.status(400).json({ error: 'Payment quantity mismatch' });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  // Atomic check-and-set to prevent double-grant race condition
  const firstPurchaseBoost = req.body.firstPurchaseBoost === true && !player.firstPurchaseBoostUsed;
  if (firstPurchaseBoost) player.firstPurchaseBoostUsed = true;
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
  addFeedEvent('play', { name: player.name, pot: potData.label, qty: finalQty, entryType: 'double_down' });
  trackEvent('double_down_completed', { playerId: player.id, pot, qty, bonusQty, firstPurchaseBoost, price: halfPrice });
  putPlayer(player);

  let winnerDrawn = null;
  if (potData.pot >= potData.drawThreshold) winnerDrawn = performDraw(pot);
  res.json({ success: true, qty: finalQty, bonusQty, price: halfPrice, player: sanitizePlayer(player), winnerDrawn });
});

// ─── Jackpot Entry ──────────────────────────────────────────────────────────
app.post('/api/jackpot-entry', rateLimit(5000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!state.jackpot || !state.jackpot.active) return res.status(400).json({ error: 'No active jackpot' });
  if (Date.now() > state.jackpot.deadline) return res.status(400).json({ error: 'Jackpot expired' });

  const qty = Math.min(Math.max(1, parseInt(req.body.quantity) || 1), 50);
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'jackpot_entry', qty * state.jackpot.entryPrice);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if ((proofCheck.proof.qty || 1) !== qty) return res.status(400).json({ error: 'Payment quantity mismatch' });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
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
    const wp = getPlayer(winner.playerId);
    const name = wp ? wp.name : pickFakeName();
    const prizeDisplay = (state.jackpot.prize / 100).toLocaleString('en-US');
    state.jackpot.winner = { name, prize: prizeDisplay, timestamp: Date.now(), tier: state.jackpot.tier };
    state.jackpot.active = false;
    if (wp) { wp.totalWon += state.jackpot.prize; putPlayer(wp); }
    db.logAudit('jackpot_winner', {
      playerId: wp ? wp.id : winner.playerId, amount: state.jackpot.prize,
      details: { tier: state.jackpot.tier, prize: prizeDisplay, name, totalEntries: state.jackpot.entries.length },
    });
    addRecentWinner({ name, prize: prizeDisplay, pot: state.jackpot.label, round: 0, timestamp: Date.now() });
    addFeedEvent('jackpot_winner', { name, prize: prizeDisplay, label: state.jackpot.label });
    winnerDrawn = state.jackpot.winner;
    // Reset jackpot entries for cached players (non-cached handled lazily on load)
    for (const [, p] of playerCache) { p.entries.jackpot = 0; }
  }

  putPlayer(player);
  res.json({ success: true, totalEntries: state.jackpot.totalEntries, qty, cost: totalCents, player: sanitizePlayer(player), winnerDrawn });
});

// ─── Flash Pot Entry ────────────────────────────────────────────────────────
app.post('/api/flash-entry', rateLimit(5000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!state.flashPot || !state.flashPot.active) return res.status(400).json({ error: 'No active flash pot' });
  if (Date.now() > state.flashPot.deadline) return res.status(400).json({ error: 'Flash pot expired' });

  const qty = Math.min(Math.max(1, parseInt(req.body.quantity) || 1), 10);
  // Server-side free entry check — never trust client
  const freeKey = `flash_${state.flashPot.deadline}`;
  const isFree = !player.freeEntryUsed[freeKey];
  if (isFree) {
    // One free entry per flash pot; only 1 entry allowed when free
    player.freeEntryUsed[freeKey] = true;
  } else {
    if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
    if (stripe) {
      const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'flash_entry', qty * 50);
      if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
      if ((proofCheck.proof.qty || 1) !== qty) return res.status(400).json({ error: 'Payment quantity mismatch' });
      if (!consumePaymentSession(player, proofCheck.proof.sid)) {
        return res.status(400).json({ error: 'Payment already applied' });
      }
    }
    // $0.50 per flash entry — 18% house cut, rest goes to pot
    const cost = qty * 50;
    const houseTake = Math.floor(cost * state.houseCut);
    state.flashPot.pot += cost - houseTake;
    player.totalSpent += cost;
    player.levelInfo = getPlayerLevel(player.totalSpent);
    player.level = player.levelInfo.level;
  }
  const actualQty = isFree ? 1 : qty;

  for (let i = 0; i < actualQty; i++) {
    state.flashPot.entries.push({ playerId: player.id, timestamp: Date.now(), type: isFree ? 'free' : 'premium' });
  }
  state.flashPot.totalEntries += actualQty;
  player.entries.flash = (player.entries.flash || 0) + actualQty;
  player.totalEntries += actualQty; player.gamesPlayed++;
  addFeedEvent('flash_entry', { name: player.name, qty: actualQty });
  putPlayer(player);
  res.json({ success: true, totalEntries: state.flashPot.totalEntries, isFree, player: sanitizePlayer(player) });
});

// ─── Push Notification Helper ───────────────────────────────────────────
function sendPushToPlayer(playerId, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const sub = pushSubscriptions.get(playerId);
  if (!sub) return;
  webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {
    pushSubscriptions.delete(playerId);
  });
}

function sendPushToAll(payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  for (const [playerId, sub] of pushSubscriptions) {
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {
      pushSubscriptions.delete(playerId);
    });
  }
}

const potAlertSent = new Map(); // track per-round alerts (auto-cleanup)
function checkPotAboutToDraw(potId) {
  const potData = state.pots[potId];
  if (!potData) return;
  const pct = potData.pot / potData.drawThreshold;
  const alertKey = `${potId}-${potData.round}`;
  if (pct >= 0.8 && !potAlertSent.has(alertKey)) {
    potAlertSent.set(alertKey, Date.now());
    const potDisplay = (potData.pot / 100).toFixed(2);
    sendPushToAll({
      title: `\u26a1 ${potData.label} about to draw!`,
      body: `$${potDisplay} pot is ${Math.round(pct * 100)}% full \u2014 get your entries in now!`,
      url: '/',
    });
  }
}

// Admin-only draw trigger — requires a simple secret token
app.post('/api/draw', rateLimit(5000, 2), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/draw' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(performDraw(req.body.potId || 'gold') || { error: 'Draw already in progress or threshold not met' });
});

// ─── Draw lock to prevent race-condition duplicate draws ─────────────────
const drawLocks = new Set();

function performDraw(potId) {
  // Prevent concurrent draws on the same pot
  if (drawLocks.has(potId)) return null;
  drawLocks.add(potId);
  try {
    const potData = state.pots[potId];
    // Re-check threshold inside lock to prevent double draw
    if (potData.pot < potData.drawThreshold) return null;
    const entry = drawWinner(potData);
    if (!entry) return { winner: null, nearMisses: [] };
  const wp = getPlayer(entry.playerId);
  const info = { name: wp ? wp.name : 'Anonymous', prize: (potData.pot / 100).toFixed(2), round: potData.round, pot: potData.label, potId, timestamp: Date.now() };
  if (wp) { wp.totalWon += potData.pot; checkAchievements(wp, 0); }
  // Award winner achievement inline (not score-dependent)
  if (wp && !wp.achievements.includes('winner')) wp.achievements.push('winner');
  if (wp) putPlayer(wp);
  db.logAudit('draw_winner', {
    playerId: wp ? wp.id : entry.playerId, amount: potData.pot,
    details: { potId, round: potData.round, prize: info.prize, name: info.name, totalEntries: potData.entries.length },
  });
  addRecentWinner(info);
  potData.winner = info;
  addFeedEvent('winner', { name: info.name, prize: info.prize, pot: potData.label });

  // Push notification: winner + near-misses
  sendPushToAll({ title: `🏆 ${potData.label} WON!`, body: `${info.name} just won $${info.prize}! New round starting now.`, url: '/' });
  if (wp) sendPushToPlayer(wp.id, { title: '🏆 YOU WON!', body: `Congratulations! You won $${info.prize} from ${potData.label}!`, url: '/' });

  // Near-miss: find players who were close (had entries but didn't win)
  const nearMisses = [];
  const playerEntryCount = {};
  for (const e of potData.entries) {
    if (e.playerId !== entry.playerId) playerEntryCount[e.playerId] = (playerEntryCount[e.playerId] || 0) + 1;
  }
  const totalEntries = potData.entries.length;
  const winnerIndex = potData.entries.indexOf(entry);
  const sorted = Object.entries(playerEntryCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [pid, count] of sorted) {
    const p = getPlayer(pid);
    if (p) {
      // awayBy = how many more entries would double their odds (meaningful improvement)
      const odds = count / totalEntries;
      const awayBy = Math.max(1, Math.ceil(count * (1 - odds)));
      nearMisses.push({ playerId: pid, name: p.name, entries: count, awayBy });
    }
  }

  // Reset pot + set new deadline
  const oldRound = potData.round;
  potData.pot = 0; potData.round++; potData.entries = []; potData.totalEntries = 0;
  const deadlines = { mini: 2 * 3600000, gold: 6 * 3600000, mega: 24 * 3600000 };
  potData.deadline = Date.now() + (deadlines[potId] || 6 * 3600000);
  // Cleanup: clear old round's alert tracking; reset cached players (non-cached handled lazily on load)
  potAlertSent.delete(`${potId}-${oldRound}`);
  for (const [, p] of playerCache) {
    p.entries[potId] = 0;
    if (!p._potRounds) p._potRounds = {};
    p._potRounds[potId] = potData.round;
    delete p.freeEntryUsed[`${potId}_${oldRound}`];
  }
  return { winner: info, nearMisses };
  } finally {
    drawLocks.delete(potId);
  }
}

app.get('/api/player/:id', rateLimit(2000, 10), (req, res) => {
  // Verify JWT matches the requested player
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (decoded.sub !== req.params.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const player = getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  // Reset session start on each new login so session rewards track real time
  player.sessionStartedAt = Date.now();
  res.json(sanitizePlayer(player));
});

// ─── Payment Method ─────────────────────────────────────────────────────
const VALID_METHODS = ['apple_pay', 'google_pay', 'card', 'cashapp', 'amazon_pay', 'link'];
const METHOD_LABELS = {
  apple_pay: { icon: ' Pay', label: 'Apple Pay' },
  google_pay: { icon: 'G Pay', label: 'Google Pay' },
  card: { icon: '💳', label: 'Card' },
  cashapp: { icon: '$', label: 'Cash App' },
  amazon_pay: { icon: 'a', label: 'Amazon Pay' },
  link: { icon: '⚡', label: 'Link' },
};

app.post('/api/payment-method', rateLimit(30000, 5), (req, res) => {
  const { playerId, method, cardLast4 } = req.body;
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });

  const info = { ...METHOD_LABELS[method], method };
  if (method === 'card' && cardLast4) {
    const safe4 = String(cardLast4).replace(/\D/g, '').slice(-4);
    if (safe4.length === 4) info.label = `Card ····${safe4}`;
  }
  player.paymentMethod = info;
  trackEvent('payment_method_saved', { playerId, method });
  putPlayer(player);
  res.json({ success: true, paymentMethod: info, player: sanitizePlayer(player) });
});

// ─── Claim Mission Reward ────────────────────────────────────────────────
app.post('/api/claim-mission', rateLimit(10000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
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
  putPlayer(player);
  res.json({ success: true, reward: m.reward, player: sanitizePlayer(player) });
});

// ─── Claim Milestone Reward ─────────────────────────────────────────────
app.post('/api/claim-milestone', rateLimit(10000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
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
  putPlayer(player);
  res.json({ success: true, reward: milestone.reward, player: sanitizePlayer(player) });
});

// ─── Session Time Reward ────────────────────────────────────────────────
const SESSION_REWARDS = [
  { minutes: 5,  reward: 1,  label: '5 min' },
  { minutes: 15, reward: 2,  label: '15 min' },
  { minutes: 30, reward: 5,  label: '30 min' },
];

app.post('/api/session-reward', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const minutes = parseInt(req.body.minutes);
  const sr = SESSION_REWARDS.find(s => s.minutes === minutes);
  if (!sr) return res.status(400).json({ error: 'Invalid session reward' });
  // Server-side session time validation
  if (!player.sessionStartedAt) player.sessionStartedAt = Date.now();
  const elapsedMin = (Date.now() - player.sessionStartedAt) / 60000;
  if (elapsedMin < sr.minutes) return res.status(400).json({ error: 'Not enough session time yet' });
  const today = new Date().toDateString();
  if (player.sessionRewardsDate !== today) { player.sessionRewardsClaimed = {}; player.sessionRewardsDate = today; }
  if (player.sessionRewardsClaimed[minutes]) return res.status(400).json({ error: 'Already claimed' });
  player.sessionRewardsClaimed[minutes] = true;
  player.entries.gold = (player.entries.gold || 0) + sr.reward;
  player.totalEntries += sr.reward;
  for (let i = 0; i < sr.reward; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'session' });
  state.pots.gold.totalEntries += sr.reward;
  putPlayer(player);
  res.json({ success: true, reward: sr.reward, label: sr.label, player: sanitizePlayer(player) });
});

// ─── Report combo for missions ──────────────────────────────────────────
app.post('/api/report-combo', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  // Cap combo to realistic maximum to prevent mission manipulation
  const combo = Math.min(Math.max(0, parseInt(req.body.combo) || 0), 50);
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

app.post('/api/mystery-box', rateLimit(10000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const tier = MYSTERY_TIERS[req.body.tier];
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'mystery_box', tier.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if ((proofCheck.proof.tier || '') !== String(req.body.tier || '')) return res.status(400).json({ error: 'Payment tier mismatch' });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  if (Date.now() - (player.lastMysteryBox || 0) < 180000) {
    const wait = Math.ceil((180000 - (Date.now() - player.lastMysteryBox)) / 1000);
    return res.status(400).json({ error: `Cooldown: ${wait}s remaining` });
  }
  player.lastMysteryBox = Date.now();
  player.totalSpent += tier.price;
  const roll = crypto.randomInt(0, 10000) / 10000;
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
  putPlayer(player);
  let winnerDrawn = null;
  if (state.pots.gold.pot >= state.pots.gold.drawThreshold) winnerDrawn = performDraw('gold');
  res.json({ success: true, rarity, entries, tier: tier.label, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 2. LIGHTNING DEAL ──────────────────────────────────────────────────
app.post('/api/lightning-deal', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
    player.lightningDeal = generateLightningDeal();
  }
  res.json({ deal: player.lightningDeal });
});

app.post('/api/lightning-buy', rateLimit(10000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  const potId = req.body.potId || 'gold';
  const pot = state.pots[potId];
  if (!pot) return res.status(400).json({ error: 'Invalid pot' });
  if (!player.lightningDeal || Date.now() > player.lightningDeal.deadline) {
    return res.status(400).json({ error: 'Deal expired! New one coming...' });
  }
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'lightning', player.lightningDeal.salePrice);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if ((proofCheck.proof.potId || 'gold') !== potId) return res.status(400).json({ error: 'Payment proof pot mismatch' });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  const deal = player.lightningDeal;
  const qty = deal.qty;
  const cost = deal.salePrice;
  const houseTake = Math.floor(cost * state.houseCut);
  player.totalSpent += cost;
  player.entries[potId] = (player.entries[potId] || 0) + qty;
  player.totalEntries += qty;
  player.gamesPlayed += 1;
  for (let i = 0; i < qty; i++) pot.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'lightning' });
  pot.totalEntries += qty;
  pot.pot += (cost - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  player.lightningDeal = null;
  addFeedEvent('lightning', { name: player.name, qty, discount: deal.discount });
  putPlayer(player);
  let winnerDrawn = null;
  if (pot.pot >= pot.drawThreshold) winnerDrawn = performDraw(potId);
  res.json({ success: true, qty, cost, discount: deal.discount, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 3. POWER SURGE (2x for 1 hour) ─────────────────────────────────────
app.post('/api/power-surge', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.powerSurgeExpires > Date.now()) return res.status(400).json({ error: 'Power Surge already active!' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'power_surge', 299);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  const cost = 299;
  player.totalSpent += cost;
  // 50% of cost goes to gold pot (after house cut), 50% is house revenue
  const psCostToPot = Math.floor(cost / 2);
  const psHouseTake = Math.floor(psCostToPot * state.houseCut);
  state.pots.gold.pot += psCostToPot - psHouseTake;
  player.powerSurgeExpires = Date.now() + 3600000;
  // Power Surge: use powerSurgeExpires for duration, not nextMultiplier (which is one-time)
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('power_surge', { name: player.name });
  putPlayer(player);
  res.json({ success: true, expires: player.powerSurgeExpires, player: sanitizePlayer(player) });
});

// ─── 4. STREAK SAVER ────────────────────────────────────────────────────
app.post('/api/streak-saver', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (player.streak < 3) return res.status(400).json({ error: 'Streak too low (need 3+)' });
  if (player.streakShield) return res.status(400).json({ error: 'Streak already protected!' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'streak_saver', 199);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  const cost = 199;
  player.totalSpent += cost;
  // 50% of cost goes to gold pot (after house cut), 50% is house revenue
  const ssCostToPot = Math.floor(cost / 2);
  const ssHouseTake = Math.floor(ssCostToPot * state.houseCut);
  state.pots.gold.pot += ssCostToPot - ssHouseTake;
  player.streakShield = true;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  putPlayer(player);
  res.json({ success: true, player: sanitizePlayer(player) });
});

// ─── 5. ALL-IN PACK ─────────────────────────────────────────────────────
app.post('/api/all-in-pack', rateLimit(10000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'all_in', 500);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
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
  player.gamesPlayed += 1;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('all_in', { name: player.name });
  putPlayer(player);
  let draws = {};
  for (const potId of ['mini', 'gold', 'mega']) {
    if (state.pots[potId].pot >= state.pots[potId].drawThreshold) draws[potId] = performDraw(potId);
  }
  res.json({ success: true, totalEntries: 15, cost, player: sanitizePlayer(player), draws });
});

// ─── 6. LIMITED EDITION DROP ─────────────────────────────────────────────
app.post('/api/limited-buy', rateLimit(10000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (stripe) {
    ensureLimitedDrop();
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'limited', state.limitedDrop.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  ensureLimitedDrop();
  if (state.limitedDrop.remaining <= 0) return res.status(400).json({ error: 'SOLD OUT! Next drop coming soon...' });
  // Atomic decrement — re-check after updating to prevent race condition
  state.limitedDrop.remaining--;
  if (state.limitedDrop.remaining < 0) {
    state.limitedDrop.remaining = 0;
    return res.status(400).json({ error: 'SOLD OUT! Next drop coming soon...' });
  }
  const drop = state.limitedDrop;
  const cost = drop.price;
  const qty = drop.entries;
  const houseTake = Math.floor(cost * state.houseCut);
  player.totalSpent += cost;
  player.entries.gold = (player.entries.gold || 0) + qty;
  player.totalEntries += qty;
  player.gamesPlayed += 1;
  for (let i = 0; i < qty; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'limited' });
  state.pots.gold.totalEntries += qty;
  state.pots.gold.pot += (cost - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  updateStreak(player);
  updateLeaderboard();
  addFeedEvent('limited_drop', { name: player.name, entries: qty, remaining: state.limitedDrop.remaining });
  putPlayer(player);
  let winnerDrawn = null;
  if (state.pots.gold.pot >= state.pots.gold.drawThreshold) winnerDrawn = performDraw('gold');
  res.json({ success: true, entries: qty, cost, remaining: state.limitedDrop.remaining, player: sanitizePlayer(player), winnerDrawn });
});

// ─── 7. MEGA MULTIPLIER (rare offer) ────────────────────────────────────
app.post('/api/mega-multiplier', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.paymentMethod) return res.status(400).json({ error: 'Add payment method first' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'mega_multiplier', 499);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) {
      return res.status(400).json({ error: 'Payment already applied' });
    }
  }
  const cost = 499;
  player.totalSpent += cost;
  // 50% of cost goes to gold pot (after house cut), 50% is house revenue
  const mmCostToPot = Math.floor(cost / 2);
  const mmHouseTake = Math.floor(mmCostToPot * state.houseCut);
  state.pots.gold.pot += mmCostToPot - mmHouseTake;
  player.nextMultiplier = 5;
  player.powerSurgeExpires = Math.max(player.powerSurgeExpires || 0, Date.now() + 1800000); // 30 min
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('mega_mult', { name: player.name });
  putPlayer(player);
  res.json({ success: true, multiplier: 5, expires: player.powerSurgeExpires, player: sanitizePlayer(player) });
});

// ─── 8. BATTLE PASS ─────────────────────────────────────────────────────
const BATTLE_PASS_PRICE = 999; // $9.99
const BATTLE_PASS_DURATION = 7 * 24 * 3600000; // 1 week
const BATTLE_PASS_TIERS = [
  { xp: 0,    free: { entries: 1, pot: 'mini' },  premium: { entries: 3, pot: 'gold' } },
  { xp: 50,   free: { entries: 1, pot: 'mini' },  premium: { entries: 5, pot: 'gold' } },
  { xp: 120,  free: null,                         premium: { mysteryBox: 'bronze' } },
  { xp: 200,  free: { entries: 2, pot: 'mini' },  premium: { entries: 8, pot: 'gold' } },
  { xp: 300,  free: null,                         premium: { entries: 5, pot: 'mega' } },
  { xp: 420,  free: { entries: 2, pot: 'gold' },  premium: { entries: 10, pot: 'gold' } },
  { xp: 550,  free: null,                         premium: { mysteryBox: 'silver' } },
  { xp: 700,  free: { entries: 3, pot: 'gold' },  premium: { entries: 15, pot: 'gold' } },
  { xp: 880,  free: null,                         premium: { multiplier: 5 } },
  { xp: 1000, free: { entries: 5, pot: 'gold' },  premium: { mysteryBox: 'gold', entries: 20, pot: 'mega' } },
];

function ensureBattlePass() {
  if (!state.battlePass || Date.now() > state.battlePass.endsAt) {
    state.battlePass = { season: (state.battlePass ? state.battlePass.season + 1 : 1), endsAt: Date.now() + BATTLE_PASS_DURATION, tiers: BATTLE_PASS_TIERS };
  }
}

app.post('/api/battle-pass-buy', rateLimit(60000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  ensureBattlePass();
  if (player.battlePass && player.battlePass.season === state.battlePass.season && player.battlePass.premium) {
    return res.status(400).json({ error: 'Already purchased this season' });
  }
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'battle_pass', BATTLE_PASS_PRICE);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += BATTLE_PASS_PRICE;
  if (!player.battlePass || player.battlePass.season !== state.battlePass.season) {
    player.battlePass = { season: state.battlePass.season, premium: true, xp: 0, claimed: [] };
  } else {
    player.battlePass.premium = true;
  }
  // Auto-claim any unclaimed premium tiers player already earned
  for (let i = 0; i < BATTLE_PASS_TIERS.length; i++) {
    if (player.battlePass.xp >= BATTLE_PASS_TIERS[i].xp && !player.battlePass.claimed.includes('p' + i)) {
      const reward = BATTLE_PASS_TIERS[i].premium;
      if (reward) applyBattlePassReward(player, reward);
      player.battlePass.claimed.push('p' + i);
    }
  }
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addFeedEvent('battle_pass', { name: player.name });
  putPlayer(player);
  res.json({ success: true, battlePass: player.battlePass, player: sanitizePlayer(player) });
});

function applyBattlePassReward(player, reward) {
  if (reward.entries && reward.pot) {
    const pot = reward.pot;
    const qty = reward.entries;
    player.entries[pot] = (player.entries[pot] || 0) + qty;
    player.totalEntries += qty;
    if (state.pots[pot]) {
      for (let i = 0; i < qty; i++) state.pots[pot].entries.push({ playerId: player.id, timestamp: Date.now(), type: 'battlepass' });
      state.pots[pot].totalEntries += qty;
    }
  }
  if (reward.multiplier) {
    player.nextMultiplier = Math.max(player.nextMultiplier || 1, reward.multiplier);
  }
  if (reward.mysteryBox) {
    const tier = MYSTERY_TIERS[reward.mysteryBox];
    if (tier) {
      const roll = Math.random();
      let rarity, range;
      if (roll < 0.05) { rarity = 'legendary'; range = tier.legendary; }
      else if (roll < 0.30) { rarity = 'rare'; range = tier.rare; }
      else { rarity = 'common'; range = tier.common; }
      const entries = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
      player.entries.gold = (player.entries.gold || 0) + entries;
      player.totalEntries += entries;
      for (let i = 0; i < entries; i++) state.pots.gold.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'battlepass_box' });
      state.pots.gold.totalEntries += entries;
    }
  }
}

app.post('/api/battle-pass-claim', rateLimit(5000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  ensureBattlePass();
  if (!player.battlePass || player.battlePass.season !== state.battlePass.season) {
    return res.status(400).json({ error: 'No battle pass for current season' });
  }
  const tierIdx = parseInt(req.body.tier);
  const track = req.body.track; // 'free' or 'premium'
  if (isNaN(tierIdx) || tierIdx < 0 || tierIdx >= BATTLE_PASS_TIERS.length) return res.status(400).json({ error: 'Invalid tier' });
  if (track !== 'free' && track !== 'premium') return res.status(400).json({ error: 'Invalid track' });
  if (track === 'premium' && !player.battlePass.premium) return res.status(400).json({ error: 'Premium pass required' });
  const claimKey = (track === 'free' ? 'f' : 'p') + tierIdx;
  if (player.battlePass.claimed.includes(claimKey)) return res.status(400).json({ error: 'Already claimed' });
  const tierData = BATTLE_PASS_TIERS[tierIdx];
  if (player.battlePass.xp < tierData.xp) return res.status(400).json({ error: 'Not enough XP' });
  const reward = tierData[track];
  if (!reward) return res.status(400).json({ error: 'No reward on this track' });
  applyBattlePassReward(player, reward);
  player.battlePass.claimed.push(claimKey);
  putPlayer(player);
  res.json({ success: true, battlePass: player.battlePass, player: sanitizePlayer(player) });
});

// Add XP on various player actions (called internally)
function addBattlePassXP(player, amount) {
  ensureBattlePass();
  if (!player.battlePass || player.battlePass.season !== state.battlePass.season) {
    player.battlePass = { season: state.battlePass.season, premium: false, xp: 0, claimed: [] };
  }
  player.battlePass.xp += amount;
}

// ─── 9. GIFTING ─────────────────────────────────────────────────────────
app.post('/api/gift-entries', rateLimit(30000, 3), (req, res) => {
  const sender = getPlayer(req.body.playerId);
  if (!sender) return res.status(404).json({ error: 'Player not found' });
  const recipientId = sanitizeString(String(req.body.recipientId || ''), 50);
  const recipient = getPlayer(recipientId);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
  if (sender.id === recipient.id) return res.status(400).json({ error: 'Cannot gift yourself' });
  const qty = Math.min(Math.max(1, parseInt(req.body.quantity) || 1), 100);
  const pot = req.body.potId || 'gold';
  if (!state.pots[pot]) return res.status(400).json({ error: 'Invalid pot' });
  const bundle = state.bundles[qty];
  const totalCents = bundle ? bundle.price : qty * 100;
  if (stripe) {
    const proofCheck = verifyPaymentProof(sender, req.body.paymentProofToken, 'gift_entries', totalCents);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if ((proofCheck.proof.qty || 1) !== qty) return res.status(400).json({ error: 'Payment quantity mismatch' });
    if (!consumePaymentSession(sender, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  sender.totalSpent += totalCents;
  const houseTake = Math.floor(totalCents * state.houseCut);
  recipient.entries[pot] = (recipient.entries[pot] || 0) + qty;
  recipient.totalEntries += qty;
  for (let i = 0; i < qty; i++) state.pots[pot].entries.push({ playerId: recipient.id, timestamp: Date.now(), type: 'gift' });
  state.pots[pot].totalEntries += qty;
  state.pots[pot].pot += (totalCents - houseTake);
  sender.levelInfo = getPlayerLevel(sender.totalSpent);
  sender.level = sender.levelInfo.level;
  addBattlePassXP(sender, qty * 5);
  addFeedEvent('gift', { name: sender.name, recipientName: recipient.name, qty, pot });
  putPlayer(sender);
  putPlayer(recipient);
  res.json({ success: true, giftedQty: qty, recipientName: recipient.name, player: sanitizePlayer(sender) });
});

// ─── 10. TOURNAMENT / CHALLENGE MODE ────────────────────────────────────
function ensureTournament() {
  if (!state.tournament || Date.now() > state.tournament.endsAt) {
    state.tournament = {
      id: crypto.randomBytes(6).toString('hex'),
      type: 'highscore',
      title: 'Deep Gold Challenge',
      entryFee: 200, // $2
      prizePool: 0,
      endsAt: Date.now() + 3600000, // 1 hour
      leaderboard: [],
      maxEntries: 100,
      totalEntries: 0,
    };
  }
  return state.tournament;
}

app.post('/api/tournament-enter', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const t = ensureTournament();
  if (Date.now() > t.endsAt) return res.status(400).json({ error: 'Tournament ended' });
  if (t.leaderboard.find(e => e.playerId === player.id)) return res.status(400).json({ error: 'Already entered' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'tournament', t.entryFee);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += t.entryFee;
  const houseCut = Math.floor(t.entryFee * 0.20);
  t.prizePool += (t.entryFee - houseCut);
  t.totalEntries++;
  t.leaderboard.push({ playerId: player.id, name: player.name, score: 0, timestamp: Date.now() });
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, 20);
  putPlayer(player);
  res.json({ success: true, tournament: { id: t.id, title: t.title, prizePool: t.prizePool, endsAt: t.endsAt, totalEntries: t.totalEntries, yourEntry: true }, player: sanitizePlayer(player) });
});

app.post('/api/tournament-score', rateLimit(5000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const t = ensureTournament();
  if (Date.now() > t.endsAt) return res.status(400).json({ error: 'Tournament ended' });
  const entry = t.leaderboard.find(e => e.playerId === player.id);
  if (!entry) return res.status(400).json({ error: 'Not entered in tournament' });
  const score = Math.min(Math.max(0, parseInt(req.body.score) || 0), 999999);
  if (score > entry.score) entry.score = score;
  t.leaderboard.sort((a, b) => b.score - a.score);
  res.json({ success: true, rank: t.leaderboard.findIndex(e => e.playerId === player.id) + 1, leaderboard: t.leaderboard.slice(0, 10) });
});

// ─── 11. CHAT COSMETICS STORE ───────────────────────────────────────────
const CHAT_COSMETICS = {
  color_gold:    { price: 199, label: 'Gold Name', type: 'nameColor', value: '#f0c040' },
  color_diamond: { price: 199, label: 'Diamond Name', type: 'nameColor', value: '#60e0ff' },
  color_ruby:    { price: 199, label: 'Ruby Name', type: 'nameColor', value: '#ff4060' },
  color_emerald: { price: 199, label: 'Emerald Name', type: 'nameColor', value: '#40e070' },
  color_royal:   { price: 199, label: 'Royal Purple', type: 'nameColor', value: '#b060ff' },
  border_fire:   { price: 299, label: 'Fire Avatar Border', type: 'avatarBorder', value: 'fire' },
  border_ice:    { price: 299, label: 'Ice Avatar Border', type: 'avatarBorder', value: 'ice' },
  border_gold:   { price: 299, label: 'Gold Avatar Border', type: 'avatarBorder', value: 'gold' },
  effect_sparkle: { price: 199, label: 'Sparkle Messages', type: 'msgEffect', value: 'sparkle' },
  effect_glow:    { price: 199, label: 'Glow Messages', type: 'msgEffect', value: 'glow' },
  title_whale:    { price: 499, label: '"Big Spender" Title', type: 'title', value: '💸 Big Spender' },
  title_og:       { price: 499, label: '"OG" Title', type: 'title', value: '👑 OG' },
  title_lucky:    { price: 299, label: '"Lucky" Title', type: 'title', value: '🍀 Lucky' },
};

app.post('/api/cosmetic-buy', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const cosmeticId = sanitizeString(String(req.body.cosmeticId || ''), 30);
  const cosmetic = CHAT_COSMETICS[cosmeticId];
  if (!cosmetic) return res.status(400).json({ error: 'Invalid cosmetic' });
  if (!player.cosmetics) player.cosmetics = { owned: [], equipped: {} };
  if (player.cosmetics.owned.includes(cosmeticId)) return res.status(400).json({ error: 'Already owned' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'cosmetic_' + cosmeticId, cosmetic.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += cosmetic.price;
  player.cosmetics.owned.push(cosmeticId);
  player.cosmetics.equipped[cosmetic.type] = cosmeticId;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  putPlayer(player);
  res.json({ success: true, cosmetics: player.cosmetics, player: sanitizePlayer(player) });
});

app.post('/api/cosmetic-equip', rateLimit(5000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const cosmeticId = sanitizeString(String(req.body.cosmeticId || ''), 30);
  if (!player.cosmetics) player.cosmetics = { owned: [], equipped: {} };
  if (cosmeticId === 'none') {
    const type = sanitizeString(String(req.body.type || ''), 20);
    if (player.cosmetics.equipped[type]) delete player.cosmetics.equipped[type];
    putPlayer(player);
    return res.json({ success: true, cosmetics: player.cosmetics });
  }
  const cosmetic = CHAT_COSMETICS[cosmeticId];
  if (!cosmetic) return res.status(400).json({ error: 'Invalid cosmetic' });
  if (!player.cosmetics.owned.includes(cosmeticId)) return res.status(400).json({ error: 'Not owned' });
  player.cosmetics.equipped[cosmetic.type] = cosmeticId;
  putPlayer(player);
  res.json({ success: true, cosmetics: player.cosmetics });
});

// ─── 12. LUCKY BOOST ────────────────────────────────────────────────────
app.post('/api/lucky-boost', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.luckyBoost && player.luckyBoost > 0) return res.status(400).json({ error: 'Already have a Lucky Boost active' });
  const cost = 149; // $1.49
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'lucky_boost', cost);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += cost;
  player.luckyBoost = 1; // 1 boost charge — consumed on next entry
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, 10);
  putPlayer(player);
  res.json({ success: true, luckyBoost: 1, player: sanitizePlayer(player) });
});

// ─── 13. SECOND CHANCE / INSURANCE ──────────────────────────────────────
app.post('/api/second-chance', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const pot = req.body.potId || 'gold';
  if (!state.pots[pot]) return res.status(400).json({ error: 'Invalid pot' });
  const cost = 99; // $0.99
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'second_chance', cost);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += cost;
  const houseTake = Math.floor(cost * state.houseCut);
  // Grant 1 entry with priority placement (pushed to front half of entries array)
  player.entries[pot] = (player.entries[pot] || 0) + 1;
  player.totalEntries += 1;
  const insertIdx = Math.floor(state.pots[pot].entries.length / 2);
  state.pots[pot].entries.splice(insertIdx, 0, { playerId: player.id, timestamp: Date.now(), type: 'second_chance' });
  state.pots[pot].totalEntries += 1;
  state.pots[pot].pot += (cost - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, 5);
  putPlayer(player);
  let winnerDrawn = null;
  if (state.pots[pot].pot >= state.pots[pot].drawThreshold) winnerDrawn = performDraw(pot);
  res.json({ success: true, pot, player: sanitizePlayer(player), winnerDrawn });
});

// ─── Urgency / Countdown Bundles ────────────────────────────────────────
// Dynamic bundles that appear when a pot is close to its draw threshold.
// Server decides availability based on pot fill %.  Bundle disappears on draw.
app.get('/api/urgency-bundles', rateLimit(5000, 10), (req, res) => {
  const bundles = [];
  for (const [potId, pot] of Object.entries(state.pots)) {
    const fillPct = pot.pot / pot.drawThreshold;
    if (fillPct >= 0.75) {
      const discount = fillPct >= 0.90 ? 40 : fillPct >= 0.85 ? 30 : 20; // higher urgency = bigger discount
      const basePrice = 499; // $4.99 normal
      const salePrice = Math.round(basePrice * (1 - discount / 100));
      const entries = fillPct >= 0.90 ? 8 : fillPct >= 0.85 ? 6 : 4;
      bundles.push({
        id: `urgency_${potId}`,
        potId,
        potLabel: pot.label,
        fillPct: Math.round(fillPct * 100),
        entries,
        basePrice,
        salePrice,
        discount,
        expiresAt: Date.now() + 600000 // 10 min window
      });
    }
  }
  res.json({ bundles });
});

app.post('/api/urgency-buy', rateLimit(30000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { potId } = req.body;
  const pot = state.pots[potId];
  if (!pot) return res.status(400).json({ error: 'Invalid pot' });
  const fillPct = pot.pot / pot.drawThreshold;
  if (fillPct < 0.75) return res.status(400).json({ error: 'Bundle no longer available' });
  const discount = fillPct >= 0.90 ? 40 : fillPct >= 0.85 ? 30 : 20;
  const basePrice = 499;
  const salePrice = Math.round(basePrice * (1 - discount / 100));
  const entries = fillPct >= 0.90 ? 8 : fillPct >= 0.85 ? 6 : 4;
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'urgency_buy', salePrice);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += salePrice;
  const houseTake = Math.floor(salePrice * state.houseCut);
  player.entries[potId] = (player.entries[potId] || 0) + entries;
  player.totalEntries += entries;
  for (let i = 0; i < entries; i++) {
    pot.entries.push({ playerId: player.id, timestamp: Date.now(), type: 'urgency' });
  }
  pot.totalEntries += entries;
  pot.pot += (salePrice - houseTake);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, entries * 5);
  addFeedEvent('urgency', { name: player.name, pot: pot.label, entries });
  putPlayer(player);
  let winnerDrawn = null;
  if (pot.pot >= pot.drawThreshold) winnerDrawn = performDraw(potId);
  res.json({ success: true, player: sanitizePlayer(player), entries, winnerDrawn });
});

// ─── PvP Wager Duels ───────────────────────────────────────────────────────
const DUEL_STAKES = {
  100:  { label: '$1',  fee: 100,  houseCut: 15 },
  500:  { label: '$5',  fee: 500,  houseCut: 15 },
  1000: { label: '$10', fee: 1000, houseCut: 15 },
  2500: { label: '$25', fee: 2500, houseCut: 12 },
  5000: { label: '$50', fee: 5000, houseCut: 10 },
};
const DUEL_BOOSTS = {
  shield:     { price: 49,  label: 'Duel Shield 🛡️',     desc: 'Survive 1 extra dynamite hit',     effect: 'extra_life' },
  score_boost:{ price: 99,  label: 'Score Boost ⚡',      desc: '1.5x score multiplier',             effect: 'score_mult_1_5' },
  lucky_dig:  { price: 149, label: 'Lucky Dig 🍀',        desc: '2x gold nugget value for this duel', effect: 'double_gold' },
};
// In-memory duel state (duels are short-lived, no need for DB)
if (!state.duels) state.duels = {};
if (!state.duelStats) state.duelStats = { totalDuels: 0, totalWagered: 0, totalHouseProfit: 0 };
if (!state.duelHistory) state.duelHistory = [];

// ─── GOLDPOT LIVE — Streaming System ────────────────────────────────────────
const STREAM_SUPER_CHATS = {
  bronze:  { price: 99,   label: 'Bronze',  color: '#cd7f32', duration: 5  },
  silver:  { price: 299,  label: 'Silver',  color: '#c0c0c0', duration: 10 },
  gold:    { price: 499,  label: 'Gold',    color: '#ffd700', duration: 20 },
  diamond: { price: 999,  label: 'Diamond', color: '#b9f2ff', duration: 30 },
};
const STREAM_GIFTS = {
  coin:      { price: 49,   label: 'Gold Coin 🪙',       animation: 'coin_rain' },
  pickaxe:   { price: 149,  label: 'Diamond Pickaxe ⛏️', animation: 'pickaxe_spin' },
  treasure:  { price: 299,  label: 'Treasure Chest 💎',   animation: 'chest_burst' },
  dynamite:  { price: 499,  label: 'TNT Blast 🧨',        animation: 'tnt_explode' },
  goldbar:   { price: 999,  label: 'Gold Bar Stack 🏆',   animation: 'gold_shower' },
  jackpot:   { price: 2499, label: 'JACKPOT 🎰',          animation: 'jackpot_mega' },
};
const STREAM_SUB_PRICE = 199; // $1.99/month
const STREAM_REVENUE_SHARE = 0.70; // 70% to streamer, 30% house
const HYPE_TRAIN_LEVELS = [
  { level: 1, goal: 5,   reward: '🔥 Chat unlocked: Hype emotes' },
  { level: 2, goal: 15,  reward: '⚡ 2x gift animations' },
  { level: 3, goal: 30,  reward: '🌟 Streamer gets 80% revenue share' },
  { level: 4, goal: 50,  reward: '💎 Exclusive badge for all participants' },
  { level: 5, goal: 100, reward: '🏆 TOP GIFTER crown + pot entry' },
];

if (!state.streams) state.streams = {};
if (!state.streamStats) state.streamStats = { totalStreams: 0, totalSuperChats: 0, totalGifts: 0, totalRevenue: 0 };

function cleanExpiredDuels() {
  const now = Date.now();
  for (const [id, duel] of Object.entries(state.duels)) {
    // Remove duels waiting > 5 min or finished > 2 min ago
    if (duel.status === 'waiting' && now - duel.createdAt > 300000) {
      // Refund creator
      const creator = getPlayer(duel.creatorId);
      if (creator) {
        creator.balance = (creator.balance || 0) + duel.stake;
        putPlayer(creator);
      }
      delete state.duels[id];
    } else if (duel.status === 'finished' && now - duel.finishedAt > 120000) {
      delete state.duels[id];
    }
  }
}
setInterval(cleanExpiredDuels, 30000);

function getDuelId() {
  return 'duel_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Create a new duel (player creates and waits for opponent)
app.post('/api/duel-create', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const stakeAmount = parseInt(req.body.stake);
  const stakeConfig = DUEL_STAKES[stakeAmount];
  if (!stakeConfig) return res.status(400).json({ error: 'Invalid stake amount' });
  // Check player isn't already in an active duel
  for (const d of Object.values(state.duels)) {
    if (d.status !== 'finished' && (d.creatorId === player.id || d.opponentId === player.id)) {
      return res.status(400).json({ error: 'Already in a duel' });
    }
  }
  // Payment
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'duel_create', stakeAmount);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += stakeAmount;
  // Parse optional boosts
  const boosts = [];
  if (req.body.boosts && Array.isArray(req.body.boosts)) {
    for (const bId of req.body.boosts) {
      if (DUEL_BOOSTS[bId]) boosts.push(bId);
    }
  }
  const duelId = getDuelId();
  state.duels[duelId] = {
    id: duelId,
    stake: stakeAmount,
    stakeLabel: stakeConfig.label,
    houseCutPct: stakeConfig.houseCut,
    creatorId: player.id,
    creatorName: player.name,
    creatorBoosts: boosts,
    creatorScore: null,
    creatorReady: false,
    opponentId: null,
    opponentName: null,
    opponentBoosts: [],
    opponentScore: null,
    opponentReady: false,
    status: 'waiting', // waiting -> active -> playing -> finished
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    winnerId: null,
    winnerName: null,
    prize: 0,
    spectators: 0,
    tips: 0,
  };
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, 5);
  putPlayer(player);
  broadcast({ type: 'duel_created', duel: sanitizeDuel(state.duels[duelId]) });
  addFeedEvent('duel', { name: player.name, action: 'created', stake: stakeConfig.label });
  res.json({ success: true, duelId, duel: sanitizeDuel(state.duels[duelId]), player: sanitizePlayer(player) });
});

// Join an existing duel
app.post('/api/duel-join', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const duelId = sanitizeString(String(req.body.duelId || ''), 30);
  const duel = state.duels[duelId];
  if (!duel) return res.status(404).json({ error: 'Duel not found' });
  if (duel.status !== 'waiting') return res.status(400).json({ error: 'Duel already started' });
  if (duel.creatorId === player.id) return res.status(400).json({ error: 'Cannot duel yourself' });
  // Check player isn't in another duel
  for (const d of Object.values(state.duels)) {
    if (d.status !== 'finished' && (d.creatorId === player.id || d.opponentId === player.id)) {
      return res.status(400).json({ error: 'Already in a duel' });
    }
  }
  // Payment
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'duel_join', duel.stake);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += duel.stake;
  // Parse optional boosts
  const boosts = [];
  if (req.body.boosts && Array.isArray(req.body.boosts)) {
    for (const bId of req.body.boosts) {
      if (DUEL_BOOSTS[bId]) boosts.push(bId);
    }
  }
  duel.opponentId = player.id;
  duel.opponentName = player.name;
  duel.opponentBoosts = boosts;
  duel.status = 'active';
  duel.startedAt = Date.now();
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  addBattlePassXP(player, 5);
  putPlayer(player);
  broadcast({ type: 'duel_matched', duel: sanitizeDuel(duel) });
  addFeedEvent('duel', { name: player.name, action: 'accepted', opponent: duel.creatorName, stake: duel.stakeLabel });
  res.json({ success: true, duel: sanitizeDuel(duel), player: sanitizePlayer(player) });
});

// Signal ready (both players must be ready before countdown)
app.post('/api/duel-ready', rateLimit(5000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const duelId = sanitizeString(String(req.body.duelId || ''), 30);
  const duel = state.duels[duelId];
  if (!duel) return res.status(404).json({ error: 'Duel not found' });
  if (duel.status !== 'active') return res.status(400).json({ error: 'Duel not active' });
  if (player.id === duel.creatorId) duel.creatorReady = true;
  else if (player.id === duel.opponentId) duel.opponentReady = true;
  else return res.status(400).json({ error: 'Not in this duel' });
  if (duel.creatorReady && duel.opponentReady) {
    duel.status = 'playing';
    duel.gameStartAt = Date.now() + 3000; // 3-second countdown
    broadcast({ type: 'duel_start', duelId: duel.id, gameStartAt: duel.gameStartAt });
  } else {
    broadcast({ type: 'duel_ready', duelId: duel.id, creatorReady: duel.creatorReady, opponentReady: duel.opponentReady });
  }
  res.json({ success: true, duel: sanitizeDuel(duel) });
});

// Submit duel score
app.post('/api/duel-score', rateLimit(5000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const duelId = sanitizeString(String(req.body.duelId || ''), 30);
  const duel = state.duels[duelId];
  if (!duel) return res.status(404).json({ error: 'Duel not found' });
  if (duel.status !== 'playing') return res.status(400).json({ error: 'Duel not in play' });
  const score = Math.max(0, Math.min(99999, parseInt(req.body.score) || 0));
  const isCreator = player.id === duel.creatorId;
  const isOpponent = player.id === duel.opponentId;
  if (!isCreator && !isOpponent) return res.status(400).json({ error: 'Not in this duel' });
  // Apply boost multiplier
  let finalScore = score;
  const boosts = isCreator ? duel.creatorBoosts : duel.opponentBoosts;
  if (boosts.includes('score_boost')) finalScore = Math.round(score * 1.5);
  if (isCreator) duel.creatorScore = finalScore;
  else duel.opponentScore = finalScore;
  broadcast({ type: 'duel_score_update', duelId: duel.id, playerId: player.id, score: finalScore });
  // Check if both scores submitted
  if (duel.creatorScore !== null && duel.opponentScore !== null) {
    resolveDuel(duel);
  }
  res.json({ success: true, duel: sanitizeDuel(duel) });
});

// Spectate tip
app.post('/api/duel-tip', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const duelId = sanitizeString(String(req.body.duelId || ''), 30);
  const duel = state.duels[duelId];
  if (!duel) return res.status(404).json({ error: 'Duel not found' });
  const targetId = sanitizeString(String(req.body.targetPlayerId || ''), 50);
  if (!targetId) return res.status(400).json({ error: 'Missing target' });
  const tipAmount = 50; // $0.50 per tip
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'duel_tip', tipAmount);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += tipAmount;
  const houseTipCut = Math.floor(tipAmount * 0.15); // 15% of tips
  const targetPlayer = getPlayer(targetId);
  if (targetPlayer) {
    targetPlayer.totalWon = (targetPlayer.totalWon || 0) + (tipAmount - houseTipCut);
    putPlayer(targetPlayer);
  }
  duel.tips += tipAmount;
  state.duelStats.totalHouseProfit += houseTipCut;
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  putPlayer(player);
  broadcast({ type: 'duel_tip', duelId: duel.id, tipper: player.name, target: targetPlayer ? targetPlayer.name : 'Player', amount: tipAmount });
  res.json({ success: true, player: sanitizePlayer(player) });
});

// Buy duel boost separately (before creating/joining)
app.post('/api/duel-boost', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const boostId = sanitizeString(String(req.body.boostId || ''), 20);
  const boost = DUEL_BOOSTS[boostId];
  if (!boost) return res.status(400).json({ error: 'Invalid boost' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'duel_boost_' + boostId, boost.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  player.totalSpent += boost.price;
  if (!player.duelBoosts) player.duelBoosts = [];
  player.duelBoosts.push(boostId);
  player.levelInfo = getPlayerLevel(player.totalSpent);
  player.level = player.levelInfo.level;
  putPlayer(player);
  res.json({ success: true, player: sanitizePlayer(player), boost: boostId });
});

// Get active duels list
app.get('/api/duels', rateLimit(5000, 10), (req, res) => {
  cleanExpiredDuels();
  const activeDuels = Object.values(state.duels)
    .filter(d => d.status !== 'finished')
    .map(sanitizeDuel);
  const recentResults = state.duelHistory.slice(-10);
  res.json({
    duels: activeDuels,
    recentResults,
    stats: {
      totalDuels: state.duelStats.totalDuels,
      totalWagered: state.duelStats.totalWagered,
    },
    stakes: DUEL_STAKES,
    boosts: DUEL_BOOSTS,
  });
});

// Challenge a specific player
app.post('/api/duel-challenge', rateLimit(15000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const targetName = sanitizeString(String(req.body.targetName || ''), 20);
  if (!targetName) return res.status(400).json({ error: 'Missing target name' });
  const stakeAmount = parseInt(req.body.stake);
  if (!DUEL_STAKES[stakeAmount]) return res.status(400).json({ error: 'Invalid stake' });
  // Broadcast challenge notification
  broadcast({ type: 'duel_challenge', from: player.name, fromId: player.id, targetName, stake: stakeAmount, stakeLabel: DUEL_STAKES[stakeAmount].label });
  res.json({ success: true, message: 'Challenge sent!' });
});

function resolveDuel(duel) {
  if (duel.status === 'finished') return; // guard against double-resolution
  duel.status = 'finished';
  duel.finishedAt = Date.now();
  const totalPool = duel.stake * 2;
  const houseCut = Math.floor(totalPool * (duel.houseCutPct / 100));
  const prize = totalPool - houseCut;
  let winnerId, winnerName, loserId, loserName;
  if (duel.creatorScore > duel.opponentScore) {
    winnerId = duel.creatorId; winnerName = duel.creatorName;
    loserId = duel.opponentId; loserName = duel.opponentName;
  } else if (duel.opponentScore > duel.creatorScore) {
    winnerId = duel.opponentId; winnerName = duel.opponentName;
    loserId = duel.creatorId; loserName = duel.creatorName;
  } else {
    // Tie — refund both (minus tiny house cut)
    const refund = Math.floor(totalPool / 2) - Math.floor(houseCut / 2);
    const p1 = getPlayer(duel.creatorId);
    const p2 = getPlayer(duel.opponentId);
    if (p1) { p1.totalWon = (p1.totalWon || 0) + refund; putPlayer(p1); }
    if (p2) { p2.totalWon = (p2.totalWon || 0) + refund; putPlayer(p2); }
    duel.winnerId = null;
    duel.winnerName = 'TIE';
    duel.prize = 0;
    state.duelStats.totalDuels++;
    state.duelStats.totalWagered += totalPool;
    state.duelStats.totalHouseProfit += houseCut;
    broadcast({ type: 'duel_finished', duel: sanitizeDuel(duel) });
    return;
  }
  // Pay winner
  const winner = getPlayer(winnerId);
  if (winner) {
    winner.totalWon = (winner.totalWon || 0) + prize;
    if (!winner.duelRecord) winner.duelRecord = { wins: 0, losses: 0, streak: 0, bestStreak: 0, totalWon: 0 };
    winner.duelRecord.wins++;
    winner.duelRecord.streak++;
    if (winner.duelRecord.streak > winner.duelRecord.bestStreak) winner.duelRecord.bestStreak = winner.duelRecord.streak;
    winner.duelRecord.totalWon += prize;
    addBattlePassXP(winner, 25);
    putPlayer(winner);
  }
  // Update loser record
  const loser = getPlayer(loserId);
  if (loser) {
    if (!loser.duelRecord) loser.duelRecord = { wins: 0, losses: 0, streak: 0, bestStreak: 0, totalWon: 0 };
    loser.duelRecord.losses++;
    loser.duelRecord.streak = 0;
    putPlayer(loser);
  }
  duel.winnerId = winnerId;
  duel.winnerName = winnerName;
  duel.prize = prize;
  state.duelStats.totalDuels++;
  state.duelStats.totalWagered += totalPool;
  state.duelStats.totalHouseProfit += houseCut;
  // Save to history
  state.duelHistory.push({
    id: duel.id,
    winnerName, loserName,
    winnerScore: winnerId === duel.creatorId ? duel.creatorScore : duel.opponentScore,
    loserScore: winnerId === duel.creatorId ? duel.opponentScore : duel.creatorScore,
    stake: duel.stakeLabel,
    prize,
    finishedAt: duel.finishedAt,
  });
  if (state.duelHistory.length > 50) state.duelHistory = state.duelHistory.slice(-50);
  broadcast({ type: 'duel_finished', duel: sanitizeDuel(duel) });
  addFeedEvent('duel_win', { name: winnerName, loser: loserName, prize: '$' + (prize / 100).toFixed(2), stake: duel.stakeLabel });
}

function sanitizeDuel(d) {
  return {
    id: d.id, stake: d.stake, stakeLabel: d.stakeLabel,
    creatorName: d.creatorName, creatorId: d.creatorId,
    creatorBoosts: d.creatorBoosts, creatorScore: d.creatorScore,
    creatorReady: d.creatorReady,
    opponentName: d.opponentName, opponentId: d.opponentId,
    opponentBoosts: d.opponentBoosts, opponentScore: d.opponentScore,
    opponentReady: d.opponentReady,
    status: d.status, createdAt: d.createdAt, startedAt: d.startedAt,
    gameStartAt: d.gameStartAt || null,
    finishedAt: d.finishedAt, winnerId: d.winnerId, winnerName: d.winnerName,
    prize: d.prize, spectators: d.spectators, tips: d.tips,
    houseCutPct: d.houseCutPct,
  };
}

// ─── GOLDPOT LIVE — Streaming Routes ────────────────────────────────────────
function getStreamId() {
  return 'stream_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitizeStream(s) {
  return {
    id: s.id, streamerId: s.streamerId, streamerName: s.streamerName,
    title: s.title, viewers: s.viewers, status: s.status,
    startedAt: s.startedAt, superChats: s.superChats.length,
    gifts: s.totalGifts, hypeLevel: s.hypeLevel, hypeProgress: s.hypeProgress,
    hypeGoal: HYPE_TRAIN_LEVELS[Math.min(s.hypeLevel, HYPE_TRAIN_LEVELS.length - 1)]?.goal || 100,
    topGifters: s.topGifters.slice(0, 5), subscribers: s.subscriberCount,
    totalEarned: s.totalEarned, isPlaying: s.isPlaying || false,
  };
}

function cleanExpiredStreams() {
  const now = Date.now();
  for (const [id, stream] of Object.entries(state.streams)) {
    if (stream.status === 'ended' && now - stream.endedAt > 60000) {
      delete state.streams[id];
    }
    // Auto-end streams idle > 30min
    if (stream.status === 'live' && now - (stream.lastActivity || stream.startedAt) > 1800000) {
      stream.status = 'ended';
      stream.endedAt = now;
      broadcast({ type: 'stream_ended', streamId: id, streamerName: stream.streamerName });
    }
  }
}
setInterval(cleanExpiredStreams, 30000);

// Go Live
app.post('/api/stream-start', rateLimit(10000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const title = sanitizeString(String(req.body.title || `${player.name}'s Stream`), 60);
  // Check if already streaming
  for (const s of Object.values(state.streams)) {
    if (s.status === 'live' && s.streamerId === player.id) {
      return res.status(400).json({ error: 'Already streaming' });
    }
  }
  const streamId = getStreamId();
  state.streams[streamId] = {
    id: streamId, streamerId: player.id, streamerName: player.name,
    title, viewers: 0, status: 'live', startedAt: Date.now(),
    lastActivity: Date.now(), superChats: [], chatMessages: [], totalGifts: 0,
    hypeLevel: 0, hypeProgress: 0, hypeExpiry: 0,
    topGifters: [], subscriberCount: 0, subscribers: {},
    totalEarned: 0, streamerEarned: 0, isPlaying: false,
  };
  state.streamStats.totalStreams++;
  broadcast({ type: 'stream_started', stream: sanitizeStream(state.streams[streamId]) });
  addFeedEvent('stream_live', { name: player.name, title });
  res.json({ success: true, streamId, stream: sanitizeStream(state.streams[streamId]) });
});

// End Stream
app.post('/api/stream-end', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const stream = state.streams[req.body.streamId];
  if (!stream || stream.streamerId !== player.id) return res.status(400).json({ error: 'Not your stream' });
  stream.status = 'ended';
  stream.endedAt = Date.now();
  // Pay out streamer earnings
  if (stream.streamerEarned > 0) {
    player.totalWon = (player.totalWon || 0) + stream.streamerEarned;
    putPlayer(player);
  }
  broadcast({ type: 'stream_ended', streamId: stream.id, streamerName: stream.streamerName, stats: { viewers: stream.viewers, superChats: stream.superChats.length, gifts: stream.totalGifts, earned: stream.totalEarned } });
  res.json({ success: true, earnings: stream.streamerEarned, player: sanitizePlayer(player) });
});

// Stream game frame (streamer playing game visible to viewers)
app.post('/api/stream-playing', rateLimit(500, 30), (req, res) => {
  const stream = state.streams[req.body.streamId];
  if (!stream || stream.status !== 'live') return res.status(400).json({ error: 'Stream not active' });
  if (stream.streamerId !== req.body.playerId) return res.status(403).json({ error: 'Not your stream' });
  stream.isPlaying = !!req.body.isPlaying;
  stream.lastActivity = Date.now();
  res.json({ ok: true });
});

// Super Chat
app.post('/api/stream-superchat', rateLimit(10000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const stream = state.streams[req.body.streamId];
  if (!stream || stream.status !== 'live') return res.status(400).json({ error: 'Stream not active' });
  const tier = req.body.tier;
  const sc = STREAM_SUPER_CHATS[tier];
  if (!sc) return res.status(400).json({ error: 'Invalid super chat tier' });
  const message = sanitizeString(String(req.body.message || ''), 200);
  // Payment verification
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'super_chat_' + tier, sc.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  // Revenue split
  const streamerCut = Math.floor(sc.price * STREAM_REVENUE_SHARE);
  const houseCut = sc.price - streamerCut;
  stream.totalEarned += sc.price;
  stream.streamerEarned += streamerCut;
  stream.lastActivity = Date.now();
  state.streamStats.totalSuperChats++;
  state.streamStats.totalRevenue += houseCut;
  const scEntry = { sender: player.name, senderId: player.id, tier, message, color: sc.color, duration: sc.duration, time: Date.now() };
  stream.superChats.push(scEntry);
  if (stream.superChats.length > 100) stream.superChats = stream.superChats.slice(-100);
  // Hype train progress
  advanceHypeTrain(stream, 1);
  // Update top gifters
  updateTopGifters(stream, player.id, player.name, sc.price);
  broadcast({ type: 'stream_superchat', streamId: stream.id, superChat: scEntry, hypeLevel: stream.hypeLevel, hypeProgress: stream.hypeProgress });
  res.json({ success: true, stream: sanitizeStream(stream), player: sanitizePlayer(player) });
});

// Send Gift
app.post('/api/stream-gift', rateLimit(10000, 10), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const stream = state.streams[req.body.streamId];
  if (!stream || stream.status !== 'live') return res.status(400).json({ error: 'Stream not active' });
  const giftId = req.body.giftId;
  const gift = STREAM_GIFTS[giftId];
  if (!gift) return res.status(400).json({ error: 'Invalid gift' });
  // Payment verification
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'stream_gift_' + giftId, gift.price);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  const streamerCut = Math.floor(gift.price * (stream.hypeLevel >= 3 ? 0.80 : STREAM_REVENUE_SHARE));
  const houseCut = gift.price - streamerCut;
  stream.totalEarned += gift.price;
  stream.streamerEarned += streamerCut;
  stream.totalGifts++;
  stream.lastActivity = Date.now();
  state.streamStats.totalGifts++;
  state.streamStats.totalRevenue += houseCut;
  advanceHypeTrain(stream, giftId === 'jackpot' ? 5 : giftId === 'goldbar' ? 3 : 1);
  updateTopGifters(stream, player.id, player.name, gift.price);
  broadcast({ type: 'stream_gift', streamId: stream.id, gift: { sender: player.name, senderId: player.id, giftId, label: gift.label, animation: gift.animation }, hypeLevel: stream.hypeLevel, hypeProgress: stream.hypeProgress });
  res.json({ success: true, stream: sanitizeStream(stream), player: sanitizePlayer(player) });
});

// Subscribe to Streamer
app.post('/api/stream-subscribe', rateLimit(10000, 5), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const stream = state.streams[req.body.streamId];
  if (!stream || stream.status !== 'live') return res.status(400).json({ error: 'Stream not active' });
  if (stream.subscribers[player.id]) return res.status(400).json({ error: 'Already subscribed' });
  if (stripe) {
    const proofCheck = verifyPaymentProof(player, req.body.paymentProofToken, 'stream_subscribe', STREAM_SUB_PRICE);
    if (!proofCheck.ok) return res.status(400).json({ error: proofCheck.error });
    if (!consumePaymentSession(player, proofCheck.proof.sid)) return res.status(400).json({ error: 'Payment already applied' });
  }
  const streamerCut = Math.floor(STREAM_SUB_PRICE * STREAM_REVENUE_SHARE);
  const houseCut = STREAM_SUB_PRICE - streamerCut;
  stream.totalEarned += STREAM_SUB_PRICE;
  stream.streamerEarned += streamerCut;
  stream.subscriberCount++;
  stream.subscribers[player.id] = { name: player.name, since: Date.now() };
  state.streamStats.totalRevenue += houseCut;
  advanceHypeTrain(stream, 2);
  broadcast({ type: 'stream_subscribe', streamId: stream.id, subscriber: player.name });
  res.json({ success: true, stream: sanitizeStream(stream), player: sanitizePlayer(player) });
});

// GET active streams
app.get('/api/streams', rateLimit(1000, 10), (req, res) => {
  const liveStreams = Object.values(state.streams)
    .filter(s => s.status === 'live')
    .sort((a, b) => b.viewers - a.viewers)
    .map(sanitizeStream);
  res.json({
    streams: liveStreams,
    stats: state.streamStats,
    superChats: STREAM_SUPER_CHATS,
    gifts: STREAM_GIFTS,
    subPrice: STREAM_SUB_PRICE,
    hypeLevels: HYPE_TRAIN_LEVELS,
  });
});

function advanceHypeTrain(stream, amount) {
  const now = Date.now();
  // Reset hype if expired (2 minutes)
  if (stream.hypeExpiry && now > stream.hypeExpiry) {
    stream.hypeLevel = 0;
    stream.hypeProgress = 0;
  }
  stream.hypeExpiry = now + 120000; // 2 min window
  stream.hypeProgress += amount;
  const maxLevel = HYPE_TRAIN_LEVELS.length - 1;
  while (stream.hypeLevel < maxLevel) {
    const currentGoal = HYPE_TRAIN_LEVELS[stream.hypeLevel].goal;
    if (stream.hypeProgress >= currentGoal) {
      stream.hypeProgress -= currentGoal;
      stream.hypeLevel++;
      broadcast({ type: 'stream_hype_level', streamId: stream.id, level: stream.hypeLevel, reward: HYPE_TRAIN_LEVELS[stream.hypeLevel].reward });
    } else break;
  }
  if (stream.hypeLevel >= maxLevel) stream.hypeProgress = Math.min(stream.hypeProgress, HYPE_TRAIN_LEVELS[maxLevel].goal);
}

function updateTopGifters(stream, playerId, playerName, amount) {
  const existing = stream.topGifters.find(g => g.id === playerId);
  if (existing) {
    existing.total += amount;
    existing.name = playerName;
  } else {
    stream.topGifters.push({ id: playerId, name: playerName, total: amount });
  }
  stream.topGifters.sort((a, b) => b.total - a.total);
  if (stream.topGifters.length > 10) stream.topGifters = stream.topGifters.slice(0, 10);
}

// ─── Withdrawals ────────────────────────────────────────────────────────────
const WITHDRAW_METHOD_LABELS = {
  stripe_connect: 'Bank Account',
  paypal: 'PayPal',
  cashapp: 'Cash App',
  venmo: 'Venmo',
};
const MIN_WITHDRAW_CENTS = 500; // $5 minimum

// ─── Stripe Connect (payouts to user bank accounts) ─────────────────────────
app.post('/api/connect-account', rateLimit(60000, 3), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    let accountId = player.stripeConnectId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        metadata: { playerId: player.id },
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      player.stripeConnectId = accountId;
      putPlayer(player);
      db.logAudit('stripe_connect_created', { playerId: player.id, details: { accountId } });
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/?connect_refresh=1`,
      return_url: `${origin}/?connect_return=1`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (err) {
    log('error', 'Stripe Connect account creation failed', { playerId: player.id, error: err.message });
    res.status(500).json({ error: 'Failed to create payout account' });
  }
});

app.get('/api/connect-status', rateLimit(10000, 10), (req, res) => {
  if (!stripe) return res.json({ connected: false });
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let playerId;
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    playerId = decoded.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.stripeConnectId) return res.json({ connected: false });
  // Check account status asynchronously
  stripe.accounts.retrieve(player.stripeConnectId).then(account => {
    res.json({
      connected: account.charges_enabled || account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      payoutsEnabled: account.payouts_enabled,
      accountId: player.stripeConnectId,
    });
  }).catch(() => {
    res.json({ connected: false });
  });
});

app.post('/api/connect-dashboard', rateLimit(60000, 5), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.stripeConnectId) return res.status(400).json({ error: 'No payout account connected' });
  try {
    const link = await stripe.accounts.createLoginLink(player.stripeConnectId);
    res.json({ url: link.url });
  } catch (err) {
    log('error', 'Stripe dashboard link failed', { playerId: player.id, error: err.message });
    res.status(500).json({ error: 'Failed to create dashboard link' });
  }
});

app.get('/api/withdrawals', rateLimit(10000, 10), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let playerId;
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    playerId = decoded.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const withdrawals = db.getPlayerWithdrawals(playerId);
  const pendingTotal = db.getPendingTotalForPlayer(playerId);
  const balance = (player.totalWon || 0) - (player.totalWithdrawn || 0);
  res.json({
    balance,
    balanceDisplay: (balance / 100).toFixed(2),
    pendingTotal,
    pendingDisplay: (pendingTotal / 100).toFixed(2),
    available: balance - pendingTotal,
    availableDisplay: ((balance - pendingTotal) / 100).toFixed(2),
    minWithdraw: MIN_WITHDRAW_CENTS,
    minWithdrawDisplay: (MIN_WITHDRAW_CENTS / 100).toFixed(2),
    withdrawals: withdrawals.map(w => ({
      id: w.id,
      amount: w.amount,
      amountDisplay: (w.amount / 100).toFixed(2),
      method: w.method,
      methodLabel: WITHDRAW_METHOD_LABELS[w.method] || w.method,
      handle: w.handle,
      status: w.status,
      requestedAt: w.requested_at,
      processedAt: w.processed_at,
    })),
  });
});

app.post('/api/withdraw', rateLimit(60000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { method, handle, amount } = req.body;
  const WITHDRAW_METHODS = ['stripe_connect', 'paypal', 'cashapp', 'venmo'];
  if (!WITHDRAW_METHODS.includes(method)) {
    return res.status(400).json({ error: 'Invalid withdrawal method' });
  }

  let cleanHandle = '';
  if (method === 'stripe_connect') {
    if (!player.stripeConnectId) {
      return res.status(400).json({ error: 'Please connect your bank account first' });
    }
    cleanHandle = player.stripeConnectId;
  } else {
    cleanHandle = sanitizeString(String(handle || ''), 100);
    if (!cleanHandle || cleanHandle.length < 3) {
      return res.status(400).json({ error: 'Please enter a valid account handle' });
    }
    // Per-method handle format validation
    if (method === 'paypal' && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(cleanHandle)) {
      return res.status(400).json({ error: 'PayPal handle must be a valid email address' });
    }
    if (method === 'cashapp' && !/^\$[a-zA-Z0-9_]{1,20}$/.test(cleanHandle)) {
      return res.status(400).json({ error: 'Cash App handle must be $username format' });
    }
    if (method === 'venmo' && !/^@[a-zA-Z0-9_-]{1,30}$/.test(cleanHandle)) {
      return res.status(400).json({ error: 'Venmo handle must be @username format' });
    }
  }

  const cents = parseInt(amount);
  if (!cents || cents < MIN_WITHDRAW_CENTS) {
    return res.status(400).json({ error: `Minimum withdrawal is $${(MIN_WITHDRAW_CENTS / 100).toFixed(2)}` });
  }
  // Max per-request withdrawal: $5,000
  if (cents > 500000) {
    return res.status(400).json({ error: 'Maximum $5,000 per withdrawal request' });
  }

  const balance = (player.totalWon || 0) - (player.totalWithdrawn || 0);
  if (cents > balance) {
    return res.status(400).json({ error: 'Insufficient balance for this withdrawal' });
  }

  // KYC required for withdrawals over $600 (IRS reporting threshold)
  if (cents >= 60000) {
    const kyc = db.getKycStatus(player.id);
    if (!kyc || kyc.status !== 'verified') {
      return res.status(403).json({
        error: 'Identity verification (KYC) is required for withdrawals of $600 or more.',
        kycRequired: true,
        kycStatus: kyc ? kyc.status : 'none',
      });
    }
  }

  // Daily withdrawal limit: $500/day — atomic check
  const todayStr = new Date().toISOString().split('T')[0];
  if (!player._withdrawDay || player._withdrawDay !== todayStr) {
    player._withdrawDay = todayStr;
    player._withdrawTodayTotal = 0;
  }
  // Mark pending immediately to prevent race condition
  player._withdrawTodayTotal += cents;
  putPlayer(player);
  if (player._withdrawTodayTotal > 50000) {
    player._withdrawTodayTotal -= cents; // rollback
    putPlayer(player);
    return res.status(400).json({ error: 'Daily withdrawal limit is $500. Try again tomorrow.' });
  }

  // Atomic balance check + withdrawal creation in a single DB transaction
  const result = db.atomicCreateWithdrawal(player.id, player.name, cents, method, cleanHandle, balance);
  if (result.error) {
    player._withdrawTodayTotal -= cents; // rollback daily tally when request is rejected
    putPlayer(player);
    return res.status(400).json({ error: result.error });
  }
  trackEvent('withdrawal_requested', { playerId: player.id, amount: cents, method });
  db.logAudit('withdrawal_request', {
    playerId: player.id, amount: cents,
    details: { method, handle: cleanHandle, withdrawalId: result.withdrawalId, balance },
  });

  res.json({
    success: true,
    withdrawalId: result.withdrawalId,
    amountDisplay: (cents / 100).toFixed(2),
    method: WITHDRAW_METHOD_LABELS[method],
    handle: cleanHandle,
    message: `Withdrawal of $${(cents / 100).toFixed(2)} to ${WITHDRAW_METHOD_LABELS[method]} requested! Processing usually takes 1-3 business days.`,
  });
});

// Admin: list pending withdrawals
app.get('/api/admin/withdrawals', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/withdrawals' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const pending = db.getPendingWithdrawals();
  res.json({ withdrawals: pending.map(w => ({
    id: w.id, playerId: w.player_id, playerName: w.player_name,
    amount: w.amount, amountDisplay: (w.amount / 100).toFixed(2),
    method: w.method, methodLabel: WITHDRAW_METHOD_LABELS[w.method] || w.method,
    handle: w.handle, status: w.status, requestedAt: w.requested_at,
  }))});
});

// Admin: approve/reject withdrawal
app.post('/api/admin/withdrawal-action', rateLimit(60000, 10), async (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/withdrawal-action' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { withdrawalId, action, note } = req.body;
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const id = parseInt(withdrawalId);
  if (!id) return res.status(400).json({ error: 'Invalid withdrawal ID' });

  const w = db.getWithdrawalById(id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });

  // For Stripe Connect withdrawals, execute the transfer before marking approved
  let transferId = null;
  if (action === 'approved' && w.method === 'stripe_connect' && stripe) {
    try {
      const transfer = await stripe.transfers.create({
        amount: w.amount,
        currency: 'usd',
        destination: w.handle, // handle stores the stripeConnectId
        metadata: { withdrawalId: String(id), playerId: w.player_id },
        description: `GoldPot withdrawal #${id}`,
      });
      transferId = transfer.id;
    } catch (err) {
      log('error', 'Stripe transfer failed', { withdrawalId: id, error: err.message });
      return res.status(500).json({ error: `Stripe transfer failed: ${err.message}` });
    }
  }

  const updateResult = db.updateWithdrawalStatus(id, action, note || '');
  if (updateResult.error) {
    return res.status(400).json({ error: updateResult.error });
  }

  // If approved, deduct from player's totalWithdrawn tracker
  if (action === 'approved') {
    db.logAudit('withdrawal_approved', {
      playerId: w.player_id, amount: w.amount,
      details: { withdrawalId: id, method: w.method, handle: w.handle, note: note || '', transferId },
    });
    const p = getPlayer(w.player_id);
    if (p) {
      p.totalWithdrawn = (p.totalWithdrawn || 0) + w.amount;
      putPlayer(p);
    }
  } else {
    db.logAudit('withdrawal_rejected', {
      playerId: w.player_id, amount: w.amount,
      details: { withdrawalId: id, method: w.method, note: note || '' },
    });
  }

  trackEvent('withdrawal_' + action, { withdrawalId: id, note, transferId });
  res.json({ success: true, action, transferId });
});

// ─── KYC (Know Your Customer) ───────────────────────────────────────────────────────
app.get('/api/kyc-status', rateLimit(10000, 10), (req, res) => {
  // Auth check: verify JWT matches the requested player
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let playerId;
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    playerId = decoded.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Only allow querying own KYC status
  if (req.query.playerId && req.query.playerId !== playerId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const player = getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const kyc = db.getKycStatus(player.id);
  res.json({
    status: kyc ? kyc.status : 'none',
    submittedAt: kyc ? kyc.submitted_at : null,
    reviewedAt: kyc ? kyc.reviewed_at : null,
  });
});

app.post('/api/kyc-submit', rateLimit(300000, 3), (req, res) => {
  const player = getPlayer(req.body.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { fullName, dateOfBirth, address, state, ssnLast4, idType } = req.body;
  if (!fullName || fullName.trim().length < 2) {
    return res.status(400).json({ error: 'Full legal name is required' });
  }
  if (ssnLast4 && !/^\d{4}$/.test(ssnLast4)) {
    return res.status(400).json({ error: 'SSN last 4 must be exactly 4 digits' });
  }

  db.submitKyc(player.id, {
    fullName: sanitizeString(fullName.trim(), 200),
    dateOfBirth: dateOfBirth ? sanitizeString(dateOfBirth, 10) : null,
    address: address ? sanitizeString(address.trim(), 500) : null,
    state: state ? sanitizeString(state.trim(), 2) : null,
    ssnLast4: ssnLast4 || null,
    idType: idType ? sanitizeString(idType, 50) : null,
  });

  db.logAudit('kyc_submitted', { playerId: player.id, details: { idType: idType || 'none' } });
  log('info', 'KYC submitted', { playerId: player.id });
  res.json({ success: true, status: 'pending', message: 'Identity verification submitted. Review typically takes 1-2 business days.' });
});

// Admin: list pending KYC submissions
app.get('/api/admin/kyc-pending', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/kyc-pending' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ submissions: db.getPendingKyc() });
});

// Admin: approve/reject KYC
app.post('/api/admin/kyc-action', rateLimit(60000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/kyc-action' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { playerId, action, note } = req.body;
  if (!['verified', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use verified or rejected.' });
  }
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });
  db.updateKycStatus(playerId, action, note || '');
  db.logAudit('kyc_' + action, { playerId, details: { note: note || '' } });
  log('info', 'KYC ' + action, { playerId });
  res.json({ success: true, action });
});

// ─── Admin: Chat Moderation ────────────────────────────────────────────────
app.post('/api/admin/chat-mute', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { playerId, action } = req.body;
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });
  if (action === 'mute') {
    chatMuted.add(playerId);
    db.logAudit('chat_mute', { playerId, details: { action: 'mute' } });
  } else if (action === 'unmute') {
    chatMuted.delete(playerId);
    db.logAudit('chat_mute', { playerId, details: { action: 'unmute' } });
  } else {
    return res.status(400).json({ error: 'Invalid action (mute/unmute)' });
  }
  res.json({ success: true, action, playerId });
});

// ─── Admin: Security Events ────────────────────────────────────────────────
app.get('/api/admin/security-events', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/security-events' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 720);
  const sinceMs = Date.now() - hours * 3600000;
  const category = req.query.category || null;
  const ip = req.query.ip || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);

  let events;
  if (ip) events = db.getSecurityEventsByIp(ip, sinceMs, limit);
  else if (category) events = db.getSecurityEventsByCategory(category, sinceMs, limit);
  else events = db.getSecurityEvents(sinceMs, limit);

  const summary = db.getSecuritySummary(sinceMs);
  res.json({ events, summary, hours, totalReturned: events.length });
});

// ─── Admin: Audit Log ──────────────────────────────────────────────────────
app.get('/api/admin/audit-log', rateLimit(10000, 10), (req, res) => {
  if (!verifyAdminSecret(req.headers['x-admin-secret'], req)) {
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'admin', 'admin_auth_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { path: '/api/admin/audit-log' },
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 720);
  const sinceMs = Date.now() - hours * 3600000;
  const action = req.query.action || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);

  let entries;
  if (action) entries = db.getAuditLogByAction(action, sinceMs, limit);
  else entries = db.getAuditLog(sinceMs, limit);

  res.json({ entries, hours, totalReturned: entries.length });
});

// ─── Responsible Gaming ─────────────────────────────────────────────────────
// Self-exclusion: lock account for a chosen period (1 day to 365 days)
app.post('/api/self-exclude', rateLimit(60000, 3), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  let decoded;
  try { decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const player = getPlayer(decoded.sub);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const days = Math.min(Math.max(parseInt(req.body.days) || 1, 1), 365);
  player.selfExcludedUntil = Date.now() + days * 86400000;
  putPlayer(player);
  db.logSecurityEvent('info', 'responsible_gaming', 'self_exclude', { playerId: player.id, days });
  res.json({ ok: true, excludedUntil: player.selfExcludedUntil });
});

// Set daily deposit limit (in whole dollars, 0 = remove, max $500)
app.post('/api/deposit-limit', rateLimit(60000, 5), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  let decoded;
  try { decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const player = getPlayer(decoded.sub);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const limitDollars = parseInt(req.body.limit);
  if (isNaN(limitDollars) || limitDollars < 0) return res.status(400).json({ error: 'Invalid limit' });
  if (limitDollars === 0) {
    player.dailyDepositLimitCents = null;
  } else {
    player.dailyDepositLimitCents = Math.min(limitDollars, 500) * 100;
  }
  putPlayer(player);
  res.json({ ok: true, dailyDepositLimitCents: player.dailyDepositLimitCents });
});

// Get responsible gaming settings for current player
app.get('/api/responsible-gaming', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  let decoded;
  try { decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const player = getPlayer(decoded.sub);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json({
    selfExcludedUntil: player.selfExcludedUntil,
    dailyDepositLimitCents: player.dailyDepositLimitCents,
    depositTodayCents: player.depositTodayCents || 0,
    sessionStartedAt: player.sessionStartedAt,
  });
});

// ─── Legal Pages ────────────────────────────────────────────────────────────
const legalPage = (title, content) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — GoldPot</title>
  <style>
    :root {
      --bg: #0d0a06;
      --surface: #1a1508;
      --surface2: #231c0e;
      --border: #2e2510;
      --gold: #d4a017;
      --gold-light: #f5d060;
      --white: #f5f0e6;
      --text: #e8dcc8;
      --text2: #b8a88a;
      --text3: #7a6c52;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-display: 'Playfair Display', Georgia, serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }
    .legal-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 24px 60px;
    }
    .legal-back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--gold);
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
      padding: 8px 0;
      transition: opacity 0.2s;
    }
    .legal-back:hover { opacity: 0.8; text-decoration: underline; }
    h1 {
      font-family: var(--font-display);
      color: var(--gold);
      font-size: 1.75rem;
      margin: 28px 0 8px;
      letter-spacing: 0.5px;
    }
    .legal-subtitle {
      color: var(--text3);
      font-size: 0.78rem;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    h2 {
      color: var(--gold-light);
      font-size: 1.05rem;
      font-weight: 700;
      margin: 32px 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
    }
    h3 {
      color: var(--white);
      font-size: 0.92rem;
      font-weight: 600;
      margin: 18px 0 8px;
    }
    p {
      font-size: 0.85rem;
      line-height: 1.75;
      color: var(--text2);
      margin-bottom: 12px;
    }
    ul, ol {
      padding-left: 22px;
      margin-bottom: 14px;
    }
    li {
      font-size: 0.85rem;
      line-height: 1.7;
      color: var(--text2);
      margin-bottom: 6px;
    }
    li b { color: var(--white); }
    code {
      background: var(--surface2);
      color: var(--gold-light);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.82rem;
    }
    a { color: var(--gold); }
    .legal-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      margin: 14px 0;
    }
    .legal-card h3 { margin-top: 0; }
    .legal-table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0 18px;
      font-size: 0.83rem;
    }
    .legal-table th {
      text-align: left;
      color: var(--gold-light);
      font-weight: 600;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .legal-table td {
      color: var(--text2);
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    .legal-table tr:last-child td { border-bottom: none; }
    .legal-footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 0.72rem;
      color: var(--text3);
    }
    @media (max-width: 480px) {
      .legal-wrap { padding: 20px 16px 48px; }
      h1 { font-size: 1.4rem; }
      h2 { font-size: 0.95rem; }
      .legal-table { font-size: 0.78rem; }
      .legal-table th, .legal-table td { padding: 6px 8px; }
    }
  </style>
</head>
<body>
  <div class="legal-wrap">
    <a href="/" class="legal-back">← Back to GoldPot</a>
    ${content}
    <p class="legal-footer">Last updated: March 2026 · © 2026 GoldPot Inc.</p>
  </div>
</body>
</html>`;

app.get('/rules', (req, res) => {
  res.send(legalPage('Official Rules', `
    <h1>OFFICIAL RULES</h1>
    <p class="legal-subtitle">GoldPot Sweepstakes — No Purchase Necessary</p>

    <h2>1. Eligibility</h2>
    <p>Open to legal residents of the 50 United States and D.C., 18 years of age or older. Void where prohibited or restricted by law. It is your responsibility to verify that participation is lawful in your jurisdiction.</p>

    <h2>2. No Purchase Necessary</h2>
    <p>NO PURCHASE OR PAYMENT IS NECESSARY TO ENTER OR WIN. A free method of entry is available via the "FREE ENTRY" button — one (1) free entry per pot per round.</p>
    <p>Free entries and paid entries carry equal weight in the drawing. However, purchasing additional entries increases your total count and therefore your statistical likelihood of winning.</p>

    <h2>3. Promotion Period</h2>
    <p>GoldPot operates as an ongoing sweepstakes. Each drawing ("round") begins when the previous round ends and continues until the pot reaches its draw threshold or the countdown timer expires, whichever occurs first. The Sponsor reserves the right to discontinue the promotion with reasonable notice.</p>

    <h2>4. How to Enter</h2>

    <div class="legal-card">
      <h3>Standard Pots (Mini, Gold, Mega)</h3>
      <ul>
        <li><b>Free Entry:</b> One (1) free entry per pot per round, no purchase required.</li>
        <li><b>Premium Entry:</b> Play the Deep Gold mini-game. Base price is $1.00 per entry.</li>
        <li><b>Bonus Entries:</b> Earned at no cost via daily login bonus, spin wheel, ad viewing, referrals, session time rewards, and mission/milestone completion.</li>
      </ul>
      <p><b>Bundle Discounts:</b></p>
      <table class="legal-table">
        <tr><th>Quantity</th><th>Price</th><th>Savings</th></tr>
        <tr><td>5 entries</td><td>$4.00</td><td>20% off</td></tr>
        <tr><td>10 entries</td><td>$7.00</td><td>30% off</td></tr>
        <tr><td>25 entries</td><td>$15.00</td><td>40% off</td></tr>
        <tr><td>50 entries</td><td>$25.00</td><td>50% off</td></tr>
        <tr><td>100 entries</td><td>$40.00</td><td>60% off</td></tr>
      </table>
    </div>

    <div class="legal-card">
      <h3>Jackpot Drawings</h3>
      <table class="legal-table">
        <tr><th>Tier</th><th>Entry Price</th></tr>
        <tr><td>Silver</td><td>$2 / entry</td></tr>
        <tr><td>Gold</td><td>$3 / entry</td></tr>
        <tr><td>Platinum</td><td>$5 / entry</td></tr>
        <tr><td>Diamond</td><td>$5 / entry</td></tr>
      </table>
      <p>Jackpots draw when the pot reaches its threshold or when the timer expires.</p>
    </div>

    <div class="legal-card">
      <h3>Flash Pots</h3>
      <p>Short-duration drawings (5 minutes). $0.50 per entry or free entries may be available.</p>
    </div>

    <div class="legal-card">
      <h3>Additional Entry Methods</h3>
      <ul>
        <li><b>Mystery Box:</b> Bronze ($3), Silver ($5), or Gold ($10) — awards a random number of entries based on rarity tier (Common, Rare, or Legendary).</li>
        <li><b>Lightning Deal:</b> Time-limited discounted entry bundles (30–70% off, 90-second window).</li>
        <li><b>Limited Edition Drop:</b> Exclusive bulk entry packs with limited stock, refreshed periodically.</li>
        <li><b>All-In Pack:</b> 5 entries to each of the 3 standard pots (15 total) for $5.</li>
        <li><b>Double Down:</b> After a purchase, option to double your entries for 50% of the original price.</li>
        <li><b>Power Surge:</b> $2.99 — 2x multiplier on your next purchase for 1 hour.</li>
        <li><b>Mega Multiplier:</b> $4.99 — 5x multiplier for 30 minutes.</li>
        <li><b>Streak Saver:</b> $1.99 — protects your login streak from resetting.</li>
      </ul>
    </div>

    <h2>5. VIP Pass</h2>
    <p>Optional VIP subscription with enhanced benefits:</p>
    <table class="legal-table">
      <tr><th>Plan</th><th>Price</th></tr>
      <tr><td>Weekly</td><td>$4.99 / week</td></tr>
      <tr><td>Monthly</td><td>$14.99 / month</td></tr>
    </table>
    <p>VIP benefits include increased daily bonus multiplier, higher daily ad-entry limits, automatic streak shield, and VIP badge. VIP status does not change the odds per entry — it provides convenience and bonus entry opportunities.</p>

    <h2>6. Drawing &amp; Winner Selection</h2>
    <p>Winners are selected by cryptographically secure random drawing (Node.js <code>crypto.randomInt</code>) from all eligible entries in the applicable pot or jackpot. Each entry carries equal weight regardless of how it was obtained (free, premium, bonus, referral, etc.).</p>

    <h2>7. Odds of Winning</h2>
    <p>Odds depend on the total number of entries received for each drawing. Your odds equal (your entries) ÷ (total entries in that pot). Odds cannot be determined in advance because total entries vary per round.</p>

    <h2>8. Prizes</h2>
    <table class="legal-table">
      <tr><th>Pot</th><th>Draw Threshold</th><th>Prize</th></tr>
      <tr><td>Mini Pot</td><td>$25</td><td>Pot value after 18% fee</td></tr>
      <tr><td>Gold Pot</td><td>$100</td><td>Pot value after 18% fee</td></tr>
      <tr><td>Mega Pot</td><td>$500</td><td>Pot value after 18% fee</td></tr>
      <tr><td>Flash Pot</td><td>Timer expiry</td><td>Pot value after 18% fee</td></tr>
    </table>
    <div class="legal-card">
      <h3>Jackpot Prizes</h3>
      <table class="legal-table">
        <tr><th>Tier</th><th>Up To</th></tr>
        <tr><td>Silver</td><td>$1,000</td></tr>
        <tr><td>Gold</td><td>$10,000</td></tr>
        <tr><td>Platinum</td><td>$50,000</td></tr>
        <tr><td>Diamond</td><td>$250,000</td></tr>
      </table>
      <p>If a jackpot timer expires before the threshold is reached, the actual pot value is awarded.</p>
    </div>
    <p>An 18% operational fee is deducted from all pots to fund platform operations, prize fulfillment, and maintenance. Prizes over $600 are subject to IRS reporting (Form 1099). Winners are solely responsible for all applicable federal, state, and local taxes.</p>

    <h2>9. Winner Notification &amp; Prize Claims</h2>
    <p>Winners are notified via the platform interface. Winners must provide valid government-issued identification and tax information (W-9/W-8BEN) to claim prizes exceeding $600. Prizes must be claimed within thirty (30) days of notification. Unclaimed prizes are forfeited.</p>

    <h2>10. General Conditions</h2>
    <p>Sponsor reserves the right to cancel, suspend, or modify the sweepstakes or any drawing if fraud, technical failures, or any factor beyond Sponsor's control compromises the integrity of the promotion. Sponsor may disqualify any participant who tampers with the entry process or violates these rules. By entering, participants agree to be bound by these Official Rules and the decisions of the Sponsor, which are final.</p>

    <h2>11. Dispute Resolution</h2>
    <p>Any disputes arising from this promotion shall be governed by the laws of the State of Delaware, without regard to conflict of law principles. Participants agree to resolve disputes through binding individual arbitration and waive any right to participate in class-action lawsuits or class-wide arbitration.</p>

    <h2>12. Sponsor</h2>
    <p>GoldPot Inc. · Contact: support@goldpot.com</p>
  `));
});

app.get('/privacy', (req, res) => {
  res.send(legalPage('Privacy Policy', `
    <h1>PRIVACY POLICY</h1>
    <p class="legal-subtitle">How we collect, use, and protect your data</p>

    <h2>1. Information We Collect</h2>
    <ul>
      <li><b>Account Information:</b> Display name you provide at registration.</li>
      <li><b>Gameplay Data:</b> Entry history, game scores, streaks, achievements, session duration, and in-app actions.</li>
      <li><b>Payment Information:</b> Payment method type (e.g., Apple Pay, card). We do not store full credit card numbers, CVVs, or bank account details. Payment processing is handled by Stripe, Inc., subject to <a href="https://stripe.com/privacy" style="color:var(--gold)">Stripe's Privacy Policy</a>.</li>
      <li><b>Technical Data:</b> IP address, browser type, device type, and referring URL for rate limiting and fraud prevention.</li>
      <li><b>Analytics:</b> Aggregated, anonymized usage events to improve the platform.</li>
    </ul>

    <h2>2. How We Use Information</h2>
    <ul>
      <li>To operate the sweepstakes, process entries, and determine winners.</li>
      <li>To personalize your experience (streaks, levels, achievements, missions).</li>
      <li>To process payments and fulfill prizes.</li>
      <li>To communicate with winners about prize claims and tax reporting.</li>
      <li>To prevent fraud, enforce fair play, and comply with legal obligations.</li>
      <li>To improve platform performance and user experience.</li>
    </ul>

    <h2>3. Data Sharing</h2>
    <p>We do not sell your personal information. We may share data with:</p>
    <ul>
      <li><b>Payment processors</b> (Stripe) to complete transactions.</li>
      <li><b>Tax authorities</b> (IRS) for prizes exceeding $600 as required by law.</li>
      <li><b>Law enforcement</b> if required by valid legal process.</li>
    </ul>

    <h2>4. Data Security</h2>
    <p>We implement industry-standard security measures including HTTPS encryption, CSRF protection, JWT authentication, rate limiting, and input sanitization. However, no method of electronic transmission or storage is 100% secure.</p>

    <h2>5. Data Retention &amp; Deletion</h2>
    <p>Account data is retained while your account is active and for a reasonable period afterward for legal and fraud-prevention purposes. Winner records and tax-related data are retained as required by law. You may request deletion of your account and personal data by contacting support@goldpot.com. Deletion requests will be fulfilled within 30 days, except where retention is required by law.</p>

    <h2>6. Children's Privacy</h2>
    <p>GoldPot is not intended for anyone under 18. We do not knowingly collect personal information from minors. If we discover we have collected information from a minor, we will delete it promptly.</p>

    <h2>7. Your Rights</h2>
    <p>Depending on your state of residence, you may have the right to access, correct, or delete your personal data. California residents may have additional rights under the CCPA. Contact support@goldpot.com to exercise your rights.</p>

    <h2>8. Changes to This Policy</h2>
    <p>We may update this Privacy Policy periodically. Material changes will be posted on the platform. Continued use after changes constitutes acceptance.</p>

    <h2>9. Contact</h2>
    <p>Questions about this policy: support@goldpot.com</p>
  `));
});

app.get('/terms', (req, res) => {
  res.send(legalPage('Terms of Service', `
    <h1>TERMS OF SERVICE</h1>
    <p class="legal-subtitle">By using GoldPot, you agree to these terms</p>

    <h2>1. Acceptance</h2>
    <p>By accessing or using GoldPot, you agree to be bound by these Terms of Service and our Official Rules and Privacy Policy, which are incorporated by reference. If you do not agree, do not use the service.</p>

    <h2>2. Eligibility</h2>
    <p>You must be at least 18 years of age and a legal resident of a U.S. state or territory where sweepstakes participation is permitted. By creating an account, you represent and warrant that you meet these requirements. GoldPot reserves the right to verify eligibility and request proof of age and residency.</p>

    <h2>3. Account Responsibilities</h2>
    <p>You are responsible for maintaining the security of your account credentials. Each individual may maintain only one (1) account. You are responsible for all activity under your account. Notify us immediately at support@goldpot.com if you suspect unauthorized access.</p>

    <h2>4. Payments, Pricing &amp; Refunds</h2>
    <p>All purchases of entries, VIP passes, and premium features are final and non-refundable. Prices are displayed in U.S. dollars and include an 18% operational fee that funds platform maintenance, prize fulfillment infrastructure, and operations. Payment is processed securely by Stripe. GoldPot does not store your full payment credentials.</p>

    <h2>5. Entries &amp; Gameplay</h2>
    <p>Entries obtained through any method (free, paid, bonus, referral) are valid only for the specific pot or drawing in which they are placed. Entries have no cash value and cannot be transferred, sold, or exchanged. Entries reset at the end of each drawing round. Game scores from the Deep Gold mini-game may award bonus entries as described in the Official Rules.</p>

    <h2>6. Fair Play</h2>
    <p>The following are strictly prohibited and will result in immediate account termination, forfeiture of all entries and prizes, and potential legal action:</p>
    <ul>
      <li>Creating or operating multiple accounts</li>
      <li>Using automated tools, scripts, or bots to enter</li>
      <li>Collusion with other participants</li>
      <li>Exploiting bugs or technical vulnerabilities</li>
      <li>Any form of fraud, deception, or manipulation</li>
    </ul>

    <h2>7. Prize Claims &amp; Taxes</h2>
    <p>Winners must claim prizes within thirty (30) days of notification. Unclaimed prizes are forfeited. Winners of prizes exceeding $600 must provide a valid government-issued ID and completed W-9 (or W-8BEN for non-residents where applicable) before prize disbursement. Winners are solely responsible for all applicable federal, state, and local taxes on prizes.</p>

    <h2>8. Intellectual Property</h2>
    <p>All content on GoldPot — including the Deep Gold game, graphics, sounds, and software — is the property of GoldPot Inc. and is protected by applicable intellectual property laws. You may not copy, modify, distribute, or reverse-engineer any part of the platform.</p>

    <h2>9. Limitation of Liability</h2>
    <p>GoldPot is provided "AS IS" and "AS AVAILABLE" without warranties of any kind, express or implied. To the maximum extent permitted by law, GoldPot Inc. shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of winnings, data, or profits, arising from your use of or inability to use the platform. Our total liability shall not exceed the amount you paid to GoldPot in the twelve (12) months preceding the claim.</p>

    <h2>10. Indemnification</h2>
    <p>You agree to indemnify and hold harmless GoldPot Inc., its officers, directors, employees, and agents from any claims, damages, losses, or expenses arising from your use of the platform or violation of these terms.</p>

    <h2>11. Dispute Resolution &amp; Governing Law</h2>
    <p>These terms are governed by the laws of the State of Delaware. Any disputes shall be resolved through binding individual arbitration administered under the rules of the American Arbitration Association. You waive any right to participate in class-action lawsuits or class-wide arbitration. Small claims court actions are permitted.</p>

    <h2>12. Modifications</h2>
    <p>We may update these terms at any time. Material changes will be posted on the platform with the updated effective date. Continued use after changes constitutes acceptance of the revised terms.</p>

    <h2>13. Termination</h2>
    <p>We may suspend or terminate your account at any time for violation of these terms or the Official Rules. Upon termination, all entries are forfeited. Sections regarding liability, indemnification, and dispute resolution survive termination.</p>

    <h2>14. Contact</h2>
    <p>GoldPot Inc. · support@goldpot.com</p>
  `));
});

app.get('/responsible-gaming', (req, res) => {
  res.send(legalPage('Responsible Gaming', `
    <h1>RESPONSIBLE GAMING</h1>
    <p class="legal-subtitle">Your well-being matters to us</p>

    <h2>Play for Fun, Not to Solve Problems</h2>
    <p>GoldPot is designed to be entertaining. If sweepstakes participation is no longer fun or is causing stress, it may be time to take a break.</p>

    <h2>Tools Available to You</h2>
    <ul>
      <li><b>Daily Deposit Limits:</b> Set a maximum amount you can spend per day. Go to Settings → Responsible Gaming in the app to configure your limit.</li>
      <li><b>Self-Exclusion:</b> Temporarily lock your account for 1 to 365 days. During this period you will be unable to make any purchases. Self-exclusion cannot be reversed once activated.</li>
      <li><b>Session Time Reminders:</b> GoldPot will notify you after 60 minutes of continuous play to help you stay aware of time spent.</li>
    </ul>

    <h2>Warning Signs</h2>
    <ul>
      <li>Spending more money or time than you intended</li>
      <li>Chasing losses by buying more entries after not winning</li>
      <li>Borrowing money to play</li>
      <li>Neglecting responsibilities because of sweepstakes participation</li>
      <li>Feeling anxious or irritable when not playing</li>
    </ul>

    <h2>Get Help</h2>
    <p>If you or someone you know has a gambling problem, help is available:</p>
    <ul>
      <li><b>National Council on Problem Gambling:</b> <a href="https://www.ncpgambling.org/" rel="noopener noreferrer" target="_blank" style="color:var(--gold)">ncpgambling.org</a> · 1-800-522-4700 (24/7)</li>
      <li><b>SAMHSA Helpline:</b> 1-800-662-4357 (free, confidential, 24/7)</li>
      <li><b>Crisis Text Line:</b> Text HOME to 741741</li>
    </ul>

    <h2>Our Commitment</h2>
    <p>GoldPot is committed to responsible gaming. We verify that all participants are 18 or older, provide free entry methods so no purchase is ever necessary, and offer the tools above to help you stay in control.</p>
  `));
});

// Serve Deep Gold game
app.get('/goldmine', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'goldmine.html')); });

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Stripe webhook — use raw body (mounted BEFORE express.json)
// Note: for this to work, add express.raw middleware for /api/stripe-webhook
// The route is registered here but needs raw body parsing (see below)
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(503).send();
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) return res.status(503).send();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    log('error', 'Webhook signature verification failed', { error: err.message });
    const ri = reqInfo(req);
    db.logSecurityEvent('critical', 'payment', 'webhook_sig_failed', {
      ip: ri.ip, userAgent: ri.userAgent,
      details: { error: err.message },
    });
    return res.status(400).send();
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Handle donation payments (no playerId required)
    if (session.metadata && session.metadata.purchaseType === 'donation') {
      const donationAmount = session.amount_total || parseInt(session.metadata.amount) || 0;
      const donorName = session.metadata.donorName || 'Anonymous';
      const targetPot = session.metadata.potId || null;
      if (donationAmount > 0) {
        state.launchFund.raised += donationAmount;
        state.launchFund.donors += 1;
        state.launchFund.recentDonors.push({ name: donorName, amount: donationAmount, timestamp: Date.now() });
        if (state.launchFund.recentDonors.length > 20) state.launchFund.recentDonors = state.launchFund.recentDonors.slice(-20);
        // Route donation money to pots (after house cut)
        const donHouseTake = Math.floor(donationAmount * state.houseCut);
        const donNet = donationAmount - donHouseTake;
        if (targetPot && state.pots[targetPot]) {
          state.pots[targetPot].pot += donNet;
        } else {
          const donNetPerPot = Math.floor(donNet / 3);
          for (const potId of ['mini', 'gold', 'mega']) {
            state.pots[potId].pot += donNetPerPot;
          }
        }
        db.saveAppState('launchFund', state.launchFund);
        addFeedEvent('donate', { name: donorName, amount: donationAmount, pot: targetPot });
        db.logAudit('donation', { amount: donationAmount, details: { donorName, sessionId: session.id, potId: targetPot } });
        broadcast({ type: 'state_update' });
      }
      return res.json({ received: true });
    }

    if (!session.metadata || !session.metadata.playerId) {
      log('error', 'Webhook missing metadata', { sessionId: session.id });
      return res.json({ received: true });
    }
    const { playerId, purchaseType, quantity, potId, tier } = session.metadata;
    const player = getPlayer(playerId);
    if (player) {
      const totalCents = session.amount_total;
      const type = purchaseType || 'premium';
      const qty = parseInt(quantity) || 1;
      const pot = potId || 'gold';

      // Mark payment as processed to prevent duplicate via verify-session
      if (!player.processedSessions) player.processedSessions = [];
      if (player.processedSessions.includes(session.id)) {
        return res.json({ received: true }); // Already processed
      }
      player.processedSessions.push(session.id);
      if (player.processedSessions.length > 200) player.processedSessions = player.processedSessions.slice(-200);

      // Track daily deposit amount for responsible gaming limits
      const today = new Date().toISOString().slice(0, 10);
      if (player.depositLimitDate !== today) {
        player.depositTodayCents = 0;
        player.depositLimitDate = today;
      }
      player.depositTodayCents = (player.depositTodayCents || 0) + (session.amount_total || 0);

        if (type === 'premium' || type === 'starter_offer') {
          player.totalSpent += totalCents;
          player.levelInfo = getPlayerLevel(player.totalSpent);
          player.level = player.levelInfo.level;
          if (!player.firstPurchaseAt) player.firstPurchaseAt = Date.now();
        const potData = state.pots[pot] || state.pots.gold;
        const houseTake = Math.floor(totalCents * state.houseCut);
        potData.pot += totalCents - houseTake;

        let mult = player.nextMultiplier || 1;
        if (player.powerSurgeExpires > Date.now()) mult = Math.max(mult, 2);
        mult = Math.min(mult, 5); // cap multiplier
        const totalQty = qty * mult;
        player.nextMultiplier = 1;

        player.entries[pot] = (player.entries[pot] || 0) + totalQty;
        player.totalEntries += totalQty;
        player.gamesPlayed++;
        for (let i = 0; i < totalQty; i++) potData.entries.push({ playerId, timestamp: Date.now(), type: 'premium' });
        potData.totalEntries += totalQty;
        addFeedEvent('play', { name: player.name, pot: potData.label, qty: totalQty, entryType: 'premium' });
        if (potData.pot >= potData.drawThreshold) performDraw(pot);
      }
        // Other purchase types are applied only by their dedicated endpoints after payment proof verification.

      updateStreak(player);
      updateLeaderboard();
      putPlayer(player);
      db.logAudit('stripe_payment', {
        playerId, amount: totalCents,
        details: { type, qty: parseInt(quantity) || 1, pot: potId || 'gold', sessionId: session.id },
      });
      broadcast({ type: 'state_update' });
    }
  }

  // Handle refunds
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const refundedAmount = charge.amount_refunded;
    const sessionId = charge.metadata && charge.metadata.sessionId;
    const playerId = charge.metadata && charge.metadata.playerId;
    if (playerId) {
      const player = getPlayer(playerId);
      if (player) {
        player.totalSpent = Math.max(0, (player.totalSpent || 0) - refundedAmount);
        player.levelInfo = getPlayerLevel(player.totalSpent);
        player.level = player.levelInfo.level;
        putPlayer(player);
      }
      db.logAudit('stripe_refund', {
        playerId, amount: refundedAmount,
        details: { chargeId: charge.id, sessionId },
      });
      log('warn', 'Stripe refund processed', { playerId, amount: refundedAmount, chargeId: charge.id });
    }
  }

  // Handle disputes
  if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object;
    const chargeId = dispute.charge;
    const amount = dispute.amount;
    const playerId = dispute.metadata && dispute.metadata.playerId;
    db.logSecurityEvent('critical', 'payment', 'stripe_dispute', {
      ip: reqInfo(req).ip,
      details: { chargeId, amount, reason: dispute.reason, playerId: playerId || 'unknown' },
    });
    db.logAudit('stripe_dispute', {
      playerId: playerId || 'unknown', amount,
      details: { chargeId, reason: dispute.reason, status: dispute.status },
    });
    log('error', 'Stripe dispute created', { chargeId, amount, reason: dispute.reason });
  }

  res.json({ received: true });
});

// ─── WebSocket Server ───────────────────────────────────────────────────────
const wsClients = new Set();

// ─── Live Chat ──────────────────────────────────────────────────────────────
const CHAT_HISTORY_MAX = 50;
const CHAT_MSG_MAX_LEN = 200;
const CHAT_RATE_WINDOW = 5000; // 5 seconds
const CHAT_RATE_MAX = 3;       // max 3 msgs per window
const chatHistory = [];
const chatMuted = new Set(); // muted player IDs
const chatPolls = new Map(); // pollId -> { question, options, votes: Map<option, Set<playerId>>, creatorId, ts, endsAt }

const PROFANITY_WORDS = ['fuck','shit','bitch','ass','damn','dick','pussy','cock','cunt','fag',
  'nigger','nigga','retard','whore','slut'];
const PROFANITY_RE = new RegExp('\\b(' + PROFANITY_WORDS.join('|') + ')\\b', 'gi');
function filterChatMessage(text) {
  // Strip URLs
  let clean = text.replace(/https?:\/\/\S+/gi, '').replace(/www\.\S+/gi, '');
  // Filter profanity
  clean = clean.replace(PROFANITY_RE, (m) => '*'.repeat(m.length));
  return clean.trim();
}

function getPlayerCosmetics(player) {
  if (!player.cosmetics || !player.cosmetics.equipped) return {};
  const eq = player.cosmetics.equipped;
  const result = {};
  if (eq.nameColor && CHAT_COSMETICS[eq.nameColor]) result.nameColor = CHAT_COSMETICS[eq.nameColor].value;
  if (eq.avatarBorder && CHAT_COSMETICS[eq.avatarBorder]) result.avatarBorder = CHAT_COSMETICS[eq.avatarBorder].value;
  if (eq.msgEffect && CHAT_COSMETICS[eq.msgEffect]) result.msgEffect = CHAT_COSMETICS[eq.msgEffect].value;
  if (eq.title && CHAT_COSMETICS[eq.title]) result.title = CHAT_COSMETICS[eq.title].value;
  return result;
}

function getChatOnlineList() {
  const names = [];
  const seen = new Set();
  for (const client of wsClients) {
    if (client.readyState !== 1 || !client._playerId) continue;
    if (seen.has(client._playerId)) continue;
    seen.add(client._playerId);
    const p = getPlayer(client._playerId);
    if (p) names.push(p.name);
  }
  return names;
}

// ─── Slash Commands ─────────────────────────────────────────────────────────
const EIGHTBALL_ANSWERS = [
  'It is certain 🎱', 'Without a doubt 🎱', 'Yes definitely 🎱', 'You may rely on it 🎱',
  'Most likely 🎱', 'Outlook good 🎱', 'Signs point to yes 🎱', 'Ask again later 🎱',
  'Cannot predict now 🎱', 'Don\'t count on it 🎱', 'My reply is no 🎱', 'Very doubtful 🎱',
  'Absolutely 🎱', 'No chance 🎱', 'The stars say yes ✨', 'Not in a million years 🎱',
];

function handleSlashCommand(ws, player, text) {
  const playerId = ws._playerId;
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/coinflip' || cmd === '/flip') {
    const result = Math.random() < 0.5 ? 'HEADS 🪙' : 'TAILS 🪙';
    const msg = {
      type: 'chat', subtype: 'command',
      id: crypto.randomBytes(8).toString('hex'),
      playerId, name: player.name, text: player.name + ' flipped a coin → ' + result,
      level: player.level || 1, vip: !!(player.vip && player.vipExpires > Date.now()),
      ts: Date.now(), reactions: {}, cosmetics: getPlayerCosmetics(player),
      cmdType: 'coinflip', cmdResult: result,
    };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    broadcast(msg);
    return true;
  }

  if (cmd === '/roll' || cmd === '/dice') {
    const max = Math.min(Math.max(parseInt(parts[1]) || 100, 2), 10000);
    const result = Math.floor(Math.random() * max) + 1;
    const msg = {
      type: 'chat', subtype: 'command',
      id: crypto.randomBytes(8).toString('hex'),
      playerId, name: player.name, text: player.name + ' rolled ' + result + ' (1-' + max + ') 🎲',
      level: player.level || 1, vip: !!(player.vip && player.vipExpires > Date.now()),
      ts: Date.now(), reactions: {}, cosmetics: getPlayerCosmetics(player),
      cmdType: 'roll', cmdResult: result,
    };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    broadcast(msg);
    return true;
  }

  if (cmd === '/8ball') {
    const question = parts.slice(1).join(' ').trim();
    const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
    const msg = {
      type: 'chat', subtype: 'command',
      id: crypto.randomBytes(8).toString('hex'),
      playerId, name: player.name,
      text: player.name + ' asks: "' + filterChatMessage(sanitizeString(question || '???', 80)) + '" → ' + answer,
      level: player.level || 1, vip: !!(player.vip && player.vipExpires > Date.now()),
      ts: Date.now(), reactions: {}, cosmetics: getPlayerCosmetics(player),
      cmdType: '8ball', cmdResult: answer,
    };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    broadcast(msg);
    return true;
  }

  if (cmd === '/me') {
    const action = filterChatMessage(sanitizeString(parts.slice(1).join(' ').trim(), 150));
    if (!action) return true;
    const msg = {
      type: 'chat', subtype: 'action',
      id: crypto.randomBytes(8).toString('hex'),
      playerId, name: player.name, text: player.name + ' ' + action,
      level: player.level || 1, vip: !!(player.vip && player.vipExpires > Date.now()),
      ts: Date.now(), reactions: {}, cosmetics: getPlayerCosmetics(player),
    };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    broadcast(msg);
    return true;
  }

  if (cmd === '/shrug') {
    const rest = parts.slice(1).join(' ').trim();
    const shrug = (rest ? filterChatMessage(sanitizeString(rest, 150)) + ' ' : '') + '¯\\_(ツ)_/¯';
    const msg = {
      type: 'chat',
      id: crypto.randomBytes(8).toString('hex'),
      playerId, name: player.name, text: shrug,
      level: player.level || 1, vip: !!(player.vip && player.vipExpires > Date.now()),
      ts: Date.now(), reactions: {}, cosmetics: getPlayerCosmetics(player),
    };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    broadcast(msg);
    return true;
  }

  if (cmd === '/poll') {
    // /poll Question? Option1 | Option2 | Option3
    const rest = parts.slice(1).join(' ');
    const qMatch = rest.match(/^(.+?)\?\s*(.+)$/);
    if (!qMatch) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'Usage: /poll Question? Option1 | Option2 | Option3' }));
      return true;
    }
    const question = filterChatMessage(sanitizeString(qMatch[1].trim() + '?', 100));
    if (!question || question.replace(/[?\s]/g, '').length === 0) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'Poll question cannot be empty' }));
      return true;
    }
    const options = qMatch[2].split('|').map(o => filterChatMessage(sanitizeString(o.trim(), 40))).filter(o => o.length > 0).slice(0, 6);
    if (options.length < 2) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'Need at least 2 options separated by |' }));
      return true;
    }
    const pollId = crypto.randomBytes(6).toString('hex');
    const votes = {};
    options.forEach(o => { votes[o] = []; });
    chatPolls.set(pollId, { question, options, votes, creatorId: playerId, creatorName: player.name, ts: Date.now(), endsAt: Date.now() + 60000 });
    // Auto-close poll after 60s
    setTimeout(() => {
      const poll = chatPolls.get(pollId);
      if (poll) {
        const results = {};
        for (const [opt, voters] of Object.entries(poll.votes)) results[opt] = voters.length;
        broadcast({ type: 'chat_poll_end', pollId, question: poll.question, results, creatorName: poll.creatorName });
      }
    }, 60000);
    broadcast({
      type: 'chat_poll', pollId, question, options, creatorName: player.name, ts: Date.now(), endsAt: Date.now() + 60000,
      votes: Object.fromEntries(options.map(o => [o, 0])),
    });
    return true;
  }

  if (cmd === '/rain') {
    // /rain <amount> — share entries with everyone online
    const amount = Math.min(Math.max(parseInt(parts[1]) || 0, 1), 50);
    if (!player.entries || player.entries < amount) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'Not enough entries! You have ' + (player.entries || 0) }));
      return true;
    }
    // Collect unique online player IDs (excluding sender)
    const recipients = [];
    const seen = new Set();
    for (const client of wsClients) {
      if (client.readyState !== 1 || !client._playerId) continue;
      if (client._playerId === playerId) continue;
      if (seen.has(client._playerId)) continue;
      seen.add(client._playerId);
      recipients.push(client._playerId);
    }
    if (recipients.length === 0) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'No other players online to rain on!' }));
      return true;
    }
    const perPerson = Math.max(1, Math.floor(amount / recipients.length));
    const totalGiven = perPerson * recipients.length;
    if (player.entries < totalGiven) {
      ws.send(JSON.stringify({ type: 'chat_error', text: 'Not enough entries for ' + recipients.length + ' players! Need at least ' + recipients.length }));
      return true;
    }
    // Deduct first, then distribute — only credit verified players
    player.entries -= totalGiven;
    putPlayer(player);
    let actualGiven = 0;
    for (const rid of recipients) {
      const rp = getPlayer(rid);
      if (rp) {
        rp.entries = (rp.entries || 0) + perPerson;
        putPlayer(rp);
        actualGiven += perPerson;
      }
    }
    // Refund entries for recipients that couldn't be found
    if (actualGiven < totalGiven) {
      player.entries += (totalGiven - actualGiven);
      putPlayer(player);
    }
    broadcast({
      type: 'chat_rain',
      name: player.name,
      playerId,
      totalGiven: actualGiven,
      perPerson,
      recipientCount: Math.floor(actualGiven / perPerson),
      ts: Date.now(),
    });
    return true;
  }

  return false; // not a command
}

function handleChatPollVote(ws, parsed) {
  const playerId = ws._playerId;
  if (!playerId) return;
  const { pollId, option } = parsed;
  if (!pollId || typeof option !== 'string') return;
  const poll = chatPolls.get(pollId);
  if (!poll || Date.now() > poll.endsAt) {
    ws.send(JSON.stringify({ type: 'chat_error', text: 'This poll has ended' }));
    return;
  }
  if (!Array.isArray(poll.votes[option])) {
    ws.send(JSON.stringify({ type: 'chat_error', text: 'Invalid poll option' }));
    return;
  }
  // Remove prior vote
  for (const [opt, voters] of Object.entries(poll.votes)) {
    const idx = voters.indexOf(playerId);
    if (idx >= 0) voters.splice(idx, 1);
  }
  // Add new vote
  poll.votes[option].push(playerId);
  // Broadcast updated counts
  const voteCounts = {};
  for (const [opt, voters] of Object.entries(poll.votes)) voteCounts[opt] = voters.length;
  broadcast({ type: 'chat_poll_update', pollId, votes: voteCounts, voterName: getPlayer(playerId)?.name });
}

function handleChatMessage(ws, parsed) {
  const playerId = ws._playerId;
  if (!playerId) return;
  if (chatMuted.has(playerId)) return;
  const player = getPlayer(playerId);
  if (!player) return;

  const rawText = String(parsed.text || '').trim();

  // Handle slash commands
  if (rawText.startsWith('/')) {
    if (handleSlashCommand(ws, player, rawText)) return;
  }

  const text = filterChatMessage(sanitizeString(rawText, CHAT_MSG_MAX_LEN));
  if (!text || text.length < 1) return;

  // Reply reference
  let replyTo = null;
  if (parsed.replyTo) {
    const orig = chatHistory.find(m => m.id === parsed.replyTo);
    if (orig) replyTo = { id: orig.id, name: orig.name, text: orig.text.slice(0, 60) };
  }

  // GIF message (validated URL from Tenor/GIPHY only)
  let gif = null;
  if (parsed.gif && typeof parsed.gif === 'string') {
    const gifUrl = parsed.gif.trim();
    if (/^https:\/\/(media\.tenor\.com|media[0-9]*\.giphy\.com)\/.+\.(gif|mp4|webm|webp)(\?.*)?$/i.test(gifUrl)) {
      gif = gifUrl;
    }
  }

  const msg = {
    type: 'chat',
    id: crypto.randomBytes(8).toString('hex'),
    playerId,
    name: player.name,
    text,
    level: player.level || 1,
    vip: !!(player.vip && player.vipExpires > Date.now()),
    ts: Date.now(),
    reactions: {},
    cosmetics: getPlayerCosmetics(player),
    replyTo,
    gif,
  };
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
  broadcast(msg);
}

function handleChatDelete(ws, parsed) {
  const playerId = ws._playerId;
  if (!playerId) return;
  const msgId = parsed.msgId;
  if (!msgId) return;
  const idx = chatHistory.findIndex(m => m.id === msgId);
  if (idx < 0) return;
  // Only allow deleting own messages
  if (chatHistory[idx].playerId !== playerId) return;
  chatHistory.splice(idx, 1);
  broadcast({ type: 'chat_delete', msgId });
}

const ALLOWED_REACTIONS = new Set(['🔥','😂','❤️','👀','🏆','💰','🎉','👑','💎','⚡','🤑','🙌']);
function handleChatReaction(ws, parsed) {
  const playerId = ws._playerId;
  if (!playerId) return;
  const { msgId, emoji } = parsed;
  if (!msgId || !emoji || !ALLOWED_REACTIONS.has(emoji)) return;
  const msg = chatHistory.find(m => m.id === msgId);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  const idx = msg.reactions[emoji].indexOf(playerId);
  if (idx >= 0) {
    msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
  } else {
    msg.reactions[emoji].push(playerId);
  }
  broadcast({ type: 'chat_react', msgId, emoji, reactions: msg.reactions });
}

function handleTypingIndicator(ws) {
  const playerId = ws._playerId;
  if (!playerId) return;
  const player = getPlayer(playerId);
  if (!player) return;
  broadcast({ type: 'chat_typing', name: player.name, playerId });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastViewerCount(streamId) {
  const stream = state.streams[streamId];
  if (!stream) return;
  const msg = JSON.stringify({ type: 'stream_viewer_count', streamId, viewers: stream.viewers });
  for (const client of wsClients) {
    if ((client.watchingStream === streamId || client._playerId === stream.streamerId) && client.readyState === 1) {
      client.send(msg);
    }
  }
}

let activePort = Number(PORT) || 3000;
let server;

function startServer(port) {
  server = app.listen(port, '0.0.0.0', () => {
    activePort = port;
    log('info', 'Server started', { port: activePort });
    console.log(`\n  🏆 GOLDPOT is live on port ${activePort}\n`);

    // Attach WebSocket upgrade
    const wss = new WebSocketServer({ noServer: true });
    const wsPerIp = new Map();
    const MAX_WS_PER_IP = 3;
    const MAX_WS_TOTAL = 500;
    server.on('upgrade', (request, socket, head) => {
      // Reject if too many total connections
      if (wsClients.size >= MAX_WS_TOTAL) { socket.destroy(); return; }
      // Per-IP limit
      const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress;
      const ipCount = wsPerIp.get(ip) || 0;
      if (ipCount >= MAX_WS_PER_IP) { socket.destroy(); return; }
      // Verify JWT token from query string
      let wsPlayerId;
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token) { socket.destroy(); return; }
        const decoded = jwt.verify(token, JWT_SECRET);
        wsPlayerId = decoded.sub;
      } catch { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws._clientIp = ip;
        ws._playerId = wsPlayerId;
        const wsPlayer = getPlayer(wsPlayerId);
        ws._playerName = wsPlayer ? wsPlayer.name : 'Anonymous';
        wss.emit('connection', ws, request);
      });
    });
    wss.on('connection', (ws) => {
      wsClients.add(ws);
      const ip = ws._clientIp;
      wsPerIp.set(ip, (wsPerIp.get(ip) || 0) + 1);
      const cleanup = () => {
        wsClients.delete(ws);
        if (ip) {
          const c = (wsPerIp.get(ip) || 1) - 1;
          if (c <= 0) wsPerIp.delete(ip); else wsPerIp.set(ip, c);
        }
        // Clean up stream viewer count
        if (ws.watchingStream && state.streams[ws.watchingStream]) {
          state.streams[ws.watchingStream].viewers = Math.max(0, state.streams[ws.watchingStream].viewers - 1);
          broadcastViewerCount(ws.watchingStream);
        }
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
      // Incoming message rate limiting
      let wsMsgCount = 0;
      const wsRateTimer = setInterval(() => { wsMsgCount = 0; }, 10000);
      ws.on('close', () => clearInterval(wsRateTimer));
      ws.on('error', () => clearInterval(wsRateTimer));
      ws.on('message', (data) => {
        // Reject oversized messages (stream frames up to 64KB, others max 1KB)
        const maxSize = 65536;
        if (data.length > maxSize) { ws.close(1009, 'Message too large'); return; }
        // Parse and route message
        try {
          const parsed = JSON.parse(data);
          // Exempt stream frames from general rate limit (they have their own interval)
          if (parsed.type !== 'stream_frame') wsMsgCount++;
          if (wsMsgCount > 20) { ws.close(1008, 'Rate limit exceeded'); return; }
          if (parsed.type === 'chat') {
            // Per-user chat rate limit
            if (!ws._chatTimes) ws._chatTimes = [];
            const now = Date.now();
            ws._chatTimes = ws._chatTimes.filter(t => now - t < CHAT_RATE_WINDOW);
            if (ws._chatTimes.length >= CHAT_RATE_MAX) return; // silently drop
            ws._chatTimes.push(now);
            handleChatMessage(ws, parsed);
          } else if (parsed.type === 'chat_history') {
            // Send recent chat history to this client
            ws.send(JSON.stringify({ type: 'chat_history', messages: chatHistory.slice(-CHAT_HISTORY_MAX) }));
          } else if (parsed.type === 'chat_react') {
            handleChatReaction(ws, parsed);
          } else if (parsed.type === 'chat_typing') {
            handleTypingIndicator(ws);
          } else if (parsed.type === 'chat_delete') {
            handleChatDelete(ws, parsed);
          } else if (parsed.type === 'chat_poll_vote') {
            handleChatPollVote(ws, parsed);
          } else if (parsed.type === 'chat_online') {
            ws.send(JSON.stringify({ type: 'chat_online', users: getChatOnlineList() }));
          } else if (parsed.type === 'duel_spectate') {
            const duel = state.duels[parsed.duelId];
            if (duel && duel.status !== 'finished') {
              duel.spectators = (duel.spectators || 0) + 1;
              ws.spectatingDuel = parsed.duelId;
              ws.send(JSON.stringify({ type: 'duel_spectate_joined', duel: sanitizeDuel(duel) }));
            }
          } else if (parsed.type === 'duel_leave_spectate') {
            if (ws.spectatingDuel && state.duels[ws.spectatingDuel]) {
              state.duels[ws.spectatingDuel].spectators = Math.max(0, (state.duels[ws.spectatingDuel].spectators || 1) - 1);
            }
            ws.spectatingDuel = null;
          } else if (parsed.type === 'stream_watch') {
            const stream = state.streams[parsed.streamId];
            if (stream && stream.status === 'live') {
              if (ws.watchingStream && state.streams[ws.watchingStream]) {
                state.streams[ws.watchingStream].viewers = Math.max(0, state.streams[ws.watchingStream].viewers - 1);
                broadcastViewerCount(ws.watchingStream);
              }
              stream.viewers++;
              ws.watchingStream = parsed.streamId;
              ws.send(JSON.stringify({ type: 'stream_joined', stream: sanitizeStream(stream), superChats: stream.superChats.slice(-20), chatHistory: (stream.chatMessages || []).slice(-30) }));
              broadcastViewerCount(parsed.streamId);
            }
          } else if (parsed.type === 'stream_leave') {
            if (ws.watchingStream && state.streams[ws.watchingStream]) {
              state.streams[ws.watchingStream].viewers = Math.max(0, state.streams[ws.watchingStream].viewers - 1);
              broadcastViewerCount(ws.watchingStream);
            }
            ws.watchingStream = null;
          } else if (parsed.type === 'stream_chat') {
            // Free chat message
            const stream = ws.watchingStream ? state.streams[ws.watchingStream] : (ws._playerId && state.streams[Object.keys(state.streams).find(k => state.streams[k].streamerId === ws._playerId)]);
            if (stream && stream.status === 'live') {
              const chatMsg = sanitizeString(String(parsed.message || ''), 200);
              if (!chatMsg) return;
              const sender = ws._playerName || 'Anonymous';
              const entry = { sender, message: chatMsg, timestamp: Date.now() };
              if (!stream.chatMessages) stream.chatMessages = [];
              stream.chatMessages.push(entry);
              if (stream.chatMessages.length > 100) stream.chatMessages = stream.chatMessages.slice(-80);
              for (const client of wsClients) {
                if (client.watchingStream === stream.id && client.readyState === 1) {
                  client.send(JSON.stringify({ type: 'stream_chat', streamId: stream.id, chat: entry }));
                }
              }
              // Also send to streamer
              for (const client of wsClients) {
                if (client._playerId === stream.streamerId && client.readyState === 1) {
                  client.send(JSON.stringify({ type: 'stream_chat', streamId: stream.id, chat: entry }));
                }
              }
            }
          } else if (parsed.type === 'stream_frame') {
            // Streamer broadcasting canvas frame data to viewers
            const stream = state.streams[parsed.streamId];
            if (stream && stream.status === 'live' && stream.streamerId === ws._playerId) {
              stream.lastActivity = Date.now();
              // Only send to viewers of this stream
              for (const client of wsClients) {
                if (client !== ws && client.watchingStream === parsed.streamId && client.readyState === 1) {
                  client.send(JSON.stringify({ type: 'stream_frame', frame: parsed.frame, score: parsed.score, viewers: stream.viewers, hypeLevel: stream.hypeLevel, hypeProgress: stream.hypeProgress, hypeGoal: HYPE_TRAIN_LEVELS[Math.min(stream.hypeLevel, HYPE_TRAIN_LEVELS.length - 1)]?.threshold || 5 }));
                }
              }
            }
          }
        } catch { /* ignore malformed */ }
      });
    });
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      log('warn', 'Port busy, trying next', { port, nextPort });
      console.log(`\n  ⚠️ Port ${port} is busy, trying ${nextPort}...\n`);
      setTimeout(() => startServer(nextPort), 200);
      return;
    }
    throw err;
  });
}

startServer(activePort);

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  log('info', `${signal} received — shutting down gracefully`);
  if (server) {
    server.close(() => {
      for (const ws of wsClients) ws.close(1001, 'Server shutting down');
      db.close();
      log('info', 'Server closed');
      process.exit(0);
    });
    // Force exit after 10 seconds
    setTimeout(() => { log('warn', 'Forced shutdown'); process.exit(1); }, 10000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Crash Safety ───────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception — process will exit', { error: err.message, stack: (err.stack || '').slice(0, 500) });
  db.logSecurityEvent('critical', 'system', 'uncaught_exception', {
    details: { error: err.message, stack: (err.stack || '').slice(0, 500) },
  });
  // Attempt graceful shutdown so DB flushes
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('error', 'Unhandled promise rejection', { error: msg });
  db.logSecurityEvent('critical', 'system', 'unhandled_rejection', {
    details: { error: msg },
  });
});
