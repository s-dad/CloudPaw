
# CloudPaw

A cloud-native pet adoption platform

## Team
- Shelley Baker
- Safia Dad

## Course
CLOUD 495 Capstone, Franklin University

## Status
Week 1 - Setting up the project.

Week 2-3 - Designed the database and built the pet listings API. Added search and filters, the adoption form, and form storage.

Week 4 - Added login. Connecting the frontend to the API and planning the move to AWS.

Not built yet: pet photo upload and image storage. The sample pets' photos are files in `images/pets/`. For other pets, admins paste a link to a photo (`https://` only), and pets without one show a default image.

## Getting Started

Runs the full site and API locally at http://localhost:3000.

### Prerequisites
- [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager)
- Node.js 24 LTS. The version is set in the `.nvmrc` file in the project root, so you don't need to type it. From the project folder, run:
  ```bash
  nvm install   # first time only: installs the version in .nvmrc
  nvm use       # switches to it; run this in each new terminal
  ```

### Install
All backend commands run from the `backend` folder.
```bash
cd backend
npm install
```

### Seed the database
```bash
node seed.js
```
This creates `backend/cloudpaw.db` and loads the sample pets from `data/pets.json`. It's safe to run again: pets that are already there aren't added twice, and any missing age, sex or location is filled in from the file without changing values that are already set. Run it after pulling changes to `data/pets.json` to update an existing database.

### Create an admin account
```bash
node create-admin.js you@example.com "Your Name"
```
You'll be asked for a password (at least 8 characters). Admins can use the Add Pet and Applications pages, and change a pet's photo link from that pet's page. Running it again for the same email resets that account's password.

### Start the server
```bash
npm start
```
Then open http://localhost:3000.

### Running tests
```bash
cd backend
npm test
```
The tests use their own temporary database, so they never change `backend/cloudpaw.db`, and they don't need the server running. They also run automatically in GitHub Actions on every push and pull request to `main`.

### Production mode
API errors always come back as JSON with a short message and no internal details (the full error is logged on the server). To also run Express with its production settings, set `NODE_ENV`:
```bash
NODE_ENV=production npm start            # macOS / Linux
$env:NODE_ENV="production"; npm start    # Windows PowerShell
```

### Rate limits
Each IP address can make, per 15 minutes: 10 failed sign-ins, 5 sign-ups, 20 adoption applications and 20 contact messages. After that, the API answers `429 Too Many Requests` until the 15 minutes are up. Change the limits with `RATE_LIMIT_LOGIN`, `RATE_LIMIT_SIGNUP` and `RATE_LIMIT_FORMS` (for example `RATE_LIMIT_LOGIN=50 npm start`). The counts are kept in the server's memory and reset when it restarts; on AWS, API Gateway throttling will replace them.

### Troubleshooting
- **Segmentation fault, or `better-sqlite3` won't load:** delete `backend/node_modules` and run `npm install` again (from the `backend` folder). Check `node -v` shows Node 24 (run `nvm use`).
- **`Cannot find module ... server.js`:** you're in the wrong folder. Run `cd backend` first.

## Configuration

Everything that differs between running locally and on AWS is a setting, not code. With nothing set, the app behaves exactly as described above.

### Backend settings (environment variables)
Set them when starting the server (e.g. `PORT=8080 npm start`), or as the Lambda function's environment variables. An invalid value stops the server at startup with a message naming it.

| Setting | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGIN` | Not set: any website may call the API from a browser | Comma-separated list of site addresses allowed to call the API, e.g. `http://localhost:3000,https://d1234.cloudfront.net`. Each must be a bare address (`https://…`, no path). |
| `NODE_ENV` | `development` | `production` gives Express its production settings and warns at startup if `ALLOWED_ORIGIN` isn't set. |
| `LOG_REQUESTS` | On | One JSON log line per `/api` request (method, path, status, time taken). `false` turns it off. Passwords, tokens, request bodies and query strings are never logged. |
| `PORT` | `3000` | Port for `npm start`. Not used on Lambda. |
| `HOST` | Every network interface | Address for `npm start`, e.g. `127.0.0.1` for this computer only. Not used on Lambda. |
| `DB_PATH` | `backend/cloudpaw.db` | The SQLite database file. |
| `RATE_LIMIT_LOGIN`, `RATE_LIMIT_SIGNUP`, `RATE_LIMIT_FORMS` | `10`, `5`, `20` per 15 minutes | See [Rate limits](#rate-limits). |

### Frontend setting (`js/config.js`)
| Setting | Default | What it does |
|---|---|---|
| `API_BASE` | `"/api"` | Where the browser sends API requests. `"/api"` means the API is on the same address as the site. |

`js/config.js` is the only frontend file that differs between environments; nothing else needs editing.

### What to set on AWS
The frontend is on S3 + CloudFront and the backend on API Gateway + Lambda, with **CloudFront forwarding `/api/*` to API Gateway**, so the site and the API share one address.

**Backend (Safia, Lambda environment variables):**
- `NODE_ENV=production`
- `ALLOWED_ORIGIN=https://<your-cloudfront-address>`. With `/api/*` forwarded, the browser doesn't need CORS, but this stops any other website from calling the API.
- Leave `LOG_REQUESTS` on, so the request lines reach CloudWatch.

**Frontend (Shelley, S3 + CloudFront):**
- Upload the top-level `*.html` pages and the `css/`, `js/`, `images/` and `data/` folders. `js/config.js` can stay as it is: `API_BASE` stays `"/api"`.
- In CloudFront, add a behavior for `/api/*` pointing at API Gateway, with caching disabled, all HTTP methods allowed, and the `Authorization` header and query strings forwarded.
- Set a custom error response for 403 and 404 to `/404.html` with status 404.
- Add a response headers policy with the same security headers Express sends locally, including this Content-Security-Policy:
  ```
  default-src 'self'; base-uri 'self'; font-src 'self' https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'self'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https://fonts.googleapis.com
  ```
  plus `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: no-referrer`.

If the frontend ever calls API Gateway on its own address instead: set `API_BASE` in `js/config.js` to that URL, set `ALLOWED_ORIGIN` to the CloudFront address, and add the API's address to `connect-src` in the Content-Security-Policy.

### Checking a deployment
`GET /api/health` returns `200 {"status":"ok"}` when the API is up and the database answers, and `503` otherwise (the details are in the logs).
