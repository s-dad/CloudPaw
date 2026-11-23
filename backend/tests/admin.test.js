// Admin-only routes: GET /api/inquiries and POST /api/pets.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
let admin;
let adopter;
before(async () => {
  t = await startTestServer();
  admin = await t.createAdmin();
  adopter = await t.signupAdopter();
});
after(() => t.stop());

const newPet = { name: 'Pepper', species: 'Cat', breed: 'Siamese', age: '3', location: 'Columbus, OH', description: 'Calm and curious.' };

describe('GET /api/inquiries (admin only)', () => {
  test('401 when signed out', async () => {
    const res = await t.api('GET', '/api/inquiries');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Please sign in.' });
  });

  test('403 for an adopter', async () => {
    const res = await t.api('GET', '/api/inquiries', { token: adopter.token });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Admins only.' });
  });

  test('200 for an admin, and never cached', async () => {
    const res = await t.api('GET', '/api/inquiries', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('POST /api/pets (admin only)', () => {
  test('401 when signed out', async () => {
    const res = await t.api('POST', '/api/pets', { body: newPet });
    assert.equal(res.status, 401);
  });

  test('403 for an adopter', async () => {
    const res = await t.api('POST', '/api/pets', { token: adopter.token, body: newPet });
    assert.equal(res.status, 403);
  });

  test('201 for an admin: saves the pet and returns it', async () => {
    const res = await t.api('POST', '/api/pets', { token: admin.token, body: newPet });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Pepper');
    assert.equal(res.body.species, 'Cat');
    assert.equal(res.body.breed, 'Siamese');
    assert.equal(res.body.age, 3); // sent as "3", saved as a number
    assert.equal(res.body.location, 'Columbus, OH');
    assert.equal(res.body.status, 'available');
    assert.equal(res.body.photo_url, null);

    const saved = await t.api('GET', `/api/pets/${res.body.id}`);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, res.body);
  });

  test('201 with only the required fields', async () => {
    const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Biscuit', species: 'Dog' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.breed, null);
    assert.equal(res.body.age, null);
  });

  test('400 with a message for each invalid field', async () => {
    const res = await t.api('POST', '/api/pets', {
      token: admin.token,
      body: { name: '', species: 'Lizard', age: '2.5' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Please fix the highlighted fields.');
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['age', 'name', 'species']);
    assert.equal(res.body.fields.species, 'Must be one of: Dog, Cat, Other.');
  });

  test('400 for an age over 100', async () => {
    const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Old', species: 'Dog', age: 101 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.fields.age, 'Must be 100 or lower.');
  });

  test('saves sex as Male, Female or Unknown', async () => {
    for (const sex of ['Male', 'Female', 'Unknown']) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: `Sex ${sex}`, species: 'Cat', sex } });
      assert.equal(res.status, 201, sex);
      assert.equal(res.body.sex, sex);
    }
  });

  test('sex left out or blank is saved as "Unknown"', async () => {
    for (const body of [{ name: 'No Sex', species: 'Dog' }, { name: 'Blank Sex', species: 'Dog', sex: '' }]) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body });
      assert.equal(res.status, 201, body.name);
      assert.equal(res.body.sex, 'Unknown');
    }
  });

  test('400 under sex for any other value, and nothing is saved', async () => {
    const before = t.db.prepare('SELECT COUNT(*) AS n FROM pets').get().n;
    for (const sex of ['female', 'M', 'Other']) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Bad Sex', species: 'Dog', sex } });
      assert.equal(res.status, 400, sex);
      assert.deepEqual(res.body.fields, { sex: 'Must be one of: Male, Female, Unknown.' });
    }
    const number = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Bad Sex', species: 'Dog', sex: 1 } });
    assert.equal(number.status, 400);
    assert.deepEqual(number.body.fields, { sex: 'Must be text.' });
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM pets').get().n, before);
  });

  test('spaces around sex are trimmed, like other text fields', async () => {
    const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Trim', species: 'Dog', sex: ' Female ' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.sex, 'Female');
  });
});

describe('admin role is checked on every request', () => {
  test('an admin demoted in the database is refused right away', async () => {
    const demoted = await t.createAdmin();
    assert.equal((await t.api('GET', '/api/inquiries', { token: demoted.token })).status, 200);

    t.db.prepare("UPDATE users SET role = 'adopter' WHERE id = ?").run(demoted.user.id);
    assert.equal((await t.api('GET', '/api/inquiries', { token: demoted.token })).status, 403);
  });
});
