// ═══════════════════════════════════════════════════════════════════════════
// GOLDPOT — SQLite Persistence Layer
// ═══════════════════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'goldpot.db');

let db;

function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT,
      player_name TEXT NOT NULL,
      prize TEXT NOT NULL,
      pot TEXT NOT NULL,
      round INTEGER,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL,
      event TEXT NOT NULL,
      ip TEXT,
      player_id TEXT,
      details TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_security_ts ON security_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_security_ip ON security_events(ip);
    CREATE INDEX IF NOT EXISTS idx_security_cat ON security_events(category);
    CREATE INDEX IF NOT EXISTS idx_security_sev ON security_events(severity);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      target_id TEXT,
      ip TEXT,
      old_value TEXT,
      new_value TEXT,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      handle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at INTEGER NOT NULL,
      processed_at INTEGER,
      admin_note TEXT
    );

    CREATE TABLE IF NOT EXISTS kyc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      full_name TEXT NOT NULL,
      date_of_birth TEXT,
      address TEXT,
      state TEXT,
      ssn_last4 TEXT,
      id_type TEXT,
      submitted_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      admin_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_kyc_player ON kyc_submissions(player_id);
    CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_submissions(status);
  `);

  return db;
}

// ─── Player CRUD ────────────────────────────────────────────────────────

const stmts = {};

function prepareStatements() {
  stmts.getPlayer = db.prepare('SELECT data FROM players WHERE id = ?');
  stmts.upsertPlayer = db.prepare(`
    INSERT INTO players (id, name, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, name = excluded.name, updated_at = excluded.updated_at
  `);
  stmts.deletePlayer = db.prepare('DELETE FROM players WHERE id = ?');
  stmts.allPlayers = db.prepare('SELECT id, data FROM players');
  stmts.getState = db.prepare('SELECT value FROM app_state WHERE key = ?');
  stmts.upsertState = db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmts.insertWinner = db.prepare(`
    INSERT INTO winners (player_id, player_name, prize, pot, round, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmts.recentWinners = db.prepare('SELECT * FROM winners ORDER BY timestamp DESC LIMIT 50');
  stmts.countPlayers = db.prepare('SELECT COUNT(*) as count FROM players');
  stmts.findByReferralCode = db.prepare("SELECT id, data FROM players WHERE json_extract(data, '$.referralCode') = ? LIMIT 1");
  stmts.topPlayersByEntries = db.prepare("SELECT id, data FROM players WHERE json_extract(data, '$.totalEntries') > 0 ORDER BY json_extract(data, '$.totalEntries') DESC LIMIT ?");
  stmts.insertWithdrawal = db.prepare(`
    INSERT INTO withdrawals (player_id, player_name, amount, method, handle, status, requested_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmts.getPlayerWithdrawals = db.prepare(
    'SELECT * FROM withdrawals WHERE player_id = ? ORDER BY requested_at DESC LIMIT 20'
  );
  stmts.getPendingWithdrawals = db.prepare(
    'SELECT * FROM withdrawals WHERE status = ? ORDER BY requested_at ASC'
  );
  stmts.updateWithdrawalStatus = db.prepare(
    'UPDATE withdrawals SET status = ?, processed_at = ?, admin_note = ? WHERE id = ?'
  );
  stmts.getPendingTotalForPlayer = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE player_id = ? AND status = ?'
  );
  stmts.getWithdrawalById = db.prepare('SELECT * FROM withdrawals WHERE id = ?');

  // Security event statements
  stmts.insertSecurityEvent = db.prepare(`
    INSERT INTO security_events (timestamp, severity, category, event, ip, player_id, details, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.getSecurityEvents = db.prepare(
    'SELECT * FROM security_events WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );
  stmts.getSecurityEventsByIp = db.prepare(
    'SELECT * FROM security_events WHERE ip = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );
  stmts.getSecurityEventsByCategory = db.prepare(
    'SELECT * FROM security_events WHERE category = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );
  stmts.getSecurityEventsBySeverity = db.prepare(
    'SELECT * FROM security_events WHERE severity = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );
  stmts.countSecurityBySeverity = db.prepare(
    'SELECT severity, COUNT(*) as count FROM security_events WHERE timestamp >= ? GROUP BY severity'
  );
  stmts.countSecurityByCategory = db.prepare(
    'SELECT category, COUNT(*) as count FROM security_events WHERE timestamp >= ? GROUP BY category'
  );
  stmts.topSecurityIps = db.prepare(
    'SELECT ip, COUNT(*) as count FROM security_events WHERE severity IN (?,?) AND timestamp >= ? GROUP BY ip ORDER BY count DESC LIMIT ?'
  );
  stmts.countIpRegistrations = db.prepare(
    "SELECT COUNT(*) as count FROM security_events WHERE category = 'auth' AND event = 'register' AND ip = ? AND timestamp >= ?"
  );
  stmts.pruneOldSecurityEvents = db.prepare(
    'DELETE FROM security_events WHERE timestamp < ?'
  );

  // Audit log statements
  stmts.insertAuditLog = db.prepare(`
    INSERT INTO audit_log (timestamp, action, actor, target_id, ip, old_value, new_value, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.getAuditLog = db.prepare(
    'SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );
  stmts.getAuditLogByAction = db.prepare(
    'SELECT * FROM audit_log WHERE action = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
  );

  // KYC statements
  stmts.upsertKyc = db.prepare(`
    INSERT INTO kyc_submissions (player_id, status, full_name, date_of_birth, address, state, ssn_last4, id_type, submitted_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      status = 'pending', full_name = excluded.full_name, date_of_birth = excluded.date_of_birth,
      address = excluded.address, state = excluded.state, ssn_last4 = excluded.ssn_last4,
      id_type = excluded.id_type, submitted_at = excluded.submitted_at, reviewed_at = NULL, admin_note = NULL
  `);
  stmts.getKycByPlayer = db.prepare('SELECT * FROM kyc_submissions WHERE player_id = ?');
  stmts.getPendingKyc = db.prepare("SELECT * FROM kyc_submissions WHERE status = 'pending' ORDER BY submitted_at ASC");
  stmts.updateKycStatus = db.prepare(
    'UPDATE kyc_submissions SET status = ?, reviewed_at = ?, admin_note = ? WHERE player_id = ?'
  );
}

function savePlayer(player) {
  const now = Date.now();
  stmts.upsertPlayer.run(player.id, player.name, JSON.stringify(player), player.createdAt || now, now);
}

function loadPlayer(id) {
  const row = stmts.getPlayer.get(id);
  return row ? JSON.parse(row.data) : null;
}

function loadAllPlayers() {
  const rows = stmts.allPlayers.all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.id, JSON.parse(row.data));
  }
  return map;
}

function saveAppState(key, value) {
  stmts.upsertState.run(key, JSON.stringify(value), Date.now());
}

function loadAppState(key) {
  const row = stmts.getState.get(key);
  return row ? JSON.parse(row.value) : null;
}

function recordWinner(info) {
  stmts.insertWinner.run(
    info.playerId || null,
    info.name,
    String(info.prize),
    info.pot,
    info.round || 0,
    info.timestamp || Date.now()
  );
}

function loadRecentWinners() {
  return stmts.recentWinners.all().map(w => ({
    name: w.player_name,
    prize: w.prize,
    pot: w.pot,
    round: w.round,
    timestamp: w.timestamp,
  }));
}

// ─── Query Helpers ──────────────────────────────────────────────────────

function countPlayers() {
  return stmts.countPlayers.get().count;
}

function findPlayerByReferralCode(code) {
  const row = stmts.findByReferralCode.get(code);
  return row ? JSON.parse(row.data) : null;
}

function getTopPlayersByEntries(limit) {
  return stmts.topPlayersByEntries.all(limit || 10).map(r => JSON.parse(r.data));
}

// ─── Withdrawal CRUD ────────────────────────────────────────────────────

function createWithdrawal(playerId, playerName, amount, method, handle) {
  const result = stmts.insertWithdrawal.run(playerId, playerName, amount, method, handle, Date.now());
  return result.lastInsertRowid;
}

function getPlayerWithdrawals(playerId) {
  return stmts.getPlayerWithdrawals.all(playerId);
}

function getPendingWithdrawals() {
  return stmts.getPendingWithdrawals.all('pending');
}

function updateWithdrawalStatus(id, status, adminNote) {
  const txn = db.transaction(() => {
    const w = stmts.getWithdrawalById.get(id);
    if (!w) return { error: 'Withdrawal not found' };
    if (w.status !== 'pending') return { error: `Withdrawal already ${w.status}` };
    stmts.updateWithdrawalStatus.run(status, Date.now(), adminNote || null, id);
    return { success: true, withdrawal: w };
  });
  return txn();
}

function getPendingTotalForPlayer(playerId) {
  const row = stmts.getPendingTotalForPlayer.get(playerId, 'pending');
  return row ? row.total : 0;
}

function getWithdrawalById(id) {
  return stmts.getWithdrawalById.get(id) || null;
}

// ─── Security Event Logging ─────────────────────────────────────────────

function logSecurityEvent(severity, category, event, opts = {}) {
  stmts.insertSecurityEvent.run(
    Date.now(),
    severity,
    category,
    event,
    opts.ip || null,
    opts.playerId || null,
    opts.details ? JSON.stringify(opts.details) : null,
    opts.userAgent || null
  );
}

function getSecurityEvents(sinceMs, limit = 100) {
  return stmts.getSecurityEvents.all(sinceMs || 0, limit);
}

function getSecurityEventsByIp(ip, sinceMs, limit = 50) {
  return stmts.getSecurityEventsByIp.all(ip, sinceMs || 0, limit);
}

function getSecurityEventsByCategory(category, sinceMs, limit = 100) {
  return stmts.getSecurityEventsByCategory.all(category, sinceMs || 0, limit);
}

function getSecuritySummary(sinceMs) {
  const since = sinceMs || (Date.now() - 24 * 3600000);
  const bySeverity = stmts.countSecurityBySeverity.all(since);
  const byCategory = stmts.countSecurityByCategory.all(since);
  const topIps = stmts.topSecurityIps.all('warn', 'critical', since, 10);
  return { since, bySeverity, byCategory, topIps };
}

function countIpRegistrations(ip, sinceMs) {
  return stmts.countIpRegistrations.get(ip, sinceMs || 0).count;
}

function pruneOldSecurityEvents(olderThanMs) {
  return stmts.pruneOldSecurityEvents.run(olderThanMs);
}

// ─── Financial Audit Log ────────────────────────────────────────────────

function logAudit(action, opts = {}) {
  stmts.insertAuditLog.run(
    Date.now(),
    action,
    opts.actor || opts.playerId || null,
    opts.targetId || null,
    opts.ip || null,
    opts.oldValue != null ? String(opts.oldValue) : null,
    opts.newValue != null ? String(opts.newValue) : null,
    opts.details ? JSON.stringify({ ...(opts.amount != null ? { amount: opts.amount } : {}), ...opts.details }) : (opts.amount != null ? JSON.stringify({ amount: opts.amount }) : null)
  );
}

function getAuditLog(sinceMs, limit = 100) {
  return stmts.getAuditLog.all(sinceMs || 0, limit);
}

function getAuditLogByAction(action, sinceMs, limit = 100) {
  return stmts.getAuditLogByAction.all(action, sinceMs || 0, limit);
}

// ─── Bulk save (called periodically) ────────────────────────────────────

function savePlayers(playersMap) {
  const saveMany = db.transaction((players) => {
    for (const [, player] of players) {
      savePlayer(player);
    }
  });
  saveMany(playersMap);
}

function savePotState(pots) {
  const serializable = {};
  for (const [key, pot] of Object.entries(pots)) {
    serializable[key] = {
      pot: pot.pot,
      totalEntries: pot.totalEntries,
      drawThreshold: pot.drawThreshold,
      round: pot.round,
      winner: pot.winner,
      label: pot.label,
      color: pot.color,
      deadline: pot.deadline,
      entries: pot.entries,
    };
  }
  saveAppState('pots', serializable);
}

function loadPotState() {
  return loadAppState('pots');
}

// Atomic withdrawal: check balance + pending in a transaction, then insert
function atomicCreateWithdrawal(playerId, playerName, amount, method, handle, balance) {
  const txn = db.transaction(() => {
    const pending = stmts.getPendingTotalForPlayer.get(playerId, 'pending');
    const pendingTotal = pending ? pending.total : 0;
    const available = balance - pendingTotal;
    if (amount > available) return { error: `Insufficient balance. Available: $${(available / 100).toFixed(2)}` };
    const result = stmts.insertWithdrawal.run(playerId, playerName, amount, method, handle, Date.now());
    return { withdrawalId: result.lastInsertRowid };
  });
  return txn();
}

// ─── KYC ──────────────────────────────────────────────────────────────────

function submitKyc(playerId, data) {
  stmts.upsertKyc.run(playerId, data.fullName, data.dateOfBirth || null, data.address || null,
    data.state || null, data.ssnLast4 || null, data.idType || null, Date.now());
}

function getKycStatus(playerId) {
  return stmts.getKycByPlayer.get(playerId) || null;
}

function getPendingKyc() {
  return stmts.getPendingKyc.all();
}

function updateKycStatus(playerId, status, adminNote) {
  stmts.updateKycStatus.run(status, Date.now(), adminNote || null, playerId);
}

function close() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    db.close();
  }
}

function checkpoint() {
  if (db) db.pragma('wal_checkpoint(PASSIVE)');
}

module.exports = {
  init,
  prepareStatements,
  savePlayer,
  loadPlayer,
  loadAllPlayers,
  savePlayers,
  countPlayers,
  findPlayerByReferralCode,
  getTopPlayersByEntries,
  saveAppState,
  loadAppState,
  savePotState,
  loadPotState,
  recordWinner,
  loadRecentWinners,
  // createWithdrawal intentionally NOT exported — use atomicCreateWithdrawal instead
  getPlayerWithdrawals,
  getPendingWithdrawals,
  updateWithdrawalStatus,
  getPendingTotalForPlayer,
  getWithdrawalById,
  atomicCreateWithdrawal,
  logSecurityEvent,
  getSecurityEvents,
  getSecurityEventsByIp,
  getSecurityEventsByCategory,
  getSecuritySummary,
  countIpRegistrations,
  pruneOldSecurityEvents,
  logAudit,
  getAuditLog,
  getAuditLogByAction,
  submitKyc,
  getKycStatus,
  getPendingKyc,
  updateKycStatus,
  checkpoint,
  close,
};
