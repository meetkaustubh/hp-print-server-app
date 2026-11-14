'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const config = require('./config');
const { normalise, UserError } = require('./files');
const { parseCookie } = require('./auth');
const legal = require('./legal');
const pkg = require('../package.json');

function createApp({ settings, printer, jobs, auth }) {
  const app = express();
  app.disable('x-powered-by');
  const tp = config.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(String(tp)) ? Number(tp) : (tp === 'false' || tp === '0' ? false : tp));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://checkout.razorpay.com', 'https://cdn.razorpay.com'],
        'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
        'connect-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com', 'https://lumberjack-cx.razorpay.com'],
        'img-src': ["'self'", 'data:', 'blob:', 'https://*.razorpay.com'],
        'worker-src': ["'self'", 'blob:'],
        'style-src': ["'self'", "'unsafe-inline'"], // Razorpay Checkout injects styles
        'font-src': ["'self'", 'data:', 'https://*.razorpay.com'],
        'object-src': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"],
      },
    },
    crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 15552000, includeSubDomains: false },
    referrerPolicy: { policy: 'no-referrer' },
  }));

  const RL_SCALE = Number(process.env.RATE_LIMIT_SCALE || 1); // tests raise this
  const limiter = (windowMin, max) => rateLimit({ windowMs: windowMin * 60_000, limit: max * RL_SCALE, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a bit and try again.' } });

  // ---- Razorpay webhook (needs the raw body for the HMAC, so it's registered before express.json) ----
  app.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const rz = jobs.razorpay();
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!rz.verifyWebhook(raw, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'bad signature' });
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
    try {
      if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
        const p = evt.payload?.payment?.entity;
        const job = p?.order_id && jobs.db.prepare('SELECT amount, currency FROM jobs WHERE order_id=?').get(p.order_id);
        // The amount on a captured payment must match what we priced server-side
        if (job && p.amount === job.amount && p.currency === job.currency && p.status === 'captured') {
          await jobs.confirmPayment({ orderId: p.order_id, paymentId: p.id, source: 'webhook' });
        }
      }
    } catch (e) { console.error('webhook error', e); return res.status(500).json({ error: 'retry' }); }
    res.json({ ok: true });
  });

  app.use(express.json({ limit: '20kb' }));
  app.use((req, res, next) => { // minimal access log: no query strings, no bodies
    res.on('finish', () => { if (!req.path.startsWith('/api/admin') && req.path !== '/api/status') console.log(`${req.method} ${req.path} ${res.statusCode}`); });
    next();
  });
  app.use('/api', limiter(15, 600));

  // ---- public API ----
  let statusCache = { at: 0, value: null };
  async function printerStatus() {
    if (Date.now() - statusCache.at < 4000 && statusCache.value) return statusCache.value;
    const v = await printer.status(settings.get('printer_name'));
    statusCache = { at: Date.now(), value: v };
    return v;
  }

  app.get('/api/config', async (req, res) => {
    const st = await printerStatus();
    const s = settings.all();
    const payOk = s.payment_mode === 'free' || jobs.razorpay().configured;
    res.json({ ...settings.publicView(), ready: st.ready && payOk, printer_state: st.state, payment_ready: payOk, paper_left: jobs.paperLeft() });
  });

  const uploadLimiter = limiter(10, 20);
  app.post('/api/uploads', uploadLimiter, (req, res, next) => {
    const maxBytes = settings.get('max_file_mb') * 1024 * 1024;
    multer({
      limits: { fileSize: maxBytes, files: 1, fields: 4, parts: 6 },
      storage: multer.diskStorage({
        destination: (r, f, cb) => cb(null, path.join(config.DATA_DIR, 'tmp')),
        filename: (r, f, cb) => cb(null, `up-${crypto.randomBytes(12).toString('hex')}`),
      }),
    }).single('file')(req, res, err => {
      if (err instanceof multer.MulterError) return next(new UserError(err.code === 'LIMIT_FILE_SIZE' ? `That file is larger than ${settings.get('max_file_mb')} MB.` : 'Upload failed.', err.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      next(err);
    });
  }, async (req, res, next) => {
    const tmp = req.file?.path;
    try {
      if (!tmp) throw new UserError('No file received.');
      const st = await printerStatus();
      if (!st.ready) throw new UserError('This printer is not available right now. Please try again later.', 503);
      const { pdfPath, pages } = await normalise({ tmpPath: tmp, originalName: req.file.originalname, settings });
      const job = jobs.createUpload({ pdfPath, pages, originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8') });
      res.status(201).json({ job: jobs.toPublic(job) });
    } catch (e) { next(e); }
    finally { if (tmp) fsp.rm(tmp, { force: true }).catch(() => {}); }
  });

  app.post('/api/checkout', limiter(10, 40), async (req, res, next) => {
    try { res.json(await jobs.checkout(req.body?.items)); } catch (e) { next(e); }
  });

  app.post('/api/checkout/confirm', limiter(10, 60), async (req, res, next) => {
    try {
      const { batch_id: batchId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
      const ord = typeof orderId === 'string' && jobs.db.prepare('SELECT batch_id FROM orders WHERE id=?').get(orderId);
      if (!ord || ord.batch_id !== batchId) throw new UserError('Payment does not match this order.', 400);
      if (!jobs.razorpay().verifyCheckoutSignature({ orderId, paymentId, signature })) throw new UserError('Payment could not be verified.', 400);
      const r = await jobs.confirmPayment({ orderId, paymentId, source: 'browser' });
      if (!r.ok) throw new UserError('Payment could not be verified.', 400);
      const batch = jobs.batchView(batchId);
      // If the customer changed their cart after this order was created, the payment is refunded automatically.
      res.json(batch ? { batch } : { stale: true, message: 'Your cart changed before this payment completed. The amount is being refunded automatically. Please check out again.' });
    } catch (e) { next(e); }
  });

  app.get('/api/batches/:id', (req, res) => {
    const batch = jobs.batchView(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Order not found' });
    res.set('Cache-Control', 'no-store').json({ batch });
  });

  // The normalised PDF, so the browser can draw page thumbnails (works for converted Office files and images too).
  app.get('/api/jobs/:id/pdf', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || !job.file_path || !['uploaded', 'awaiting_payment'].includes(job.status) || !fs.existsSync(job.file_path)) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="document.pdf"', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.sendFile(job.file_path, { dotfiles: 'allow' });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.set('Cache-Control', 'no-store').json({ job: jobs.toPublic(job) });
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (job && job.status === 'uploaded') { jobs.dropFile(job.id); jobs.setStatus(job.id, 'expired'); }
    res.json({ ok: true });
  });

  app.get('/legal/:page', (req, res) => {
    const s = settings.all();
    const external = { privacy: s.privacy_url, terms: s.terms_url, refund: s.refund_url }[req.params.page];
    if (external) return res.redirect(external);
    const html = legal.render(req.params.page, s);
    if (!html) return res.status(404).send('Not found');
    res.type('html').send(html);
  });

  // ---- admin API ----
  const admin = express.Router();
  const loginLimiter = limiter(15, 10);
  const cookieOpts = req => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}${req.secure ? '; Secure' : ''}`;

  admin.get('/session', (req, res) => {
    const token = parseCookie(req.headers.cookie, 'pn_admin');
    res.json({
      setup_required: auth.needsSetup, authed: !!(token && auth.valid(token)), version: pkg.version,
      setup_hint: config.EDITION === 'pi'
        ? 'Find it on the device: it is printed in the install log, or in the file PRINTNIMBUS-SETUP-CODE.txt on the SD card\'s boot partition.'
        : 'Find it in the black window that opened when you started the app, or in the file data/setup-code.txt inside the app folder.',
    });
  });
  admin.post('/setup', loginLimiter, (req, res) => {
    if (req.headers['x-requested-with'] !== 'printnimbus') return res.status(403).json({ error: 'Bad request origin' });
    const r = auth.setup(req.body?.code, req.body?.password);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.setHeader('Set-Cookie', `pn_admin=${auth.newSession()}; ${cookieOpts(req)}`);
    res.json({ ok: true });
  });
  admin.post('/login', loginLimiter, (req, res) => {
    if (req.headers['x-requested-with'] !== 'printnimbus') return res.status(403).json({ error: 'Bad request origin' });
    const token = auth.login(req.body?.password);
    if (!token) return res.status(401).json({ error: 'Wrong password' });
    res.setHeader('Set-Cookie', `pn_admin=${token}; ${cookieOpts(req)}`);
    res.json({ ok: true });
  });
  admin.use(auth.middleware());
  admin.post('/logout', (req, res) => { auth.destroy(req.adminToken); res.setHeader('Set-Cookie', `pn_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`); res.json({ ok: true }); });
  admin.post('/password', (req, res) => {
    const r = auth.changePassword(req.body?.current, req.body?.next);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.setHeader('Set-Cookie', `pn_admin=${auth.newSession()}; ${cookieOpts(req)}`);
    res.json({ ok: true });
  });
  admin.get('/settings', (req, res) => res.json(settings.adminView()));
  admin.put('/settings', (req, res) => {
    const patch = { ...(req.body || {}) };
    for (const k of ['razorpay_key_secret', 'razorpay_webhook_secret']) if (patch[k] === '') delete patch[k]; // blank = keep existing
    if (patch.payment_mode === 'razorpay') {
      const merged = { ...settings.all(), ...patch };
      if (!merged.razorpay_key_id || !merged.razorpay_key_secret) return res.status(400).json({ error: 'Enter the Razorpay Key ID and Key Secret before turning on payments.' });
    }
    const r = settings.set(patch);
    if (!r.ok) return res.status(400).json({ error: 'Some values are invalid', fields: r.errors });
    statusCache = { at: 0, value: null };
    res.json(settings.adminView());
  });
  admin.get('/printers', async (req, res) => res.json({ printers: await printer.list(), status: await printer.status(settings.get('printer_name')) }));
  admin.post('/test-print', async (req, res, next) => {
    try { await printer.testPage(settings.get('printer_name')); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: 'Test print failed: ' + (e.stderr || e.message).toString().slice(0, 200) }); }
  });
  admin.get('/stats', (req, res) => res.json(jobs.stats()));
  admin.get('/jobs', (req, res) => res.json({ jobs: jobs.list({ limit: 200 }) }));
  admin.get('/jobs/:id/events', (req, res) => {
    if (!jobs.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ events: jobs.db.prepare('SELECT ts, kind, detail FROM events WHERE job_id=? ORDER BY id').all(req.params.id) });
  });
  admin.post('/jobs/:id/refund', async (req, res) => {
    if (!jobs.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await jobs.refund(req.params.id, 'admin');
    res.status(r.ok ? 200 : 409).json(r);
  });
  admin.post('/jobs/:id/reprint', async (req, res, next) => { try { await jobs.reprint(req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });
  admin.delete('/jobs/:id/file', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Not found' });
    if (['queued', 'printing'].includes(j.status)) return res.status(409).json({ error: 'This job is printing right now.' });
    jobs.dropFile(j.id); jobs.event(j.id, 'admin_file_deleted');
    res.json({ ok: true });
  });
  admin.get('/jobs/:id/file', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || !j.file_path || !fs.existsSync(j.file_path)) return res.status(404).json({ error: 'The file is not stored.' });
    res.download(j.file_path, (j.original_name || 'document').replace(/\.[^.]*$/, '') + '.pdf');
  });
  admin.post('/files/delete-all', (req, res) => res.json({ deleted: jobs.dropAllFinished() }));
  admin.get('/qr.svg', async (req, res) => {
    const url = settings.get('public_url') || `${req.protocol}://${req.get('host')}`;
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  });
  admin.get('/system', async (req, res) => {
    let disk = null, temp = null;
    try { const st = await fsp.statfs(config.DATA_DIR); disk = { free_mb: Math.round(st.bavail * st.bsize / 1048576), total_mb: Math.round(st.blocks * st.bsize / 1048576) }; } catch {}
    try { temp = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch {}
    res.json({
      version: pkg.version, node: process.version, uptime_s: Math.round(os.uptime()), hostname: os.hostname(),
      mem_free_mb: Math.round(os.freemem() / 1048576), mem_total_mb: Math.round(os.totalmem() / 1048576), disk, cpu_temp_c: temp,
      print_backend: printer.name, payment_mode: settings.get('payment_mode'),
      razorpay_mode: jobs.razorpay().configured ? (jobs.razorpay().isLive ? 'live' : 'test') : 'not configured',
      public_url: settings.get('public_url') || null,
      addresses: Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address),
    });
  });
  app.use('/api/admin', admin);

  // ---- static ----
  // Operators can white-label by dropping a logo.png into the data folder
  app.get('/brand-logo', (req, res) => {
    const custom = path.join(config.DATA_DIR, 'logo.png');
    res.set('Cache-Control', 'no-cache');
    if (fs.existsSync(custom)) return res.type('png').sendFile(custom);
    res.type('svg').sendFile(path.join(config.ROOT, 'public', 'logo.svg'));
  });
  app.use('/admin/assets', express.static(path.join(config.ROOT, 'admin'), { index: false, dotfiles: 'deny', maxAge: '5m' }));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(config.ROOT, 'admin', 'index.html')));
  express.static.mime.define({ 'text/javascript': ['mjs'] });
  app.use(express.static(path.join(config.ROOT, 'public'), { dotfiles: 'deny', index: 'index.html', maxAge: '5m' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request' });
    if (err?.userFacing) return res.status(err.status || 400).json({ error: err.message });
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
