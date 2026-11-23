// Admin-only routes: GET /api/inquiries, POST /api/pets (including sex and
// photo_url validation) and PATCH /api/pets/:id.
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

// Links that POST /api/pets and PATCH /api/pets/:id must both reject.
const INVALID_PHOTO_URLS = [
  'http://example.com/a.jpg', // not https
  'javascript:alert(1)',
  'data:image/png;base64,AAAA',
  'ftp://example.com/a.jpg',
  'images/pets/luna.jpg', // relative path
  '//example.com/a.jpg', // no scheme
  'https://', // no host
  'https://exa mple.com/a.jpg', // space inside
  'https://user:secret@example.com/a.jpg', // username and password
];

describe('POST /api/pets photo_url (Image URL)', () => {
  test('saves a valid https link, and GET /api/pets/:id returns it', async () => {
    for (const link of [
      'https://images.example.org/pets/luna.jpg',
      'https://cdn.example.com/photo?id=123&size=large',
      'HTTPS://Example.com/Upper.png',
      `https://example.com/${'a'.repeat(1900)}.jpg`,
    ]) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Photo', species: 'Cat', photo_url: link } });
      assert.equal(res.status, 201, link.slice(0, 60));
      assert.equal(res.body.photo_url, link);
      assert.equal((await t.api('GET', `/api/pets/${res.body.id}`)).body.photo_url, link);
    }
  });

  test('spaces around the link are trimmed', async () => {
    const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Photo', species: 'Cat', photo_url: '  https://example.com/a.jpg  ' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.photo_url, 'https://example.com/a.jpg');
  });

  test('missing or blank: saved as empty, so the site shows its default image', async () => {
    for (const body of [{ name: 'No Photo', species: 'Dog' }, { name: 'Blank Photo', species: 'Dog', photo_url: '' }, { name: 'Spaces', species: 'Dog', photo_url: '   ' }]) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body });
      assert.equal(res.status, 201, body.name);
      assert.equal(res.body.photo_url, null);
    }
  });

  test('400 under photo_url for anything that is not an https link, and nothing is saved', async () => {
    const before = t.db.prepare('SELECT COUNT(*) AS n FROM pets').get().n;
    for (const link of INVALID_PHOTO_URLS) {
      const res = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Bad', species: 'Dog', photo_url: link } });
      assert.equal(res.status, 400, link);
      assert.deepEqual(res.body.fields, { photo_url: 'Must be a full image link starting with https://' }, link);
    }

    const tooLong = await t.api('POST', '/api/pets', {
      token: admin.token, body: { name: 'Bad', species: 'Dog', photo_url: `https://example.com/${'a'.repeat(2000)}.jpg` },
    });
    assert.equal(tooLong.status, 400);
    assert.deepEqual(tooLong.body.fields, { photo_url: 'Must be 2000 characters or fewer.' });

    const notText = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Bad', species: 'Dog', photo_url: 42 } });
    assert.equal(notText.status, 400);
    assert.deepEqual(notText.body.fields, { photo_url: 'Must be text.' });

    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM pets').get().n, before);
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

describe('PATCH /api/pets/:id (change a pet\'s photo link)', () => {
  const GOOD = 'https://images.example.org/pets/fixed.jpg';
  const addPet = async (body = {}) =>
    (await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Patchy', species: 'Dog', ...body } })).body;
  const patch = (id, body, token = admin.token) => t.api('PATCH', `/api/pets/${id}`, { token, body });

  test('401 when signed out, 403 for an adopter, and the photo is unchanged', async () => {
    const pet = await addPet({ photo_url: 'https://example.com/old.jpg' });
    const signedOut = await patch(pet.id, { photo_url: GOOD }, null);
    assert.equal(signedOut.status, 401);
    const asAdopter = await patch(pet.id, { photo_url: GOOD }, adopter.token);
    assert.equal(asAdopter.status, 403);
    assert.equal((await t.api('GET', `/api/pets/${pet.id}`)).body.photo_url, 'https://example.com/old.jpg');
  });

  test('404 for a pet that does not exist', async () => {
    for (const id of ['999', 'abc', '0']) {
      const res = await patch(id, { photo_url: GOOD });
      assert.equal(res.status, 404, `id ${id}`);
      assert.deepEqual(res.body, { error: 'Pet not found' });
    }
  });

  test('200: sets a new link and returns the updated pet', async () => {
    const pet = await addPet({ photo_url: 'https://example.com/broken.jpg' });
    const res = await patch(pet.id, { photo_url: `  ${GOOD}  ` });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, pet.id);
    assert.equal(res.body.photo_url, GOOD);
    assert.equal((await t.api('GET', `/api/pets/${pet.id}`)).body.photo_url, GOOD);
  });

  test('200: "" or null removes the link, so the site shows its default image', async () => {
    for (const empty of ['', null, '   ']) {
      const pet = await addPet({ photo_url: GOOD });
      const res = await patch(pet.id, { photo_url: empty });
      assert.equal(res.status, 200, JSON.stringify(empty));
      assert.equal(res.body.photo_url, null);
    }
  });

  test('only the photo changes: every other field in the body is ignored', async () => {
    const pet = await addPet({ breed: 'Beagle', age: '3', sex: 'Female' });
    const res = await patch(pet.id, {
      photo_url: GOOD, id: 999, name: 'Hacked', species: 'Cat', status: 'adopted', breed: 'X', age: 50, sex: 'Male',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ...pet, photo_url: GOOD });
    assert.equal((await t.api('GET', '/api/pets/999')).status, 404);
  });

  test('400 when photo_url is left out, and nothing changes', async () => {
    const pet = await addPet({ photo_url: GOOD });
    for (const body of [{}, { name: 'Only a name' }]) {
      const res = await patch(pet.id, body);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.fields, { photo_url: 'Send a link starting with https://, or an empty value to remove the photo.' });
    }
    assert.equal((await t.api('GET', `/api/pets/${pet.id}`)).body.photo_url, GOOD);
  });

  test('400 for an invalid link, and the photo is unchanged', async () => {
    const pet = await addPet({ photo_url: GOOD });
    for (const link of INVALID_PHOTO_URLS) {
      const res = await patch(pet.id, { photo_url: link });
      assert.equal(res.status, 400, link);
      assert.deepEqual(res.body.fields, { photo_url: 'Must be a full image link starting with https://' }, link);
    }
    assert.equal((await t.api('GET', `/api/pets/${pet.id}`)).body.photo_url, GOOD);
  });

  test('uses exactly the same rules as POST /api/pets', async () => {
    const candidates = [
      ...INVALID_PHOTO_URLS,
      GOOD, 'HTTPS://Example.com/Upper.png', 'https://cdn.example.com/p?id=1&s=l',
      `https://example.com/${'a'.repeat(1990)}`, `https://example.com/${'a'.repeat(2000)}.jpg`, 42, '',
    ];
    const pet = await addPet();
    for (const link of candidates) {
      const created = await t.api('POST', '/api/pets', { token: admin.token, body: { name: 'Same', species: 'Dog', photo_url: link } });
      const patched = await patch(pet.id, { photo_url: link });
      const label = String(link).slice(0, 50);
      assert.equal(created.status === 201, patched.status === 200, `same accept/reject for ${label}`);
      if (created.status === 400) assert.deepEqual(patched.body.fields, created.body.fields, `same message for ${label}`);
      else assert.equal(patched.body.photo_url, created.body.photo_url, `same saved value for ${label}`);
    }
  });
});
