import { mkdirSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { createPostgresStore, createSqliteStore } from './database.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const staffPasscode = process.env.STAFF_PASSCODE || '';
const allowsLocalShortPasscode = process.env.NODE_ENV === 'development'
  && process.env.ALLOW_SHORT_STAFF_PASSCODE === 'true'
  && /^\d{4}$/.test(staffPasscode);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}
if (staffPasscode.length < 12 && !allowsLocalShortPasscode) {
  throw new Error('Set STAFF_PASSCODE in .env to a private value of at least 12 characters.');
}

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to a persistent PostgreSQL database in production.');
}

let sqliteDb;
let postgresPool;
let store;
if (process.env.DATABASE_URL) {
  postgresPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });
  store = createPostgresStore(postgresPool);
  await store.initialize();
} else {
  const databasePath = path.resolve(process.env.DATABASE_PATH || './data/clarte-beaute.sqlite');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  sqliteDb = new Database(databasePath);
  store = createSqliteStore(sqliteDb);
}

const app = createApp({ store, staffPasscode });
const server = app.listen(port, () => {
  console.log(`Clarté Beauté backend listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(async () => {
    sqliteDb?.close();
    await postgresPool?.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
