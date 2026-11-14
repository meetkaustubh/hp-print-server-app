'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const H = require('./helpers');

let ctx;
before(async () => { ctx = await H.start(); });
after(async () => { await ctx.close(); });
const X = { 'X-Requested-With': 'printnimbus' };

test('uploads: content must match extension; exe/php/html disguised as pdf are rejected', async () => {
  const evil = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake exe');
  assert.equal((await ctx.upload(evil, 'invoice.pdf')).status, 415);
  assert.equal((await ctx.upload(Buffer.from('<?php system($_GET[1]);'), 'a.pdf')).status, 415);
  assert.equal((await ctx.upload(Buffer.from('<script>alert(1)</script>'), 'a.html')).status, 415);
  assert.equal((await ctx.upload(await H.makePdf(1), 'a.exe')).status, 415);
  assert.equal((await ctx.upload(Buffer.alloc(0), 'empty.pdf')).status, 415);
});

test('uploads: path-traversal filenames cannot escape the data dir', async () => {
  const r = await ctx.upload(await H.makePdf(1), '../../../../etc/cron.d/x.pdf');
  assert.equal(r.status, 201);
  assert.ok(!/[\\/]/.test(r.json.job.original_name.replace(/_/g, '')) || !r.json.job.original_name.includes('/'));
  const stored = ctx.jobs.get(r.json.job.id).file_path;
  assert.ok(stored.startsWith(path.join(process.env.DATA_DIR, 'jobs') + path.sep));
});

test('uploads: size and page limits enforced', async () => {
  ctx.settings.set({ max_file_mb: 1, max_pages: 3 });
  assert.equal((await ctx.upload(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024)]), 'big.pdf')).status, 413);
  assert.equal((await ctx.upload(await H.makePdf(4), 'long.pdf')).status, 422);
  assert.equal((await ctx.upload(await H.makePdf(3), 'ok.pdf')).status, 201);
  ctx.settings.set({ max_file_mb: 25, max_pages: 100 });
});

test('uploads: damaged PDF handled gracefully (no 500)', async () => {
  const r = await ctx.upload(Buffer.from('%PDF-1.4\n1 0 obj << /Broken >> endobj garbage'), 'bad.pdf');
  assert.equal(r.status, 422);
});

test('images are converted to a printable PDF', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const r = await ctx.upload(png, 'photo.png', 'image/png');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.job.pages_total, 1);
});

test('Word / Excel / PowerPoint / text files are not accepted', async () => {
  for (const n of ['a.docx', 'a.doc', 'a.xlsx', 'a.pptx', 'a.txt', 'a.rtf']) assert.equal((await ctx.upload(Buffer.from('hello'), n)).status, 415, n);
});

test('static server: dotfiles, db, source and traversal are not reachable', async () => {
  fs.writeFileSync(path.join(process.cwd(), 'public', '.env'), 'SECRET=1'); // simulate the old mistake
  try {
    for (const p of ['/.env', '/%2e%2e/package.json', '/../package.json', '/data/printnimbus.db', '/src/config.js', '/node_modules/express/package.json', '/printnimbus.db', '/..%2f..%2fetc%2fpasswd', '/admin/assets/../../package.json'])
      assert.notEqual((await ctx.api('GET', p)).status, 200, p);
    assert.ok(!(await ctx.api('GET', '/.env')).text.includes('SECRET'));
  } finally { fs.rmSync(path.join(process.cwd(), 'public', '.env'), { force: true }); }
});

test('security headers present (CSP, nosniff, no x-powered-by)', async () => {
  const r = await ctx.api('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('admin API requires login; old open endpoints are gone', async () => {
  for (const [m, p] of [['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings'], ['GET', '/api/admin/jobs'], ['POST', '/api/admin/jobs/abc/refund'], ['POST', '/api/admin/test-print'], ['GET', '/api/admin/qr.svg']])
    assert.equal((await ctx.api(m, p, m === 'GET' ? undefined : {}, X)).status, 401, p);
  for (const [m, p] of [['POST', '/refund'], ['POST', '/sendEmail'], ['POST', '/log'], ['POST', '/print'], ['POST', '/upload']])
    assert.equal((await ctx.api(m, p, {})).status, 404, p);
});

test('admin setup: needs the on-device code; then login, CSRF header, no secret leakage', async () => {
  const code = ctx.auth.ensureSetupCode();
  assert.ok(code && code.length === 8);
  assert.equal((await ctx.api('POST', '/api/admin/setup', { code: 'WRONGCODE', password: 'correct horse battery' }, X)).status, 400);
  assert.equal((await ctx.api('POST', '/api/admin/setup', { code, password: 'short' }, X)).status, 400);
  assert.equal((await ctx.api('POST', '/api/admin/setup', { code, password: 'correct horse battery' })).status, 403); // no CSRF header
  assert.equal((await ctx.api('POST', '/api/admin/setup', { code, password: 'correct horse battery', username: 'a b' }, X)).status, 400); // bad username
  const ok = await ctx.api('POST', '/api/admin/setup', { code, password: 'correct horse battery', username: 'Shop.Owner' }, X);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await ctx.api('POST', '/api/admin/setup', { code, password: 'another password!' }, X)).status, 400); // can't re-run

  const c = { ...X, Cookie: cookie.split(';')[0] };
  assert.equal((await ctx.api('POST', '/api/admin/login', { username: 'Shop.Owner', password: 'nope' }, X)).status, 401);
  assert.equal((await ctx.api('POST', '/api/admin/login', { username: 'someone-else', password: 'correct horse battery' }, X)).status, 401);
  assert.equal((await ctx.api('POST', '/api/admin/login', { password: 'correct horse battery' }, X)).status, 401);
  assert.equal((await ctx.api('POST', '/api/admin/login', { username: 'shop.owner', password: 'correct horse battery' }, X)).status, 200); // case-insensitive
  assert.equal((await ctx.api('POST', '/api/admin/login', { username: 'Shop.Owner', password: 'correct horse battery' })).status, 403);

  const rz = await ctx.api('PUT', '/api/admin/settings', { razorpay_key_id: H.KEY_ID, razorpay_key_secret: H.KEY_SECRET, business_name: '<b>Shop</b>' }, c);
  assert.equal(rz.status, 200);
  const got = await ctx.api('GET', '/api/admin/settings', undefined, c);
  assert.ok(!got.text.includes(H.KEY_SECRET)); assert.equal(got.json.razorpay_key_secret_set, true);
  assert.ok(!got.text.includes('scrypt$'));
  const pub = await ctx.api('GET', '/api/config');
  assert.ok(!pub.text.includes(H.KEY_SECRET)); assert.ok(!pub.text.includes('scrypt$'));
  // state-changing call without CSRF header is refused even with a valid cookie
  assert.equal((await ctx.api('PUT', '/api/admin/settings', { price_bw: 1 }, { Cookie: c.Cookie })).status, 403);
  // validation
  const bad = await ctx.api('PUT', '/api/admin/settings', { price_bw: -5, copies: 3, notify_webhook: 'javascript:alert(1)', printer_name: 'x; rm -rf /' }, c);
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.price_bw && bad.json.fields.copies && bad.json.fields.notify_webhook && bad.json.fields.printer_name);
  // can't go live without keys
  ctx.settings.set({ razorpay_key_id: '', razorpay_key_secret: '' });
  assert.equal((await ctx.api('PUT', '/api/admin/settings', { payment_mode: 'razorpay' }, c)).status, 400);
  // logout kills the session
  await ctx.api('POST', '/api/admin/logout', {}, c);
  assert.equal((await ctx.api('GET', '/api/admin/settings', undefined, c)).status, 401);
});

test('login is rate limited', async () => {
  const saved = process.env.RATE_LIMIT_SCALE;
  // fresh app with real (unscaled) limits
  process.env.RATE_LIMIT_SCALE = '1';
  const strict = await H.start();
  let last;
  for (let i = 0; i < 12; i++) last = await strict.api('POST', '/api/admin/login', { username: 'u', password: 'x' + i }, X);
  assert.equal(last.status, 429);
  await strict.close();
  process.env.RATE_LIMIT_SCALE = saved;
});

test('public job endpoint leaks no file paths or other users data', async () => {
  const up = await ctx.upload(await H.makePdf(1));
  const j = (await ctx.api('GET', `/api/jobs/${up.json.job.id}`)).json.job;
  assert.ok(!('file_path' in j) && !('order_id' in j));
  assert.equal((await ctx.api('GET', '/api/jobs/1')).status, 404);
  assert.equal((await ctx.api('GET', "/api/jobs/' OR 1=1 --")).status, 404);
});

test('legal pages escape operator text', async () => {
  ctx.settings.set({ business_name: '<img src=x onerror=alert(1)>' });
  const r = await ctx.api('GET', '/legal/privacy');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('<img src=x'));
  assert.equal((await ctx.api('GET', '/legal/../../etc/passwd')).status, 404);
});

test('page preview PDF is served only for live uploads, sandboxed', async () => {
  const up = await ctx.upload(await H.makePdf(2));
  const r = await fetch(`${ctx.base}/api/jobs/${up.json.job.id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await r.arrayBuffer()).byteLength > 100, true);
  assert.equal((await ctx.api('GET', '/api/jobs/nothex/pdf')).status, 404);
  assert.equal((await ctx.api('GET', '/api/jobs/00000000000000000000000000000000/pdf')).status, 404);
});

test('pdf.js is vendored and served with a JavaScript MIME type (no CDN needed)', async () => {
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const r = await fetch(`${ctx.base}/vendor/pdfjs/${f}`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  }
});

test('Windows printer status parser understands Get-Printer output', () => {
  const { parsePrinterStatus: p } = require('../src/printer/windows');
  assert.equal(p('{"Name":"HP","PrinterStatus":0,"WorkOffline":false}').ready, true);
  assert.equal(p('{"Name":"HP","PrinterStatus":"Normal","WorkOffline":false}').ready, true);
  assert.equal(p('{"Name":"HP","PrinterStatus":5}').detail, 'Printer: out of paper');
  assert.equal(p('{"Name":"HP","PrinterStatus":"PaperJam"}').ready, false);
  assert.equal(p('{"Name":"HP","PrinterStatus":0,"WorkOffline":true}').ready, false);
  assert.equal(p('garbage').ready, false);
});

test('phone photos are auto-rotated upright using EXIF orientation', async () => {
  const { execFileSync } = require('node:child_process');
  try { execFileSync('which', ['pdftoppm']); } catch { return; }
  const os = require('node:os');
  // fixture: left half red, right half blue. orientation 1 = as is; 6 = rotate 90 CW (left -> top); 8 = 90 CCW (left -> bottom); 3 = 180 (left -> right)
  const expected = { 1: ['left', 'red'], 3: ['right', 'red'], 6: ['top', 'red'], 8: ['bottom', 'red'] };
  for (const [o, [where]] of Object.entries(expected)) {
    const up = await ctx.upload(fs.readFileSync(path.join(__dirname, 'fixtures', `exif${o}.jpg`)), `p${o}.jpg`, 'image/jpeg');
    assert.equal(up.status, 201, up.text);
    const pdf = ctx.jobs.get(up.json.job.id).file_path;
    const base = path.join(os.tmpdir(), `exif-${o}-${Date.now()}`);
    execFileSync('pdftoppm', ['-r', '20', '-png', '-singlefile', pdf, base]);
    // read PNG pixels with a tiny decoder via python (PIL) to avoid adding a JS dependency to the test
    const out = execFileSync('python3', ['-c', `
from PIL import Image
im=Image.open("${base}.png").convert("RGB"); w,h=im.size
pts={"left":(w*0.3,h/2),"right":(w*0.7,h/2),"top":(w/2,h*0.35),"bottom":(w/2,h*0.65)}
x,y=pts["${where}"]; r,g,b=im.getpixel((int(x),int(y))); print("red" if r>200 and b<80 else "blue" if b>200 and r<80 else "other", "landscape" if w>h else "portrait")
`]).toString().trim();
    assert.equal(out.split(' ')[0], 'red', `orientation ${o}: expected red at ${where}, got ${out}`);
    assert.equal(out.split(' ')[1], o === '1' || o === '3' ? 'landscape' : 'portrait', `orientation ${o} page shape`);
  }
});

test('Pi edition signs in with a module number, not a chosen username', () => {
  const config = require('../src/config');
  const { Auth } = require('../src/auth');
  const store = {};
  const fake = { get: k => store[k] ?? (k === 'admin_password_hash' ? '' : ''), setInternal: (k, v) => { store[k] = v; } };
  const prev = config.EDITION; config.EDITION = 'pi';
  try {
    const a = new Auth(fake);
    assert.equal(a.identityLabel, 'Module number');
    assert.match(a.identity, /^PN-[A-Z2-9]{6}$/);
    assert.equal(a.identity, new Auth(fake).identity, 'stable across restarts');
    assert.equal(a.setup(a.ensureSetupCode(), 'a long enough password', 'ignored-name').ok, true);
    assert.equal(a.login('ignored-name', 'a long enough password'), null);
    assert.ok(a.login(a.identity.toLowerCase(), 'a long enough password'));
  } finally { config.EDITION = prev; }
});
