'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./db');
const { Settings } = require('./settings');
const { JobService } = require('./jobs');
const { Auth } = require('./auth');
const createPrinter = require('./printer');
const { createApp } = require('./app');

function build({ fetchImpl, printer } = {}) {
  for (const d of ['jobs', 'tmp']) fs.mkdirSync(path.join(config.DATA_DIR, d), { recursive: true, mode: 0o700 });
  const db = openDb(config.DATA_DIR);
  const settings = new Settings(db);
  const pr = printer || createPrinter();
  const jobs = new JobService({ db, settings, printer: pr, fetchImpl });
  const auth = new Auth(settings);
  const app = createApp({ settings, printer: pr, jobs, auth });
  return { app, db, settings, jobs, auth, printer: pr };
}
module.exports = { build };
