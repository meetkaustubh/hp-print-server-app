'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before src/config is first required
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-test-'));
process.env.PRINT_BACKEND = 'dryrun';
process.env.TRUST_PROXY = 'loopback';
process.env.RATE_LIMIT_SCALE = process.env.RATE_LIMIT_SCALE || '1000';

const { PDFDocument } = require('pdf-lib');
const { build } = require('../src/bootstrap');
const { hmacHex } = require('../src/payments/razorpay');

const KEY_ID = 'rzp_test_AAAAAAAAAAAAAA', KEY_SECRET = 'test_secret_value', WEBHOOK_SECRET = 'whsec_test';

async function makePdf(pages = 3) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 750 });
  return Buffer.from(await d.save());
}

function fakeRazorpay() {
  const calls = { orders: [], refunds: [] };
  const state = { refundStatus: 200, n: 0 };
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (status, obj) => ({ ok: status < 300, status, json: async () => obj });
    if (url.endsWith('/orders')) { calls.orders.push(body); return json(200, { id: `order_${++state.n}`, amount: body.amount, currency: body.currency }); }
    if (/\/payments\/.+\/refund$/.test(url)) {
      calls.refunds.push({ url, body });
      return state.refundStatus === 200 ? json(200, { id: `rfnd_${++state.n}` }) : json(500, { error: { description: 'gateway down' } });
    }
    return json(404, {});
  };
  return { fetchImpl, calls, state };
}

async function start(opts = {}) {
  const rz = fakeRazorpay();
  const ctx = build({ fetchImpl: rz.fetchImpl });
  const server = await new Promise(r => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body); if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + url, init);
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const upload = async (buf, name = 'doc.pdf', type = 'application/pdf') => {
    const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name);
    return api('POST', '/api/uploads', fd);
  };
  const close = () => new Promise(r => { ctx.jobs.stop(); server.close(r); });
  return { ...ctx, base, api, upload, rz, close };
}

async function waitFor(fn, ms = 8000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await new Promise(r => setTimeout(r, 50)); }
}

const enableRazorpay = ctx => ctx.settings.set({ payment_mode: 'razorpay', razorpay_key_id: KEY_ID, razorpay_key_secret: KEY_SECRET, razorpay_webhook_secret: WEBHOOK_SECRET });
const sign = (orderId, paymentId, secret = KEY_SECRET) => hmacHex(secret, `${orderId}|${paymentId}`);

module.exports = { start, makePdf, waitFor, enableRazorpay, sign, hmacHex, KEY_ID, KEY_SECRET, WEBHOOK_SECRET };
