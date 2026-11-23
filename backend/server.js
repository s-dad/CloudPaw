const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth');

/* ---------- Settings ---------- */
// Everything that differs between running locally and on AWS comes from
// environment variables. Unset means today's local behavior. (DB_PATH is read
// in db.js; the RATE_LIMIT_* values are read with the rate limits below.)
// An invalid value stops the server at startup with a clear message, instead
// of quietly running with a setting nobody intended.

// PORT: where `npm start` listens (0 lets the operating system pick).
// Not used on Lambda, where API Gateway calls the app directly.
function readPort(raw) {
  if (raw === undefined || raw === '') return 3000;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535 (got "${raw}").`);
  }
  return Number(raw);
}

// ALLOWED_ORIGIN: comma-separated list of sites allowed to call the API from a
// browser, e.g. "http://localhost:3000,https://d1234.cloudfront.net".
// Unset: any site may (Access-Control-Allow-Origin: *), as before. On AWS, set
// it to the CloudFront address so only the real site can call the API.
function readOrigins(raw) {
  if (raw === undefined || raw.trim() === '') return null;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('ALLOWED_ORIGIN is set but lists no addresses.');
  return entries.map((entry) => {
    let url = null;
    try {
      url = new URL(entry);
    } catch {
      // handled below
    }
    const ok = url && ['http:', 'https:'].includes(url.protocol)
      && url.origin === entry.replace(/\/$/, '').toLowerCase();
    if (!ok) {
      throw new Error(
        `ALLOWED_ORIGIN entries must be an address like https://example.com or http://localhost:3000, with no path (got "${entry}").`,
      );
    }
    return url.origin;
  });
}

// LOG_REQUESTS: one JSON log line per /api request. On unless set to false
// (the tests turn it off to keep their output quiet).
function readOnOff(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false (got "${raw}").`);
}

const config = {
  logRequests: readOnOff('LOG_REQUESTS', process.env.LOG_REQUESTS, true),
  port: readPort(process.env.PORT),
  // HOST: which network address to listen on. Unset: every interface, IPv4 and
  // IPv6 (Node's default when no host is given), as before. 127.0.0.1 = this
  // computer only. Not used on Lambda.
  host: process.env.HOST || undefined,
  // NODE_ENV: "production" makes Express and its libraries use their
  // production settings. API errors never include details either way.
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigins: readOrigins(process.env.ALLOWED_ORIGIN),
};

/* ---------- Logging ---------- */
// One JSON object per line, so CloudWatch can search by field (level, path,
// status...). Only the method, the path without its query string, the status
// and timing are logged: never headers (they carry sign-in tokens), request
// bodies (passwords, applicants' details) or query strings.
const pathOf = (req) => req.originalUrl.split('?')[0];

function writeLog(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === 'info') console.log(line);
  else console.error(line);
}

// An unexpected error, with its stack, for the server log only.
function logError(req, message, err) {
  writeLog({
    level: 'error', message, method: req.method, path: pathOf(req),
    error: err?.message, stack: err?.stack,
  });
}

if (config.nodeEnv === 'production' && !config.allowedOrigins) {
  writeLog({ level: 'warn', message: 'NODE_ENV is production but ALLOWED_ORIGIN is not set, so any website can call this API from a browser.' });
}

const app = express();
app.locals.config = config; // for tests

// Request log: one line per /api request when it finishes. First in the chain,
// so requests rejected early (bad JSON, rate limits, CORS preflights) are
// logged too and the time covers everything.
if (config.logRequests) {
  app.use((req, res, next) => {
    const path = pathOf(req);
    if (path !== '/api' && !path.startsWith('/api/')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      writeLog({ level: 'info', method: req.method, path, status: res.statusCode, ms: Math.round(ms * 10) / 10 });
    });
    next();
  });
}

// Security headers on every response (helmet's defaults), plus a
// Content-Security-Policy that only lets the browser load what the site uses.
// Helmet's default policy is kept except for these changes:
//   script-src  'self' (default): only js/script.js from this server. No inline
//               <script> or onclick="..." anywhere (script-src-attr 'none').
//   style-src   our CSS, the Google Fonts stylesheet, and inline styles.
//               No page uses inline styles any more (chatbot.html was removed),
//               so 'unsafe-inline' could be dropped in a later change.
//               Narrower than the default, which allows any https: stylesheet.
//   font-src    our files and fonts.gstatic.com, where Google Fonts serves the
//               font files. Narrower than the default (any https: or data:).
//   img-src     our images plus any https: image, because admins can paste a
//               pet photo link from any site (Image URL on the Add Pet form).
//               A list of allowed sites would break whenever a shelter uses a
//               different host. Images can't run code, http: stays blocked,
//               and Referrer-Policy: no-referrer means the other site isn't
//               told which page loaded the image.
//   upgrade-insecure-requests  off: locally the site runs on plain http://, and
//               this would make browsers request everything over https://.
//               On AWS, CloudFront enforces HTTPS instead.
// fetch() calls to /api are same-origin, covered by default-src 'self'. If the
// API moves to another domain (e.g. API Gateway), add it to connect-src.
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https:'],
        'upgrade-insecure-requests': null,
      },
    },
  }),
);
// CORS: which other sites may call the API from a browser (see ALLOWED_ORIGIN).
// The site itself is served from the same address as the API, so it doesn't
// need CORS locally. Tokens go in the Authorization header, not cookies.
app.use(cors(config.allowedOrigins ? { origin: config.allowedOrigins } : {}));
app.use(express.json());

// All JSON API routes live under /api (e.g. /api/pets), so they can never
// collide with the frontend's page and asset paths.
const api = express.Router();

// Deployment check: 200 {"status":"ok"} when the database answers a simple
// query, otherwise a JSON 503 (the real error goes to the log only). Before
// the rate limits and never cached, so monitoring can call it freely.
api.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({ status: 'ok' });
  } catch (err) {
    logError(req, 'Health check failed', err);
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});

/* ---------- Rate limits ---------- */
// Slows down password guessing and form spam: each client IP address gets a
// fixed number of requests per 15 minutes on these routes, then a JSON 429.
// Each route has its own counter. Defaults can be changed with environment
// variables (the tests raise them so they don't hit the limits).
//
// These counters live in this server's memory, so they only work for a single
// running server, which is what we have locally. On AWS, Lambda runs many
// copies of the app that don't share memory, so each copy would keep its own
// count; there, API Gateway throttling will do this job instead.
const RATE_WINDOW_MS = 15 * 60 * 1000;

// A positive whole number from the environment, or the default.
function limitFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rateLimiter(limit, message, options = {}) {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit,
    message: { error: message },
    standardHeaders: 'draft-8', // RateLimit and RateLimit-Policy headers
    legacyHeaders: false, // no X-RateLimit-* headers
    ...options,
  });
}

const LOGIN_LIMIT = limitFromEnv('RATE_LIMIT_LOGIN', 10);
const SIGNUP_LIMIT = limitFromEnv('RATE_LIMIT_SIGNUP', 5);
const FORM_LIMIT = limitFromEnv('RATE_LIMIT_FORMS', 20);
const TRY_LATER = 'Please wait a few minutes and try again.';

// Login counts only failed attempts, so people who sign in normally are never
// slowed down; repeated wrong passwords are.
api.post('/auth/login', rateLimiter(LOGIN_LIMIT, `Too many sign-in attempts. ${TRY_LATER}`, {
  skipSuccessfulRequests: true,
}));
api.post('/auth/signup', rateLimiter(SIGNUP_LIMIT, `Too many sign-up attempts. ${TRY_LATER}`));
api.post('/inquiries', rateLimiter(FORM_LIMIT, `Too many applications sent. ${TRY_LATER}`));
api.post('/messages', rateLimiter(FORM_LIMIT, `Too many messages sent. ${TRY_LATER}`));

api.use('/auth', auth.router);

api.get('/pets', (req, res) => {
  const { species, q } = req.query;
  // Adopted pets are left out of listings and search. GET /pets/:id still
  // returns them, so old links to a pet's page keep working.
  // (IS NOT, unlike !=, also keeps rows whose status is empty.)
  const conditions = ["status IS NOT 'adopted'"];
  const params = [];

  if (species) {
    conditions.push('species = ?');
    params.push(species);
  }

  // Free-text search: case-insensitive partial match on name, species, breed,
  // or location (city, e.g. "Columbus").
  // % and _ are wildcards in LIKE, so escape them to search for them literally.
  const term = typeof q === 'string' ? q.trim() : '';
  if (term) {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const searched = ['name', 'species', 'breed', 'location'];
    conditions.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...searched.map(() => pattern));
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM pets${where}`).all(...params);
  res.json(rows);
});

api.get('/pets/:id', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(req.params.id);
  if (!pet) return res.status(404).json({ error: 'Pet not found' });
  res.json(pet);
});

// Matches the options in admin-add.html.
const SPECIES_OPTIONS = ['Dog', 'Cat', 'Other'];
const SEX_OPTIONS = ['Male', 'Female', 'Unknown'];
const AGE_MAX = 100;

// Checks the fields for a new pet. Returns { values, errors } like validateInquiry.
// Image links (photo_url): https only, so a pasted link can't be http:// (mixed
// content) or something like javascript:. The server only stores the link and
// never fetches it, so it can't be used to make the server request other sites.
const PHOTO_URL_MAX = 2000;
function isHttpsUrl(value) {
  if (!/^https:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Reads an optional photo_url. Returns { value } (null when empty, meaning the
// site shows its default image) or { error }. POST /pets and PATCH /pets/:id
// both use this, so they apply exactly the same rules.
function readPhotoUrl(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'Must be text.' };
  const value = raw.trim();
  if (!value) return { value: null };
  if (value.length > PHOTO_URL_MAX) return { error: `Must be ${PHOTO_URL_MAX} characters or fewer.` };
  if (!isHttpsUrl(value)) return { error: 'Must be a full image link starting with https://' };
  return { value };
}

// Only these fields are read; anything else in the body (id, status) is ignored.
function validatePet(body) {
  const errors = {};
  const values = {};

  const text = (field, { required, max }) => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors[field] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'string') {
      errors[field] = 'Must be text.';
      return null;
    }
    const value = raw.trim();
    if (!value) {
      if (required) errors[field] = 'This field is required.';
      return null;
    }
    if (value.length > max) {
      errors[field] = `Must be ${max} characters or fewer.`;
      return null;
    }
    return value;
  };

  values.name = text('name', { required: true, max: 100 });
  values.species = text('species', { required: true, max: 20 });
  values.breed = text('breed', { required: false, max: 100 });
  values.location = text('location', { required: false, max: 100 });
  values.description = text('description', { required: false, max: 2000 });
  // Optional, so requests that don't send it still work; saved as "Unknown".
  values.sex = text('sex', { required: false, max: 20 });
  // Optional link to the pet's photo; empty means the site shows its fallback image.
  const photo = readPhotoUrl(body.photo_url);
  values.photo_url = photo.value ?? null;
  if (photo.error) errors.photo_url = photo.error;

  if (values.species && !SPECIES_OPTIONS.includes(values.species)) {
    errors.species = `Must be one of: ${SPECIES_OPTIONS.join(', ')}.`;
  }
  if (values.sex === null && !errors.sex) {
    values.sex = 'Unknown';
  } else if (values.sex && !SEX_OPTIONS.includes(values.sex)) {
    errors.sex = `Must be one of: ${SEX_OPTIONS.join(', ')}.`;
  }

  // Optional. Accept 3 or "3" (HTML forms send strings), but not 2.5, -1 or "abc".
  values.age = null;
  const age = body.age;
  if (age !== undefined && age !== null && age !== '') {
    const ageText = typeof age === 'number' ? String(age) : typeof age === 'string' ? age.trim() : '';
    if (!/^\d+$/.test(ageText)) {
      errors.age = 'Must be a whole number, 0 or higher.';
    } else if (Number(ageText) > AGE_MAX) {
      errors.age = `Must be ${AGE_MAX} or lower.`;
    } else {
      values.age = Number(ageText);
    }
  }

  return { values, errors };
}

// Admin only: add a pet. -> 201 with the saved pet, 400 with per-field errors.
api.post('/pets', auth.requireAdmin, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { values, errors } = validatePet(body);

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
  }

  try {
    const result = db.prepare(`INSERT INTO pets (name, species, breed, age, sex, location, description, photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      values.name,
      values.species,
      values.breed,
      values.age,
      values.sex,
      values.location,
      values.description,
      values.photo_url
    );
    const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(pet);
  } catch (err) {
    logError(req, 'Failed to save pet', err);
    res.status(500).json({ error: 'Could not save the pet. Please try again later.' });
  }
});

// Admin only: change a pet's photo link, e.g. to fix one that no longer loads.
// Body: { photo_url }. A link sets it; "" or null removes it (the site then
// shows its default image). Same rules as POST /pets (readPhotoUrl). Every
// other field in the body is ignored. -> 200 with the updated pet.
api.patch('/pets/:id', auth.requireAdmin, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // Leaving photo_url out is an error, so an empty request can't look like it worked.
  if (!Object.hasOwn(body, 'photo_url')) {
    return res.status(400).json({
      error: 'Please fix the highlighted fields.',
      fields: { photo_url: 'Send a link starting with https://, or an empty value to remove the photo.' },
    });
  }
  const photo = readPhotoUrl(body.photo_url);
  if (photo.error) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: { photo_url: photo.error } });
  }

  // Same rule as GET /pets/:id: anything that isn't a positive whole number can't match.
  const id = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : null;
  try {
    const result = id && db.prepare('UPDATE pets SET photo_url = ? WHERE id = ?').run(photo.value, id);
    if (!result || result.changes === 0) return res.status(404).json({ error: 'Pet not found' });
    res.json(db.prepare('SELECT * FROM pets WHERE id = ?').get(id));
  } catch (err) {
    logError(req, 'Failed to update pet photo', err);
    res.status(500).json({ error: 'Could not update the photo. Please try again later.' });
  }
});

/* ---------- Adoption inquiries ---------- */
// Matches the options in adopt.html.
const HOUSING_OPTIONS = ['House', 'Apartment', 'Condo / Townhouse', 'Other'];
const YARD_OPTIONS = ['Yes', 'No'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+().\-\s]+$/;

// Checks the adoption form fields sent by adopt.html.
// Returns { values, errors }: values are trimmed and ready to save,
// errors maps each bad field name to a message (empty when everything is valid).
function validateInquiry(body) {
  const errors = {};
  const values = {};

  // Reads a text field. Missing or blank is an error only when the field is required.
  const text = (field, { required, max }) => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors[field] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'string') {
      errors[field] = 'Must be text.';
      return null;
    }
    const value = raw.trim();
    if (!value) {
      if (required) errors[field] = 'This field is required.';
      return null;
    }
    if (value.length > max) {
      errors[field] = `Must be ${max} characters or fewer.`;
      return null;
    }
    return value;
  };

  values.name = text('name', { required: true, max: 100 });
  values.email = text('email', { required: true, max: 254 });
  values.phone = text('phone', { required: true, max: 30 });
  values.city = text('city', { required: true, max: 100 });
  values.housing = text('housing', { required: true, max: 50 });
  values.yard = text('yard', { required: false, max: 10 });
  values.otherPets = text('otherPets', { required: false, max: 2000 });
  values.reason = text('reason', { required: true, max: 2000 });

  if (values.email && !EMAIL_PATTERN.test(values.email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (values.phone) {
    const digits = values.phone.replace(/\D/g, '').length;
    if (!PHONE_PATTERN.test(values.phone) || digits < 7 || digits > 15) {
      errors.phone = 'Enter a valid phone number.';
    }
  }
  if (values.housing && !HOUSING_OPTIONS.includes(values.housing)) {
    errors.housing = `Must be one of: ${HOUSING_OPTIONS.join(', ')}.`;
  }
  if (values.yard && !YARD_OPTIONS.includes(values.yard)) {
    errors.yard = 'Must be Yes or No.';
  }
  if (body.agree !== 'yes') {
    errors.agree = 'You must agree before submitting.';
  }

  // The form sends petId as a string ("3"); accept a whole number in either form.
  const petId = String(body.petId ?? '').trim();
  if (!/^[1-9]\d*$/.test(petId)) {
    errors.petId = 'Choose a pet.';
  } else {
    values.petId = Number(petId);
  }

  return { values, errors };
}

api.post('/inquiries', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { values, errors } = validateInquiry(body);

  // better-sqlite3 enforces REFERENCES pets(id), so a missing pet would make the INSERT
  // fail with a 500. Check here first so the form gets a clear 400 for petId instead.
  // Only available pets take applications (not adopted ones).
  if (!errors.petId) {
    const pet = db.prepare('SELECT status FROM pets WHERE id = ?').get(values.petId);
    if (!pet) {
      errors.petId = 'That pet could not be found.';
    } else if ((pet.status ?? 'available') !== 'available') {
      errors.petId = 'This pet is no longer available for adoption.';
    }
  }

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
  }

  try {
    const result = db.prepare(`INSERT INTO inquiries
      (pet_id, name, email, phone, city, housing, yard, other_pets, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      values.petId,
      values.name,
      values.email,
      values.phone,
      values.city,
      values.housing,
      values.yard,
      values.otherPets,
      values.reason
    );
    res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Application received!' });
  } catch (err) {
    logError(req, 'Failed to save inquiry', err);
    res.status(500).json({ error: 'Could not save your application. Please try again later.' });
  }
});

// The fields returned for an application, with the pet's name. Shared by
// GET /inquiries and PATCH /inquiries/:id so both return the same shape.
// LEFT JOIN so an application is never dropped, even if its pet row is missing
// (pet_name is then null).
const INQUIRY_SELECT = `
  SELECT i.id, i.pet_id, p.name AS pet_name, i.name, i.email, i.phone, i.city,
         i.housing, i.yard, i.other_pets, i.reason, i.status, i.created_at
  FROM inquiries i
  LEFT JOIN pets p ON p.id = i.pet_id`;

// Admin only: every saved application, newest first, with the pet's name.
api.get('/inquiries', auth.requireAdmin, (req, res) => {
  // Contains applicants' personal details, so never let a browser or proxy cache it.
  res.set('Cache-Control', 'no-store');
  try {
    const rows = db.prepare(`${INQUIRY_SELECT} ORDER BY i.created_at DESC, i.id DESC`).all();
    res.json(rows);
  } catch (err) {
    logError(req, 'Failed to load inquiries', err);
    res.status(500).json({ error: 'Could not load applications.' });
  }
});

// Admin only: approve or deny a pending application. Body: { status }.
//   approved -> the pet becomes "adopted", and the pet's other pending
//               applications are denied automatically (same transaction).
//   denied   -> only this application changes; the pet stays as it is.
// Decisions are final: an application that is already approved or denied
// can't be changed (409), and a pet that's already adopted can't be approved
// for someone else (409).
// -> 200 { application, autoDenied: [ids of applications denied automatically] }
const DECISIONS = ['approved', 'denied'];

api.patch('/inquiries/:id', auth.requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (!DECISIONS.includes(body.status)) {
    return res.status(400).json({
      error: 'Please fix the highlighted fields.',
      fields: { status: 'Must be approved or denied.' },
    });
  }

  // Same rule as GET /pets/:id: anything that isn't a positive whole number can't match.
  const id = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : null;

  // All checks and updates run in one transaction, so two decisions made at
  // the same moment can't both succeed. Returns { status, body } to send.
  const decide = db.transaction(() => {
    const inquiry = id && db.prepare('SELECT id, pet_id, status FROM inquiries WHERE id = ?').get(id);
    if (!inquiry) return { status: 404, body: { error: 'Application not found' } };

    if (inquiry.status !== 'pending') {
      return { status: 409, body: { error: `This application has already been ${inquiry.status}.` } };
    }

    let autoDenied = [];
    if (body.status === 'approved') {
      const pet = db.prepare('SELECT status FROM pets WHERE id = ?').get(inquiry.pet_id);
      if (pet && pet.status === 'adopted') {
        return { status: 409, body: { error: 'This pet has already been adopted.' } };
      }
      db.prepare("UPDATE pets SET status = 'adopted' WHERE id = ?").run(inquiry.pet_id);
      autoDenied = db.prepare(
        "SELECT id FROM inquiries WHERE pet_id = ? AND id != ? AND status = 'pending' ORDER BY id"
      ).all(inquiry.pet_id, inquiry.id).map((row) => row.id);
      db.prepare(
        "UPDATE inquiries SET status = 'denied' WHERE pet_id = ? AND id != ? AND status = 'pending'"
      ).run(inquiry.pet_id, inquiry.id);
    }

    db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(body.status, inquiry.id);
    const application = db.prepare(`${INQUIRY_SELECT} WHERE i.id = ?`).get(inquiry.id);
    return { status: 200, body: { application, autoDenied } };
  });

  try {
    const result = decide();
    res.status(result.status).json(result.body);
  } catch (err) {
    logError(req, 'Failed to update inquiry', err);
    res.status(500).json({ error: 'Could not update the application. Please try again later.' });
  }
});

/* ---------- Contact messages ---------- */
// Checks the contact form fields sent by about.html: name, email, message.
// Returns { values, errors } like validateInquiry; other fields are ignored.
function validateMessage(body) {
  const errors = {};
  const values = {};

  const text = (field, max) => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      errors[field] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'string') {
      errors[field] = 'Must be text.';
      return null;
    }
    const value = raw.trim();
    if (!value) {
      errors[field] = 'This field is required.';
      return null;
    }
    if (value.length > max) {
      errors[field] = `Must be ${max} characters or fewer.`;
      return null;
    }
    return value;
  };

  values.name = text('name', 100);
  values.email = text('email', 254);
  values.message = text('message', 5000);

  if (values.email && !EMAIL_PATTERN.test(values.email)) {
    errors.email = 'Enter a valid email address.';
  }

  return { values, errors };
}

// Public: anyone can send a message from the About page.
api.post('/messages', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { values, errors } = validateMessage(body);

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
  }

  try {
    const result = db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)')
      .run(values.name, values.email, values.message);
    res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Message sent!' });
  } catch (err) {
    logError(req, 'Failed to save message', err);
    res.status(500).json({ error: 'Could not send your message. Please try again later.' });
  }
});

// Unknown /api paths get a JSON 404 instead of falling through to the static files.
api.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

/* ---------- Frontend ---------- */
// The site's files sit in the repo root next to backend/, which holds the
// database (users, password hashes, sessions). So never serve the root folder
// as a whole: expose only the frontend, which is also the set of files to
// upload to S3: the top-level *.html pages, css/, js/, images/ and data/.
const SITE_ROOT = path.join(__dirname, '..');
for (const dir of ['css', 'js', 'images', 'data']) {
  app.use(`/${dir}`, express.static(path.join(SITE_ROOT, dir)));
}
// Top-level pages only: "/" -> index.html, "/pets.html", "/about.html", ...
app.get(/^\/(?:[\w-]+\.html)?$/, (req, res, next) => {
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.sendFile(file, { root: SITE_ROOT }, (err) => err && next());
});

// Anything else that isn't a page or file: the site's 404 page, with status
// 404 (unknown /api paths already got a JSON 404 above). On AWS, CloudFront
// serves the same 404.html as its error page.
app.use((req, res) => {
  res.status(404);
  const notFoundText = () => res.type('text').send('Not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFoundText();
  res.sendFile('404.html', { root: SITE_ROOT }, (err) => err && !res.headersSent && notFoundText());
});

/* ---------- Errors ---------- */
// The one place errors end up, instead of Express's HTML error page (which
// includes the stack trace unless NODE_ENV=production). Replies are always
// JSON with a fixed message: never err.message or a stack, whatever NODE_ENV is.
//
// How errors get here: Express 5 passes along both errors thrown in normal
// route handlers (GET /api/pets, GET /api/pets/:id) and rejected promises from
// async ones (signup, login), so those routes don't need their own try/catch.
// Routes that already catch their errors keep their own friendly 500 messages.
// Messages for errors express.json() raises while reading a request body,
// by error type.
const BODY_ERROR_MESSAGES = {
  'entity.parse.failed': 'The request body is not valid JSON.', // 400
  'entity.too.large': 'The request body is too large.', // 413
  'charset.unsupported': 'The request body uses an unsupported encoding.', // 415
  'encoding.unsupported': 'The request body uses an unsupported encoding.', // 415
};

// Express requires all four parameters to recognize an error handler.
app.use((err, req, res, next) => {
  // A reply was already partly sent, so a JSON one can't follow; let Express
  // close the connection.
  if (res.headersSent) return next(err);

  // Problems with the request itself (malformed JSON, too large, bad encoding).
  // Keep their 4xx status so the client's mistake isn't reported as a server error.
  const status = err.status || err.statusCode;
  if (err.expose && status >= 400 && status < 500) {
    // Only the error's type: a JSON parser's message can quote part of the
    // body, which could be a password.
    writeLog({
      level: 'warn', message: 'Request body could not be read', method: req.method,
      path: pathOf(req), status, type: err.type || 'unknown',
    });
    return res.status(status).json({
      error: BODY_ERROR_MESSAGES[err.type] || 'The request could not be read.',
    });
  }

  // Anything else is unexpected: log the details here, send none to the client.
  logError(req, 'Unexpected error', err);
  res.status(500).json({ error: 'Something went wrong. Please try again later.' });
});

module.exports = app;

// Listen only when this file is run directly (node server.js or npm start).
// Tests require it instead and start the app on a free port; on Lambda a
// handler will call the app without listening at all.
if (require.main === module) {
  const { port, host } = config;
  const onListening = () => {
    const shown = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    console.log(`CloudPaw on http://${shown}:${server.address().port} (API at /api)`);
  };
  // No host given = every interface, IPv4 and IPv6, as before.
  const server = host ? app.listen(port, host, onListening) : app.listen(port, onListening);
}
