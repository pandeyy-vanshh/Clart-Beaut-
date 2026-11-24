import { mkdirSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { createApp } from './app.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const staffPasscode = process.env.STAFF_PASSCODE || '';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}
if (staffPasscode.length < 12) {
  throw new Error('Set STAFF_PASSCODE in .env to a private value of at least 12 characters.');
}

const databasePath = path.resolve(process.env.DATABASE_PATH || './data/clarte-beaute.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
const app = createApp({ db, staffPasscode });
const server = app.listen(port, () => {
  console.log(`Clarté Beauté backend listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
