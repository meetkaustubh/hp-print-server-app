'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Runtime (non-user-editable) config comes from the environment.
// Everything the operator edits day-to-day lives in the admin panel (settings table).
module.exports = {
  ROOT,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  // windows (laptop build) | cups (Pi / Linux / macOS) | dryrun (no printer; files are copied to DATA_DIR/printed)
  PRINT_BACKEND: process.env.PRINT_BACKEND || (process.platform === 'win32' ? 'windows' : 'cups'),
  // Number of proxy hops to trust for client IP (0 = none, 'loopback' for cloudflared on same box)
  TRUST_PROXY: process.env.TRUST_PROXY ?? 'loopback',
  // Optional secret overrides (win over values saved in the admin panel)
  ENV_RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  ENV_RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  ENV_RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  // Hard limits that settings can't exceed (protects the 512 MB Pi Zero 2 W)
  HARD_MAX_FILE_MB: 50,
  HARD_MAX_PAGES: 500,
  // 'pi' (set by the systemd unit) or 'laptop'; only changes help text
  EDITION: process.env.PRINTNIMBUS_EDITION || 'laptop',
  SETUP_CODE_COPY_PATH: process.env.SETUP_CODE_COPY_PATH || '',
};
