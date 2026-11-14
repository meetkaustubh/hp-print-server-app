#!/usr/bin/env node
'use strict';
// Operator tools, run over ssh:  node src/cli.js reset-admin
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./db');
const { Settings } = require('./settings');
const { Auth } = require('./auth');

const cmd = process.argv[2];
fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
const db = openDb(config.DATA_DIR); const settings = new Settings(db); const auth = new Auth(settings);
if (cmd === 'reset-admin') {
  settings.setInternal('admin_password_hash', '');
  fs.rmSync(path.join(config.DATA_DIR, 'setup-code.txt'), { force: true });
  console.log('Admin password cleared. New setup code:', auth.ensureSetupCode());
  console.log('Restart the service, then open /admin and use this code to choose a new password.');
} else if (cmd === 'init') {
  const code = auth.ensureSetupCode();
  auth.publishModuleNumber();
  console.log(code ? `Setup code: ${code}` : 'Already set up.');
} else {
  console.log('Usage: node src/cli.js <init|reset-admin>');
}
