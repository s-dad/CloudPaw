// Backend settings (environment variables) and CORS.
//
// ALLOWED_ORIGIN is set here, before the app loads; this file runs in its own
// process, so the other test files keep the default (any origin). Defaults,
// other values and startup are checked by running the server as a separate
// program with a clean environment and a temporary database.
process.env.ALLOWED_ORIGIN = 'http://localhost:3000, https://d1234.cloudfront.net/';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { startTestServer } = require('./helpers');

const BACKEND = path.join(__dirname, '..');
const SETTINGS = ['PORT', 'HOST', 'NODE_ENV', 'ALLOWED_ORIGIN', 'LOG_REQUESTS'];

let t;
let dir;
before(async () => {
  t = await startTestServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpaw-config-test-'));
});
after(async () => {
  await t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The environment for a separate server process: none of the settings from
// this process or the terminal, a temporary database, plus `extra`.
function childEnv(extra = {}) {
  const env = { ...process.env, DB_PATH: path.join(dir, 'child.db') };
  for (const name of SETTINGS) delete env[name];
  return { ...env, ...extra };
}

// Loads server.js in a separate process (without listening) and returns the
// settings it read, or its error output if it refused to start.
function readConfig(extra) {
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(require("./server").locals.config))'],
    { cwd: BACKEND, env: childEnv(extra), encoding: 'utf8' },
  );
  return { status: result.status, config: result.status === 0 ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

// A request with exactly the headers given (fetch() may change Origin).
function request(method, urlPath, headers = {}) {
  const { port } = new URL(t.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('settings', () => {
  test('defaults: today\'s behavior', () => {
    const { status, config } = readConfig();
    assert.equal(status, 0);
    assert.deepEqual(config, {
      logRequests: true,
      port: 3000,
      // host is left out: every interface, as Node does when none is given
      nodeEnv: 'development',
      allowedOrigins: null, // any site may call the API
    });
  });

  test('every setting can be changed, and ALLOWED_ORIGIN is tidied', () => {
    const { status, config } = readConfig({
      PORT: '8080', HOST: '127.0.0.1', NODE_ENV: 'production', LOG_REQUESTS: 'off',
      ALLOWED_ORIGIN: ' http://localhost:3000 ,https://D1234.CloudFront.net/ ',
    });
    assert.equal(status, 0);
    assert.deepEqual(config, {
      logRequests: false,
      port: 8080,
      host: '127.0.0.1',
      nodeEnv: 'production',
      allowedOrigins: ['http://localhost:3000', 'https://d1234.cloudfront.net'],
    });
  });

  test('LOG_REQUESTS accepts true/false, 1/0, yes/no, on/off in any case', () => {
    for (const [value, expected] of [['TRUE', true], ['1', true], ['yes', true], ['On', true], ['false', false], ['0', false], ['NO', false], ['off', false]]) {
      assert.equal(readConfig({ LOG_REQUESTS: value }).config.logRequests, expected, value);
    }
  });

  test('invalid values stop the server with a clear message', () => {
    const cases = [
      [{ PORT: 'abc' }, 'PORT must be a whole number from 0 to 65535 (got "abc").'],
      [{ PORT: '70000' }, 'PORT must be a whole number from 0 to 65535 (got "70000").'],
      [{ PORT: '-1' }, 'PORT must be a whole number from 0 to 65535 (got "-1").'],
      [{ LOG_REQUESTS: 'maybe' }, 'LOG_REQUESTS must be true or false (got "maybe").'],
      [{ ALLOWED_ORIGIN: ',' }, 'ALLOWED_ORIGIN is set but lists no addresses.'],
    ];
    for (const entry of ['d1234.cloudfront.net', 'https://site.com/app', 'ftp://x.com', 'https://a.com?x=1']) {
      cases.push([{ ALLOWED_ORIGIN: entry }, `with no path (got "${entry}").`]);
    }
    for (const [env, message] of cases) {
      const { status, stderr } = readConfig(env);
      assert.notEqual(status, 0, JSON.stringify(env));
      assert.ok(stderr.includes(message), `${JSON.stringify(env)}: ${stderr.split('\n').find((l) => l.includes('Error'))}`);
    }
  });

  test('NODE_ENV=production without ALLOWED_ORIGIN logs a JSON warning; with it, none', () => {
    const warned = readConfig({ NODE_ENV: 'production' });
    const line = warned.stderr.trim().split('\n').find((l) => l.startsWith('{'));
    assert.ok(line, 'a warning line');
    const entry = JSON.parse(line);
    assert.equal(entry.level, 'warn');
    assert.match(entry.message, /ALLOWED_ORIGIN is not set/);

    const quiet = readConfig({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://d1234.cloudfront.net' });
    assert.equal(quiet.stderr.trim(), '');
  });

  test('node server.js listens on PORT and HOST and answers', async () => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: BACKEND, env: childEnv({ PORT: '0', HOST: '127.0.0.1', LOG_REQUESTS: 'false' }),
    });
    try {
      const started = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`no startup line: ${output}`)), 10000);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = /CloudPaw on http:\/\/127\.0\.0\.1:(\d+) \(API at \/api\)/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}: ${output}`)));
      });
      const res = await fetch(`http://127.0.0.1:${started}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    } finally {
      child.kill();
    }
  });
});

describe('CORS with ALLOWED_ORIGIN set', () => {
  test('an allowed site gets its own address back', async () => {
    for (const origin of ['https://d1234.cloudfront.net', 'http://localhost:3000']) {
      const res = await request('GET', '/api/pets', { Origin: origin });
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], origin);
      assert.match(res.headers.vary, /Origin/);
    }
  });

  test('any other site gets no CORS header, so the browser blocks it', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:5500', 'https://d1234.cloudfront.net.evil.example']) {
      const res = await request('GET', '/api/pets', { Origin: origin });
      assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
    }
  });

  test('the site itself (no Origin header) still works', async () => {
    const res = await request('GET', '/api/pets');
    assert.equal(res.status, 200);
  });

  test('preflight for PATCH with a token: allowed site passes, other site does not', async () => {
    const ask = (origin) => request('OPTIONS', '/api/pets/1', {
      Origin: origin,
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'authorization,content-type',
    });
    const ok = await ask('https://d1234.cloudfront.net');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://d1234.cloudfront.net');
    assert.match(ok.headers['access-control-allow-methods'], /PATCH/);
    assert.match(ok.headers['access-control-allow-headers'], /authorization/);

    const blocked = await ask('https://evil.example');
    assert.equal(blocked.headers['access-control-allow-origin'], undefined);
  });
});
