// Rate limits on login, signup and the public forms.
//
// Low limits are set here, before the app loads. helpers.js only raises limits
// that aren't already set, and each test file runs in its own process, so these
// low values don't affect the other test files.
process.env.RATE_LIMIT_LOGIN = '3';
process.env.RATE_LIMIT_SIGNUP = '2';
process.env.RATE_LIMIT_FORMS = '2';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const TRY_LATER = 'Please wait a few minutes and try again.';

function assertTooManyRequests(res, message) {
  assert.equal(res.status, 429);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(res.body, { error: message });
  assert.match(res.headers.get('retry-after'), /^\d+$/, 'says how many seconds to wait');
}

describe('POST /api/auth/login', () => {
  test('successful logins never count toward the limit', async () => {
    const admin = await t.createAdmin(); // signs in once
    for (let i = 0; i < 5; i++) {
      const res = await t.api('POST', '/api/auth/login', { body: { email: admin.email, password: admin.password } });
      assert.equal(res.status, 200, `successful login ${i + 1}`);
    }
  });

  test('repeated wrong passwords eventually get a JSON 429', async () => {
    const admin = await t.createAdmin();
    const wrong = { email: admin.email, password: 'wrong-password' };

    for (let i = 1; i <= 3; i++) {
      const res = await t.api('POST', '/api/auth/login', { body: wrong });
      assert.equal(res.status, 401, `failed attempt ${i}`);
    }
    const blocked = await t.api('POST', '/api/auth/login', { body: wrong });
    assertTooManyRequests(blocked, `Too many sign-in attempts. ${TRY_LATER}`);
    assert.match(blocked.headers.get('ratelimit-policy'), /3-in-15min/);

    // Once blocked, even the right password has to wait.
    const right = await t.api('POST', '/api/auth/login', { body: { email: admin.email, password: admin.password } });
    assert.equal(right.status, 429);
  });
});

describe('POST /api/auth/signup', () => {
  test('gets a JSON 429 after the limit', async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await t.api('POST', '/api/auth/signup', {
        body: { name: 'New', email: t.uniqueEmail('limit'), password: 'password-123' },
      });
      assert.equal(res.status, 201, `signup ${i}`);
    }
    const blocked = await t.api('POST', '/api/auth/signup', {
      body: { name: 'New', email: t.uniqueEmail('limit'), password: 'password-123' },
    });
    assertTooManyRequests(blocked, `Too many sign-up attempts. ${TRY_LATER}`);
  });
});

describe('public forms', () => {
  const inquiry = {
    petId: '1', name: 'Ana', email: 'ana@cloudpaw.test', phone: '614-555-0100',
    city: 'Columbus', housing: 'House', reason: 'We love dogs.', agree: 'yes',
  };

  test('POST /api/inquiries gets a JSON 429 after the limit; messages have their own counter', async () => {
    for (let i = 1; i <= 2; i++) {
      assert.equal((await t.api('POST', '/api/inquiries', { body: inquiry })).status, 201, `application ${i}`);
    }
    assertTooManyRequests(
      await t.api('POST', '/api/inquiries', { body: inquiry }),
      `Too many applications sent. ${TRY_LATER}`,
    );

    const message = await t.api('POST', '/api/messages', { body: { name: 'Ana', email: 'ana@cloudpaw.test', message: 'Hi' } });
    assert.equal(message.status, 201);
  });

  test('POST /api/messages counts invalid submissions too', async () => {
    // One message was already sent in the test above, so one more is allowed.
    assert.equal((await t.api('POST', '/api/messages', { body: {} })).status, 400);
    assertTooManyRequests(
      await t.api('POST', '/api/messages', { body: {} }),
      `Too many messages sent. ${TRY_LATER}`,
    );
  });
});

describe('routes without a limit', () => {
  test('still work for the same client', async () => {
    assert.equal((await t.api('GET', '/api/pets')).status, 200);
    assert.equal((await t.api('GET', '/api/pets/1')).status, 200);
  });
});
