# Clarté Beauté

The site uses an Express API with SQLite for local development and PostgreSQL when `DATABASE_URL` is set.

## Run locally

1. Install Node.js 22.
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

## Free-tier deployment (Neon + Render)

1. Create a free Neon Postgres project and copy its pooled connection string.
2. In Render, create a Blueprint from this repository and use `render.yaml`.
3. Set the requested `DATABASE_URL` to the Neon connection string and `STAFF_PASSCODE` to a private value of at least 12 characters. Do not use the local `0112` passcode in production.
4. After the deploy completes, use the public `onrender.com` URL for booking and the staff dashboard on every device.

Neon's free plan currently includes 1 GB per project and scales compute to zero after inactivity. Render's free web service can sleep after 15 minutes and may take about a minute to wake. Free tiers have limits and are not recommended for critical production booking operations.

For local development only, a four-digit passcode can be enabled by setting `NODE_ENV=development` and `ALLOW_SHORT_STAFF_PASSCODE=true`. The server still requires at least 12 characters in production or when this opt-in is unset.
