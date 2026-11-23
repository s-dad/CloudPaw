// GET /api/health and the JSON logs.
//
// Request logging is turned on here, before the app loads; this file runs in
// its own process, so the other test files stay quiet. Log lines are captured
// by replacing console.log / console.error for the duration of each test.
process.env.LOG_REQUESTS = 'true';
process.env.RATE_LIMIT_LOGIN = '3'; // low, so the logging test can reach a 429 quickly

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Captures what the server logs while `fn` runs. Request lines are written
// when the response finishes, so wait a moment before reading them.
async function captureLogs(ctx, fn) {
  const out = ctx.mock.method(console, 'log', () => {});
  const err = ctx.mock.method(console, 'error', () => {});
  const result = await fn();
  await sleep(50);
  const lines = (mock) => mock.mock.calls.map((call) => call.arguments.join(' '));
  return { result, info: lines(out), problems: lines(err), all: [...lines(out), ...lines(err)] };
}

describe('GET /api/health', () => {
  test('200 {"status":"ok"} when the database answers, never cached', async (ctx) => {
    const { result: res, info } = await captureLogs(ctx, () => t.api('GET', '/api/health'));
    assert.equal(JSON.parse(info[0]).path, '/api/health', 'logged like any API request');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('503 with no details when the database can\'t answer; the error is logged', async (ctx) => {
    const realPrepare = t.db.prepare;
    t.db.prepare = function (sql) {
      if (sql === 'SELECT 1 AS ok') throw new Error('SIMULATED database is down at /internal/db.js');
      return realPrepare.call(this, sql);
    };
    let logs;
    try {
      logs = await captureLogs(ctx, () => t.api('GET', '/api/health'));
    } finally {
      t.db.prepare = realPrepare;
    }
    const res = logs.result;
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: 'error', error: 'Database unavailable' });
    assert.doesNotMatch(res.text, /SIMULATED|internal|at .+\.js/);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const entry = JSON.parse(logs.problems[0]);
    assert.equal(entry.level, 'error');
    assert.equal(entry.message, 'Health check failed');
    assert.equal(entry.path, '/api/health');
    assert.match(entry.error, /^SIMULATED/);
  });

  test('is not rate-limited', async (ctx) => {
    await captureLogs(ctx, async () => {
      for (let i = 0; i < 25; i++) assert.equal((await t.api('GET', '/api/health')).status, 200);
    });
  });
});

describe('request logs', () => {
  test('one JSON line per API request: time, method, path, status, time taken', async (ctx) => {
    const { info } = await captureLogs(ctx, () => t.api('GET', '/api/pets/1'));
    assert.equal(info.length, 1);
    const entry = JSON.parse(info[0]);
    assert.deepEqual(Object.keys(entry).sort(), ['level', 'method', 'ms', 'path', 'status', 'time']);
    assert.equal(entry.level, 'info');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/api/pets/1');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.ms, 'number');
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
  });

  test('pages, CSS, images and 404 pages are not logged; API 404s are', async (ctx) => {
    const { info } = await captureLogs(ctx, async () => {
      for (const p of ['/', '/pets.html', '/css/style.css', '/images/logo.svg', '/nope.html', '/api/nope']) await t.rawGet(p);
    });
    assert.deepEqual(info.map((line) => JSON.parse(line)).map((e) => `${e.status} ${e.path}`), ['404 /api/nope']);
  });

  test('never logs passwords, tokens, emails, the Authorization header or query strings', async (ctx) => {
    const email = 'private.person@cloudpaw.test';
    const password = 'Sup3r-Secret-Passw0rd';
    let token;
    const logs = await captureLogs(ctx, async () => {
      await t.api('POST', '/api/auth/signup', { body: { name: 'Private Person', email, password } });
      token = (await t.api('POST', '/api/auth/login', { body: { email, password } })).body.token;
      await t.api('GET', '/api/auth/me', { token });
      await t.api('GET', '/api/pets?q=VeryPrivateSearchText&species=Dog');
      await t.api('POST', '/api/inquiries', {
        body: { petId: '1', name: 'Applicant Name', email: 'applicant@cloudpaw.test', phone: '614-555-0100', city: 'Columbus', housing: 'House', reason: 'Private reason text', agree: 'yes' },
      });
    });
    const text = logs.all.join('\n');
    assert.ok(logs.info.length >= 5, 'the requests were logged');
    for (const secret of [password, token, email, 'Bearer', 'authorization', 'VeryPrivateSearchText', 'species=', 'Applicant Name', 'applicant@cloudpaw.test', 'Private reason text', '614-555']) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `log must not contain ${secret.slice(0, 12)}…`);
    }
    assert.ok(logs.info.map((l) => JSON.parse(l).path).includes('/api/pets'), 'path logged without its query string');
  });

  test('unreadable JSON: logged by error type only, never the body', async (ctx) => {
    const logs = await captureLogs(ctx, () => fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"email":"x@cloudpaw.test","password":"Leaky-Passw0rd-123"',
    }));
    assert.equal(logs.result.status, 400);
    const warn = JSON.parse(logs.problems[0]);
    assert.deepEqual(
      { level: warn.level, status: warn.status, type: warn.type, path: warn.path },
      { level: 'warn', status: 400, type: 'entity.parse.failed', path: '/api/auth/login' },
    );
    assert.doesNotMatch(logs.all.join('\n'), /Leaky-Passw0rd|x@cloudpaw/);
    assert.equal(JSON.parse(logs.info[0]).status, 400, 'the request itself is logged too');
  });

  test('requests rejected early are logged too (rate limit, CORS preflight)', async (ctx) => {
    const { info } = await captureLogs(ctx, async () => {
      for (let i = 0; i < 4; i++) await t.api('POST', '/api/auth/login', { body: { email: 'nobody@cloudpaw.test', password: 'wrong-password' } });
      await fetch(`${t.base}/api/pets/1`, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'PATCH' } });
    });
    const statuses = info.map((line) => JSON.parse(line)).map((e) => `${e.method} ${e.status}`);
    assert.ok(statuses.includes('POST 429'), statuses.join(', '));
    assert.ok(statuses.includes('OPTIONS 204'), statuses.join(', '));
  });

  test('every log line is a single line of valid JSON', async (ctx) => {
    const realPrepare = t.db.prepare;
    t.db.prepare = function (sql) {
      if (/FROM pets/.test(sql)) throw new Error('SIMULATED\nmulti-line\nerror');
      return realPrepare.call(this, sql);
    };
    let logs;
    try {
      logs = await captureLogs(ctx, () => t.api('GET', '/api/pets'));
    } finally {
      t.db.prepare = realPrepare;
    }
    assert.ok(logs.all.length >= 2);
    for (const line of logs.all) {
      assert.ok(!line.includes('\n'), 'one line');
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});
