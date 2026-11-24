import { randomBytes, randomInt } from 'node:crypto';

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

const APPOINTMENT_COLUMNS = `
  booking_id, name, phone, email, date, time, specialist_name, notes,
  total_duration, total_price, status
`;

function hasConflict(bookings, specialist, start, duration) {
  return bookings.some(booking => {
    if (booking.specialist_name !== specialist || booking.status !== 'confirmed') return false;
    const existingStart = Number(booking.time.slice(0, 2)) * 60 + Number(booking.time.slice(3));
    return existingStart < start + duration && existingStart + booking.total_duration > start;
  });
}

function toAppointment(appointment, services) {
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

function createBookingId() {
  return `CB${randomBytes(8).toString('hex').toUpperCase()}`;
}

function selectAvailableSpecialist(bookings, candidates, start, duration) {
  const available = candidates.filter(name => !hasConflict(bookings, name, start, duration));
  return available.length ? available[randomInt(available.length)] : null;
}

function initializeSqlite(db) {
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

  if (db.prepare('SELECT COUNT(*) AS count FROM services').get().count === 0) {
    const insert = db.prepare(`
      INSERT INTO services (slug, name, category, description, duration, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const service of INITIAL_SERVICES) insert.run(...service);
    })();
  }
}

export function createSqliteStore(db) {
  initializeSqlite(db);

  function getConfirmedBookings(date, specialists) {
    const placeholders = specialists.map(() => '?').join(',');
    return db.prepare(`
      SELECT specialist_name, time, total_duration, status FROM appointments
      WHERE date = ? AND specialist_name IN (${placeholders}) AND status = 'confirmed'
    `).all(date, ...specialists);
  }

  function appointmentWithServices(appointment) {
    if (!appointment) return null;
    const services = db.prepare(`
      SELECT name, price, duration FROM appointment_services
      WHERE booking_id = ? ORDER BY position
    `).all(appointment.booking_id);
    return toAppointment(appointment, services);
  }

  return {
    listServices() {
      return db.prepare(`
        SELECT slug, name, category, description, duration, price
        FROM services WHERE active = 1 ORDER BY slug
      `).all();
    },
    getConfirmedBookings,
    getActiveServices(serviceIds) {
      const placeholders = serviceIds.map(() => '?').join(',');
      return db.prepare(`
        SELECT slug, name, price, duration FROM services
        WHERE active = 1 AND slug IN (${placeholders})
      `).all(...serviceIds);
    },
    createBooking({ name, phone, email, date, time, specialist, notes, start, totalDuration, totalPrice, services }) {
      return db.transaction(() => {
        const candidates = specialist === 'any' ? SPECIALISTS : [specialist];
        const bookings = getConfirmedBookings(date, candidates);
        const assignedSpecialist = selectAvailableSpecialist(bookings, candidates, start, totalDuration);
        if (!assignedSpecialist) return null;

        const bookingId = createBookingId();
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
    },
    getAppointmentById(bookingId) {
      const appointment = db.prepare(`SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE booking_id = ?`)
        .get(bookingId);
      return appointmentWithServices(appointment);
    },
    getAppointmentsByBookingId(bookingId) {
      const appointments = db.prepare(`SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE booking_id = ?`)
        .all(bookingId);
      return appointments.map(appointmentWithServices);
    },
    getAppointmentsByPhone(phone) {
      const appointments = db.prepare(`
        SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE phone = ? ORDER BY date, time
      `).all(phone);
      return appointments.map(appointmentWithServices);
    },
    cancelAppointment(bookingId) {
      return db.prepare(`
        UPDATE appointments SET status = 'cancelled'
        WHERE booking_id = ? AND status = 'confirmed'
      `).run(bookingId).changes;
    },
    listStaffAppointments() {
      const appointments = db.prepare(`
        SELECT ${APPOINTMENT_COLUMNS} FROM appointments ORDER BY date, time
      `).all();
      return appointments.map(appointmentWithServices);
    },
    updateAppointmentStatus(status, bookingId) {
      return db.prepare('UPDATE appointments SET status = ? WHERE booking_id = ?')
        .run(status, bookingId).changes;
    },
    createService(service, baseSlug) {
      let slug = baseSlug;
      let suffix = 2;
      while (db.prepare('SELECT 1 FROM services WHERE slug = ?').get(slug)) {
        slug = `${baseSlug}-${suffix++}`;
      }
      db.prepare(`
        INSERT INTO services (slug, name, category, description, duration, price)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(slug, service.name, service.category, service.description, service.duration, service.price);
      return { ...service, slug };
    }
  };
}

export function createPostgresStore(pool) {
  async function getConfirmedBookings(date, specialists, client = pool) {
    const result = await client.query(`
      SELECT specialist_name, time, total_duration, status FROM appointments
      WHERE date = $1 AND specialist_name = ANY($2::text[]) AND status = 'confirmed'
    `, [date, specialists]);
    return result.rows;
  }

  async function appointmentWithServices(appointment) {
    if (!appointment) return null;
    const result = await pool.query(`
      SELECT name, price, duration FROM appointment_services
      WHERE booking_id = $1 ORDER BY position
    `, [appointment.booking_id]);
    return toAppointment(appointment, result.rows);
  }

  return {
    async initialize() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS services (
          slug TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          duration INTEGER NOT NULL CHECK(duration > 0),
          price INTEGER NOT NULL CHECK(price >= 0),
          active SMALLINT NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
        )
      `);
      await pool.query(`
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS appointments_date_status
        ON appointments(date, status)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS appointment_services (
          booking_id TEXT NOT NULL REFERENCES appointments(booking_id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          price INTEGER NOT NULL,
          duration INTEGER NOT NULL,
          PRIMARY KEY (booking_id, position)
        )
      `);
      const count = Number((await pool.query('SELECT COUNT(*) AS count FROM services')).rows[0].count);
      if (count === 0) {
        const values = INITIAL_SERVICES.flat();
        const rows = INITIAL_SERVICES.map((_, row) => {
          const first = row * 6 + 1;
          return `(${Array.from({ length: 6 }, (_value, column) => `$${first + column}`).join(', ')})`;
        });
        await pool.query(`
          INSERT INTO services (slug, name, category, description, duration, price)
          VALUES ${rows.join(', ')}
          ON CONFLICT (slug) DO NOTHING
        `, values);
      }
    },
    async listServices() {
      const result = await pool.query(`
        SELECT slug, name, category, description, duration, price
        FROM services WHERE active = 1 ORDER BY slug
      `);
      return result.rows;
    },
    getConfirmedBookings,
    async getActiveServices(serviceIds) {
      const placeholders = serviceIds.map((_id, index) => `$${index + 1}`).join(', ');
      const result = await pool.query(`
        SELECT slug, name, price, duration FROM services
        WHERE active = 1 AND slug IN (${placeholders})
      `, serviceIds);
      return result.rows;
    },
    async createBooking({ name, phone, email, date, time, specialist, notes, start, totalDuration, totalPrice, services }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const candidates = specialist === 'any' ? SPECIALISTS : [specialist];
        for (const candidate of candidates) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
            [date, candidate]
          );
        }
        const bookings = await getConfirmedBookings(date, candidates, client);
        const assignedSpecialist = selectAvailableSpecialist(bookings, candidates, start, totalDuration);
        if (!assignedSpecialist) {
          await client.query('ROLLBACK');
          return null;
        }

        const bookingId = createBookingId();
        await client.query(`
          INSERT INTO appointments
            (booking_id, name, phone, email, date, time, specialist_name, notes, total_duration, total_price)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [bookingId, name, phone, email, date, time, assignedSpecialist, notes, totalDuration, totalPrice]);
        for (const [position, service] of services.entries()) {
          await client.query(`
            INSERT INTO appointment_services (booking_id, position, name, price, duration)
            VALUES ($1, $2, $3, $4, $5)
          `, [bookingId, position, service.name, service.price, service.duration]);
        }
        await client.query('COMMIT');
        return bookingId;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async getAppointmentById(bookingId) {
      const result = await pool.query(`SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE booking_id = $1`, [bookingId]);
      return appointmentWithServices(result.rows[0]);
    },
    async getAppointmentsByBookingId(bookingId) {
      const result = await pool.query(`SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE booking_id = $1`, [bookingId]);
      return Promise.all(result.rows.map(appointmentWithServices));
    },
    async getAppointmentsByPhone(phone) {
      const result = await pool.query(`
        SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE phone = $1 ORDER BY date, time
      `, [phone]);
      return Promise.all(result.rows.map(appointmentWithServices));
    },
    async cancelAppointment(bookingId) {
      const result = await pool.query(`
        UPDATE appointments SET status = 'cancelled'
        WHERE booking_id = $1 AND status = 'confirmed'
      `, [bookingId]);
      return result.rowCount;
    },
    async listStaffAppointments() {
      const result = await pool.query(`
        SELECT ${APPOINTMENT_COLUMNS} FROM appointments ORDER BY date, time
      `);
      return Promise.all(result.rows.map(appointmentWithServices));
    },
    async updateAppointmentStatus(status, bookingId) {
      const result = await pool.query('UPDATE appointments SET status = $1 WHERE booking_id = $2', [status, bookingId]);
      return result.rowCount;
    },
    async createService(service, baseSlug) {
      for (let suffix = 1; suffix < 1000; suffix += 1) {
        const slug = suffix === 1 ? baseSlug : `${baseSlug.slice(0, 48 - String(suffix).length - 1)}-${suffix}`;
        const result = await pool.query(`
          INSERT INTO services (slug, name, category, description, duration, price)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (slug) DO NOTHING
          RETURNING slug
        `, [slug, service.name, service.category, service.description, service.duration, service.price]);
        if (result.rowCount) return { ...service, slug };
      }
      throw new Error('Unable to generate a unique service slug.');
    }
  };
}
