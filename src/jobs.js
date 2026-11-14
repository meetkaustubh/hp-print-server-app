'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { computePrice, parsePageRange, compactRange } = require('./pricing');
const { UserError, PAPER } = require('./files');
const { Razorpay } = require('./payments/razorpay');
const { notify } = require('./notify');

const MIN = 60_000;
const UNPAID_TTL = 30 * MIN;
const PRINTER_WAIT_MS = 3 * MIN;      // how long a paid job waits for a stopped printer before refund
const MAX_PENDING_UPLOADS = 40;       // protects disk on a tiny SD card

const FRIENDLY = {
  uploaded: 'Choose your print options',
  awaiting_payment: 'Waiting for payment',
  queued: 'Payment received. Waiting for the printer',
  printing: 'Printing now',
  done: 'Printed',
  failed: 'Printing failed',
  refunding: 'Refunding',
  refunded: 'Printing failed. Your payment has been refunded',
  refund_failed: 'Printing failed and the automatic refund did not go through',
  expired: 'This job expired',
};

class JobService {
  constructor({ db, settings, printer, fetchImpl }) {
    this.db = db; this.settings = settings; this.printer = printer; this.fetchImpl = fetchImpl;
    this.working = false; this.timers = [];
  }

  /* ---------- helpers ---------- */
  event(jobId, kind, detail = '') {
    this.db.prepare('INSERT INTO events(ts, job_id, kind, detail) VALUES(?,?,?,?)').run(Date.now(), jobId, kind, String(detail).slice(0, 500));
  }
  get(id) { return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) : undefined; }
  setStatus(id, status, extra = {}) {
    const cols = ['status=?', 'updated_at=?'], vals = [status, Date.now()];
    for (const [k, v] of Object.entries(extra)) { cols.push(`${k}=?`); vals.push(v); }
    this.db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id=?`).run(...vals, id);
  }
  razorpay() {
    const s = this.settings.all();
    return new Razorpay({ keyId: s.razorpay_key_id, keySecret: s.razorpay_key_secret, webhookSecret: s.razorpay_webhook_secret, fetchImpl: this.fetchImpl });
  }
  toPublic(j) {
    return {
      id: j.id, batch_id: j.batch_id || undefined, status: j.status, message: FRIENDLY[j.status] || j.status,
      original_name: j.original_name, pages_total: j.pages_total, pages_selected: j.pages_selected,
      copies: j.copies, color: !!j.color, duplex: !!j.duplex, paper: j.paper,
      amount: j.amount, currency: j.currency,
      payment_id: ['refunded', 'refund_failed', 'failed'].includes(j.status) ? j.payment_id : undefined,
      pickup_message: j.status === 'done' ? this.settings.get('pickup_message') : undefined,
      support_contact: ['refund_failed', 'failed'].includes(j.status) ? this.settings.get('support_contact') : undefined,
    };
  }

  /* ---------- customer flow ---------- */
  createUpload({ pdfPath, pages, originalName }) {
    const s = this.settings.all();
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('uploaded','awaiting_payment')").get().n;
    if (pending >= MAX_PENDING_UPLOADS) { fs.rmSync(pdfPath, { force: true }); throw new UserError('The kiosk is busy right now. Please try again in a few minutes.', 503); }
    if (pages > s.max_pages) { fs.rmSync(pdfPath, { force: true }); throw new UserError(`That document has ${pages} pages. The limit is ${s.max_pages}.`, 422); }
    const id = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const safeName = String(originalName || 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 80);
    this.db.prepare(`INSERT INTO jobs(id,status,created_at,updated_at,original_name,file_path,pages_total,currency) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, 'uploaded', now, now, safeName, pdfPath, pages, s.currency);
    this.event(id, 'uploaded', `${pages} pages`);
    return this.get(id);
  }

  /** Validate + price options. Throws UserError on anything odd. */
  quote(job, raw) {
    const s = this.settings.all();
    const copies = Number(raw.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > s.max_copies) throw new UserError(`Copies must be between 1 and ${s.max_copies}.`);
    const color = raw.color === true || raw.color === 'true';
    const duplex = raw.duplex === true || raw.duplex === 'true';
    if (color && !s.allow_color) throw new UserError('Colour printing is not available on this printer.');
    if (duplex && !s.allow_duplex) throw new UserError('Double-sided printing is not available on this printer.');
    const paper = raw.paper || s.default_paper;
    if (!PAPER[paper]) throw new UserError('Unknown paper size.');
    const range = typeof raw.page_range === 'string' ? raw.page_range.trim() : '';
    const selected = parsePageRange(range, job.pages_total);
    if (!selected) throw new UserError(`Page range is not valid. Use something like 1-3,5 (this document has ${job.pages_total} pages).`);
    const amount = computePrice(s, { pages: selected.length, copies, color });
    return { copies, color, duplex, paper, selected, page_range: range ? compactRange(selected) : '', amount };
  }

  /**
   * One order = one or more uploaded documents, each with its own options, paid with a single Razorpay order.
   * items: [{ id, copies, color, duplex, page_range }]
   */
  /** sheets of paper one job uses (double-sided halves it) */
  sheetsFor(pages, copies, duplex) { return Math.ceil(((pages || 1) * (copies || 1)) / (duplex ? 2 : 1)); }
  /** Sheets still available to new orders: tray count minus paper already promised to queued/printing jobs. null = not tracked. */
  paperLeft() {
    const s = this.settings.all(); if (!s.paper_tracking) return null;
    let promised = 0;
    for (const j of this.db.prepare("SELECT pages_selected p, copies c, duplex d FROM jobs WHERE status IN ('queued','printing')").all()) promised += this.sheetsFor(j.p, j.c, j.d);
    return Math.max(0, s.paper_in_tray - promised);
  }
  async checkout(rawItems) {
    const s = this.settings.all();
    if (!Array.isArray(rawItems) || rawItems.length < 1) throw new UserError('Add at least one document.');
    if (rawItems.length > s.max_docs) throw new UserError(`You can print up to ${s.max_docs} documents per order.`);
    const seen = new Set(), rows = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') throw new UserError('Invalid order.');
      const job = this.get(raw.id);
      if (!job || seen.has(job.id) || !['uploaded', 'awaiting_payment'].includes(job.status)) throw new UserError('One of your documents is no longer available. Please upload it again.', 404);
      if (!job.file_path || !fs.existsSync(job.file_path)) throw new UserError(`"${job.original_name}" expired. Please upload it again.`, 410);
      seen.add(job.id);
      try { rows.push({ job, q: this.quote(job, raw) }); }
      catch (e) { if (e.userFacing) e.message = `${job.original_name}: ${e.message}`; throw e; }
    }
    const left = this.paperLeft();
    if (left !== null) {
      const need = rows.reduce((n, r) => n + this.sheetsFor(r.q.selected.length, r.q.copies, r.q.duplex), 0);
      if (need > left) throw new UserError(left > 0 ? `Only ${left} sheet${left === 1 ? '' : 's'} of paper left in the printer, and this order needs ${need}. Please reduce pages or copies.` : 'The printer is out of paper right now. Please try again later.', 409);
    }
    // order-level minimum charge: any top-up is attributed to the first document
    let total = rows.reduce((n, r) => n + r.q.amount, 0);
    if (total > 0 && total < s.min_charge) { rows[0].q.amount += s.min_charge - total; total = s.min_charge; }

    const batchId = crypto.randomBytes(16).toString('hex');
    const free = s.payment_mode === 'free' || total === 0;
    let order = null;
    if (!free) {
      const rz = this.razorpay();
      if (!rz.configured) throw new UserError('Online payment is not set up on this kiosk yet.', 503);
      try { order = await rz.createOrder({ amount: total, currency: s.currency, receipt: batchId, notes: { batch: batchId } }); }
      catch (e) { this.event(null, 'order_error', e.message); throw new UserError('We could not start the payment. Please try again.', 502); }
    }
    const now = Date.now();
    const setOpts = this.db.prepare(`UPDATE jobs SET batch_id=?, pages_selected=?, page_range=?, copies=?, color=?, duplex=?, paper=?, amount=?, order_id=?, updated_at=? WHERE id=?`);
    this.db.exec('BEGIN');
    try {
      for (const { job, q } of rows) setOpts.run(batchId, q.selected.length, q.page_range, q.copies, q.color ? 1 : 0, q.duplex ? 1 : 0, q.paper, q.amount, order ? order.id : null, now, job.id);
      if (order) this.db.prepare('INSERT INTO orders(id,batch_id,amount,currency,status,created_at) VALUES(?,?,?,?,?,?)').run(order.id, batchId, total, s.currency, 'created', now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }

    if (free) {
      for (const { job } of rows) { this.setStatus(job.id, 'queued', { queued_at: now }); this.event(job.id, 'queued', s.payment_mode === 'free' ? 'free mode' : 'zero price'); }
      this.kick();
      return { batch: this.batchView(batchId) };
    }
    for (const { job } of rows) { this.setStatus(job.id, 'awaiting_payment'); this.event(job.id, 'order_created', `${order.id} total ${total}`); }
    return { batch: this.batchView(batchId), order: { id: order.id, amount: order.amount, currency: order.currency, key_id: s.razorpay_key_id } };
  }

  /** Called from the browser handler (signature already checked) and from the webhook (HMAC already checked). */
  async confirmPayment({ orderId, paymentId, source }) {
    const ord = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!ord) return { ok: false, reason: 'unknown order' };
    if (ord.payment_id && ord.payment_id !== paymentId) return { ok: false, reason: 'order already paid by a different payment' };
    if (!ord.payment_id) this.db.prepare("UPDATE orders SET payment_id=?, status='paid' WHERE id=? AND payment_id IS NULL").run(paymentId, orderId);

    const jobs = this.db.prepare('SELECT * FROM jobs WHERE order_id=?').all(orderId);
    if (!jobs.length) return this.refundStaleOrder(ord, paymentId, source);   // customer changed the cart and paid an older order

    const now = Date.now();
    let queued = 0;
    for (const j of jobs) {
      if (j.status !== 'awaiting_payment' && j.status !== 'expired') continue;   // already processed: idempotent
      this.db.prepare('UPDATE jobs SET payment_id=? WHERE id=? AND payment_id IS NULL').run(paymentId, j.id);
      if (j.status === 'expired' || !j.file_path || !fs.existsSync(j.file_path)) {
        // money taken, nothing left to print: give this document's share back
        this.event(j.id, 'late_payment', `${paymentId} via ${source}`);
        this.refund(j.id, 'late payment after expiry').catch(() => {});
        continue;
      }
      const r = this.db.prepare("UPDATE jobs SET status='queued', queued_at=?, updated_at=? WHERE id=? AND status='awaiting_payment'").run(now, now, j.id);
      if (r.changes) { this.event(j.id, 'paid', `${paymentId} via ${source}`); queued++; }
    }
    if (queued) this.kick();
    return { ok: true, batch_id: jobs[0].batch_id };
  }

  async refundStaleOrder(ord, paymentId, source) {
    const claim = this.db.prepare("UPDATE orders SET status='stale_refunding' WHERE id=? AND status IN ('paid','stale_refund_failed')").run(ord.id);
    if (!claim.changes) return { ok: true, duplicate: true };
    this.event(null, 'stale_order_paid', `${ord.id} ${paymentId} via ${source}`);
    try {
      await this.razorpay().refund({ paymentId, amount: ord.amount, receipt: ord.id, notes: { reason: 'cart changed before payment' } });
      this.db.prepare("UPDATE orders SET status='stale_refunded' WHERE id=?").run(ord.id);
    } catch (e) {
      this.db.prepare("UPDATE orders SET status='stale_refund_failed' WHERE id=?").run(ord.id);
      notify(this.settings, `STALE ORDER ${ord.id} paid (${paymentId}) but the auto-refund failed: ${e.message}. Refund it from the Razorpay dashboard.`);
    }
    return { ok: true, refunded: true };
  }

  /** Everything the customer's status screen needs about one order. */
  batchView(batchId) {
    if (typeof batchId !== 'string' || !/^[a-f0-9]{32}$/.test(batchId)) return null;
    const rows = this.db.prepare('SELECT * FROM jobs WHERE batch_id=? ORDER BY rowid').all(batchId);
    if (!rows.length) return null;
    const terminal = ['done', 'failed', 'refunded', 'refund_failed', 'expired'];
    const sum = f => rows.filter(f).reduce((n, j) => n + j.amount, 0);
    return {
      id: batchId,
      jobs: rows.map(j => this.toPublic(j)),
      amount: rows.reduce((n, j) => n + j.amount, 0),
      refunded_amount: sum(j => j.status === 'refunded'),
      currency: rows[0].currency,
      finished: rows.every(j => terminal.includes(j.status)),
      awaiting_payment: rows.some(j => j.status === 'awaiting_payment'),
    };
  }

  /* ---------- refunds ---------- */
  async refund(id, reason) {
    const job = this.get(id);
    if (!job || !job.payment_id) return { ok: false, error: 'No payment on this job' };
    // atomically claim the refund so it can never run twice
    const claim = this.db.prepare("UPDATE jobs SET status='refunding', updated_at=? WHERE id=? AND refund_id IS NULL AND status IN ('failed','refund_failed','done','expired','queued','awaiting_payment')").run(Date.now(), id);
    if (!claim.changes) return { ok: false, error: 'Job is not refundable in its current state' };
    try {
      const res = await this.razorpay().refund({ paymentId: job.payment_id, amount: job.amount, receipt: id, notes: { reason: String(reason).slice(0, 100) } });
      this.setStatus(id, 'refunded', { refund_id: res.id });
      this.event(id, 'refunded', `${res.id} (${reason})`);
      return { ok: true, refund_id: res.id };
    } catch (e) {
      this.setStatus(id, 'refund_failed', { error: `refund error: ${e.message}`.slice(0, 300) });
      this.event(id, 'refund_error', e.message);
      notify(this.settings, `REFUND FAILED for job ${id.slice(0, 8)} payment ${job.payment_id}: ${e.message}. Refund it from the Razorpay dashboard.`);
      return { ok: false, error: e.message };
    }
  }

  /* ---------- worker ---------- */
  kick() { setImmediate(() => this.processQueue().catch(e => console.error('worker error', e))); }
  start() {
    this.recover();
    this.timers.push(setInterval(() => this.kick(), 5000));
    this.timers.push(setInterval(() => this.sweep().catch(e => console.error('sweep error', e)), MIN));
    this.sweep().catch(() => {});
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  recover() {
    for (const j of this.db.prepare("SELECT * FROM jobs WHERE status IN ('printing','refunding')").all()) {
      if (j.status === 'refunding') {
        this.setStatus(j.id, 'refund_failed', { error: 'Server restarted mid-refund. Check the Razorpay dashboard before retrying.' });
      } else if (j.cups_job) {
        this.setStatus(j.id, 'failed', { error: 'Server restarted while printing. Check the printer output, then refund if nothing came out.' });
      } else {
        this.setStatus(j.id, 'queued');
      }
      this.event(j.id, 'recovered', j.status);
    }
  }

  async processQueue() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY queued_at ASC, rowid ASC LIMIT 1").get();
        if (!job) return;
        const printerName = this.settings.get('printer_name');
        const st = await this.printer.status(printerName);
        if (!st.ready) {
          if (Date.now() - (job.queued_at || job.updated_at) > PRINTER_WAIT_MS) { await this.fail(job, `Printer not ready: ${st.detail}`); continue; }
          return; // leave queued, try again on the next tick
        }
        await this.print(job, printerName);
      }
    } finally { this.working = false; }
  }

  async print(job, printerName) {
    const claim = this.db.prepare("UPDATE jobs SET status='printing', updated_at=? WHERE id=? AND status='queued'").run(Date.now(), job.id);
    if (!claim.changes) return;
    this.event(job.id, 'printing');
    try {
      const cupsJob = await this.printer.submit({
        printer: printerName, file: job.file_path, copies: job.copies, color: !!job.color, duplex: !!job.duplex,
        paper: job.paper, pages: job.page_range || '', title: `PrintNimbus ${job.id.slice(0, 8)}`,
      });
      this.setStatus(job.id, 'printing', { cups_job: cupsJob });
      const limit = Date.now() + Math.min(20 * MIN, 2 * MIN + 20_000 * (job.pages_selected || 1) * (job.copies || 1));
      while (await this.printer.isActive(cupsJob)) {
        if (Date.now() > limit) { await this.printer.cancel(cupsJob); throw new Error('Timed out waiting for the printer (paper jam, out of paper or offline?)'); }
        await new Promise(r => setTimeout(r, 2500));
      }
      this.setStatus(job.id, 'done');
      this.event(job.id, 'done', cupsJob);
      if (this.settings.get('paper_tracking')) this.settings.setInternal('paper_in_tray', Math.max(0, this.settings.get('paper_in_tray') - this.sheetsFor(job.pages_selected, job.copies, job.duplex)));
      this.purgeFile(job.id, this.settings.get('retention_minutes') * MIN);
    } catch (e) {
      await this.fail(this.get(job.id), e.message);
    }
  }

  async fail(job, reason) {
    this.setStatus(job.id, 'failed', { error: String(reason).slice(0, 300) });
    this.event(job.id, 'failed', reason);
    notify(this.settings, `Print job ${job.id.slice(0, 8)} failed: ${reason}`);
    if (job.payment_id) await this.refund(job.id, 'print failed');
  }

  purgeFile(id, afterMs) {
    const t = setTimeout(() => this.dropFile(id), afterMs); t.unref?.();
  }
  dropFile(id) {
    const j = this.get(id);
    if (!j?.file_path) return;
    fs.rmSync(j.file_path, { force: true });
    this.db.prepare('UPDATE jobs SET file_path=NULL WHERE id=?').run(id);
  }

  /** Housekeeping: expire abandoned uploads, delete old files, trim logs/temp. */
  async sweep() {
    const now = Date.now();
    const retention = this.settings.get('retention_minutes') * MIN;
    for (const j of this.db.prepare("SELECT id, status FROM jobs WHERE status IN ('uploaded','awaiting_payment') AND created_at < ?").all(now - UNPAID_TTL)) {
      // keep awaiting_payment row alive for a late webhook; just drop the file only for 'uploaded'
      if (j.status === 'uploaded') { this.dropFile(j.id); this.setStatus(j.id, 'expired'); }
      else if (this.db.prepare('SELECT created_at FROM jobs WHERE id=?').get(j.id).created_at < now - 2 * UNPAID_TTL) { this.dropFile(j.id); this.setStatus(j.id, 'expired'); }
    }
    for (const j of this.db.prepare("SELECT id FROM jobs WHERE file_path IS NOT NULL AND status IN ('done','failed','refunded','refund_failed','expired') AND updated_at < ?").all(now - retention)) this.dropFile(j.id);

    // orphan files (crash between write and DB insert) + stale temp
    const referenced = new Set(this.db.prepare('SELECT file_path FROM jobs WHERE file_path IS NOT NULL').all().map(r => r.file_path));
    for (const dir of ['jobs', 'tmp']) {
      const full = path.join(config.DATA_DIR, dir);
      for (const f of await fsp.readdir(full).catch(() => [])) {
        const p = path.join(full, f);
        const st = await fsp.stat(p).catch(() => null);
        if (!st || now - st.mtimeMs < 15 * MIN) continue;
        if (dir === 'jobs' && referenced.has(p)) continue;
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 90 * 24 * 3600_000);
  }

  /* ---------- admin ---------- */
  list({ limit = 100, status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare("SELECT * FROM jobs WHERE status != 'uploaded' ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(j => ({ ...this.toPublic(j), created_at: j.created_at, payment_id: j.payment_id, refund_id: j.refund_id, error: j.error, order_id: j.order_id, batch_id: j.batch_id, has_file: !!j.file_path }));
  }
  stats() {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const q = (sql, ...a) => this.db.prepare(sql).get(...a);
    return {
      today_jobs: q("SELECT COUNT(*) n FROM jobs WHERE status='done' AND updated_at >= ?", day.getTime()).n,
      today_pages: q("SELECT COALESCE(SUM(pages_selected*copies),0) n FROM jobs WHERE status='done' AND updated_at >= ?", day.getTime()).n,
      today_revenue: q(`SELECT COALESCE(SUM(amount),0) n FROM jobs WHERE payment_id IS NOT NULL AND status IN ('done') AND updated_at >= ?`, day.getTime()).n,
      total_revenue: q(`SELECT COALESCE(SUM(amount),0) n FROM jobs WHERE payment_id IS NOT NULL AND status='done'`).n,
      queued: q("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','printing')").n,
      needs_attention: q("SELECT COUNT(*) n FROM jobs WHERE status IN ('refund_failed')").n,
    };
  }
  async reprint(id) {
    const j = this.get(id);
    if (!j || !j.file_path || !fs.existsSync(j.file_path)) throw new UserError('The file has already been deleted.', 410);
    if (!['failed', 'refund_failed', 'done'].includes(j.status)) throw new UserError('Job is not reprintable in this state.', 409);
    this.setStatus(id, 'queued', { error: null, queued_at: Date.now() }); this.event(id, 'admin_reprint'); this.kick();
  }
}

module.exports = { JobService, FRIENDLY };
