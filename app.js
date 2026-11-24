import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPEN_MINUTES = 10 * 60;
const CLOSE_MINUTES = 20 * 60;
const LAST_START_MINUTES = 19 * 60 + 30;
const SLOT_INTERVAL = 30;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SPECIALISTS = ['Reeta', 'Gurpreet', 'Simran', 'Anjali', 'Pooja'];

const INITIAL_SERVICES = [
  ['signature-haircut', 'Signature Haircut', 'Hair', 'Wash, consultation, cut and blow-dry.', 45, 600],
  ['blow-dry-and-styling', 'Blow-dry and Styling', 'Hair', 'Smooth, voluminous or curled finish.', 30, 400],
  ['hair-spa', 'Hair Spa', 'Hair', 'Deep conditioning with scalp massage.', 60, 1200],
  ['keratin-smoothing', 'Keratin Smoothing', 'Hair', 'Frizz-free shine that lasts for months.', 150, 5000],
  ['gentlemens-classic-cut', 'Gentleman’s Classic Cut', 'Gentlemen', 'Scissor cut, side part or taper, wash and finish.', 30, 300],
  ['hot-towel-shave-and-beard-sculpt', 'Hot Towel Shave & Beard Sculpt', 'Gentlemen', 'Warm towel, straight-edge shave and beard shaping.', 30, 400],
  ['mens-facial', 'Men’s Facial', 'Gentlemen', 'Deep cleanse, scrub and calming mask.', 45, 1000],
  ['global-colour', 'Global Colour', 'Colour', 'All-over colour with ammonia-free options.', 90, 3000],
  ['highlights', 'Highlights', 'Colour', 'Hand-painted dimension and tone.', 120, 4500],
  ['classic-manicure', 'Classic Manicure', 'Nails', 'Shape, cuticle care and polish.', 40, 500],
  ['gel-nail-art', 'Gel Nail Art', 'Nails', 'Gel finish with custom nail art.', 75, 1200],
  ['womens-facial', 'Women’s Facial', 'Skin', 'Cleanse, exfoliate, mask and glow.', 60, 1500],
  ['de-tan-cleanup', 'De-tan Cleanup', 'Skin', 'A brightening cleanup for fresh skin.', 45, 900],
  ['kids-haircut', 'Kids’ Haircut', 'Kids', 'Gentle cut for children under 12.', 25, 250],
  ['full-arm-waxing', 'Full-arm Waxing', 'Waxing', 'Smooth finish with gentle wax.', 30, 400],
  ['threading', 'Threading', 'Threading', 'Eyebrows, upper lip or forehead.', 15, 80],
  ['bridal-makeup', 'Bridal Makeup', 'Bridal', 'Full bridal look with a trial consult.', 150, 15000],
  ['party-makeup', 'Party Makeup', 'Bridal', 'Soft glam for any occasion.', 60, 3000]
];

export function initializeDatabase(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      duration INTEGER NOT NULL CHECK(duration > 0),
      price INTEGER NOT NULL CHECK(price >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS appointments (
      booking_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      specialist_name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      total_duration INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK(status IN ('confirmed', 'completed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS appointments_date_status
      ON appointments(date, status);
    CREATE TABLE IF NOT EXISTS appointment_services (
      booking_id TEXT NOT NULL REFERENCES appointments(booking_id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      PRIMARY KEY (booking_id, position)
    );
  `);

  const serviceCount = db.prepare('SELECT COUNT(*) AS count FROM services').get().count;
  if (serviceCount === 0) {
    const insert = db.prepare(`
      INSERT INTO services (slug, name, category, description, duration, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const service of INITIAL_SERVICES) insert.run(...service);
    })();
  }
}

function respondError(res, status, detail) {
  return res.status(status).json({ detail });
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function todayInKapurthala() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts();
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function minutesFromTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function slugify(value) {
  return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function listServices(db) {
  return db.prepare(`
    SELECT slug, name, category, description, duration, price
    FROM services WHERE active = 1 ORDER BY rowid
  `).all();
}

function appointmentWithServices(db, appointment) {
  if (!appointment) return null;
  const services = db.prepare(`
    SELECT name, price, duration FROM appointment_services
    WHERE booking_id = ? ORDER BY position
  `).all(appointment.booking_id);
  return {
    booking_id: appointment.booking_id,
    name: appointment.name,
    phone: appointment.phone,
    date: appointment.date,
    time: appointment.time,
    specialist_name: appointment.specialist_name,
    total_duration: appointment.total_duration,
    total_price: appointment.total_price,
    status: appointment.status,
    services
  };
}

function hasConflict(db, date, specialist, start, duration) {
  const bookings = db.prepare(`
    SELECT time, total_duration FROM appointments
    WHERE date = ? AND specialist_name = ? AND status = 'confirmed'
  `).all(date, specialist);
  return bookings.some(booking => {
    const existingStart = minutesFromTime(booking.time);
    return existingStart < start + duration && existingStart + booking.total_duration > start;
  });
}

function availableSpecialists(db, date, start, duration) {
  return SPECIALISTS.filter(name => !hasConflict(db, date, name, start, duration));
}

export function createApp({ db, staffPasscode = '', staticRoot = ROOT }) {
  initializeDatabase(db);

  const app = express();
  const sessions = new Map();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { detail: 'Too many login attempts. Try again in 15 minutes.' }
  });

  function requireStaff(req, res, next) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get('authorization') || '');
    const expiresAt = match ? sessions.get(match[1]) : undefined;
    if (!expiresAt || expiresAt <= Date.now()) {
      if (match) sessions.delete(match[1]);
      return respondError(res, 401, 'Staff login required.');
    }
    return next();
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/services', (_req, res) => res.json(listServices(db)));

  app.get('/api/availability', (req, res) => {
    const { date, specialist_id: specialist = 'any' } = req.query;
    const duration = Number(req.query.duration);
    if (!validDate(date) || date < todayInKapurthala()) {
      return respondError(res, 400, 'Choose a valid date that is not in the past.');
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      return respondError(res, 400, 'Duration must be between 1 and 600 minutes.');
    }
    if (specialist !== 'any' && !SPECIALISTS.includes(specialist)) {
      return respondError(res, 400, 'Choose a valid specialist.');
    }

    const slots = [];
    for (let start = OPEN_MINUTES; start <= LAST_START_MINUTES; start += SLOT_INTERVAL) {
      const candidates = specialist === 'any' ? SPECIALISTS : [specialist];
      const available = start + duration <= CLOSE_MINUTES
        && candidates.some(name => !hasConflict(db, date, name, start, duration));
      slots.push({
        time: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
        available
      });
    }
    return res.json({ slots });
  });

  app.post('/api/appointments', (req, res) => {
    const body = req.body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const { date, time, specialist_id: specialist = 'any' } = body;

    if (name.length < 2 || name.length > 80) return respondError(res, 400, 'Name must be between 2 and 80 characters.');
    if (!/^\d{10}$/.test(phone)) return respondError(res, 400, 'Enter a valid 10-digit phone number.');
    if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return respondError(res, 400, 'Enter a valid email address.');
    }
    if (notes.length > 500) return respondError(res, 400, 'Notes must be 500 characters or fewer.');
    if (!validDate(date) || date < todayInKapurthala()) return respondError(res, 400, 'Choose a valid date that is not in the past.');

    const start = typeof time === 'string' ? minutesFromTime(time) : null;
    if (start === null || start < OPEN_MINUTES || start > LAST_START_MINUTES || start % SLOT_INTERVAL !== 0) {
      return respondError(res, 400, 'Choose an available appointment time.');
    }
    if (specialist !== 'any' && !SPECIALISTS.includes(specialist)) return respondError(res, 400, 'Choose a valid specialist.');

    const serviceIds = body.service_ids;
    if (!Array.isArray(serviceIds) || serviceIds.length < 1 || serviceIds.length > 10
      || serviceIds.some(id => typeof id !== 'string') || new Set(serviceIds).size !== serviceIds.length) {
      return respondError(res, 400, 'Choose between 1 and 10 valid services.');
    }
    const placeholders = serviceIds.map(() => '?').join(',');
    const servicesById = new Map(db.prepare(`
      SELECT slug, name, price, duration FROM services
      WHERE active = 1 AND slug IN (${placeholders})
    `).all(...serviceIds).map(service => [service.slug, service]));
    if (servicesById.size !== serviceIds.length) return respondError(res, 400, 'One or more selected services are unavailable.');

    const services = serviceIds.map(id => servicesById.get(id));
    const totalDuration = services.reduce((total, service) => total + service.duration, 0);
    const totalPrice = services.reduce((total, service) => total + service.price, 0);
    if (start + totalDuration > CLOSE_MINUTES) return respondError(res, 400, 'The selected services do not fit before closing time.');

    const createBooking = db.transaction(() => {
      const candidates = specialist === 'any'
        ? availableSpecialists(db, date, start, totalDuration)
        : availableSpecialists(db, date, start, totalDuration).filter(name => name === specialist);
      if (!candidates.length) return null;

      const assignedSpecialist = candidates[randomInt(candidates.length)];
      const bookingId = `CB${randomBytes(8).toString('hex').toUpperCase()}`;
      db.prepare(`
        INSERT INTO appointments
          (booking_id, name, phone, email, date, time, specialist_name, notes, total_duration, total_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(bookingId, name, phone, email, date, time, assignedSpecialist, notes, totalDuration, totalPrice);
      const insertService = db.prepare(`
        INSERT INTO appointment_services (booking_id, position, name, price, duration)
        VALUES (?, ?, ?, ?, ?)
      `);
      services.forEach((service, position) => {
        insertService.run(bookingId, position, service.name, service.price, service.duration);
      });
      return bookingId;
    }).immediate();

    if (!createBooking) return respondError(res, 409, 'That time was just booked. Choose another available time.');
    const appointment = appointmentWithServices(db, db.prepare(`
      SELECT booking_id, name, phone, email, date, time, specialist_name, notes,
        total_duration, total_price, status FROM appointments WHERE booking_id = ?
    `).get(createBooking));
    return res.status(201).json(appointment);
  });

  app.get('/api/appointments/lookup/:query', (req, res) => {
    const query = req.params.query.trim();
    const normalizedPhone = query.replace(/\D/g, '');
    let rows;
    if (/^CB[0-9A-F]{16}$/i.test(query)) {
      rows = db.prepare(`
        SELECT booking_id, name, phone, email, date, time, specialist_name, notes,
          total_duration, total_price, status
        FROM appointments WHERE booking_id = ?
      `).all(query.toUpperCase());
    } else if (/^\d{10}$/.test(normalizedPhone)) {
      rows = db.prepare(`
        SELECT booking_id, name, phone, email, date, time, specialist_name, notes,
          total_duration, total_price, status
        FROM appointments WHERE phone = ? ORDER BY date, time
      `).all(normalizedPhone);
    } else {
      return respondError(res, 400, 'Enter a valid 10-digit phone number or booking ID.');
    }
    return res.json(rows.map(row => appointmentWithServices(db, row)));
  });

  app.delete('/api/appointments/:bookingId', (req, res) => {
    const bookingId = req.params.bookingId.toUpperCase();
    if (!/^CB[0-9A-F]{16}$/.test(bookingId)) return respondError(res, 400, 'Invalid booking ID.');
    const result = db.prepare(`
      UPDATE appointments SET status = 'cancelled'
      WHERE booking_id = ? AND status = 'confirmed'
    `).run(bookingId);
    if (!result.changes) return respondError(res, 404, 'Confirmed appointment not found.');
    return res.json({ ok: true });
  });

  app.post('/api/staff/login', loginLimiter, (req, res) => {
    if (!staffPasscode) return respondError(res, 503, 'Staff login is not configured on this server.');
    const passcode = typeof req.body.passcode === 'string' ? req.body.passcode : '';
    const expected = createHash('sha256').update(staffPasscode).digest();
    const supplied = createHash('sha256').update(passcode).digest();
    if (!timingSafeEqual(expected, supplied)) return respondError(res, 401, 'Invalid staff passcode.');

    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= Date.now()) sessions.delete(token);
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return res.json({ token });
  });

  app.post('/api/staff/logout', requireStaff, (req, res) => {
    const token = req.get('authorization').slice('Bearer '.length);
    sessions.delete(token);
    return res.json({ ok: true });
  });

  app.get('/api/staff/appointments', requireStaff, (_req, res) => {
    const rows = db.prepare(`
      SELECT booking_id, name, phone, email, date, time, specialist_name, notes,
        total_duration, total_price, status
      FROM appointments ORDER BY date, time
    `).all();
    return res.json(rows.map(row => appointmentWithServices(db, row)));
  });

  app.patch('/api/staff/appointments/:bookingId', requireStaff, (req, res) => {
    const status = req.body.status;
    if (!['confirmed', 'completed', 'cancelled'].includes(status)) {
      return respondError(res, 400, 'Choose a valid appointment status.');
    }
    const result = db.prepare('UPDATE appointments SET status = ? WHERE booking_id = ?')
      .run(status, req.params.bookingId.toUpperCase());
    if (!result.changes) return respondError(res, 404, 'Appointment not found.');
    return res.json({ ok: true });
  });

  app.post('/api/staff/services', requireStaff, (req, res) => {
    const { name, category, description } = req.body;
    const duration = Number(req.body.duration);
    const price = Number(req.body.price);
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
      return respondError(res, 400, 'Service name must be between 2 and 80 characters.');
    }
    if (typeof category !== 'string' || category.trim().length < 2 || category.trim().length > 40) {
      return respondError(res, 400, 'Category must be between 2 and 40 characters.');
    }
    if (!Number.isInteger(duration) || duration < 5 || duration > 600) {
      return respondError(res, 400, 'Duration must be between 5 and 600 minutes.');
    }
    if (!Number.isSafeInteger(price) || price < 0 || price > 10000000) {
      return respondError(res, 400, 'Price must be a non-negative whole number.');
    }
    if (typeof description !== 'undefined' && (typeof description !== 'string' || description.length > 300)) {
      return respondError(res, 400, 'Description must be 300 characters or fewer.');
    }

    const baseSlug = slugify(name.trim());
    if (!baseSlug) return respondError(res, 400, 'Service name must contain letters or numbers.');
    let slug = baseSlug;
    let suffix = 2;
    while (db.prepare('SELECT 1 FROM services WHERE slug = ?').get(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const service = {
      slug,
      name: name.trim(),
      category: category.trim(),
      description: (description || '').trim() || 'Signature salon service.',
      duration,
      price
    };
    db.prepare(`
      INSERT INTO services (slug, name, category, description, duration, price)
      VALUES (@slug, @name, @category, @description, @duration, @price)
    `).run(service);
    return res.status(201).json(service);
  });

  app.use('/api', (_req, res) => respondError(res, 404, 'API route not found.'));
  app.get('/', (_req, res) => res.sendFile(path.join(staticRoot, 'index.html')));
  app.get('/index.html', (_req, res) => res.sendFile(path.join(staticRoot, 'index.html')));
  app.use('/images', express.static(path.join(staticRoot, 'images'), { fallthrough: false, index: false }));
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.status && err.status < 500) return respondError(res, err.status, err.message);
    console.error('Request failed:', err);
    return respondError(res, 500, 'An unexpected server error occurred.');
  });

  return app;
}
