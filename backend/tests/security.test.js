// Security checks: private files are never served, request bodies can't set
// protected fields, and HTML typed into forms is stored as plain text.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

describe('only the public frontend is served', () => {
  // Sanity check, so the 404s below mean "blocked", not "server serves nothing".
  test('public pages and assets load', async () => {
    for (const p of ['/', '/index.html', '/pets.html', '/admin-add.html', '/css/style.css', '/js/script.js', '/data/pets.json']) {
      assert.equal(await t.rawGet(p), 200, p);
    }
  });

  // These files exist in the repo, so a 404 proves they are blocked.
  // cloudpaw.db is included too, though it may not exist (e.g. in CI).
  const privatePaths = [
    '/backend/cloudpaw.db',
    '/backend/server.js',
    '/backend/package.json',
    '/backend/schema.sql',
    '/backend/node_modules/express/package.json',
    '/README.md',
    '/.nvmrc',
    '/.github/workflows/ci-cd.yml',
  ];
  for (const p of privatePaths) {
    test(`404 for ${p}`, async () => {
      assert.equal(await t.rawGet(p), 404);
    });
  }

  // "../" tricks to climb out of a public folder, sent exactly as written.
  const pathTricks = [
    '/css/../backend/cloudpaw.db',
    '/css/../backend/package.json',
    '/images/%2e%2e/backend/package.json',
    '/data/..%2fbackend%2fpackage.json',
    '/css/%2e%2e%2fREADME.md',
  ];
  for (const p of pathTricks) {
    test(`404 for path trick ${p}`, async () => {
      assert.equal(await t.rawGet(p), 404);
    });
  }
});

describe('protected fields cannot be set from the request', () => {
  test('POST /api/pets ignores id, status and photo_url in the body', async () => {
    const admin = await t.createAdmin();
    const res = await t.api('POST', '/api/pets', {
      token: admin.token,
      body: {
        name: 'Rex',
        species: 'Dog',
        id: 999,
        status: 'adopted',
        photo_url: 'https://evil.example/x.jpg',
      },
    });
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, 999);
    assert.equal(res.body.status, 'available');
    assert.equal(res.body.photo_url, null);
    assert.equal((await t.api('GET', '/api/pets/999')).status, 404);
  });
});

describe('HTML in form fields is stored as plain text', () => {
  test('an application with HTML is saved and returned unchanged, as JSON text', async () => {
    const admin = await t.createAdmin();
    const html = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const created = await t.api('POST', '/api/inquiries', {
      body: {
        petId: '1',
        name: html,
        email: 'xss@cloudpaw.test',
        phone: '614-555-0100',
        city: 'Columbus',
        housing: 'House',
        reason: html,
        agree: 'yes',
      },
    });
    assert.equal(created.status, 201);

    // Stored exactly as typed: not stripped, not run, not double-escaped.
    const row = t.db.prepare('SELECT name, reason FROM inquiries WHERE id = ?').get(created.body.id);
    assert.equal(row.name, html);
    assert.equal(row.reason, html);

    // Returned as a JSON string, so a browser won't treat it as HTML. The
    // admin page escapes it before showing it (escapeHtml in js/script.js).
    const list = await t.api('GET', '/api/inquiries', { token: admin.token });
    assert.match(list.headers.get('content-type'), /application\/json/);
    const found = list.body.find((i) => i.id === created.body.id);
    assert.equal(found.name, html);
  });
});

describe('security headers (helmet)', () => {
  // A page, an API response and an error response should all get them.
  const requests = [
    ['a page (GET /)', () => t.api('GET', '/')],
    ['an API response (GET /api/pets)', () => t.api('GET', '/api/pets')],
    ['a JSON error (malformed JSON)', async () => {
      const res = await fetch(`${t.base}/api/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
      });
      return { status: res.status, headers: res.headers };
    }],
  ];

  for (const [name, request] of requests) {
    test(`present on ${name}, and X-Powered-By is gone`, async (ctx) => {
      ctx.mock.method(console, 'error', () => {}); // the malformed-JSON request logs a line
      const { headers } = await request();

      assert.equal(headers.get('x-powered-by'), null);
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(headers.get('referrer-policy'), 'no-referrer');
      assert.match(headers.get('strict-transport-security'), /max-age=\d+/);
      assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');

      const csp = headers.get('content-security-policy');
      assert.ok(csp, 'has a Content-Security-Policy');
      const directives = Object.fromEntries(csp.split(';').map((d) => {
        const [key, ...values] = d.trim().split(/\s+/);
        return [key, values.join(' ')];
      }));
      assert.equal(directives['default-src'], "'self'");
      assert.equal(directives['script-src'], "'self'", 'scripts only from this server');
      assert.equal(directives['script-src-attr'], "'none'", 'no onclick="..." handlers');
      assert.equal(directives['object-src'], "'none'");
      assert.equal(directives['frame-ancestors'], "'self'");
      assert.equal(directives['style-src'], "'self' https://fonts.googleapis.com 'unsafe-inline'");
      assert.equal(directives['font-src'], "'self' https://fonts.gstatic.com");
      assert.ok(!('upgrade-insecure-requests' in directives), 'off for local http');
    });
  }
});
