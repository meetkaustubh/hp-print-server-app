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

const isPi = () => config.EDITION === 'pi';
/** Pi units sign in with a module number derived from the board's serial, so it is stable across reinstalls and unique per unit. */
function serialModuleNumber() {
  try {
    const m = /^Serial\s*:\s*([0-9a-f]+)/im.exec(fs.readFileSync('/proc/cpuinfo', 'utf8'));
    if (!m) return null;
    const h = crypto.createHash('sha256').update('printnimbus:' + m[1]).digest();
    return 'PN-' + Array.from(h.subarray(0, 6), b => SETUP_ALPHABET[b % SETUP_ALPHABET.length]).join('');
  } catch { return null; }
}
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const sameId = (a, b) => { const x = Buffer.from(String(a || '').trim().toLowerCase()), y = Buffer.from(String(b || '').trim().toLowerCase()); return x.length === y.length && crypto.timingSafeEqual(x, y); };

class Auth {
  constructor(settings) {
    this.settings = settings;
    this.sessions = new Map();
    this.codeFile = path.join(config.DATA_DIR, 'setup-code.txt');
  }
  /** What the admin types in the first box: module number (Pi) or username (laptop). */
  get identityLabel() { return isPi() ? 'Module number' : 'Username'; }
  get identity() {
    if (isPi()) {
      const s = serialModuleNumber();
      if (s) return s;
      let id = this.settings.get('admin_username');
      if (!id) { id = 'PN-' + Array.from(crypto.randomBytes(6), b => SETUP_ALPHABET[b % SETUP_ALPHABET.length]).join(''); this.settings.setInternal('admin_username', id); }
      return id;
    }
    return this.settings.get('admin_username') || 'admin';
  }
  /** Write the module number next to the setup code so it can be read off the SD card / printed on a label. */
  publishModuleNumber() {
    if (!isPi()) return;
    try { fs.writeFileSync(path.join(config.DATA_DIR, 'module-number.txt'), this.identity + '\n', { mode: 0o644 }); } catch {}
  }
  get needsSetup() { return !this.settings.get('admin_password_hash'); }

  /** First-boot claim code: whoever can read the device (SD card / ssh) can claim the admin account. */
  ensureSetupCode() {
    if (!this.needsSetup) return null;
    if (fs.existsSync(this.codeFile)) return fs.readFileSync(this.codeFile, 'utf8').trim();
    const code = Array.from(crypto.randomBytes(8), b => SETUP_ALPHABET[b % SETUP_ALPHABET.length]).join('');
    fs.writeFileSync(this.codeFile, code + '\n', { mode: 0o600 });
    if (config.SETUP_CODE_COPY_PATH) { try { fs.writeFileSync(config.SETUP_CODE_COPY_PATH, `Print Nimbus setup code: ${code}\nModule number (sign-in name): ${this.identity}\n`); } catch {} }
    return code;
  }
  setup(code, password, username) {
    if (!this.needsSetup) return { ok: false, error: 'Already set up' };
    const expected = this.ensureSetupCode();
    const a = Buffer.from(String(code || '').trim().toUpperCase()), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'Wrong setup code' };
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return { ok: false, error: 'Password must be at least 10 characters' };
    if (!isPi()) {
      const u = String(username || 'admin').trim();
      if (!USERNAME_RE.test(u)) return { ok: false, error: 'Username must be 3-32 letters, numbers, dot, dash or underscore' };
      this.settings.setInternal('admin_username', u);
    }
    this.settings.setInternal('admin_password_hash', hashPassword(password));
    fs.rmSync(this.codeFile, { force: true });
    if (config.SETUP_CODE_COPY_PATH) fs.rmSync(config.SETUP_CODE_COPY_PATH, { force: true });
    return { ok: true };
  }
  login(identity, password) {
    if (this.needsSetup || typeof password !== 'string') return null;
    const passOk = verifyPassword(password, this.settings.get('admin_password_hash'));   // always checked, so timing does not reveal a valid username
    if (!sameId(identity, this.identity) || !passOk) return null;
    return this.newSession();
  }
  changePassword(current, next, username) {
    if (!verifyPassword(String(current), this.settings.get('admin_password_hash'))) return { ok: false, error: 'Current password is wrong' };
    if (username && !isPi() && !sameId(username, this.identity)) {
      const u = String(username).trim();
      if (!USERNAME_RE.test(u)) return { ok: false, error: 'Username must be 3-32 letters, numbers, dot, dash or underscore' };
      this.settings.setInternal('admin_username', u);
      if (!next) { this.sessions.clear(); return { ok: true }; }
    }
    if (!next && (isPi() || !username || sameId(username, this.identity))) return { ok: false, error: 'Nothing to change' };
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
