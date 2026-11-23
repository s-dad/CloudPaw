// Error handling: every error comes back as JSON with a fixed message, never
// Express's HTML error page, a stack trace or the internal error text.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

// Signs of leaked internals: stack frames, file paths, error class names, or
// the simulated error's own text.
const LEAK = /at .+\.js:\d+|node_modules|SyntaxError|TypeError|Error:|SIMULATED|<html|<!DOCTYPE/i;

// Makes db.prepare throw for SQL matching `pattern` while `fn` runs, then
// restores it. The server and the tests share the same db object.
async function withDatabaseFailure(pattern, fn) {
  const realPrepare = t.db.prepare;
  t.db.prepare = function (sql) {
    if (pattern.test(sql)) throw new Error('SIMULATED database failure in /internal/path/db.js');
    return realPrepare.call(this, sql);
  };
  try {
    return await fn();
  } finally {
    t.db.prepare = realPrepare;
  }
}

async function postRaw(path, rawBody) {
  const res = await fetch(t.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('malformed JSON', () => {
  for (const [path, body] of [
    ['/api/auth/login', '{"email": not json'],
    ['/api/inquiries', '{'],
    ['/api/messages', '[1,'],
  ]) {
    test(`POST ${path} returns a JSON 400 with no stack trace`, async (ctx) => {
      const log = ctx.mock.method(console, 'error', () => {});
      const res = await postRaw(path, body);

      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(JSON.parse(res.text), { error: 'The request body is not valid JSON.' });
      assert.doesNotMatch(res.text, LEAK);
      assert.equal(log.mock.callCount(), 1, 'the server logs one line');
    });
  }
});

describe('unexpected errors', () => {
  const cases = [
    ['GET /api/pets', /FROM pets/, () => t.api('GET', '/api/pets')],
    ['GET /api/pets/:id', /FROM pets/, () => t.api('GET', '/api/pets/1')],
    ['POST /api/auth/signup', /FROM users WHERE email/, () =>
      t.api('POST', '/api/auth/signup', { body: { name: 'A', email: t.uniqueEmail('err'), password: 'password-123' } })],
    ['POST /api/auth/login', /FROM users WHERE email/, () =>
      t.api('POST', '/api/auth/login', { body: { email: 'someone@cloudpaw.test', password: 'password-123' } })],
  ];

  for (const [name, pattern, request] of cases) {
    test(`${name}: a database failure returns a JSON 500 with no stack trace`, async (ctx) => {
      const log = ctx.mock.method(console, 'error', () => {});
      const res = await withDatabaseFailure(pattern, request);

      assert.equal(res.status, 500);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(res.body, { error: 'Something went wrong. Please try again later.' });
      assert.doesNotMatch(res.text, LEAK);

      // The details go to the server log instead, as one JSON line.
      assert.equal(log.mock.callCount(), 1);
      const entry = JSON.parse(log.mock.calls[0].arguments[0]);
      assert.equal(entry.level, 'error');
      assert.equal(entry.message, 'Unexpected error');
      assert.match(entry.error, /^SIMULATED/, 'logs the real error');
      assert.match(entry.stack, /SIMULATED[\s\S]*at /, 'with its stack');
      assert.equal(entry.method, name.split(' ')[0]);
      assert.equal(entry.path, name.split(' ')[1].replace(':id', '1'));
    });
  }

  test('the same request works again once the database is back', async () => {
    const res = await t.api('GET', '/api/pets');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
  });

  test('routes with their own error handling keep their friendly message', async (ctx) => {
    ctx.mock.method(console, 'error', () => {});
    const res = await withDatabaseFailure(/INSERT INTO messages/, () =>
      t.api('POST', '/api/messages', { body: { name: 'A', email: 'a@cloudpaw.test', message: 'Hi' } }));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Could not send your message. Please try again later.' });
  });
});
