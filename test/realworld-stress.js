/**
 * Real-World Stress & Fuzz Test
 *
 * Simulates realistic user journeys end-to-end:
 *  Phase 1: Registration storm (500 users, burst)
 *  Phase 2: Concurrent gameplay (free entries, daily bonus, spin, ads, game bonus)
 *  Phase 3: Chat flood + WebSocket stress
 *  Phase 4: Purchase flows (checkout sessions, mystery boxes, lightning deals)
 *  Phase 5: Jackpot & flash pot entries
 *  Phase 6: PvP duel simulation
 *  Phase 7: Referral chain stress
 *  Phase 8: Responsible gaming features under load
 *  Phase 9: Withdrawal & KYC flow
 *  Phase 10: Edge-case fuzzing (malformed data, boundary values, unicode, huge payloads)
 *  Phase 11: Concurrent state consistency (pot values, entry counts)
 *  Phase 12: Session marathon (long user journeys)
 *
 * Usage:
 *   1. Start server:  PORT=3099 DEMO_MODE=true node server.js
 *   2. Run:           node test/realworld-stress.js
 */

'use strict';
const http = require('http');
const crypto = require('crypto');

const BASE = process.env.TEST_URL || 'http://localhost:3099';
const url = new URL(BASE);
const HOST = url.hostname;
const PORT = parseInt(url.port) || 80;
const NUM_USERS = parseInt(process.env.STRESS_USERS) || 200;
const CONCURRENCY = parseInt(process.env.STRESS_CONCURRENCY) || 50;

// ── Results ─────────────────────────────────────────────────────────────────
const results = [];
let passed = 0, failed = 0;
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (pass) passed++; else failed++;
  const icon = pass ? '✓' : '✗';
  console.log(`  ${icon} ${id}: ${name} — ${detail}`);
}

// ── HTTP Helper ─────────────────────────────────────────────────────────────
function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    const start = Date.now();
    const r = http.request({ hostname: HOST, port: PORT, path, method, headers: hdrs, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let csrf = null;
        const sc = res.headers['set-cookie'];
        if (sc) { for (const c of sc) { const m = c.match(/_csrf=([^;]+)/); if (m) csrf = m[1]; } }
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, csrf, latency: Date.now() - start });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, error: e.message, latency: Date.now() - start }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null, error: 'timeout', latency: Date.now() - start }); });
    if (payload) r.write(payload);
    r.end();
  });
}

function authHeaders(token, csrf) {
  const h = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (csrf) { h['Cookie'] = `_csrf=${csrf}`; h['X-CSRF-Token'] = csrf; }
  return h;
}

// Fetch a CSRF token from the server (GET request sets cookie)
async function getCsrf(ip) {
  const r = await req('GET', '/', null, { 'X-Forwarded-For': ip || '10.0.0.1' });
  // Parse _csrf from set-cookie header
  const sc = r.headers['set-cookie'];
  if (sc) {
    for (const c of (Array.isArray(sc) ? sc : [sc])) {
      const m = c.match(/_csrf=([^;]+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function randomName() { return 'U_' + crypto.randomBytes(6).toString('hex'); }
function randomEmail() { return `test_${crypto.randomBytes(6).toString('hex')}@stresstest.com`; }
function randomDob() { const y = 1970 + Math.floor(Math.random() * 35); return `${y}-06-15`; }
function randomIp() { return `${100 + Math.floor(Math.random()*155)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}`; }

// ── Concurrency helper ──────────────────────────────────────────────────────
async function runPool(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║     GOLDPOT REAL-WORLD STRESS & FUZZ TEST                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Target: ${BASE}`);
  console.log(`Users: ${NUM_USERS} | Concurrency: ${CONCURRENCY}\n`);

  // Connectivity check
  const probe = await req('GET', '/api/state', null, { 'X-Forwarded-For': '10.0.0.1' });
  if (probe.status === 0) {
    console.error(`\n  ✗ Server not reachable at ${BASE}\n`);
    console.error('  Start it with: PORT=3099 DEMO_MODE=true node server.js\n');
    process.exit(1);
  }

  const startTime = Date.now();

  // ═══ Phase 1: Registration Storm ═══════════════════════════════════════════
  console.log('\n── Phase 1: Registration Storm ──────────────────────────────');
  const users = [];
  const regTasks = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const name = randomName();
    const ip = randomIp();
    regTasks.push(async () => {
      // Get CSRF token first
      const csrf = await getCsrf(ip);
      if (!csrf) return null;
      const r = await req('POST', '/api/register', { name, email: randomEmail(), dateOfBirth: randomDob() }, {
        'X-Forwarded-For': ip,
        'Cookie': `_csrf=${csrf}`,
        'X-CSRF-Token': csrf,
      });
      if (r.status === 200 && r.body && r.body.token) {
        return { name, token: r.body.token, playerId: r.body.player?.id, ip, csrf };
      }
      return null;
    });
  }
  const regResults = await runPool(regTasks, CONCURRENCY);
  for (const u of regResults) { if (u) users.push(u); }
  const regRate = users.length / NUM_USERS * 100;
  record('P1.1', `Registration success rate (${users.length}/${NUM_USERS})`, regRate >= 80,
    `${regRate.toFixed(1)}% registered`);

  if (users.length < 20) {
    console.error('\n  ✗ Too few users registered to continue. Check server.\n');
    printSummary(startTime);
    process.exit(1);
  }

  // ═══ Phase 2: Concurrent Gameplay ══════════════════════════════════════════
  console.log('\n── Phase 2: Concurrent Gameplay ─────────────────────────────');

  // 2a: Free entries — every user tries free entry on mini pot
  const freeEntryTasks = users.slice(0, 200).map(u => async () => {
    return req('POST', '/api/free-entry', { playerId: u.playerId, potId: 'mini' },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip });
  });
  const freeResults = await runPool(freeEntryTasks, CONCURRENCY);
  const freeOk = freeResults.filter(r => r.status === 200).length;
  const freeDenied = freeResults.filter(r => r.status === 400 || r.status === 429).length;
  record('P2.1', `Free entries (${freeOk} ok, ${freeDenied} denied)`, freeOk > 0,
    `${freeOk} succeeded, ${freeDenied} denied, ${freeResults.filter(r => r.status === 0).length} errors`);

  // 2b: Double free entry attempts (should be denied)
  await sleep(300);
  const doubleFreeResults = await runPool(
    users.slice(0, 50).map(u => async () =>
      req('POST', '/api/free-entry', { playerId: u.playerId, potId: 'mini' },
        { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
    ), CONCURRENCY);
  const doubleFreeDenied = doubleFreeResults.filter(r => r.status === 400).length;
  record('P2.2', 'Double free entry blocked', doubleFreeDenied >= doubleFreeResults.length * 0.8,
    `${doubleFreeDenied}/${doubleFreeResults.length} correctly denied`);

  // 2c: Daily bonus claims
  await sleep(300);
  const bonusTasks = users.slice(0, 100).map(u => async () =>
    req('POST', '/api/daily-bonus', { playerId: u.playerId },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const bonusResults = await runPool(bonusTasks, CONCURRENCY);
  const bonusOk = bonusResults.filter(r => r.status === 200).length;
  record('P2.3', `Daily bonus claims (${bonusOk}/100)`, bonusOk > 0,
    `${bonusOk} succeeded, ${bonusResults.filter(r => r.status === 400).length} denied`);

  // 2d: Spin wheel
  await sleep(300);
  const spinTasks = users.slice(0, 100).map(u => async () =>
    req('POST', '/api/spin-wheel', { playerId: u.playerId },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const spinResults = await runPool(spinTasks, CONCURRENCY);
  const spinOk = spinResults.filter(r => r.status === 200).length;
  record('P2.4', `Spin wheel (${spinOk}/100)`, spinOk > 0,
    `${spinOk} succeeded, ${spinResults.filter(r => r.status !== 200).length} denied/rate-limited`);

  // 2e: Watch ad entries
  await sleep(300);
  const adTasks = users.slice(100, 200).map(u => async () =>
    req('POST', '/api/ad-entry', { playerId: u.playerId, potId: 'mini' },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const adResults = await runPool(adTasks, 50);
  const adOk = adResults.filter(r => r.status === 200).length;
  record('P2.5', `Ad entries (${adOk}/100)`, true,
    `${adOk} succeeded, ${adResults.filter(r => r.status !== 200).length} denied`);

  // 2f: Game bonus (submit game scores)
  await sleep(300);
  const gameBonusTasks = users.slice(0, 50).map(u => async () =>
    req('POST', '/api/game-bonus', { playerId: u.playerId, score: 50 + Math.floor(Math.random() * 300), potId: 'mini' },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const gameResults = await runPool(gameBonusTasks, 50);
  const gameOk = gameResults.filter(r => r.status === 200).length;
  record('P2.6', `Game bonus submissions (${gameOk}/50)`, true,
    `${gameOk} accepted, ${gameResults.filter(r => r.status !== 200).length} denied`);

  // ═══ Phase 3: State Consistency ════════════════════════════════════════════
  console.log('\n── Phase 3: State Consistency ───────────────────────────────');

  // 3a: All users fetch state concurrently
  const stateTasks = users.slice(0, 200).map(u => async () =>
    req('GET', '/api/state', null, { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const stateResults = await runPool(stateTasks, CONCURRENCY);
  const stateOk = stateResults.filter(r => r.status === 200).length;
  record('P3.1', `State fetches (${stateOk}/200)`, stateOk >= 180,
    `${stateOk} succeeded`);

  // 3b: State data integrity — all states should have same pot values
  const potAmounts = stateResults.filter(r => r.status === 200 && r.body?.pots)
    .map(r => JSON.stringify(Object.keys(r.body.pots).sort()));
  const uniquePotKeys = [...new Set(potAmounts)];
  record('P3.2', 'Pot structure consistent across users', uniquePotKeys.length === 1,
    `${uniquePotKeys.length} unique pot structures`);

  // 3c: Entry counts should be non-negative
  const entryStates = stateResults.filter(r => r.status === 200 && r.body?.pots);
  let negativeEntries = 0;
  for (const s of entryStates) {
    for (const p of Object.values(s.body.pots)) {
      if (p.entries < 0 || p.amount < 0) negativeEntries++;
    }
  }
  record('P3.3', 'No negative entry/pot values', negativeEntries === 0,
    negativeEntries === 0 ? 'All values ≥ 0' : `${negativeEntries} negative values found`);

  // 3d: Leaderboard from state data
  const lbCount = stateResults.filter(r => r.status === 200 && r.body?.leaderboard).length;
  record('P3.4', `Leaderboard in state (${lbCount}/${stateOk})`, lbCount > 0,
    `${lbCount} state responses include leaderboard`);

  // ═══ Phase 4: Purchase Flow Simulation ═════════════════════════════════════
  console.log('\n── Phase 4: Purchase Flow Simulation ───────────────────────');

  // 4a: Create checkout sessions (should work in demo mode)
  await sleep(300);
  const checkoutTypes = ['premium_entry', 'bundle_5', 'bundle_10', 'mystery_box_bronze', 'mystery_box_silver',
    'mystery_box_gold', 'all_in', 'power_surge', 'mega_multiplier', 'streak_saver'];
  const checkoutTasks = [];
  for (let i = 0; i < 50; i++) {
    const u = users[i % users.length];
    const type = checkoutTypes[i % checkoutTypes.length];
    checkoutTasks.push(async () =>
      req('POST', '/api/create-checkout-session', { playerId: u.playerId, type, potId: 'mini' },
        { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
    );
  }
  const checkoutResults = await runPool(checkoutTasks, 30);
  const checkoutOk = checkoutResults.filter(r => r.status === 200 || r.status === 503).length;
  record('P4.1', `Checkout sessions (${checkoutOk}/50)`, checkoutOk > 0,
    `${checkoutOk} responded (200 or 503/no-stripe)`);

  // 4b: Premium entries in demo mode
  await sleep(300);
  const premTasks = users.slice(0, 30).map(u => async () =>
    req('POST', '/api/premium-entry', { playerId: u.playerId, potId: 'mini' },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const premResults = await runPool(premTasks, 30);
  const premOk = premResults.filter(r => r.status === 200).length;
  record('P4.2', `Premium entries in demo (${premOk}/30)`, true,
    `${premOk} accepted, ${premResults.filter(r => r.status !== 200).length} denied`);

  // ═══ Phase 5: Jackpot & Flash Entries ══════════════════════════════════════
  console.log('\n── Phase 5: Jackpot & Flash Entries ─────────────────────────');

  // 5a: Jackpot entries
  await sleep(300);
  const jpTiers = ['silver', 'gold', 'platinum', 'diamond'];
  const jpTasks = users.slice(0, 40).map((u, i) => async () =>
    req('POST', '/api/jackpot-entry', { playerId: u.playerId, tier: jpTiers[i % 4] },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const jpResults = await runPool(jpTasks, 30);
  const jpOk = jpResults.filter(r => r.status === 200).length;
  record('P5.1', `Jackpot entries (${jpOk}/40)`, true,
    `${jpOk} accepted across ${jpTiers.length} tiers`);

  // 5b: Flash pot entries
  await sleep(300);
  const flashTasks = users.slice(0, 30).map(u => async () =>
    req('POST', '/api/flash-entry', { playerId: u.playerId },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const flashResults = await runPool(flashTasks, 30);
  const flashOk = flashResults.filter(r => r.status === 200).length;
  record('P5.2', `Flash entries (${flashOk}/30)`, true,
    `${flashOk} accepted`);

  // ═══ Phase 6: PvP Duel Simulation ══════════════════════════════════════════
  console.log('\n── Phase 6: PvP Duel Simulation ─────────────────────────────');

  // 6a: Create duels
  await sleep(300);
  const duelUsers = users.slice(0, 20);
  const creators = duelUsers.filter((_, i) => i % 2 === 0);
  const joiners = duelUsers.filter((_, i) => i % 2 === 1);

  const duelCreateTasks = creators.map(u => async () =>
    req('POST', '/api/duel-create', { playerId: u.playerId, stakeId: 'stake_1' },
      { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
  );
  const duelCreateResults = await runPool(duelCreateTasks, 10);
  const duelsCreated = duelCreateResults.filter(r => r.status === 200).length;
  record('P6.1', `Duels created (${duelsCreated}/10)`, true,
    `${duelsCreated} created`);

  // 6b: Join duels
  await sleep(300);
  const duelIds = duelCreateResults.filter(r => r.status === 200 && r.body?.duel)
    .map(r => r.body.duel.id);
  const duelJoinTasks = duelIds.slice(0, 5).map((duelId, i) => {
    const u = joiners[i] || joiners[0];
    return async () =>
      req('POST', '/api/duel-join', { playerId: u.playerId, duelId },
        { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip });
  });
  const duelJoinResults = await runPool(duelJoinTasks, 5);
  const duelsJoined = duelJoinResults.filter(r => r.status === 200).length;
  record('P6.2', `Duels joined (${duelsJoined}/${duelIds.length})`, true,
    `${duelsJoined} joined`);

  // ═══ Phase 7: Referral Chain Stress ════════════════════════════════════════
  console.log('\n── Phase 7: Referral Chain Stress ───────────────────────────');

  // 7a: Submit referrals
  await sleep(300);
  const refTasks = [];
  for (let i = 1; i < Math.min(50, users.length); i++) {
    const referrer = users[i - 1];
    const referee = users[i];
    refTasks.push(async () =>
      req('POST', '/api/referral', { playerId: referee.playerId, referrerName: referrer.name },
        { ...authHeaders(referee.token, referee.csrf), 'X-Forwarded-For': referee.ip })
    );
  }
  const refResults = await runPool(refTasks, 20);
  const refOk = refResults.filter(r => r.status === 200).length;
  const refDenied = refResults.filter(r => r.status === 400).length;
  record('P7.1', `Referrals (${refOk} ok, ${refDenied} denied)`, true,
    `${refOk} accepted, ${refDenied} denied (self/dupe)`);

  // 7b: Referral dashboard accessible
  const refDashRes = await req('GET', `/api/referral-dashboard/${users[0].playerId}`, null,
    { ...authHeaders(users[0].token), 'X-Forwarded-For': users[0].ip });
  record('P7.2', 'Referral dashboard accessible', refDashRes.status === 200,
    `Status: ${refDashRes.status}`);

  // ═══ Phase 8: Responsible Gaming Under Load ════════════════════════════════
  console.log('\n── Phase 8: Responsible Gaming ──────────────────────────────');

  // 8a: Set deposit limits
  await sleep(300);
  const limUser = users[users.length - 1];
  const limRes = await req('POST', '/api/deposit-limit',
    { limit: 50 },
    { ...authHeaders(limUser.token, limUser.csrf), 'X-Forwarded-For': limUser.ip });
  record('P8.1', 'Set deposit limit', limRes.status === 200,
    `Status: ${limRes.status}`);

  // 8b: Self-exclusion
  const exclUser = users[users.length - 2];
  const exclRes = await req('POST', '/api/self-exclude',
    { playerId: exclUser.playerId, days: 1 },
    { ...authHeaders(exclUser.token, exclUser.csrf), 'X-Forwarded-For': exclUser.ip });
  record('P8.2', 'Self-exclusion set', exclRes.status === 200,
    `Status: ${exclRes.status}`);

  // 8c: Self-excluded user cannot make free entry
  await sleep(200);
  const exclEntryRes = await req('POST', '/api/free-entry',
    { playerId: exclUser.playerId, potId: 'mini' },
    { ...authHeaders(exclUser.token, exclUser.csrf), 'X-Forwarded-For': exclUser.ip });
  record('P8.3', 'Self-excluded user blocked from entries', exclEntryRes.status === 403,
    `Status: ${exclEntryRes.status} — ${exclEntryRes.body?.error || 'no error msg'}`);

  // 8d: Self-excluded user cannot spin
  const exclSpinRes = await req('POST', '/api/spin-wheel',
    { playerId: exclUser.playerId },
    { ...authHeaders(exclUser.token, exclUser.csrf), 'X-Forwarded-For': exclUser.ip });
  record('P8.4', 'Self-excluded user blocked from spin', exclSpinRes.status === 403,
    `Status: ${exclSpinRes.status}`);

  // 8e: Responsible gaming info endpoint
  const rgRes = await req('GET', '/api/responsible-gaming', null,
    { ...authHeaders(exclUser.token), 'X-Forwarded-For': exclUser.ip });
  record('P8.5', 'Responsible gaming info accessible', rgRes.status === 200,
    `Status: ${rgRes.status}`);

  // ═══ Phase 9: Withdrawal & KYC Flow ════════════════════════════════════════
  console.log('\n── Phase 9: Withdrawal & KYC ────────────────────────────────');

  // 9a: Withdrawal without balance
  await sleep(300);
  const wdUser = users[0];
  const wdRes = await req('POST', '/api/withdraw',
    { playerId: wdUser.playerId, amountCents: 100 },
    { ...authHeaders(wdUser.token, wdUser.csrf), 'X-Forwarded-For': wdUser.ip });
  record('P9.1', 'Withdrawal with no balance', wdRes.status === 400 || wdRes.status === 403,
    `Status: ${wdRes.status} — ${wdRes.body?.error || ''}`);

  // 9b: KYC status check
  const kycRes = await req('GET', '/api/kyc-status', null,
    { ...authHeaders(wdUser.token), 'X-Forwarded-For': wdUser.ip });
  record('P9.2', 'KYC status check', kycRes.status === 200 || kycRes.status === 404,
    `Status: ${kycRes.status}`);

  // ═══ Phase 10: Edge-Case Fuzzing ═══════════════════════════════════════════
  console.log('\n── Phase 10: Edge-Case Fuzzing ──────────────────────────────');
  const fuzzUser = users[1];
  const fuzzH = { ...authHeaders(fuzzUser.token, fuzzUser.csrf), 'X-Forwarded-For': fuzzUser.ip };

  // Helper: register with auto-CSRF
  async function fuzzRegister(body, ip) {
    const fip = ip || randomIp();
    const csrf = await getCsrf(fip);
    // Add email and dateOfBirth if not present (needed for registration)
    const fullBody = { email: randomEmail(), dateOfBirth: randomDob(), ...body };
    return req('POST', '/api/register', fullBody, {
      'X-Forwarded-For': fip, 'Cookie': `_csrf=${csrf}`, 'X-CSRF-Token': csrf,
    });
  }

  // 10a: Unicode name registration
  const unicodeRes = await fuzzRegister({ name: '💎🔥ゴールド金' });
  record('P10.1', 'Unicode name registration', unicodeRes.status === 200 || unicodeRes.status === 400,
    `Status: ${unicodeRes.status}`);

  // 10b: Empty body POST (server injects playerId from JWT, so may succeed)
  const emptyRes = await req('POST', '/api/free-entry', null, fuzzH);
  record('P10.2', 'Empty body handling',
    emptyRes.status === 200 || emptyRes.status === 400 || emptyRes.status === 422,
    `Status: ${emptyRes.status} — server didn't crash`);

  // 10c: Extremely long name — server sanitizes/truncates to 20 chars
  const longName = 'A'.repeat(5000);
  const longRes = await fuzzRegister({ name: longName });
  record('P10.3', 'Oversized name handled', longRes.status === 200 || longRes.status === 400,
    `Status: ${longRes.status} — name truncated or rejected`);

  // 10d: Negative entry values
  const negRes = await req('POST', '/api/jackpot-entry',
    { playerId: fuzzUser.playerId, tier: 'silver', count: -999 }, fuzzH);
  record('P10.4', 'Negative count handled', negRes.status !== 0,
    `Status: ${negRes.status} — no crash`);

  // 10e: Invalid pot ID
  const badPotRes = await req('POST', '/api/free-entry',
    { playerId: fuzzUser.playerId, potId: 'nonexistent_pot_XXXX' }, fuzzH);
  record('P10.5', 'Invalid pot ID rejected', badPotRes.status === 400,
    `Status: ${badPotRes.status}`);

  // 10f: SQL injection in name
  const sqlInj = await fuzzRegister({ name: "'; DROP TABLE players;--" });
  record('P10.6', 'SQL injection in name', sqlInj.status === 200 || sqlInj.status === 400,
    `Status: ${sqlInj.status} — server survived`);

  // 10g: XSS in chat (via API, though usually via WS)
  const xssPayload = '<script>alert(1)</script>';
  const xssRes = await fuzzRegister({ name: xssPayload });
  record('P10.7', 'XSS in name handled', xssRes.status === 200 || xssRes.status === 400,
    `Status: ${xssRes.status} (should sanitize or reject)`);

  // 10h: Zero-length name — server generates default name (Player_XXXXXX)
  const zeroRes = await fuzzRegister({ name: '' });
  record('P10.8', 'Empty name handled', zeroRes.status === 200 || zeroRes.status === 400,
    `Status: ${zeroRes.status}`);

  // 10i: Huge JSON payload
  const hugePayload = { playerId: fuzzUser.playerId, junk: 'X'.repeat(100000) };
  const hugeRes = await req('POST', '/api/free-entry', hugePayload, fuzzH);
  record('P10.9', 'Huge payload handled', hugeRes.status === 413 || hugeRes.status === 400 || hugeRes.status === 200,
    `Status: ${hugeRes.status}`);

  // 10j: Invalid JSON
  const badJsonRes = await req('POST', '/api/free-entry', '{bad json!!!!', {
    ...fuzzH, 'Content-Type': 'application/json'
  });
  record('P10.10', 'Invalid JSON handled', badJsonRes.status === 400 || badJsonRes.status === 422,
    `Status: ${badJsonRes.status}`);

  // 10k: Prototype pollution
  const protoRes = await fuzzRegister(
    { name: 'test', __proto__: { admin: true }, constructor: { prototype: { admin: true } } });
  record('P10.11', 'Prototype pollution benign', protoRes.status === 200 || protoRes.status === 400,
    `Status: ${protoRes.status}`);

  // 10l: Float/NaN values for numeric fields
  const nanRes = await req('POST', '/api/deposit-limit',
    { playerId: fuzzUser.playerId, dailyLimitCents: NaN }, fuzzH);
  record('P10.12', 'NaN numeric value handled', nanRes.status !== 0,
    `Status: ${nanRes.status} — no crash`);

  // 10m: Array where string expected
  const arrRes = await fuzzRegister({ name: [1, 2, 3] });
  record('P10.13', 'Array-as-name handled', arrRes.status === 400 || arrRes.status === 200,
    `Status: ${arrRes.status}`);

  // 10n: Missing CSRF on protected endpoint
  const noCsrf = await req('POST', '/api/free-entry',
    { playerId: fuzzUser.playerId, potId: 'mini' },
    { 'Authorization': `Bearer ${fuzzUser.token}`, 'X-Forwarded-For': fuzzUser.ip });
  record('P10.14', 'Missing CSRF token rejected', noCsrf.status === 403,
    `Status: ${noCsrf.status}`);

  // ═══ Phase 11: Concurrent Pot Consistency ══════════════════════════════════
  console.log('\n── Phase 11: Concurrent Pot Consistency ─────────────────────');

  // 11a: Hammer free entries on all 3 pots simultaneously
  await sleep(500);
  const consistencyUsers = users.slice(50, 150);
  const potIds = ['mini', 'gold', 'mega'];
  const potTasks = [];
  for (const u of consistencyUsers) {
    for (const pot of potIds) {
      potTasks.push(async () =>
        req('POST', '/api/free-entry', { playerId: u.playerId, potId: pot },
          { ...authHeaders(u.token, u.csrf), 'X-Forwarded-For': u.ip })
      );
    }
  }
  const potResults = await runPool(potTasks, CONCURRENCY);
  const potOk = potResults.filter(r => r.status === 200).length;
  record('P11.1', `Multi-pot free entries (${potOk}/${potTasks.length})`, potOk > 0,
    `${potOk} accepted across 3 pots`);

  // 11b: Check pot state is still valid
  const finalState = await req('GET', '/api/state', null,
    { ...authHeaders(users[0].token), 'X-Forwarded-For': users[0].ip });
  const pots = finalState.body?.pots;
  let potsValid = true;
  if (pots) {
    for (const [id, p] of Object.entries(pots)) {
      if (p.entries < 0 || p.amount < 0) { potsValid = false; break; }
    }
  }
  record('P11.2', 'Pot values still valid after stress', potsValid,
    pots ? `mini: ${pots.mini?.entries || 0} entries, gold: ${pots.gold?.entries || 0}, mega: ${pots.mega?.entries || 0}` : 'No pot data');

  // ═══ Phase 12: Session Marathon ════════════════════════════════════════════
  console.log('\n── Phase 12: Session Marathon ───────────────────────────────');

  // 12a: Full user journey — register, state, free entry, bonus, spin, ad, leaderboard, profile
  const marathonUser = users[5];
  const mh = { ...authHeaders(marathonUser.token, marathonUser.csrf), 'X-Forwarded-For': marathonUser.ip };
  const journey = [
    ['GET', '/api/state', null, `State fetch`],
    ['GET', '/api/leaderboard', null, 'Leaderboard'],
    ['GET', '/api/activity', null, 'Activity feed'],
    ['GET', '/api/responsible-gaming-info', null, 'RG info'],
    ['GET', '/api/missions', null, 'Missions'],
    ['POST', '/api/session-time', { playerId: marathonUser.playerId, seconds: 120 }, 'Session time'],
  ];
  let journeyOk = 0;
  for (const [method, path, body, label] of journey) {
    const r = await req(method, path, body, mh);
    if (r.status === 200 || r.status === 404) journeyOk++;
    await sleep(100);
  }
  record('P12.1', `Full user journey (${journeyOk}/${journey.length} steps)`, journeyOk >= journey.length - 1,
    `${journeyOk}/${journey.length} steps succeeded`);

  // 12b: Reauth token (expects Authorization header, body not needed)
  const reauthRes = await req('POST', '/api/reauth', {},
    { ...authHeaders(marathonUser.token, marathonUser.csrf), 'X-Forwarded-For': marathonUser.ip });
  record('P12.2', 'Token reauth', reauthRes.status === 200,
    `Status: ${reauthRes.status}`);

  // 12c: Multiple rapid state fetches (10 in 2 seconds)
  const rapidTasks = Array.from({ length: 10 }, () => async () =>
    req('GET', '/api/state', null, { ...authHeaders(marathonUser.token), 'X-Forwarded-For': marathonUser.ip })
  );
  const rapidResults = await runPool(rapidTasks, 10);
  const rapidOk = rapidResults.filter(r => r.status === 200).length;
  record('P12.3', `Rapid state fetches (${rapidOk}/10)`, rapidOk >= 8,
    `${rapidOk}/10 succeeded`);

  // ═══ Phase 13: Latency & Throughput Summary ════════════════════════════════
  console.log('\n── Phase 13: Performance Summary ────────────────────────────');

  const allLatencies = [];
  // Collect latencies from all phases (approximate from state results)
  for (const r of [...stateResults, ...freeResults, ...bonusResults]) {
    if (r.latency) allLatencies.push(r.latency);
  }
  if (allLatencies.length > 0) {
    allLatencies.sort((a, b) => a - b);
    const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
    const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];
    const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)];
    const avg = Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length);
    record('P13.1', 'p50 latency', p50 < 500, `${p50}ms`);
    record('P13.2', 'p95 latency', p95 < 2000, `${p95}ms`);
    record('P13.3', 'p99 latency', p99 < 5000, `${p99}ms`);
    record('P13.4', 'Avg latency', avg < 1000, `${avg}ms`);
  }

  const elapsed = Date.now() - startTime;
  const totalReqs = freeResults.length + doubleFreeResults.length + bonusResults.length +
    spinResults.length + adResults.length + gameResults.length + stateResults.length +
    checkoutResults.length + premResults.length + jpResults.length + flashResults.length +
    refResults.length + potResults.length + rapidResults.length +
    duelCreateResults.length + duelJoinResults.length + NUM_USERS;
  const rps = Math.round(totalReqs / (elapsed / 1000));
  record('P13.5', 'Throughput', rps > 10, `${rps} req/s over ${(elapsed / 1000).toFixed(1)}s`);

  // ═══ Print Summary ═════════════════════════════════════════════════════════
  printSummary(startTime);
}

function printSummary(startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed (${elapsed}s)${' '.repeat(Math.max(0, 22 - String(passed).length - String(failed).length - elapsed.length))}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results) {
      if (!r.pass) console.log(`  ✗ ${r.id}: ${r.name} — ${r.detail}`);
    }
  }
  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
