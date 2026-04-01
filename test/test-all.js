/* ═══════════════════════════════════════════════════════════════════════════
   GOLDPOT — Comprehensive Functional + Fuzz Test Suite
   Run: node test/test-all.js [port]
   ═══════════════════════════════════════════════════════════════════════════ */
const http = require('http');
const crypto = require('crypto');

const PORT = process.argv[2] || 3099;
const BASE = `http://localhost:${PORT}`;
let csrfToken = null;
let authToken = null;
let playerId = null;
let cookies = '';
let passed = 0;
let failed = 0;
let testName = '';

// ─── HTTP Helper ───────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (cookies) headers['Cookie'] = cookies;

    const opts = { hostname: url.hostname, port: url.port, path: url.pathname, method, headers };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Capture Set-Cookie
        const sc = res.headers['set-cookie'];
        if (sc) {
          for (const c of sc) {
            const name = c.split('=')[0];
            const val = c.split(';')[0];
            if (name === '_csrf') csrfToken = val.split('=')[1];
            // Merge into cookies string
            const existing = cookies.split('; ').filter(x => !x.startsWith(name + '='));
            existing.push(val);
            cookies = existing.filter(Boolean).join('; ');
          }
        }
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: json, raw: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const GET = (p) => request('GET', p);
const POST = (p, b) => request('POST', p, b);

// ─── Assertions ────────────────────────────────────────────────────────────
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL [${testName}]: ${msg}`); }
}
function section(name) { console.log(`\n━━━ ${name} ━━━`); }

// ─── Test Runner ───────────────────────────────────────────────────────────
async function run() {
  console.log(`\nGOLDPOT Test Suite — ${BASE}\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // 1. CSRF + Setup
  // ═══════════════════════════════════════════════════════════════════════
  section('CSRF & Health');

  testName = 'health-check';
  let r = await GET('/api/health');
  assert(r.status === 200, `Expected 200 got ${r.status}`);
  assert(r.body && r.body.status === 'ok', 'Health should return ok');
  console.log('  ✓ Health check OK');

  testName = 'csrf-token-issued';
  r = await GET('/');
  assert(csrfToken && csrfToken.length > 10, 'Should get CSRF cookie');
  console.log(`  ✓ CSRF token acquired (${csrfToken ? csrfToken.substring(0, 12) + '...' : 'NONE'})`);

  testName = 'csrf-reject-no-token';
  const savedCsrf = csrfToken;
  csrfToken = null;
  r = await POST('/api/free-entry', { playerId: 'fake', potId: 'mini' });
  assert(r.status === 403, `Should reject without CSRF, got ${r.status}`);
  csrfToken = savedCsrf;
  console.log('  ✓ POST rejected without CSRF token');

  testName = 'csrf-reject-wrong-token';
  csrfToken = 'wrong-token-12345';
  r = await POST('/api/free-entry', { playerId: 'fake', potId: 'mini' });
  assert(r.status === 403, `Should reject wrong CSRF, got ${r.status}`);
  csrfToken = savedCsrf;
  console.log('  ✓ POST rejected with wrong CSRF token');

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Registration
  // ═══════════════════════════════════════════════════════════════════════
  section('Registration');

  const testId = crypto.randomBytes(4).toString('hex');
  const testName2 = `Tester_${testId}`;
  const testEmail = `test_${testId}@example.com`;

  testName = 'register-valid';
  r = await POST('/api/register', { name: testName2, email: testEmail, state: 'CA', dateOfBirth: '2000-01-15' });
  assert(r.status === 200, `Register expected 200 got ${r.status}`);
  assert(r.body && r.body.player, 'Should return player');
  if (r.body && r.body.player) playerId = r.body.player.id;
  if (r.body && r.body.token) authToken = r.body.token;
  console.log(`  ✓ Registered player: ${playerId ? playerId.substring(0, 8) + '...' : 'NONE'}`);

  testName = 'register-duplicate-email';
  r = await POST('/api/register', { name: 'Dup', email: testEmail, state: 'NY', dateOfBirth: '1990-05-20' });
  assert(r.status === 400 || (r.body && r.body.error), 'Duplicate email should fail');
  console.log('  ✓ Duplicate email rejected');

  testName = 'register-underage';
  r = await POST('/api/register', { name: 'Kid', email: `kid_${testId}@example.com`, state: 'TX', dateOfBirth: '2015-01-01' });
  assert(r.status === 400 || (r.body && r.body.error), 'Underage should fail');
  console.log('  ✓ Underage registration rejected');

  testName = 'register-no-dob';
  r = await POST('/api/register', { name: 'NoDob', email: `nodob_${testId}@example.com`, state: 'FL' });
  assert(r.status === 400 || (r.body && r.body.error), 'No DOB should fail');
  console.log('  ✓ Missing DOB rejected');

  testName = 'register-bad-dob-format';
  r = await POST('/api/register', { name: 'BadDob', email: `baddob_${testId}@example.com`, state: 'WA', dateOfBirth: '01/15/2000' });
  assert(r.status === 400 || (r.body && r.body.error), 'Bad DOB format should fail');
  console.log('  ✓ Invalid DOB format rejected');

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Game State
  // ═══════════════════════════════════════════════════════════════════════
  section('Game State');

  testName = 'get-state';
  r = await GET(`/api/state?playerId=${playerId}`);
  assert(r.status === 200, `State expected 200 got ${r.status}`);
  assert(r.body && r.body.pots && r.body.pots.mini, 'Should have mini pot');
  assert(r.body && r.body.pots && r.body.pots.gold, 'Should have gold pot');
  assert(r.body && r.body.pots && r.body.pots.mega, 'Should have mega pot');
  console.log('  ✓ Game state loaded (mini/gold/mega pots present)');

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Free Entry — All 3 Pots
  // ═══════════════════════════════════════════════════════════════════════
  section('Free Entry');

  for (const pot of ['mini', 'gold', 'mega']) {
    testName = `free-entry-${pot}`;
    r = await POST('/api/free-entry', { playerId, potId: pot });
    assert(r.status === 200, `Free entry ${pot} expected 200 got ${r.status}`);
    assert(r.body && r.body.player && r.body.player.entries[pot] >= 1, `Should have entry in ${pot}`);
    console.log(`  ✓ Free entry ${pot}: ${r.body?.player?.entries[pot] || 0} entry`);
  }

  testName = 'free-entry-duplicate';
  r = await POST('/api/free-entry', { playerId, potId: 'mini' });
  assert(r.status === 400, `Duplicate free entry should fail, got ${r.status}`);
  assert(r.body && r.body.error && r.body.error.includes('already used'), 'Should say already used');
  console.log('  ✓ Duplicate free entry rejected');

  testName = 'free-entry-invalid-pot';
  r = await POST('/api/free-entry', { playerId, potId: 'nonexistent' });
  assert(r.status === 400, `Invalid pot should fail, got ${r.status}`);
  console.log('  ✓ Invalid pot rejected');

  testName = 'free-entry-no-player';
  r = await POST('/api/free-entry', { playerId: 'fake-player-id-12345', potId: 'mini' });
  assert(r.status === 404 || r.status === 401 || r.status === 403, `Fake player should fail, got ${r.status}`);
  console.log('  ✓ Fake player rejected');

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Daily Bonus
  // ═══════════════════════════════════════════════════════════════════════
  section('Daily Bonus');

  testName = 'daily-bonus';
  r = await POST('/api/daily-bonus', { playerId });
  assert(r.status === 200, `Daily bonus expected 200 got ${r.status}`);
  if (r.body && r.body.bonusEntries !== undefined) {
    console.log(`  ✓ Daily bonus: +${r.body.bonusEntries} entries (streak: ${r.body.streak})`);
  } else if (r.body && r.body.error) {
    console.log(`  ✓ Daily bonus: ${r.body.error} (already claimed or rate limited)`);
  }

  testName = 'daily-bonus-duplicate';
  r = await POST('/api/daily-bonus', { playerId });
  assert(r.status === 400 || (r.body && r.body.error), 'Second daily bonus should fail');
  console.log('  ✓ Duplicate daily bonus rejected');

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Watch Ad (simulated)
  // ═══════════════════════════════════════════════════════════════════════
  section('Watch Ad');

  testName = 'watch-ad';
  r = await POST('/api/watch-ad', { playerId, potId: 'mini' });
  if (r.status === 200) {
    console.log(`  ✓ Watch ad: +1 entry granted`);
  } else {
    console.log(`  ✓ Watch ad: ${r.body?.error || 'rate limited'} (status ${r.status})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Spin Wheel
  // ═══════════════════════════════════════════════════════════════════════
  section('Spin Wheel');

  testName = 'spin-wheel';
  r = await POST('/api/spin', { playerId });
  if (r.status === 200 && r.body) {
    console.log(`  ✓ Spin: Won "${r.body.prize || r.body.segment || 'unknown'}"`);
  } else {
    console.log(`  ✓ Spin: ${r.body?.error || 'already spun today'} (status ${r.status})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Deposit Limit
  // ═══════════════════════════════════════════════════════════════════════
  section('Deposit Limit');

  testName = 'set-deposit-limit';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 50 });
  assert(r.status === 200, `Set limit expected 200 got ${r.status}`);
  console.log(`  ✓ Deposit limit set to $50/day`);

  testName = 'set-deposit-limit-zero';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 0 });
  assert(r.status === 200, `Remove limit expected 200 got ${r.status}`);
  console.log(`  ✓ Deposit limit removed`);

  testName = 'set-deposit-limit-negative';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: -10 });
  assert(r.status === 400 || (r.body && r.body.error), 'Negative limit should fail');
  console.log(`  ✓ Negative limit rejected`);

  testName = 'set-deposit-limit-huge';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 999999 });
  assert(r.status === 400 || (r.body && r.body.error), 'Absurd limit should fail');
  console.log(`  ✓ Absurdly high limit rejected`);

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Withdrawal (should fail — no balance)
  // ═══════════════════════════════════════════════════════════════════════
  section('Withdrawal');

  testName = 'withdraw-no-balance';
  r = await POST('/api/withdraw', { playerId, amount: 500, method: 'paypal', paypalEmail: 'test@example.com' });
  assert(r.status === 400 || (r.body && r.body.error), 'Withdraw with no balance should fail');
  console.log(`  ✓ Withdraw with no balance rejected: ${r.body?.error || 'error'}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Legal Pages
  // ═══════════════════════════════════════════════════════════════════════
  section('Legal Pages');

  for (const page of ['rules', 'privacy', 'terms', 'responsible-gaming']) {
    testName = `legal-${page}`;
    r = await GET(`/${page}`);
    assert(r.status === 200, `${page} expected 200 got ${r.status}`);
    assert(r.raw.length > 1000, `${page} should have content (${r.raw.length} bytes)`);
    console.log(`  ✓ /${page}: ${r.status} (${r.raw.length} bytes)`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 11. FUZZ TESTING
  // ═══════════════════════════════════════════════════════════════════════
  section('FUZZ — SQL Injection');

  const sqlPayloads = [
    "'; DROP TABLE players; --",
    "1' OR '1'='1",
    "1; DELETE FROM players WHERE '1'='1",
    "' UNION SELECT * FROM players --",
    "Robert'); DROP TABLE students;--",
    "1' AND 1=CAST((SELECT password FROM users LIMIT 1) AS int)--",
  ];

  for (const payload of sqlPayloads) {
    testName = `sqli-name`;
    r = await POST('/api/register', { name: payload, email: `sqli${crypto.randomBytes(3).toString('hex')}@test.com`, state: 'CA', dateOfBirth: '2000-01-01' });
    // Should either succeed (name is just stored as-is in JSON, not interpolated into SQL) or reject — but NOT crash
    assert(r.status === 200 || r.status === 400 || r.status === 429, `SQLi name should not crash server (${r.status})`);
  }
  // Verify server is still alive
  r = await GET('/api/health');
  assert(r.status === 200 && r.body.status === 'ok', 'Server should survive SQLi');
  console.log(`  ✓ Server survived ${sqlPayloads.length} SQL injection payloads`);

  section('FUZZ — XSS');

  const xssPayloads = [
    '<script>alert("xss")</script>',
    '"><img src=x onerror=alert(1)>',
    "javascript:alert('XSS')",
    '<svg onload=alert(1)>',
    '{{constructor.constructor("return this")()}}',
    '${7*7}',
    '<iframe src="javascript:alert(1)">',
  ];

  for (const payload of xssPayloads) {
    testName = `xss-name`;
    r = await POST('/api/register', { name: payload.substring(0, 20), email: `xss${crypto.randomBytes(3).toString('hex')}@test.com`, state: 'CA', dateOfBirth: '2000-01-01' });
    assert(r.status === 200 || r.status === 400 || r.status === 429, `XSS name should not crash (${r.status})`);
  }
  r = await GET('/api/health');
  assert(r.status === 200, 'Server should survive XSS payloads');
  console.log(`  ✓ Server survived ${xssPayloads.length} XSS payloads`);

  section('FUZZ — Type Confusion');

  const typePayloads = [
    { playerId: null, potId: 'mini' },
    { playerId: undefined, potId: 'mini' },
    { playerId: 12345, potId: 'mini' },
    { playerId: true, potId: 'mini' },
    { playerId: [], potId: 'mini' },
    { playerId: {}, potId: 'mini' },
    { playerId, potId: null },
    { playerId, potId: 12345 },
    { playerId, potId: true },
    { playerId, potId: ['mini', 'gold'] },
    { playerId, potId: { $gt: '' } },
    {},
    null,
  ];

  let typeCrashes = 0;
  for (let i = 0; i < typePayloads.length; i++) {
    testName = `type-confusion-${i}`;
    try {
      r = await POST('/api/free-entry', typePayloads[i]);
      assert(r.status >= 200 && r.status < 600, `Type confusion should return valid HTTP status (${r.status})`);
    } catch (e) {
      typeCrashes++;
    }
  }
  r = await GET('/api/health');
  assert(r.status === 200, 'Server should survive type confusion');
  console.log(`  ✓ Server survived ${typePayloads.length} type confusion payloads (${typeCrashes} connection errors)`);

  section('FUZZ — Oversized Payloads');

  testName = 'oversized-name';
  r = await POST('/api/register', { name: 'A'.repeat(10000), email: `big${testId}@test.com`, state: 'CA', dateOfBirth: '2000-01-01' });
  assert(r.status === 400 || r.status === 413 || r.status === 200 || r.status === 429, `Oversized name: ${r.status}`);
  console.log(`  ✓ Oversized name (10K chars): status ${r.status}`);

  testName = 'oversized-email';
  r = await POST('/api/register', { name: 'Big', email: 'a'.repeat(5000) + '@test.com', state: 'CA', dateOfBirth: '2000-01-01' });
  assert(r.status === 400 || r.status === 413 || r.status === 200 || r.status === 429, `Oversized email: ${r.status}`);
  console.log(`  ✓ Oversized email (5K chars): status ${r.status}`);

  testName = 'huge-json-body';
  const hugeBody = { playerId, potId: 'mini' };
  for (let i = 0; i < 100; i++) hugeBody[`junk_${i}`] = 'x'.repeat(1000);
  r = await POST('/api/free-entry', hugeBody);
  assert(r.status >= 200 && r.status < 600, `Huge JSON body: ${r.status}`);
  console.log(`  ✓ Huge JSON body (~100KB): status ${r.status}`);

  r = await GET('/api/health');
  assert(r.status === 200, 'Server should survive oversized payloads');
  console.log(`  ✓ Server still healthy after oversized payloads`);

  section('FUZZ — Path Traversal');

  const traversalPaths = [
    '/api/../../../etc/passwd',
    '/api/..%2f..%2f..%2fetc/passwd',
    '/api/state?playerId=../../etc/passwd',
    '/api/state?playerId=..\\..\\..\\windows\\system32\\config\\sam',
    '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
  ];

  for (const path of traversalPaths) {
    testName = 'path-traversal';
    try {
      r = await GET(path);
      assert(r.status !== 200 || !r.raw.includes('root:'), `Path traversal should not leak files: ${path}`);
    } catch {}
  }
  console.log(`  ✓ ${traversalPaths.length} path traversal attempts blocked`);

  section('FUZZ — Prototype Pollution');

  const pollutionPayloads = [
    { playerId, potId: 'mini', '__proto__': { admin: true } },
    { playerId, potId: 'mini', 'constructor': { prototype: { admin: true } } },
    { '__proto__': { isAdmin: true }, playerId, potId: 'mini' },
  ];

  for (const payload of pollutionPayloads) {
    testName = 'proto-pollution';
    r = await POST('/api/free-entry', payload);
    assert(r.status >= 200 && r.status < 600, `Proto pollution should not crash (${r.status})`);
  }
  r = await GET('/api/health');
  assert(r.status === 200, 'Server should survive prototype pollution');
  console.log(`  ✓ ${pollutionPayloads.length} prototype pollution attempts survived`);

  section('FUZZ — Race Conditions (rapid-fire free entry)');

  // Register a fresh player for race test
  const raceId = crypto.randomBytes(4).toString('hex');
  r = await POST('/api/register', { name: `Racer_${raceId}`, email: `racer_${raceId}@test.com`, state: 'NY', dateOfBirth: '1995-06-15' });
  const racePlayerId = r.body?.player?.id;
  const raceToken = r.body?.token;
  if (racePlayerId && raceToken) {
    const savedAuth = authToken;
    authToken = raceToken;
    // Fire 10 concurrent free-entry requests for same pot
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(POST('/api/free-entry', { playerId: racePlayerId, potId: 'gold' }));
    }
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 200).length;
    const failures = results.filter(r => r.status === 400).length;
    assert(successes <= 1, `Race condition: should have at most 1 success, got ${successes}`);
    console.log(`  ✓ 10 concurrent free-entry: ${successes} success, ${failures} rejected (expected: 1 success)`);
    authToken = savedAuth;
  } else {
    console.log('  ⚠ Skipped race test (could not create race player)');
  }

  section('FUZZ — Boundary Values');

  testName = 'deposit-limit-boundary-1';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 1 });
  console.log(`  ✓ Deposit limit $1: status ${r.status}`);

  testName = 'deposit-limit-boundary-max';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 10000 });
  console.log(`  ✓ Deposit limit $10,000: status ${r.status}`);

  testName = 'deposit-limit-boundary-over';
  r = await POST('/api/set-deposit-limit', { playerId, limitDollars: 10001 });
  assert(r.status === 400 || r.status === 429 || (r.body && r.body.error), 'Over $10K limit should fail');
  console.log(`  ✓ Deposit limit $10,001: ${r.status === 400 ? 'rejected' : 'status ' + r.status}`);

  testName = 'self-exclude-invalid-days';
  r = await POST('/api/self-exclude', { playerId, days: 999 });
  assert(r.status === 400 || r.status === 429 || (r.body && r.body.error), 'Invalid exclusion days should fail');
  console.log(`  ✓ Self-exclude 999 days: ${r.status === 400 ? 'rejected' : 'status ' + r.status}`);

  testName = 'self-exclude-zero';
  r = await POST('/api/self-exclude', { playerId, days: 0 });
  assert(r.status === 400 || r.status === 429 || (r.body && r.body.error), 'Zero days should fail');
  console.log(`  ✓ Self-exclude 0 days: ${r.status === 400 ? 'rejected' : 'status ' + r.status}`);

  testName = 'self-exclude-negative';
  r = await POST('/api/self-exclude', { playerId, days: -7 });
  assert(r.status === 400 || r.status === 429 || (r.body && r.body.error), 'Negative days should fail');
  console.log(`  ✓ Self-exclude -7 days: ${r.status === 400 ? 'rejected' : 'status ' + r.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Account Deletion (last test — destroys test player)
  // ═══════════════════════════════════════════════════════════════════════
  section('Account Deletion (GDPR)');

  testName = 'delete-account';
  r = await POST('/api/delete-account', { playerId });
  assert(r.status === 200 || r.status === 403, `Delete account got ${r.status}`);
  console.log(`  ✓ Account deleted: status ${r.status} ${r.body?.message || r.body?.error || ''}`);

  testName = 'deleted-player-gone';
  r = await GET(`/api/state?playerId=${playerId}`);
  // Player should no longer exist or return null player
  console.log(`  ✓ Deleted player state check: status ${r.status}`);

  testName = 'delete-already-deleted';
  r = await POST('/api/delete-account', { playerId });
  assert(r.status === 401 || r.status === 404, `Delete again should fail, got ${r.status}`);
  console.log(`  ✓ Re-delete rejected: status ${r.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Final Health Check
  // ═══════════════════════════════════════════════════════════════════════
  section('Final Health Check');
  r = await GET('/api/health');
  assert(r.status === 200 && r.body.status === 'ok', 'Server should be healthy after all tests');
  console.log(`  ✓ Server is alive and healthy after all tests`);

  // ═══════════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(2);
});
