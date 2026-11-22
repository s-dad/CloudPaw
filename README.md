
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

Not built yet: pet photo upload and image storage. Pet photos are static files in `images/pets/`, and pets added through the admin page use a placeholder image.

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

### Seed the database (run once)
```bash
node seed.js
```
This creates `backend/cloudpaw.db` and loads the sample pets from `data/pets.json`. Run it only once: running it again adds duplicate pets.

### Create an admin account
```bash
node create-admin.js you@example.com "Your Name"
```
You'll be asked for a password (at least 8 characters). Admins can use the Add Pet and Applications pages. Running it again for the same email resets that account's password.

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
