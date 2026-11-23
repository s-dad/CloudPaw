/* =============================================================================
   Shared test setup.

   startTestServer() gives each test file its own throwaway copy of the app:
     1. creates a temporary folder with an empty database file
     2. points DB_PATH at it BEFORE the app is loaded, so the real
        backend/cloudpaw.db is never opened
     3. seeds it with the real seed.js (the 6 pets from data/pets.json)
     4. starts the app on a free port (port 0 = let the OS pick)
   stop() closes the server and database and deletes the temporary folder.

   node --test runs each test file in its own process, so each file gets its
   own fresh database and its own port.
   ============================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REAL_DB = path.join(__dirname, '..', 'cloudpaw.db');

async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpaw-test-'));
  const dbPath = path.join(dir, 'test.db');
  process.env.DB_PATH = dbPath;

  // The tests sign up and sign in many times from the same address within
  // seconds, so raise the rate limits for them. Only when not already set: a
  // test file that checks the limits sets its own low values before calling this.
  for (const name of ['RATE_LIMIT_LOGIN', 'RATE_LIMIT_SIGNUP', 'RATE_LIMIT_FORMS']) {
    process.env[name] ??= '1000';
  }
  // No request log lines in the test output, unless a test file turns them on.
  process.env.LOG_REQUESTS ??= 'false';

  const db = require('../db');
  // Safety check: stop if the app opened anything other than the temporary
  // file (e.g. db.js was loaded before DB_PATH was set).
  if (path.resolve(db.name) !== path.resolve(dbPath) || path.resolve(db.name) === path.resolve(REAL_DB)) {
    throw new Error(`Refusing to run tests: database is ${db.name}, expected ${dbPath}`);
  }

  // seed.js runs when loaded; hide its summary line from test output.
  const log = console.log;
  console.log = () => {};
  try {
    require('../seed');
  } finally {
    console.log = log;
  }

  const app = require('../server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Sends a request and returns { status, headers, body (parsed JSON or null), text }.
  async function api(method, urlPath, { token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (e.g. an HTML page); callers can use text.
    }
    return { status: res.status, headers: res.headers, body: json, text };
  }

  // GET with the path sent exactly as written. fetch() cleans up "../" before
  // sending, so path-trick requests need the lower-level http module.
  function rawGet(rawPath) {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });
  }

  let counter = 0;
  const uniqueEmail = (prefix) => `${prefix}-${++counter}@cloudpaw.test`;

  // Signs up through the API (always creates an adopter). Returns { user, token, email, password }.
  async function signupAdopter() {
    const email = uniqueEmail('adopter');
    const password = 'adopter-password-123';
    const res = await api('POST', '/api/auth/signup', { body: { name: 'Test Adopter', email, password } });
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
    return { ...res.body, email, password };
  }

  // Creates an admin the same way create-admin.js does (hashPassword + role
  // 'admin'), then signs in through the API. Returns { user, token, email, password }.
  async function createAdmin() {
    const { hashPassword } = require('../auth');
    const email = uniqueEmail('admin');
    const password = 'admin-password-123';
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run('Test Admin', email, await hashPassword(password));
    const res = await api('POST', '/api/auth/login', { body: { email, password } });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${res.text}`);
    return { ...res.body, email, password };
  }

  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, db, dbPath, api, rawGet, uniqueEmail, signupAdopter, createAdmin, stop };
}

module.exports = { startTestServer };
