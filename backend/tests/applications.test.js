// Approving and denying applications (PATCH /api/inquiries/:id), and what
// happens to adopted pets. This file adopts pets, so it has its own database
// (each test file runs in its own process); tests run in order and build on
// each other.
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

// Seeded pets: 1 Luna (Dog), 2 Milo (Cat), 3 Bella (Dog), 4 Oliver (Cat), 5 Charlie, 6 Sadie.
async function apply(petId, name) {
  const res = await t.api('POST', '/api/inquiries', {
    body: {
      petId: String(petId), name, email: `${name.toLowerCase()}@cloudpaw.test`, phone: '614-555-0100',
      city: 'Columbus', housing: 'House', reason: 'We would love to adopt.', agree: 'yes',
    },
  });
  assert.equal(res.status, 201, `application from ${name}`);
  return res.body.id;
}
const decide = (id, status, token = admin.token) =>
  t.api('PATCH', `/api/inquiries/${id}`, { token, body: status === undefined ? {} : { status } });
const inquiryStatus = (id) => t.db.prepare('SELECT status FROM inquiries WHERE id = ?').get(id).status;
const petStatus = (id) => t.db.prepare('SELECT status FROM pets WHERE id = ?').get(id).status;

describe('PATCH /api/inquiries/:id: who can call it', () => {
  test('401 when signed out', async () => {
    const id = await apply(6, 'Signedout');
    const res = await decide(id, 'approved', null);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Please sign in.' });
    assert.equal(inquiryStatus(id), 'pending');
  });

  test('403 for an adopter', async () => {
    const id = await apply(6, 'Notadmin');
    const res = await decide(id, 'approved', adopter.token);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Admins only.' });
    assert.equal(inquiryStatus(id), 'pending');
  });
});

describe('PATCH /api/inquiries/:id: invalid requests', () => {
  test('400 for a status other than approved or denied', async () => {
    const id = await apply(6, 'Badstatus');
    for (const status of ['maybe', 'pending', 'Approved', '', 1, undefined]) {
      const res = await decide(id, status);
      assert.equal(res.status, 400, `status ${JSON.stringify(status)}`);
      assert.deepEqual(res.body.fields, { status: 'Must be approved or denied.' });
    }
    assert.equal(inquiryStatus(id), 'pending');
  });

  test('404 for an application that does not exist', async () => {
    for (const id of ['999', 'abc', '0', '-1']) {
      const res = await decide(id, 'approved');
      assert.equal(res.status, 404, `id ${id}`);
      assert.deepEqual(res.body, { error: 'Application not found' });
    }
  });
});

describe('approving and denying', () => {
  let ana, ben, cal, dee;
  let approvedReply; // the application from the approve response, checked against the list below
  before(async () => {
    ana = await apply(1, 'Ana'); // Luna
    ben = await apply(1, 'Ben'); // Luna
    cal = await apply(1, 'Cal'); // Luna
    dee = await apply(2, 'Dee'); // Milo
  });

  test('approve: 200, pet adopted, the pet\'s other pending applications denied', async () => {
    const res = await decide(ana, 'approved');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.application.id, ana);
    assert.equal(res.body.application.status, 'approved');
    assert.equal(res.body.application.pet_name, 'Luna');
    assert.deepEqual(res.body.autoDenied, [ben, cal]);
    approvedReply = res.body.application;

    assert.equal(petStatus(1), 'adopted');
    assert.equal(inquiryStatus(ben), 'denied');
    assert.equal(inquiryStatus(cal), 'denied');
    assert.equal(inquiryStatus(dee), 'pending', 'applications for other pets are not touched');
  });

  test('the returned application matches its row in GET /api/inquiries', async () => {
    const list = await t.api('GET', '/api/inquiries', { token: admin.token });
    const fromList = list.body.find((i) => i.id === ana);
    assert.deepEqual(approvedReply, fromList);
  });

  test('deny: 200, only that application changes, the pet stays available', async () => {
    const res = await decide(dee, 'denied');
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, 'denied');
    assert.deepEqual(res.body.autoDenied, []);
    assert.equal(petStatus(2), 'available');
  });

  test('409: decisions are final', async () => {
    for (const [id, status, was] of [[ana, 'approved', 'approved'], [ana, 'denied', 'approved'], [ben, 'approved', 'denied'], [dee, 'denied', 'denied']]) {
      const res = await decide(id, status);
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, { error: `This application has already been ${was}.` });
    }
    assert.equal(inquiryStatus(ana), 'approved');
    assert.equal(inquiryStatus(ben), 'denied');
  });

  test('409: a pending application for an adopted pet cannot be approved, but can be denied', async () => {
    // The API no longer accepts applications for adopted pets, so add one directly.
    const eve = Number(t.db.prepare(
      "INSERT INTO inquiries (pet_id, name, email, phone, city, housing, reason) VALUES (1, 'Eve', 'eve@cloudpaw.test', '614-555-0100', 'Columbus', 'House', 'R')"
    ).run().lastInsertRowid);

    const approve = await decide(eve, 'approved');
    assert.equal(approve.status, 409);
    assert.deepEqual(approve.body, { error: 'This pet has already been adopted.' });
    assert.equal(inquiryStatus(eve), 'pending');

    const deny = await decide(eve, 'denied');
    assert.equal(deny.status, 200);
    assert.equal(inquiryStatus(eve), 'denied');
  });

  test('if saving fails part-way, nothing is changed (one transaction)', async (ctx) => {
    ctx.mock.method(console, 'error', () => {});
    const fay = await apply(3, 'Fay'); // Bella
    const gus = await apply(3, 'Gus'); // Bella

    // Fail on the last step, after the pet and the other application were updated.
    const realPrepare = t.db.prepare;
    t.db.prepare = function (sql) {
      if (sql.startsWith('UPDATE inquiries SET status = ? WHERE id = ?')) throw new Error('simulated failure');
      return realPrepare.call(this, sql);
    };
    let res;
    try {
      res = await decide(fay, 'approved');
    } finally {
      t.db.prepare = realPrepare;
    }

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Could not update the application. Please try again later.' });
    assert.equal(petStatus(3), 'available', 'pet change rolled back');
    assert.equal(inquiryStatus(fay), 'pending');
    assert.equal(inquiryStatus(gus), 'pending', 'auto-deny rolled back');
  });
});

describe('adopted pets (Luna was adopted above)', () => {
  const names = (res) => res.body.map((p) => p.name);

  test('GET /api/pets leaves adopted pets out', async () => {
    const res = await t.api('GET', '/api/pets');
    assert.equal(res.status, 200);
    assert.ok(!names(res).includes('Luna'));
    assert.equal(res.body.length, 5);
  });

  test('search and the species filter leave them out too', async () => {
    assert.deepEqual(names(await t.api('GET', '/api/pets?q=luna')), []);
    assert.deepEqual(names(await t.api('GET', '/api/pets?q=columbus')), []);
    assert.ok(!names(await t.api('GET', '/api/pets?species=Dog')).includes('Luna'));
  });

  test('GET /api/pets/:id still returns an adopted pet, so old links work', async () => {
    const res = await t.api('GET', '/api/pets/1');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Luna');
    assert.equal(res.body.status, 'adopted');
  });

  test('POST /api/inquiries refuses an adopted pet with a 400 under petId', async () => {
    const before = t.db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n;
    const res = await t.api('POST', '/api/inquiries', {
      body: {
        petId: '1', name: 'Late', email: 'late@cloudpaw.test', phone: '614-555-0100',
        city: 'Columbus', housing: 'House', reason: 'R', agree: 'yes',
      },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.fields, { petId: 'This pet is no longer available for adoption.' });
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n, before);
  });

  test('available pets still take applications', async () => {
    await apply(2, 'Hal'); // Milo is still available
  });
});
