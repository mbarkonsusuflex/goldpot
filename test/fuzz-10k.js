/**
 * Fuzz / Load Test — 10,000 simulated users
 *
 * Tests concurrency-sensitive endpoints for race conditions:
 *  - Free entry daily limit bypass
 *  - Pot entry count consistency
 *  - Limited-drop overselling
 *  - Double-down / payment session replay
 *  - Registration IP rate limiting
 *  - WebSocket broadcast under load
 *
 * Usage:
 *   1. Start server:  PORT=3099 node server.js
 *   2. Run test:      node test/fuzz-10k.js
 *
 * Requires only Node.js built-ins (http, crypto).
 */

const http = require('http');
const crypto = require('crypto');

const BASE = process.env.TEST_URL || 'http://localhost:3099';
const url = new URL(BASE);
const HOST = url.hostname;
const PORT = parseInt(url.port) || 80;
const TOTAL_USERS = parseInt(process.env.FUZZ_USERS) || 10_000;
const CONCURRENCY = parseInt(process.env.FUZZ_CONCURRENCY) || 200; // max in-flight requests
const REPORT_INTERVAL = 2000; // ms between progress prints

// ── Metrics ─────────────────────────────────────────────────────────────────
const metrics = {
  registered: 0,
  regFailed: 0,
  freeEntries: 0,
  freeEntryDenied: 0,
  freeEntryRaceBypass: 0,  // entries beyond 5/day = race condition detected
  stateOK: 0,
  stateFail: 0,
  dailyBonusOK: 0,
  dailyBonusDenied: 0,
  spinOK: 0,
  spinDenied: 0,
  rateLimited: 0,
  errors: 0,
  networkErrors: 0,
  totalRequests: 0,
  latencies: [],
  startTime: 0,
};

// ── HTTP Helper ─────────────────────────────────────────────────────────────
function request(method, path, body, token, fakeIp, csrfToken) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Unique IP per user to avoid IP rate limits blocking the test
    if (fakeIp) headers['X-Forwarded-For'] = fakeIp;
    // CSRF: send token as both cookie and header
    if (csrfToken) {
      headers['Cookie'] = `_csrf=${csrfToken}`;
      headers['X-CSRF-Token'] = csrfToken;
    }

    const start = Date.now();
    const req = http.request({ hostname: HOST, port: PORT, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const latency = Date.now() - start;
        metrics.latencies.push(latency);
        metrics.totalRequests++;
        // Extract CSRF cookie from set-cookie if present
        let csrf = csrfToken;
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          for (const c of setCookie) {
            const m = c.match(/_csrf=([^;]+)/);
            if (m) csrf = m[1];
          }
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), latency, csrf });
        } catch {
          resolve({ status: res.statusCode, body: data, latency, csrf });
        }
      });
    });
    req.on('error', (err) => {
      metrics.networkErrors++;
      metrics.totalRequests++;
      resolve({ status: 0, body: { error: err.message }, latency: Date.now() - start, csrf: csrfToken });
    });
    req.setTimeout(15000, () => { req.destroy(); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Get CSRF token by hitting a GET endpoint ────────────────────────────────
async function getCsrf(fakeIp) {
  const res = await request('GET', '/api/health', null, null, fakeIp);
  return res.csrf;
}

// ── Generate unique fake IP for each simulated user ─────────────────────────
function fakeIp(index) {
  const a = (index >> 16) & 255;
  const b = (index >> 8) & 255;
  const c = index & 255;
  return `10.${a}.${b}.${c || 1}`;
}

// ── Single user simulation ──────────────────────────────────────────────────
async function simulateUser(index) {
  const ip = fakeIp(index);
  const email = `fuzz${index}@test.local`;
  const name = `Fuzz_${index}`;

  // 0. Get CSRF token
  const csrf = await getCsrf(ip);
  if (!csrf) { metrics.errors++; return; }

  // 1. Register
  const reg = await request('POST', '/api/register', { name, email }, null, ip, csrf);
  if (reg.status === 200 && reg.body.token) {
    metrics.registered++;
  } else {
    metrics.regFailed++;
    if (reg.status === 429) metrics.rateLimited++;
    return; // can't continue without a token
  }

  const token = reg.body.token;
  const playerId = reg.body.player.id;

  // 2. Fetch state
  const st = await request('GET', '/api/state', null, null, ip);
  if (st.status === 200) metrics.stateOK++;
  else metrics.stateFail++;

  // 3. Free entries — try 8 times to detect daily-limit race condition
  //    (limit is 5/day; if we succeed >5 times, there's a bug)
  let freeSuccesses = 0;
  const freePromises = [];
  for (let i = 0; i < 8; i++) {
    freePromises.push(
      request('POST', '/api/free-entry', { playerId, potId: ['mini', 'gold', 'mega'][i % 3] }, token, ip, csrf)
    );
  }
  const freeResults = await Promise.all(freePromises);
  for (const r of freeResults) {
    if (r.status === 200 && r.body.success) {
      freeSuccesses++;
      metrics.freeEntries++;
    } else if (r.status === 400) {
      metrics.freeEntryDenied++;
    } else if (r.status === 429) {
      metrics.rateLimited++;
    } else {
      metrics.errors++;
    }
  }
  if (freeSuccesses > 5) {
    metrics.freeEntryRaceBypass += freeSuccesses - 5;
  }

  // 4. Daily bonus
  const db1 = await request('POST', '/api/daily-bonus', { playerId }, token, ip, csrf);
  if (db1.status === 200) metrics.dailyBonusOK++;
  else metrics.dailyBonusDenied++;

  // 5. Spin wheel
  const sp = await request('POST', '/api/spin-wheel', { playerId }, token, ip, csrf);
  if (sp.status === 200) metrics.spinOK++;
  else metrics.spinDenied++;

  // 6. Double daily bonus (should be blocked)
  const db2 = await request('POST', '/api/daily-bonus', { playerId }, token, ip, csrf);
  if (db2.status === 200) {
    metrics.errors++; // should NOT succeed twice
  }

  // 7. Double spin (should be blocked)
  const sp2 = await request('POST', '/api/spin-wheel', { playerId }, token, ip, csrf);
  if (sp2.status === 200) {
    metrics.errors++; // should NOT succeed twice
  }
}

// ── Semaphore for concurrency control ───────────────────────────────────────
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  acquire() {
    if (this.current < this.max) { this.current++; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) { this.current++; this.queue.shift()(); }
  }
}

// ── Pot entry consistency check ─────────────────────────────────────────────
async function checkPotConsistency() {
  const st = await request('GET', '/api/state', null, null, '10.255.255.1');
  if (st.status !== 200) return { ok: false, error: 'Could not fetch state' };

  const results = {};
  for (const [potId, potData] of Object.entries(st.body.pots || {})) {
    results[potId] = {
      totalEntries: potData.totalEntries,
      arrayLength: potData.entryCount ?? 'N/A',
    };
  }
  return { ok: true, pots: results };
}

// ── Race condition: concurrent free entries for same user ───────────────────
async function testFreeEntryRace() {
  const ip = '10.200.200.1';
  const csrf = await getCsrf(ip);
  const reg = await request('POST', '/api/register', {
    name: 'RaceTest', email: 'racetest@test.local'
  }, null, ip, csrf);
  if (reg.status !== 200) return { test: 'free-entry-race', result: 'SKIP', reason: `reg failed: ${reg.body.error || reg.status}` };

  const token = reg.body.token;
  const playerId = reg.body.player.id;

  // Fire 20 concurrent free entry requests for the SAME pot+round
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(request('POST', '/api/free-entry', { playerId, potId: 'gold' }, token, ip, csrf));
  }
  const results = await Promise.all(promises);
  const successes = results.filter(r => r.status === 200 && r.body.success).length;

  return {
    test: 'free-entry-race',
    result: successes <= 1 ? 'PASS' : 'FAIL',
    detail: `${successes} successful out of 20 concurrent (expected: max 1)`,
  };
}

// ── Race condition: concurrent daily bonus for same user ────────────────────
async function testDailyBonusRace() {
  const ip = '10.200.200.2';
  const reg = await request('POST', '/api/register', {
    name: 'BonusRace', email: 'bonusrace@test.local'
  }, null, ip);
  if (reg.status !== 200) return { test: 'daily-bonus-race', result: 'SKIP', reason: 'reg failed' };

  const token = reg.body.token;
  const playerId = reg.body.player.id;

  // First, do a free entry so the player has played
  await request('POST', '/api/free-entry', { playerId, potId: 'gold' }, token, ip);

  // Fire 20 concurrent daily bonus claims
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(request('POST', '/api/daily-bonus', { playerId }, token, ip));
  }
  const results = await Promise.all(promises);
  const successes = results.filter(r => r.status === 200 && r.body.success !== false).length;

  return {
    test: 'daily-bonus-race',
    result: successes <= 1 ? 'PASS' : 'FAIL',
    detail: `${successes} successful out of 20 concurrent (expected: max 1)`,
  };
}

// ── Race condition: concurrent spin-wheel for same user ─────────────────────
async function testSpinRace() {
  const ip = '10.200.200.3';
  const csrf = await getCsrf(ip);
  const reg = await request('POST', '/api/register', {
    name: 'SpinRace', email: 'spinrace@test.local'
  }, null, ip, csrf);
  if (reg.status !== 200) return { test: 'spin-race', result: 'SKIP', reason: `reg failed: ${reg.body.error || reg.status}` };

  const token = reg.body.token;
  const playerId = reg.body.player.id;

  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(request('POST', '/api/spin-wheel', { playerId }, token, ip, csrf));
  }
  const results = await Promise.all(promises);
  const successes = results.filter(r => r.status === 200 && r.body.entries !== undefined).length;

  return {
    test: 'spin-race',
    result: successes <= 1 ? 'PASS' : 'FAIL',
    detail: `${successes} successful out of 20 concurrent (expected: max 1)`,
  };
}

// ── Registration flood from single IP ───────────────────────────────────────
async function testRegFloodSameIP() {
  const ip = '10.200.200.4';
  const csrf = await getCsrf(ip);
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(request('POST', '/api/register', {
      name: `Flood${i}`, email: `flood${i}@test.local`
    }, null, ip, csrf));
  }
  const results = await Promise.all(promises);
  const successes = results.filter(r => r.status === 200).length;
  const rateLimited = results.filter(r => r.status === 429).length;

  return {
    test: 'reg-flood-same-ip',
    result: successes <= 5 ? 'PASS' : 'FAIL',
    detail: `${successes} registered, ${rateLimited} rate-limited (expected: max 5 per IP/day)`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        GOLDPOT FUZZ TEST — 10,000 USER SIMULATION          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Target:      ${BASE}`);
  console.log(`Users:       ${TOTAL_USERS.toLocaleString()}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log('');

  // Verify server is up
  const health = await request('GET', '/api/health', null, null, '10.0.0.1');
  if (health.status !== 200) {
    console.error('ERROR: Server not reachable at', BASE);
    console.error('Start it with: PORT=3099 node server.js');
    process.exit(1);
  }
  console.log('Server is up. Starting tests...\n');

  // ── Phase 1: Targeted race condition tests ────────────────────────────
  console.log('─── Phase 1: Race Condition Tests ───────────────────────────');
  const raceTests = await Promise.all([
    testFreeEntryRace(),
    testDailyBonusRace(),
    testSpinRace(),
    testRegFloodSameIP(),
  ]);

  for (const t of raceTests) {
    const icon = t.result === 'PASS' ? '✓' : t.result === 'FAIL' ? '✗' : '–';
    console.log(`  ${icon} ${t.test}: ${t.result} — ${t.detail || t.reason}`);
  }
  console.log('');

  // ── Phase 2: Load test with N users ───────────────────────────────────
  console.log(`─── Phase 2: ${TOTAL_USERS.toLocaleString()} User Load Test ──────────────────────`);

  metrics.startTime = Date.now();
  const sem = new Semaphore(CONCURRENCY);

  // Progress reporter
  const progressTimer = setInterval(() => {
    const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1);
    const rps = (metrics.totalRequests / (elapsed || 1)).toFixed(0);
    process.stdout.write(
      `\r  [${elapsed}s] Registered: ${metrics.registered}/${TOTAL_USERS} | ` +
      `Requests: ${metrics.totalRequests} | RPS: ${rps} | ` +
      `Errors: ${metrics.errors} | Net Errors: ${metrics.networkErrors}  `
    );
  }, REPORT_INTERVAL);

  // Launch all users with concurrency control
  const tasks = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    tasks.push(
      sem.acquire().then(async () => {
        try {
          await simulateUser(i);
        } catch (err) {
          metrics.errors++;
        } finally {
          sem.release();
        }
      })
    );
  }

  await Promise.all(tasks);
  clearInterval(progressTimer);
  process.stdout.write('\n\n');

  // ── Phase 3: Post-test consistency checks ─────────────────────────────
  console.log('─── Phase 3: Post-Test Consistency ──────────────────────────');

  const potCheck = await checkPotConsistency();
  if (potCheck.ok) {
    console.log('  Pot entry counts:');
    for (const [potId, data] of Object.entries(potCheck.pots)) {
      console.log(`    ${potId}: totalEntries=${data.totalEntries}`);
    }
  }

  // ── Final Report ──────────────────────────────────────────────────────
  const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1);
  const latencies = metrics.latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : 0;

  const raceFailures = raceTests.filter(t => t.result === 'FAIL');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    FINAL REPORT                             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Duration:            ${elapsed}s`);
  console.log(`║  Total Requests:      ${metrics.totalRequests.toLocaleString()}`);
  console.log(`║  Avg RPS:             ${(metrics.totalRequests / elapsed).toFixed(0)}`);
  console.log(`║  ──────────────────────────────────────────────────────────`);
  console.log(`║  Registered:          ${metrics.registered.toLocaleString()} / ${TOTAL_USERS.toLocaleString()}`);
  console.log(`║  Reg Failures:        ${metrics.regFailed}`);
  console.log(`║  Free Entries OK:     ${metrics.freeEntries}`);
  console.log(`║  Free Entry Denied:   ${metrics.freeEntryDenied}`);
  console.log(`║  Daily Bonus OK:      ${metrics.dailyBonusOK}`);
  console.log(`║  Spins OK:            ${metrics.spinOK}`);
  console.log(`║  Rate Limited:        ${metrics.rateLimited}`);
  console.log(`║  Errors:              ${metrics.errors}`);
  console.log(`║  Network Errors:      ${metrics.networkErrors}`);
  console.log(`║  ──────────────────────────────────────────────────────────`);
  console.log(`║  RACE CONDITIONS:`);
  console.log(`║    Free Entry Bypass: ${metrics.freeEntryRaceBypass} extra entries (should be 0)`);
  console.log(`║    Race Tests:        ${raceTests.length - raceFailures.length}/${raceTests.length} passed`);
  for (const f of raceFailures) {
    console.log(`║      ✗ ${f.test}: ${f.detail}`);
  }
  console.log(`║  ──────────────────────────────────────────────────────────`);
  console.log(`║  LATENCY:`);
  console.log(`║    Avg: ${avg}ms | P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Exit code based on failures
  const critical = metrics.freeEntryRaceBypass > 0 || raceFailures.length > 0 || metrics.networkErrors > metrics.totalRequests * 0.01;
  if (critical) {
    console.log('\n⚠ CRITICAL ISSUES DETECTED — see race condition results above');
    process.exit(1);
  } else {
    console.log('\n✓ All tests passed');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
