const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Which database file to open. Defaults to backend/cloudpaw.db. Set DB_PATH to
// use a different file, e.g. the tests point it at a temporary database so they
// never touch the real one. Applies to everything that uses this module
// (server.js, seed.js, create-admin.js).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cloudpaw.db');
const db = new Database(DB_PATH);
db.exec(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));

// Older databases still have an unused "applications" table (applications are
// stored in "inquiries"), so drop it. IF EXISTS makes this a no-op once it's gone.
db.exec('DROP TABLE IF EXISTS applications');

// CREATE TABLE IF NOT EXISTS never changes a table that already exists, so
// columns added to schema.sql later must also be added to older databases here.
// Each one is added only if missing, so this is safe to run on every start and
// keeps all existing rows.
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('pets', 'location', 'TEXT');
addColumnIfMissing('pets', 'sex', 'TEXT'); // Male, Female or Unknown; empty = not recorded yet

module.exports = db;
