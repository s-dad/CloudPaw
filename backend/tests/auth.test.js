// Sign-up, sign-in, "who am I" and sign-out: /api/auth/*.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

describe('POST /api/auth/signup', () => {
  test('creates an adopter and returns the user and a token', async () => {
    const email = t.uniqueEmail('signup');
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: 'Ana Test', email, password: 'correct-horse-1' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.name, 'Ana Test');
    assert.equal(res.body.user.email, email);
    assert.equal(res.body.user.role, 'adopter');
    assert.equal(typeof res.body.token, 'string');
    assert.ok(res.body.token.length >= 40);
  });

  test('never returns the password or its hash', async () => {
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: 'Ana Test', email: t.uniqueEmail('signup'), password: 'correct-horse-1' },
    });
    assert.deepEqual(Object.keys(res.body.user).sort(), ['email', 'id', 'name', 'role']);
    assert.doesNotMatch(res.text, /correct-horse-1|scrypt\$/);
  });

  test('stores the password hashed with scrypt, never as plain text', async () => {
    const email = t.uniqueEmail('signup');
    await t.api('POST', '/api/auth/signup', { body: { name: 'Ana', email, password: 'correct-horse-1' } });
    const row = t.db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email);
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!row.password_hash.includes('correct-horse-1'));
  });

  test('ignores a role in the request: new accounts are always adopters', async () => {
    const email = t.uniqueEmail('sneaky');
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: 'Sneaky', email, password: 'correct-horse-1', role: 'admin' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'adopter');
    assert.equal(t.db.prepare('SELECT role FROM users WHERE email = ?').get(email).role, 'adopter');
  });

  test('saves the email in lower case', async () => {
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: 'Case Test', email: 'Mixed.Case@CloudPaw.TEST', password: 'correct-horse-1' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'mixed.case@cloudpaw.test');
  });

  test('409 for an email that is already registered (any letter case)', async () => {
    const email = t.uniqueEmail('dupe');
    await t.api('POST', '/api/auth/signup', { body: { name: 'First', email, password: 'correct-horse-1' } });
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: 'Second', email: email.toUpperCase(), password: 'correct-horse-2' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'An account with that email already exists.');
    assert.equal(res.body.fields.email, 'An account with that email already exists.');
  });

  test('400 with a message for each invalid field', async () => {
    const res = await t.api('POST', '/api/auth/signup', {
      body: { name: '', email: 'not-an-email', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Please fix the highlighted fields.');
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'name', 'password']);
    assert.equal(res.body.fields.password, 'Must be at least 8 characters.');
  });

  test('400 when the body is missing entirely', async () => {
    const res = await t.api('POST', '/api/auth/signup', { body: {} });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'name', 'password']);
  });
});

describe('POST /api/auth/login', () => {
  test('returns the user and a token for the right password', async () => {
    const { email, password } = await t.signupAdopter();
    const res = await t.api('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
    assert.equal(res.body.user.role, 'adopter');
    assert.equal(typeof res.body.token, 'string');
  });

  test('accepts the email in any letter case', async () => {
    const { email, password } = await t.signupAdopter();
    const res = await t.api('POST', '/api/auth/login', { body: { email: email.toUpperCase(), password } });
    assert.equal(res.status, 200);
  });

  test('401 for a wrong password, with the same message as an unknown email', async () => {
    const { email } = await t.signupAdopter();
    const wrongPassword = await t.api('POST', '/api/auth/login', {
      body: { email, password: 'not-the-password' },
    });
    const unknownEmail = await t.api('POST', '/api/auth/login', {
      body: { email: 'nobody@cloudpaw.test', password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error, 'Email or password is incorrect.');
    assert.deepEqual(unknownEmail.body, wrongPassword.body);
  });

  test('400 when the email or password is missing', async () => {
    const res = await t.api('POST', '/api/auth/login', { body: { email: 'someone@cloudpaw.test' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Enter your email and password.');
  });
});

describe('GET /api/auth/me', () => {
  test('200 with the signed-in user', async () => {
    const { token, email } = await t.signupAdopter();
    const res = await t.api('GET', '/api/auth/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['email', 'id', 'name', 'role']);
  });

  test('401 with no token', async () => {
    const res = await t.api('GET', '/api/auth/me');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Please sign in.' });
  });

  test('401 with a made-up token', async () => {
    const res = await t.api('GET', '/api/auth/me', { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
  });

  test('401 once the session has expired', async () => {
    const { token, user } = await t.signupAdopter();
    t.db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);
    const res = await t.api('GET', '/api/auth/me', { token });
    assert.equal(res.status, 401);
  });

  test('only the hash of the token is stored', async () => {
    const { token, user } = await t.signupAdopter();
    const rows = t.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(user.id);
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.notEqual(row.token_hash, token);
  });
});

describe('POST /api/auth/logout', () => {
  test('204, and the token stops working', async () => {
    const { token } = await t.signupAdopter();
    assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 200);

    const res = await t.api('POST', '/api/auth/logout', { token });
    assert.equal(res.status, 204);
    assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 401);
  });

  test('204 even without a token, so the browser can always clear its sign-in', async () => {
    const res = await t.api('POST', '/api/auth/logout');
    assert.equal(res.status, 204);
  });
});
