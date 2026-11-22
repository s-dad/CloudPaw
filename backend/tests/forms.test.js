// Public forms: adoption applications (POST /api/inquiries) and contact messages (POST /api/messages).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

// What adopt.html sends (FormData values are strings).
const validInquiry = () => ({
  petId: '1',
  name: 'Ana Applicant',
  email: 'ana@cloudpaw.test',
  phone: '(614) 555-0100',
  city: 'Columbus',
  housing: 'House',
  yard: 'Yes',
  otherPets: '',
  reason: 'We have a big yard and love Labs.',
  agree: 'yes',
});

describe('POST /api/inquiries', () => {
  test('201 for a valid application, saved as pending', async () => {
    const res = await t.api('POST', '/api/inquiries', { body: validInquiry() });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Application received!');
    assert.equal(typeof res.body.id, 'number');

    const row = t.db.prepare('SELECT * FROM inquiries WHERE id = ?').get(res.body.id);
    assert.equal(row.pet_id, 1);
    assert.equal(row.name, 'Ana Applicant');
    assert.equal(row.housing, 'House');
    assert.equal(row.other_pets, null); // empty optional field saved as null
    assert.equal(row.status, 'pending');
  });

  test('shows up for an admin in GET /api/inquiries with the pet name', async () => {
    const admin = await t.createAdmin();
    const created = await t.api('POST', '/api/inquiries', { body: { ...validInquiry(), name: 'Listed Applicant' } });
    const list = await t.api('GET', '/api/inquiries', { token: admin.token });
    const found = list.body.find((i) => i.id === created.body.id);
    assert.ok(found);
    assert.equal(found.pet_name, 'Luna');
    assert.equal(found.name, 'Listed Applicant');
    assert.equal(found.status, 'pending');
  });

  test('400 with a message for each invalid field', async () => {
    const res = await t.api('POST', '/api/inquiries', {
      body: {
        petId: 'abc',
        name: '',
        email: 'not-an-email',
        phone: '12',
        city: '',
        housing: 'Castle',
        yard: 'Maybe',
        reason: '',
        // agree missing
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Please fix the highlighted fields.');
    assert.deepEqual(
      Object.keys(res.body.fields).sort(),
      ['agree', 'city', 'email', 'housing', 'name', 'petId', 'phone', 'reason', 'yard'],
    );
  });

  test('400 for a pet that does not exist, instead of a server error', async () => {
    const res = await t.api('POST', '/api/inquiries', { body: { ...validInquiry(), petId: '999' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.fields, { petId: 'That pet could not be found.' });
  });

  test('nothing is saved when the input is invalid', async () => {
    const before = t.db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n;
    await t.api('POST', '/api/inquiries', { body: { ...validInquiry(), email: 'bad' } });
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n, before);
  });
});

describe('POST /api/messages', () => {
  test('201 for a valid message, saved as new', async () => {
    const res = await t.api('POST', '/api/messages', {
      body: { name: 'Ana', email: 'ana@cloudpaw.test', message: 'Do you foster senior dogs?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Message sent!');

    const row = t.db.prepare('SELECT * FROM messages WHERE id = ?').get(res.body.id);
    assert.equal(row.message, 'Do you foster senior dogs?');
    assert.equal(row.status, 'new');
  });

  test('400 with a message for each missing field', async () => {
    const res = await t.api('POST', '/api/messages', { body: {} });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'message', 'name']);
  });

  test('400 for an invalid email', async () => {
    const res = await t.api('POST', '/api/messages', {
      body: { name: 'Ana', email: 'not-an-email', message: 'Hi' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.fields, { email: 'Enter a valid email address.' });
  });
});
