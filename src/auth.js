'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const SESSION_TTL = 12 * 3600_000;
const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

class Auth {
  constructor(settings) {
    this.settings = settings;
    this.sessions = new Map();
    this.codeFile = path.join(config.DATA_DIR, 'setup-code.txt');
  }
  get needsSetup() { return !this.settings.get('admin_password_hash'); }

  /** First-boot claim code: whoever can read the device (SD card / ssh) can claim the admin account. */
  ensureSetupCode() {
    if (!this.needsSetup) return null;
    if (fs.existsSync(this.codeFile)) return fs.readFileSync(this.codeFile, 'utf8').trim();
    const code = Array.from(crypto.randomBytes(8), b => SETUP_ALPHABET[b % SETUP_ALPHABET.length]).join('');
    fs.writeFileSync(this.codeFile, code + '\n', { mode: 0o600 });
    if (config.SETUP_CODE_COPY_PATH) { try { fs.writeFileSync(config.SETUP_CODE_COPY_PATH, `Print Nimbus setup code: ${code}\n`); } catch {} }
    return code;
  }
  setup(code, password) {
    if (!this.needsSetup) return { ok: false, error: 'Already set up' };
    const expected = this.ensureSetupCode();
    const a = Buffer.from(String(code || '').trim().toUpperCase()), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'Wrong setup code' };
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return { ok: false, error: 'Password must be at least 10 characters' };
    this.settings.setInternal('admin_password_hash', hashPassword(password));
    fs.rmSync(this.codeFile, { force: true });
    if (config.SETUP_CODE_COPY_PATH) fs.rmSync(config.SETUP_CODE_COPY_PATH, { force: true });
    return { ok: true };
  }
  login(password) {
    if (this.needsSetup || typeof password !== 'string' || !verifyPassword(password, this.settings.get('admin_password_hash'))) return null;
    return this.newSession();
  }
  changePassword(current, next) {
    if (!verifyPassword(String(current), this.settings.get('admin_password_hash'))) return { ok: false, error: 'Current password is wrong' };
    if (typeof next !== 'string' || next.length < 10 || next.length > 200) return { ok: false, error: 'New password must be at least 10 characters' };
    this.settings.setInternal('admin_password_hash', hashPassword(next));
    this.sessions.clear();
    return { ok: true };
  }
  newSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + SESSION_TTL);
    return token;
  }
  valid(token) {
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }
  destroy(token) { this.sessions.delete(token); }

  /** Express middleware for /api/admin/* (except login/setup/session). */
  middleware() {
    return (req, res, next) => {
      const token = parseCookie(req.headers.cookie, 'pn_admin');
      if (!token || !this.valid(token)) return res.status(401).json({ error: 'Please sign in' });
      // CSRF defence in depth on top of SameSite=Strict: state-changing calls must carry a custom header
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'printnimbus') return res.status(403).json({ error: 'Bad request origin' });
      req.adminToken = token;
      next();
    };
  }
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

module.exports = { Auth, parseCookie, hashPassword, verifyPassword };
