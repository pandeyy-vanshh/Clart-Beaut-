# Clarté Beauté

The site uses an Express API and SQLite database for appointment booking, availability, service management, and the staff dashboard.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `STAFF_PASSCODE` to a private value of at least 12 characters.
4. Run `npm start` and open `http://localhost:3000`.

The database is created at `data/clarte-beaute.sqlite` by default. Keep `.env` and the database file private; both are excluded from Git.

## Use with VS Code Live Server

Keep the Express backend running on port 3001 with `PORT=3001 npm start`, then open `index.html` with Live Server (usually `http://127.0.0.1:5500`). The page sends API requests to the backend on port 3001.

## API

- `GET /api/services`
- `GET /api/availability?date=YYYY-MM-DD&specialist_id=any&duration=30`
- `POST /api/appointments`
- `GET /api/appointments/lookup/:phone-or-booking-id`
- `DELETE /api/appointments/:bookingId`
- `POST /api/staff/login`
- `POST /api/staff/logout`
- `GET /api/staff/appointments` (staff token required)
- `PATCH /api/staff/appointments/:bookingId` (staff token required)
- `POST /api/staff/services` (staff token required)

For deployment, configure `STAFF_PASSCODE` as a secret and use persistent storage for the SQLite database.

For local development only, a four-digit passcode can be enabled by setting `NODE_ENV=development` and `ALLOW_SHORT_STAFF_PASSCODE=true`. The server still requires at least 12 characters in production or when this opt-in is unset.
