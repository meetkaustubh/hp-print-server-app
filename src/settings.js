'use strict';
// Operator-editable settings, stored in SQLite. Secrets are write-only through the API.
const config = require('./config');

const DEFAULTS = {
  business_name: 'Print Nimbus',
  tagline: 'Upload. Pay. Collect.',
  pickup_message: 'Your print is ready. Please collect it from the printer.',
  support_contact: '',
  currency: 'INR',
  price_bw: 500,       // smallest unit per page (paise)
  price_color: 1000,
  min_charge: 0,
  max_pages: 100,
  max_copies: 20,
  max_docs: 10,        // documents per order
  max_file_mb: 25,
  default_paper: 'A4',
  paper_tracking: false, // count sheets in the tray and stop orders that would run out
  paper_in_tray: 0,
  allow_duplex: true,
  allow_color: true,
  printer_name: '',    // CUPS queue name
  payment_mode: 'free', // free | razorpay
  razorpay_key_id: '',
  razorpay_key_secret: '',
  razorpay_webhook_secret: '',
  retention_minutes: 10,  // how long files are kept after print/failure
  retain_files: false,    // true = admin keeps printed files until deleted by hand
  notify_webhook: '',     // optional URL (ntfy.sh, Slack, Discord, Telegram relay...) called on failures
  terms_url: '',
  privacy_url: '',
  refund_url: '',
  public_url: '',         // used for the QR poster
  color_billing: 'all',        // all = every selected page at the colour price | per_page = colour price only for pages that contain colour
  // Heavy-colour surcharge: a colour page whose coloured area reaches a level costs extra (percent on top of the colour price)
  color_medium_pct: 10, color_medium_extra: 20,
  color_medhigh_pct: 30, color_medhigh_extra: 50,
  color_high_pct: 60, color_high_extra: 100,
  bulk_min_pages: 0,           // 0 = off. Orders with at least this many pages (pages x copies, all documents) use the bulk prices
  bulk_price_bw: 0,            // paise per page; 0 = same as the normal price
  bulk_price_color: 0,
  test_mode: false,            // simulated payments + optional simulated printing/refunds
  test_print_outcome: 'real',  // real | success | fail
  test_refund_outcome: 'success', // success | fail
  admin_password_hash: '',
  admin_username: '',     // laptop: chosen at setup. Pi: only used if the board has no serial number
};

const SECRET_KEYS = new Set(['razorpay_key_secret', 'razorpay_webhook_secret', 'admin_password_hash']);
const ENV_SECRET = {
  razorpay_key_id: 'ENV_RAZORPAY_KEY_ID',
  razorpay_key_secret: 'ENV_RAZORPAY_KEY_SECRET',
  razorpay_webhook_secret: 'ENV_RAZORPAY_WEBHOOK_SECRET',
};

const int = (min, max) => v => { const n = Math.trunc(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be between ${min} and ${max}`); return n; };
const bool = v => { if (typeof v !== 'boolean') throw new Error('must be true/false'); return v; };
const str = (max = 200) => v => { if (typeof v !== 'string' || v.length > max) throw new Error(`must be text up to ${max} chars`); return v.trim(); };
const url = v => { v = str(300)(v); if (v && !/^https?:\/\//i.test(v)) throw new Error('must start with http:// or https://'); return v; };
const oneOf = list => v => { if (!list.includes(v)) throw new Error(`must be one of ${list.join(', ')}`); return v; };

const VALIDATORS = {
  business_name: str(60), tagline: str(100), pickup_message: str(240), support_contact: str(120),
  currency: oneOf(['INR']),
  price_bw: int(0, 1_000_000), price_color: int(0, 1_000_000), min_charge: int(0, 1_000_000),
  max_pages: int(1, config.HARD_MAX_PAGES), max_copies: int(1, 100), max_docs: int(1, 20), max_file_mb: int(1, config.HARD_MAX_FILE_MB),
  default_paper: oneOf(['A4', 'Letter', 'A3', 'Legal']),
  paper_tracking: bool, paper_in_tray: int(0, 100000),
  allow_duplex: bool, allow_color: bool,
  printer_name: v => { v = str(120)(v); if (v && !/^[\p{L}\p{N} ._\-()#&+,]+$/u.test(v)) throw new Error('invalid printer name'); return v; },
  payment_mode: oneOf(['free', 'razorpay']),
  razorpay_key_id: v => { v = str(80)(v); if (v && !/^rzp_(live|test)_[A-Za-z0-9]+$/.test(v)) throw new Error('should look like rzp_live_xxx or rzp_test_xxx'); return v; },
  razorpay_key_secret: str(120), razorpay_webhook_secret: str(120),
  retention_minutes: int(1, 1440), retain_files: bool,
  color_billing: oneOf(['all', 'per_page']), color_medium_pct: int(1, 100), color_medhigh_pct: int(1, 100), color_high_pct: int(1, 100),
  color_medium_extra: int(0, 1000), color_medhigh_extra: int(0, 1000), color_high_extra: int(0, 1000),
  bulk_min_pages: int(0, 100000), bulk_price_bw: int(0, 1_000_000), bulk_price_color: int(0, 1_000_000),
  test_mode: bool, test_print_outcome: oneOf(['real', 'success', 'fail']), test_refund_outcome: oneOf(['success', 'fail']),
  notify_webhook: url, terms_url: url, privacy_url: url, refund_url: url, public_url: url,
};

class Settings {
  constructor(db) {
    this.db = db;
    this.cache = null;
  }
  _load() {
    const out = { ...DEFAULTS };
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (row.key in DEFAULTS) { try { out[row.key] = JSON.parse(row.value); } catch {} }
    }
    return out;
  }
  all() {
    if (!this.cache) this.cache = this._load();
    const s = { ...this.cache };
    for (const [k, envKey] of Object.entries(ENV_SECRET)) if (config[envKey]) s[k] = config[envKey];
    return s;
  }
  get(key) { return this.all()[key]; }
  set(patch) {
    const errors = {};
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      const validate = VALIDATORS[k];
      if (!validate) { errors[k] = 'unknown or read-only setting'; continue; }
      try { clean[k] = validate(v); } catch (e) { errors[k] = e.message; }
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    const stmt = this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.db.exec('BEGIN');
    try { for (const [k, v] of Object.entries(clean)) stmt.run(k, JSON.stringify(v)); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    return { ok: true };
  }
  setInternal(key, value) { // for non-validated internal keys (admin hash)
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    this.cache = null;
  }
  /** Settings safe to show the browser that's using the kiosk. */
  publicView() {
    const s = this.all();
    return {
      business_name: s.business_name, tagline: s.tagline, pickup_message: s.pickup_message, support_contact: s.support_contact,
      currency: s.currency, price_bw: s.price_bw, price_color: s.price_color, min_charge: s.min_charge,
      max_pages: s.max_pages, max_copies: s.max_copies, max_docs: s.max_docs, max_file_mb: s.max_file_mb, default_paper: s.default_paper,
      allow_duplex: s.allow_duplex, allow_color: s.allow_color, payment_mode: s.payment_mode, paper_tracking: s.paper_tracking,
      color_billing: s.color_billing,
      color_medium_pct: s.color_medium_pct, color_medium_extra: s.color_medium_extra, color_medhigh_pct: s.color_medhigh_pct, color_medhigh_extra: s.color_medhigh_extra, color_high_pct: s.color_high_pct, color_high_extra: s.color_high_extra, test_mode: s.test_mode,
      bulk_min_pages: s.bulk_min_pages, bulk_price_bw: s.bulk_price_bw || s.price_bw, bulk_price_color: s.bulk_price_color || s.price_color,
      razorpay_key_id: s.payment_mode === 'razorpay' ? s.razorpay_key_id : '',
      accepts: this.acceptedExtensions(),
      terms_url: s.terms_url, privacy_url: s.privacy_url, refund_url: s.refund_url,
    };
  }
  acceptedExtensions() {
    const base = ['pdf', 'jpg', 'jpeg', 'png'];
    return base;
  }
  /** Settings for the admin panel: secrets replaced by "is set" flags. */
  adminView() {
    const s = this.all();
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'admin_password_hash') continue;
      out[k] = SECRET_KEYS.has(k) ? '' : s[k];
    }
    out.razorpay_key_secret_set = !!s.razorpay_key_secret;
    out.razorpay_webhook_secret_set = !!s.razorpay_webhook_secret;
    out.secrets_from_env = Object.entries(ENV_SECRET).filter(([, e]) => config[e]).map(([k]) => k);
    return out;
  }
}

module.exports = { Settings, DEFAULTS };
