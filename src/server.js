'use strict';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Print Nimbus needs Node.js 22.13 or newer (you have ${process.version}). Download the LTS version from https://nodejs.org`);
  process.exit(1);
}
const config = require('./config');
const { build } = require('./bootstrap');

const { app, jobs, auth, db, settings } = build();
const code = auth.ensureSetupCode();
jobs.start();

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`Print Nimbus listening on http://${config.HOST}:${config.PORT}  (printer backend: ${config.PRINT_BACKEND})`);
  if (code) console.log(`\n  First-time setup: open /admin and enter this setup code: ${code}\n  (also saved in ${config.DATA_DIR}/setup-code.txt)\n`);
});
server.requestTimeout = 120_000; server.headersTimeout = 20_000; server.keepAliveTimeout = 10_000;

function shutdown() {
  console.log('Shutting down...');
  jobs.stop();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
