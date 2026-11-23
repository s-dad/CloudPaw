// Security checks: private files are never served, request bodies can't set
// protected fields, HTML typed into forms is stored as plain text, security
// headers and the 404 page, and nothing in the frontend that the
// Content-Security-Policy would block.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startTestServer } = require('./helpers');

const SITE_ROOT = path.join(__dirname, '..', '..');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

describe('only the public frontend is served', () => {
  // Sanity check, so the 404s below mean "blocked", not "server serves nothing".
  test('public pages and assets load', async () => {
    for (const p of [
      '/', '/index.html', '/pets.html', '/admin-add.html', '/css/style.css', '/js/config.js', '/js/script.js', '/data/pets.json',
      '/images/logo.svg', '/images/favicon.svg', '/images/placeholder.svg',
    ]) {
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
  test('POST /api/pets ignores id and status in the body (photo_url is saved when valid)', async () => {
    const admin = await t.createAdmin();
    const res = await t.api('POST', '/api/pets', {
      token: admin.token,
      body: {
        name: 'Rex',
        species: 'Dog',
        id: 999,
        status: 'adopted',
        photo_url: 'https://images.example.org/rex.jpg',
      },
    });
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, 999);
    assert.equal(res.body.status, 'available');
    assert.equal(res.body.photo_url, 'https://images.example.org/rex.jpg');
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
      assert.equal(directives['style-src'], "'self' https://fonts.googleapis.com", 'no inline styles');
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, 'nothing unsafe anywhere in the policy');
      assert.equal(directives['font-src'], "'self' https://fonts.gstatic.com");
      assert.equal(directives['img-src'], "'self' data: https:", 'pasted https image links, never http:');
      assert.ok(!('upgrade-insecure-requests' in directives), 'off for local http');
    });
  }
});

describe('CORS with ALLOWED_ORIGIN unset (the default)', () => {
  test('any site may call the API, as before', async () => {
    const { port } = new URL(t.base);
    const allowOrigin = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/pets', headers: { Origin: 'https://any-site.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['access-control-allow-origin']));
      }).on('error', reject);
    });
    assert.equal(allowOrigin, '*');
  });
});

describe('404 page', () => {
  const NOT_FOUND = "We couldn't find that page";

  test('unknown pages, deep addresses and missing files get the 404 page with status 404', async () => {
    for (const p of ['/nope.html', '/pets', '/a/b/c', '/images/nope.png', '/css/nope.css']) {
      const res = await t.api('GET', p);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get('content-type'), /text\/html/, p);
      assert.ok(res.text.includes(NOT_FOUND), p);
      assert.ok(res.headers.get('content-security-policy'), `${p} has the security headers`);
    }
  });

  test('it links back to Home and Find a Pet, and works at any depth', async () => {
    const res = await t.api('GET', '/a/b/c');
    assert.match(res.text, /<base href="\/"/);
    assert.match(res.text, /<a href="index\.html"[^>]*>Go to Home<\/a>/);
    assert.match(res.text, /<a href="pets\.html"[^>]*>Find a Pet<\/a>/);
    assert.match(res.text, /<meta name="robots" content="noindex"/);
  });

  test('private files still get a 404, now with the friendly page', async () => {
    for (const p of ['/backend/cloudpaw.db', '/backend/server.js', '/css/../backend/package.json']) {
      assert.equal(await t.rawGet(p), 404, p);
    }
  });

  test('other methods get a plain "Not found"; unknown /api paths keep their JSON 404', async () => {
    const post = await t.api('POST', '/nope', { body: {} });
    assert.equal(post.status, 404);
    assert.match(post.headers.get('content-type'), /text\/plain/);
    assert.equal(post.text, 'Not found');

    const api = await t.api('GET', '/api/nope');
    assert.equal(api.status, 404);
    assert.deepEqual(api.body, { error: 'Not found' });
  });
});

describe('nothing in the frontend that the CSP would block', () => {
  // The CSP allows scripts and styles only from files (no 'unsafe-inline'), so
  // inline code in the pages or in HTML built by script.js would be blocked in
  // the browser. Checked against the files themselves.
  const pages = fs.readdirSync(SITE_ROOT).filter((f) => f.endsWith('.html'));
  const scripts = fs.readdirSync(path.join(SITE_ROOT, 'js')).filter((f) => f.endsWith('.js'));
  const read = (...parts) => fs.readFileSync(path.join(SITE_ROOT, ...parts), 'utf8');
  const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

  test('the site has the pages and scripts this checks', () => {
    assert.ok(pages.length >= 10, pages.join(', '));
    assert.deepEqual(scripts.sort(), ['config.js', 'script.js']);
  });

  for (const page of pages) {
    test(`${page}: no inline styles, inline scripts or on...= handlers; loads config.js then script.js`, () => {
      const html = withoutComments(read(page));
      assert.doesNotMatch(html, /<style[\s>]/i, '<style> block');
      assert.doesNotMatch(html, /\sstyle\s*=/i, 'style="..." attribute');
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'inline <script>');
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'on...= event handler');
      const scriptTags = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(scriptTags, ['js/config.js', 'js/script.js']);
    });
  }

  for (const file of scripts) {
    test(`js/${file}: builds no inline styles or handlers`, () => {
      const code = read('js', file);
      assert.doesNotMatch(code, /\sstyle\s*=\s*\\?["'`]/, 'style="..." in built HTML');
      assert.doesNotMatch(code, /<style[\s>]/i, '<style> in built HTML');
      assert.doesNotMatch(code, /setAttribute\(\s*["'`]style["'`]/, 'setAttribute("style")');
      assert.doesNotMatch(code, /\.cssText\b/, 'style.cssText');
      assert.doesNotMatch(code, /\son[a-z]+\s*=\s*\\?["'`]/, 'on...="..." in built HTML');
      assert.doesNotMatch(code, /setAttribute\(\s*["'`]on[a-z]+["'`]/, 'setAttribute("on...")');
      assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(/, 'eval / new Function');
    });
  }
});
