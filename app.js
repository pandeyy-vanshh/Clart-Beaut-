import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

function hasConflict(bookings, specialist, start, duration) {
  return bookings.some(booking => {
    if (booking.specialist_name !== specialist) return false;
    const existingStart = minutesFromTime(booking.time);
    return existingStart < start + duration && existingStart + booking.total_duration > start;
  });
}

export function createApp({ store, staffPasscode = '', staticRoot = ROOT }) {
  const app = express();
  const sessions = new Map();
  const liveServerOrigins = new Set([
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin || !liveServerOrigins.has(origin)) return next();

    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.vary('Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
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

  app.get('/api/services', async (_req, res) => res.json(await store.listServices()));

  app.get('/api/availability', async (req, res) => {
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

    const candidates = specialist === 'any' ? SPECIALISTS : [specialist];
    const bookings = await store.getConfirmedBookings(date, candidates);
    const slots = [];
    for (let start = OPEN_MINUTES; start <= LAST_START_MINUTES; start += SLOT_INTERVAL) {
      const available = start + duration <= CLOSE_MINUTES
        && candidates.some(name => !hasConflict(bookings, name, start, duration));
      slots.push({
        time: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
        available
      });
    }
    return res.json({ slots });
  });

  app.post('/api/appointments', async (req, res) => {
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
    const serviceRows = await store.getActiveServices(serviceIds);
    const servicesById = new Map(serviceRows.map(service => [service.slug, service]));
    if (servicesById.size !== serviceIds.length) return respondError(res, 400, 'One or more selected services are unavailable.');

    const services = serviceIds.map(id => servicesById.get(id));
    const totalDuration = services.reduce((total, service) => total + service.duration, 0);
    const totalPrice = services.reduce((total, service) => total + service.price, 0);
    if (start + totalDuration > CLOSE_MINUTES) return respondError(res, 400, 'The selected services do not fit before closing time.');

    const createBooking = await store.createBooking({
      name, phone, email, date, time, specialist, notes, start, totalDuration, totalPrice, services
    });

    if (!createBooking) return respondError(res, 409, 'That time was just booked. Choose another available time.');
    const appointment = await store.getAppointmentById(createBooking);
    return res.status(201).json(appointment);
  });

  app.get('/api/appointments/lookup/:query', async (req, res) => {
    const query = req.params.query.trim();
    const normalizedPhone = query.replace(/\D/g, '');
    let rows;
    if (/^CB[0-9A-F]{16}$/i.test(query)) {
      rows = await store.getAppointmentsByBookingId(query.toUpperCase());
    } else if (/^\d{10}$/.test(normalizedPhone)) {
      rows = await store.getAppointmentsByPhone(normalizedPhone);
    } else {
      return respondError(res, 400, 'Enter a valid 10-digit phone number or booking ID.');
    }
    return res.json(rows);
  });

  app.delete('/api/appointments/:bookingId', async (req, res) => {
    const bookingId = req.params.bookingId.toUpperCase();
    if (!/^CB[0-9A-F]{16}$/.test(bookingId)) return respondError(res, 400, 'Invalid booking ID.');
    if (!await store.cancelAppointment(bookingId)) {
      return respondError(res, 404, 'Confirmed appointment not found.');
    }
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

  app.get('/api/staff/appointments', requireStaff, async (_req, res) => {
    return res.json(await store.listStaffAppointments());
  });

  app.patch('/api/staff/appointments/:bookingId', requireStaff, async (req, res) => {
    const status = req.body.status;
    if (!['confirmed', 'completed', 'cancelled'].includes(status)) {
      return respondError(res, 400, 'Choose a valid appointment status.');
    }
    const updated = await store.updateAppointmentStatus(status, req.params.bookingId.toUpperCase());
    if (!updated) return respondError(res, 404, 'Appointment not found.');
    return res.json({ ok: true });
  });

  app.post('/api/staff/services', requireStaff, async (req, res) => {
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
    const service = {
      name: name.trim(),
      category: category.trim(),
      description: (description || '').trim() || 'Signature salon service.',
      duration,
      price
    };
    return res.status(201).json(await store.createService(service, baseSlug));
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
