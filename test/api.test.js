import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../app.js';
import { createPostgresStore, createSqliteStore } from '../database.js';

const STAFF_PASSCODE = 'test-passcode-for-api';
const FUTURE_DATE = '2099-06-15';

function setup(t) {
  const db = new Database(':memory:');
  const store = createSqliteStore(db);
  const app = createApp({ store, staffPasscode: STAFF_PASSCODE });
  t.after(() => db.close());
  return request(app);
}

async function setupPostgres(t) {
  const db = new PGlite();
  const pool = {
    query: (...args) => db.query(...args),
    connect: async () => ({ query: (...args) => db.query(...args), release() {} })
  };
  const store = createPostgresStore(pool);
  await store.initialize();
  const app = createApp({ store, staffPasscode: STAFF_PASSCODE });
  t.after(() => db.close());
  return request(app);
}

test('allows requests from local VS Code Live Server only', async t => {
  const api = setup(t);
  const origin = 'http://127.0.0.1:5500';
  const preflight = await api.options('/api/staff/login')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type')
    .expect(204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.match(preflight.headers['access-control-allow-headers'], /Content-Type/i);

  const login = await api.post('/api/staff/login')
    .set('Origin', origin).send({ passcode: STAFF_PASSCODE }).expect(200);
  assert.equal(login.headers['access-control-allow-origin'], origin);

  const otherOrigin = await api.get('/api/services')
    .set('Origin', 'https://example.com').expect(200);
  assert.equal(otherOrigin.headers['access-control-allow-origin'], undefined);
});

test('services are seeded and availability prevents specialist double-booking', async t => {
  const api = setup(t);
  const services = await api.get('/api/services').expect(200);
  assert.equal(services.body.length, 18);

  const service = services.body.find(item => item.slug === 'signature-haircut');
  assert.ok(service);
  const booking = await api.post('/api/appointments').send({
    name: 'Test Client',
    phone: '9876543210',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'Reeta',
    service_ids: [service.slug]
  }).expect(201);
  assert.equal(booking.body.specialist_name, 'Reeta');
  assert.equal(booking.body.total_price, service.price);

  const availability = await api.get('/api/availability')
    .query({ date: FUTURE_DATE, specialist_id: 'Reeta', duration: 30 }).expect(200);
  assert.equal(availability.body.slots.find(slot => slot.time === '10:00').available, false);
  assert.equal(availability.body.slots.find(slot => slot.time === '11:00').available, true);

  await api.post('/api/appointments').send({
    name: 'Another Client',
    phone: '9876543211',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'Reeta',
    service_ids: [service.slug]
  }).expect(409);

  const lookup = await api.get('/api/appointments/lookup/9876543210').expect(200);
  assert.equal(lookup.body[0].booking_id, booking.body.booking_id);
  await api.delete(`/api/appointments/${booking.body.booking_id}`).expect(200);
});

test('staff routes require a token and allow service management after login', async t => {
  const api = setup(t);
  await api.get('/api/staff/appointments').expect(401);
  await api.post('/api/staff/login').send({ passcode: 'wrong-password' }).expect(401);

  const login = await api.post('/api/staff/login')
    .send({ passcode: STAFF_PASSCODE }).expect(200);
  const authorization = { Authorization: `Bearer ${login.body.token}` };

  const service = await api.post('/api/staff/services').set(authorization).send({
    name: 'Express Test Service',
    category: 'Testing',
    description: 'Created by the API test.',
    duration: 30,
    price: 500
  }).expect(201);
  assert.equal(service.body.slug, 'express-test-service');

  const services = await api.get('/api/services').expect(200);
  assert.ok(services.body.some(item => item.slug === service.body.slug));
  await api.post('/api/staff/logout').set(authorization).expect(200);
  await api.get('/api/staff/appointments').set(authorization).expect(401);
});

test('staff appointments include client and service details for live bookings', async t => {
  const api = setup(t);
  const service = (await api.get('/api/services').expect(200)).body
    .find(item => item.slug === 'signature-haircut');
  await api.post('/api/appointments').send({
    name: 'Test Client',
    phone: '9876543210',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'Reeta',
    service_ids: [service.slug]
  }).expect(201);

  const login = await api.post('/api/staff/login')
    .send({ passcode: STAFF_PASSCODE }).expect(200);
  const appointments = await api.get('/api/staff/appointments')
    .set({ Authorization: `Bearer ${login.body.token}` }).expect(200);
  assert.equal(appointments.body.length, 1);
  assert.equal(appointments.body[0].name, 'Test Client');
  assert.equal(appointments.body[0].phone, '9876543210');
  assert.deepEqual(appointments.body[0].services.map(item => item.name), [service.name]);
});

test('Postgres storage persists booking details for the staff dashboard', async t => {
  const api = await setupPostgres(t);
  const services = await api.get('/api/services').expect(200);
  assert.equal(services.body.length, 18);
  const service = services.body.find(item => item.slug === 'signature-haircut');

  const booking = await api.post('/api/appointments').send({
    name: 'Postgres Client',
    phone: '9876543210',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'Reeta',
    service_ids: [service.slug]
  }).expect(201);
  assert.equal(booking.body.services[0].name, service.name);

  const login = await api.post('/api/staff/login')
    .send({ passcode: STAFF_PASSCODE }).expect(200);
  const authorization = { Authorization: `Bearer ${login.body.token}` };
  const appointments = await api.get('/api/staff/appointments')
    .set(authorization).expect(200);
  assert.equal(appointments.body[0].name, 'Postgres Client');
  assert.deepEqual(appointments.body[0].services.map(item => item.name), [service.name]);

  const availability = await api.get('/api/availability')
    .query({ date: FUTURE_DATE, specialist_id: 'Reeta', duration: 30 }).expect(200);
  assert.equal(availability.body.slots.find(slot => slot.time === '10:00').available, false);
  await api.post('/api/appointments').send({
    name: 'Another Postgres Client',
    phone: '9876543211',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'Reeta',
    service_ids: [service.slug]
  }).expect(409);

  await api.patch(`/api/staff/appointments/${booking.body.booking_id}`)
    .set(authorization).send({ status: 'completed' }).expect(200);
  const lookup = await api.get(`/api/appointments/lookup/${booking.body.booking_id}`).expect(200);
  assert.equal(lookup.body[0].status, 'completed');

  const addedService = await api.post('/api/staff/services').set(authorization).send({
    name: 'Postgres Test Service',
    category: 'Testing',
    description: 'Created in the Postgres adapter test.',
    duration: 30,
    price: 500
  }).expect(201);
  assert.equal(addedService.body.slug, 'postgres-test-service');
});

test('booking validation rejects past dates and invalid service IDs', async t => {
  const api = setup(t);
  await api.post('/api/appointments').send({
    name: 'Test Client',
    phone: '9876543210',
    date: '2000-01-01',
    time: '10:00',
    specialist_id: 'any',
    service_ids: ['signature-haircut']
  }).expect(400);

  await api.post('/api/appointments').send({
    name: 'Test Client',
    phone: '9876543210',
    date: FUTURE_DATE,
    time: '10:00',
    specialist_id: 'any',
    service_ids: ['missing-service']
  }).expect(400);
});
