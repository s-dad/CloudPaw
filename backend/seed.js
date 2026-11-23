/* =============================================================================
   CloudPaw — load the sample pets from backend/data/pets.json

   Usage (from the backend folder):  node seed.js

   Safe to run more than once. For each pet in backend/data/pets.json, matched by name:
     - not in the database yet: it's added
     - already there: only its empty age, sex and location are filled in from
       the file. Values that are already set are never changed, so edits made
       on the site are kept.
   Everything runs in one transaction: if anything fails, nothing is changed.
   ============================================================================= */

const db = require('./db');
const raw = require('./data/pets.json');
const pets = Array.isArray(raw) ? raw : raw.pets;

// The columns filled in for pets that already exist.
const FILLABLE = ['age', 'sex', 'location'];
const isEmpty = (value) => value === null || value === undefined || value === '';

const findByName = db.prepare('SELECT id, age, sex, location FROM pets WHERE name = ?');
const insert = db.prepare(`INSERT INTO pets
  (name, species, breed, age, sex, description, photo_url, location)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
// COALESCE keeps the current value unless it's empty.
const fillMissing = db.prepare(`UPDATE pets SET
  age = COALESCE(age, ?),
  sex = COALESCE(NULLIF(sex, ''), ?),
  location = COALESCE(NULLIF(location, ''), ?)
  WHERE id = ?`);

// One pet from the file, in database columns (accepts a few older field names).
function fromFile(p) {
  return {
    name: p.name,
    species: p.species ?? p.type ?? null,
    breed: p.breed ?? null,
    age: typeof p.age === 'number' ? p.age : null,
    sex: p.sex ?? null,
    description: p.description ?? p.bio ?? null,
    photo_url: p.photo ?? p.image ?? p.img ?? null,
    location: p.location ?? null,
  };
}

const seed = db.transaction(() => {
  const counts = { added: 0, updated: 0, unchanged: 0 };
  for (const pet of pets.map(fromFile)) {
    const existing = findByName.all(pet.name);
    if (existing.length === 0) {
      insert.run(pet.name, pet.species, pet.breed, pet.age, pet.sex, pet.description, pet.photo_url, pet.location);
      counts.added++;
      continue;
    }
    for (const row of existing) {
      const fills = FILLABLE.filter((column) => isEmpty(row[column]) && !isEmpty(pet[column]));
      if (fills.length) {
        fillMissing.run(pet.age, pet.sex, pet.location, row.id);
        counts.updated++;
      } else {
        counts.unchanged++;
      }
    }
  }
  return counts;
});

const { added, updated, unchanged } = seed();
console.log(
  `Seeded pets from backend/data/pets.json: ${added} added, ${updated} updated ` +
  `(missing age, sex or location filled in), ${unchanged} already up to date.`
);
