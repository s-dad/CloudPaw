// seed.js: safe to run more than once, and fills in missing pet data.
// Runs seed.js as its own program (like `node seed.js`) against temporary
// databases via DB_PATH; the real cloudpaw.db is never opened.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const BACKEND = path.join(__dirname, '..');
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpaw-seed-test-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const newDbPath = () => path.join(dir, `seed-${++counter}.db`);

// Runs `node seed.js` with DB_PATH set; returns what it printed.
const runSeed = (dbPath) =>
  execFileSync(process.execPath, ['seed.js'], { cwd: BACKEND, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' }).trim();

// Reads all pets from a database file, closing it again.
function readPets(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM pets ORDER BY id').all();
  } finally {
    db.close();
  }
}
function edit(dbPath, sql) {
  const db = new Database(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const EXPECTED = {
  Luna: { age: 2, sex: 'Female', location: 'Columbus, OH' },
  Milo: { age: 3, sex: 'Male', location: 'Cleveland, OH' },
  Bella: { age: 1, sex: 'Female', location: 'Cincinnati, OH' },
  Oliver: { age: 4, sex: 'Male', location: 'Dayton, OH' },
  Charlie: { age: 5, sex: 'Male', location: 'Toledo, OH' },
  Sadie: { age: 2, sex: 'Female', location: 'Akron, OH' },
};
const summary = (pets) => Object.fromEntries(pets.map((p) => [p.name, { age: p.age, sex: p.sex, location: p.location }]));

describe('node seed.js', () => {
  test('on a new database: adds the 6 pets with age, sex and location', () => {
    const dbPath = newDbPath();
    const out = runSeed(dbPath);
    assert.match(out, /6 added, 0 updated .*, 0 already up to date\./);
    assert.deepEqual(summary(readPets(dbPath)), EXPECTED);
  });

  test('running it twice adds no duplicates and changes nothing', () => {
    const dbPath = newDbPath();
    runSeed(dbPath);
    const first = readPets(dbPath);

    const out = runSeed(dbPath);
    assert.match(out, /0 added, 0 updated .*, 6 already up to date\./);
    assert.deepEqual(readPets(dbPath), first);
  });

  test('on an older database (no location or sex columns): adds the columns and fills them in, keeping ages', () => {
    // The pets table as it was first created, seeded before location and sex existed.
    const dbPath = newDbPath();
    edit(dbPath, `
      CREATE TABLE pets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, species TEXT, breed TEXT,
        age INTEGER, description TEXT, photo_url TEXT, status TEXT DEFAULT 'available'
      );
      INSERT INTO pets (name, species, breed, age) VALUES
        ('Luna', 'Dog', 'Labrador Retriever', 2), ('Milo', 'Cat', 'Tabby', 3),
        ('Bella', 'Dog', 'Beagle', 1), ('Oliver', 'Cat', 'Maine Coon', 4),
        ('Charlie', 'Dog', 'Golden Retriever', 5), ('Sadie', 'Dog', 'Border Collie', 2);
      UPDATE pets SET status = 'adopted' WHERE name = 'Sadie';
    `);

    const out = runSeed(dbPath);
    assert.match(out, /0 added, 6 updated/);
    const pets = readPets(dbPath);
    assert.equal(pets.length, 6, 'no duplicates');
    assert.deepEqual(summary(pets), EXPECTED);
    assert.equal(pets.find((p) => p.name === 'Sadie').status, 'adopted', 'other columns untouched');

    assert.match(runSeed(dbPath), /0 added, 0 updated .*, 6 already up to date\./);
  });

  test('never overwrites values that are already set', () => {
    const dbPath = newDbPath();
    runSeed(dbPath);
    edit(dbPath, `
      UPDATE pets SET age = 7, location = 'Edited City', sex = NULL WHERE name = 'Luna';
      UPDATE pets SET sex = 'Unknown', age = NULL WHERE name = 'Milo';
      UPDATE pets SET location = '' WHERE name = 'Bella';
    `);

    const out = runSeed(dbPath);
    assert.match(out, /0 added, 3 updated .*, 3 already up to date\./);
    const pets = summary(readPets(dbPath));
    assert.deepEqual(pets.Luna, { age: 7, sex: 'Female', location: 'Edited City' }, 'set values kept, empty sex filled');
    assert.deepEqual(pets.Milo, { age: 3, sex: 'Unknown', location: 'Cleveland, OH' }, '"Unknown" is a value, so it is kept');
    assert.equal(pets.Bella.location, 'Cincinnati, OH', 'an empty string counts as missing');
  });

  test('leaves pets that are not in data/pets.json alone', () => {
    const dbPath = newDbPath();
    runSeed(dbPath);
    edit(dbPath, "INSERT INTO pets (name, species) VALUES ('Biscuit', 'Dog')");

    runSeed(dbPath);
    const biscuit = readPets(dbPath).find((p) => p.name === 'Biscuit');
    assert.deepEqual({ age: biscuit.age, sex: biscuit.sex, location: biscuit.location }, { age: null, sex: null, location: null });
    assert.equal(readPets(dbPath).length, 7);
  });
});
