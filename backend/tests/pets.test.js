// Public pet routes: GET /api/pets (list, search, species filter) and GET /api/pets/:id.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const names = (pets) => pets.map((p) => p.name).sort();

describe('GET /api/pets', () => {
  test('lists all 6 seeded pets with every column', async () => {
    const res = await t.api('GET', '/api/pets');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
    assert.deepEqual(names(res.body), ['Bella', 'Charlie', 'Luna', 'Milo', 'Oliver', 'Sadie']);
    assert.deepEqual(
      Object.keys(res.body[0]).sort(),
      ['age', 'breed', 'description', 'id', 'location', 'name', 'photo_url', 'sex', 'species', 'status'],
    );
    assert.equal(res.body[0].status, 'available');
  });

  test('?q= searches name, species and breed, ignoring case', async () => {
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=luna')).body), ['Luna']);
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=LAB')).body), ['Luna']);
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=retriever')).body), ['Charlie', 'Luna']);
    assert.equal((await t.api('GET', '/api/pets?q=cat')).body.length, 2);
  });

  test('?q= treats % and _ as plain characters, not wildcards', async () => {
    const res = await t.api('GET', '/api/pets?q=%25'); // %25 is "%" in a URL
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
    assert.deepEqual((await t.api('GET', '/api/pets?q=_')).body, []);
  });

  test('?q= with no match returns an empty list', async () => {
    const res = await t.api('GET', '/api/pets?q=unicorn');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('?species= filters by exact species', async () => {
    assert.deepEqual(names((await t.api('GET', '/api/pets?species=Cat')).body), ['Milo', 'Oliver']);
    assert.equal((await t.api('GET', '/api/pets?species=Dog')).body.length, 4);
  });

  test('?q= also searches location (city), ignoring case', async () => {
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=columbus')).body), ['Luna']);
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=DAYTON')).body), ['Oliver']);
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=cinci')).body), ['Bella']);
    assert.equal((await t.api('GET', '/api/pets?q=%2C%20OH')).body.length, 6, '", OH" is in every location');
  });

  test('a city search combines with ?species=', async () => {
    assert.deepEqual(names((await t.api('GET', '/api/pets?q=cleveland&species=Cat')).body), ['Milo']);
    assert.deepEqual((await t.api('GET', '/api/pets?q=cleveland&species=Dog')).body, []);
  });

  test('?species= and ?q= combine', async () => {
    assert.deepEqual(names((await t.api('GET', '/api/pets?species=Dog&q=collie')).body), ['Sadie']);
    assert.deepEqual((await t.api('GET', '/api/pets?species=Cat&q=collie')).body, []);
  });
});

describe('GET /api/pets/:id', () => {
  test('returns one pet', async () => {
    const res = await t.api('GET', '/api/pets/1');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 1);
    assert.equal(res.body.name, 'Luna');
    assert.equal(res.body.location, 'Columbus, OH');
  });

  test('seeded pets have their age and sex', async () => {
    const pets = (await t.api('GET', '/api/pets')).body;
    const bySex = Object.fromEntries(pets.map((p) => [p.name, `${p.age} ${p.sex}`]));
    assert.deepEqual(bySex, {
      Luna: '2 Female', Milo: '3 Male', Bella: '1 Female', Oliver: '4 Male', Charlie: '5 Male', Sadie: '2 Female',
    });
  });

  test('404 with a JSON error for a pet that does not exist', async () => {
    for (const id of ['999', 'abc']) {
      const res = await t.api('GET', `/api/pets/${id}`);
      assert.equal(res.status, 404, `id ${id}`);
      assert.deepEqual(res.body, { error: 'Pet not found' });
    }
  });
});

describe('unknown /api paths', () => {
  test('return a JSON 404, not an HTML page', async () => {
    const res = await t.api('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(res.body, { error: 'Not found' });
  });
});
