'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const H = require('./helpers');

let ctx;
before(async () => { ctx = await H.start(); H.enableRazorpay(ctx); });
after(async () => { await ctx.close(); });

const printedDir = () => path.join(process.env.DATA_DIR, 'printed');
const printedCount = () => fs.existsSync(printedDir()) ? fs.readdirSync(printedDir()).filter(f => f.endsWith('.pdf')).length : 0;
const defaults = { copies: 1, color: false, duplex: false };

async function upload(pages = 3, name = 'doc.pdf') {
  const up = await ctx.upload(await H.makePdf(pages), name);
  assert.equal(up.status, 201, up.text);
  return up.json.job.id;
}
/** one-document order (the common case) */
async function newOrder(pages = 3, opts = {}) {
  const id = await upload(pages);
  const co = await ctx.api('POST', '/api/checkout', { items: [{ id, ...defaults, copies: 2, ...opts }] });
  return { id, co };
}
const confirmBody = (co, pay, sig) => ({ batch_id: co.json.batch.id, razorpay_order_id: co.json.order.id, razorpay_payment_id: pay, razorpay_signature: sig ?? H.sign(co.json.order.id, pay) });
const pay = (co, p, sig) => ctx.api('POST', '/api/checkout/confirm', confirmBody(co, p, sig));
const status = id => ctx.jobs.get(id).status;

test('price is computed on the server and ignores client-supplied amounts', async () => {
  const { co } = await newOrder(3, { amount: 1, price: 1, price_bw: 0 });
  assert.equal(co.status, 200, co.text);
  assert.equal(co.json.order.amount, 3 * 2 * 500);
  assert.equal(ctx.rz.calls.orders.at(-1).amount, 3000);
  // an extra top-level "amount" is ignored too
  const id = await upload(2);
  const co2 = await ctx.api('POST', '/api/checkout', { amount: 1, items: [{ id, ...defaults }] });
  assert.equal(co2.json.order.amount, 1000);
});

test('colour is priced higher and page ranges reduce price', async () => {
  const { co } = await newOrder(5, { copies: 1, color: true, page_range: '2-3' });
  assert.equal(co.json.order.amount, 2000);
  assert.equal(co.json.batch.jobs[0].pages_selected, 2);
});

test('invalid options are rejected', async () => {
  for (const o of [{ page_range: '0-3' }, { page_range: '1-99' }, { page_range: 'abc' }, { page_range: '3-1' }, { page_range: '1,,2' }, { page_range: '1-2-3' }, { copies: 0 }, { copies: 21 }, { copies: 1.5 }, { copies: 'x' }, { paper: 'Banana' }]) {
    const { co } = await newOrder(3, o);
    assert.equal(co.status, 400, JSON.stringify(o));
  }
  assert.equal((await ctx.api('POST', '/api/checkout', { items: [] })).status, 400);
  assert.equal((await ctx.api('POST', '/api/checkout', {})).status, 400);
  assert.equal((await ctx.api('POST', '/api/checkout', { items: [{ id: 'nope', ...defaults }] })).status, 404);
});

test('multi-document order: one payment, per-document colour/copies/pages, all print together', async () => {
  const a = await upload(4, 'report.pdf'), b = await upload(2, 'photos.pdf'), c = await upload(1, 'ticket.pdf');
  const before = printedCount();
  const co = await ctx.api('POST', '/api/checkout', { items: [
    { id: a, copies: 1, color: false, duplex: true, page_range: '1-3' },   // 3 pages b/w   = 1500
    { id: b, copies: 2, color: true, duplex: false },                       // 2x2 colour    = 4000
    { id: c, copies: 1, color: false, duplex: false },                      // 1 page b/w    = 500
  ] });
  assert.equal(co.status, 200, co.text);
  assert.equal(co.json.order.amount, 1500 + 4000 + 500);
  assert.equal(co.json.batch.jobs.length, 3);
  assert.deepEqual(co.json.batch.jobs.map(j => j.amount), [1500, 4000, 500]);
  assert.equal((await pay(co, 'pay_multi')).status, 200);
  await H.waitFor(() => [a, b, c].every(id => status(id) === 'done'));
  assert.equal(printedCount(), before + 3);
  const metas = fs.readdirSync(printedDir()).filter(f => f.endsWith('.json')).sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0])).slice(-3).map(f => JSON.parse(fs.readFileSync(path.join(printedDir(), f))));
  assert.deepEqual(metas.map(m => [m.color, m.duplex, m.copies, m.pages]), [[false, true, 1, '1-3'], [true, false, 2, ''], [false, false, 1, '']]);
  const view = (await ctx.api('GET', `/api/batches/${co.json.batch.id}`)).json.batch;
  assert.equal(view.finished, true); assert.ok(view.jobs.every(j => j.status === 'done'));
});

test('document limit per order is enforced', async () => {
  ctx.settings.set({ max_docs: 2 });
  const ids = [await upload(1), await upload(1), await upload(1)];
  assert.equal((await ctx.api('POST', '/api/checkout', { items: ids.map(id => ({ id, ...defaults })) })).status, 400);
  // same document twice is not allowed (would double-charge/print one file under one id)
  assert.equal((await ctx.api('POST', '/api/checkout', { items: [{ id: ids[0], ...defaults }, { id: ids[0], ...defaults }] })).status, 404);
  ctx.settings.set({ max_docs: 10 });
});

test('minimum charge applies to the whole order', async () => {
  ctx.settings.set({ min_charge: 2000 });
  const { co } = await newOrder(1, { copies: 1 });
  assert.equal(co.json.order.amount, 2000);
  ctx.settings.set({ min_charge: 0 });
});

test('nothing prints until payment is verified; legacy open endpoints are gone', async () => {
  const before = printedCount();
  const { id } = await newOrder(2);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(status(id), 'awaiting_payment');
  assert.equal(printedCount(), before);
  for (const p of ['/print', '/upload', '/refund']) assert.equal((await ctx.api('POST', p, {})).status, 404);
});

test('forged / wrong signatures are rejected and nothing prints', async () => {
  const { id, co } = await newOrder(2);
  const o = co.json.order.id;
  const attempts = [
    confirmBody(co, 'pay_1', 'deadbeef'),
    confirmBody(co, 'pay_1', H.sign(o, 'pay_1', 'wrong-secret')),
    confirmBody(co, 'pay_OTHER', H.sign(o, 'pay_1')),
    { ...confirmBody(co, 'pay_1'), razorpay_order_id: 'order_999' },
    { batch_id: co.json.batch.id, razorpay_order_id: o },
    {},
  ];
  for (const b of attempts) assert.equal((await ctx.api('POST', '/api/checkout/confirm', b)).status >= 400, true);
  assert.equal(status(id), 'awaiting_payment');
});

test('a valid payment for order A cannot be replayed onto order B', async () => {
  const a = await newOrder(2), b = await newOrder(2);
  assert.equal((await pay(a.co, 'pay_replayA')).status, 200);
  const replay = await ctx.api('POST', '/api/checkout/confirm', { batch_id: b.co.json.batch.id, razorpay_order_id: a.co.json.order.id, razorpay_payment_id: 'pay_replayA', razorpay_signature: H.sign(a.co.json.order.id, 'pay_replayA') });
  assert.equal(replay.status, 400);
  assert.equal(status(b.id), 'awaiting_payment');
});

test('valid payment prints once; duplicate confirm / webhook does not double print', async () => {
  const before = printedCount();
  const { id, co } = await newOrder(2);
  assert.equal((await pay(co, 'pay_good1')).status, 200);
  assert.equal((await pay(co, 'pay_good1')).status, 200);
  await H.waitFor(() => status(id) === 'done');
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_good1', order_id: co.json.order.id, amount: 2000, currency: 'INR', status: 'captured' } } } });
  assert.equal((await ctx.api('POST', '/api/razorpay/webhook', evt, { 'x-razorpay-signature': H.hmacHex(H.WEBHOOK_SECRET, evt) })).status, 200);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(printedCount(), before + 1);
  assert.ok((await ctx.api('GET', `/api/jobs/${id}`)).json.job.pickup_message);
});

test('webhook: bad signature rejected; mismatched amount ignored; valid one prints', async () => {
  const { id, co } = await newOrder(2);
  const o = co.json.order.id;
  const mk = amount => JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh1', order_id: o, amount, currency: 'INR', status: 'captured' } } } });
  assert.equal((await ctx.api('POST', '/api/razorpay/webhook', mk(2000), { 'x-razorpay-signature': 'nope' })).status, 400);
  const under = mk(1);
  await ctx.api('POST', '/api/razorpay/webhook', under, { 'x-razorpay-signature': H.hmacHex(H.WEBHOOK_SECRET, under) });
  assert.equal(status(id), 'awaiting_payment');
  const good = mk(2000);
  await ctx.api('POST', '/api/razorpay/webhook', good, { 'x-razorpay-signature': H.hmacHex(H.WEBHOOK_SECRET, good) });
  await H.waitFor(() => status(id) === 'done');
});

test('print failure triggers one automatic full refund; a second refund is refused', async () => {
  const { id, co } = await newOrder(2);
  ctx.printer._state.fail = true;
  await pay(co, 'pay_fail1');
  await H.waitFor(() => status(id) === 'refunded');
  ctx.printer._state.fail = false;
  const r = ctx.rz.calls.refunds.filter(x => x.url.includes('pay_fail1'));
  assert.equal(r.length, 1); assert.equal(r[0].body.amount, 2000);
  assert.equal((await ctx.jobs.refund(id, 'again')).ok, false);
  assert.equal(ctx.rz.calls.refunds.filter(x => x.url.includes('pay_fail1')).length, 1);
});

test('multi-document: when one document fails, only that document is refunded (partial refund)', async () => {
  const a = await upload(2, 'good.pdf'), b = await upload(3, 'bad.pdf');
  const co = await ctx.api('POST', '/api/checkout', { items: [{ id: a, ...defaults }, { id: b, ...defaults, color: true }] }); // 1000 + 3000
  ctx.printer._state.failIf = job => job.pages === '' && job.color === true;
  await pay(co, 'pay_partial');
  await H.waitFor(() => status(a) === 'done' && status(b) === 'refunded');
  ctx.printer._state.failIf = null;
  const r = ctx.rz.calls.refunds.filter(x => x.url.includes('pay_partial'));
  assert.equal(r.length, 1); assert.equal(r[0].body.amount, 3000);
  const v = (await ctx.api('GET', `/api/batches/${co.json.batch.id}`)).json.batch;
  assert.equal(v.refunded_amount, 3000); assert.equal(v.amount, 4000); assert.equal(v.finished, true);
});

test('refund gateway failure shows as refund_failed; operator retry works', async () => {
  const { id, co } = await newOrder(2);
  ctx.printer._state.fail = true; ctx.rz.state.refundStatus = 500;
  await pay(co, 'pay_fail2');
  await H.waitFor(() => status(id) === 'refund_failed');
  ctx.printer._state.fail = false; ctx.rz.state.refundStatus = 200;
  assert.equal((await ctx.api('GET', `/api/jobs/${id}`)).json.job.payment_id, 'pay_fail2');
  assert.equal((await ctx.jobs.refund(id, 'retry')).ok, true);
  assert.equal(status(id), 'refunded');
});

test('paid job waits for a stopped printer, then refunds after the grace period', async () => {
  const { id, co } = await newOrder(2);
  ctx.printer._state.ready = false;
  await pay(co, 'pay_stopped');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(status(id), 'queued');
  ctx.db.prepare('UPDATE jobs SET queued_at=? WHERE id=?').run(Date.now() - 4 * 60_000, id);
  await ctx.jobs.processQueue();
  assert.equal(status(id), 'refunded');
  ctx.printer._state.ready = true;
});

test('payment after the upload expired is refunded, not lost', async () => {
  const { id, co } = await newOrder(2);
  ctx.db.prepare('UPDATE jobs SET created_at=? WHERE id=?').run(Date.now() - 2 * 3600_000, id);
  await ctx.jobs.sweep();
  assert.equal(status(id), 'expired');
  await pay(co, 'pay_late');
  await H.waitFor(() => status(id) === 'refunded');
});

test('customer edits the cart and pays the OLD order: full refund of the stale order', async () => {
  const id = await upload(2);
  const first = await ctx.api('POST', '/api/checkout', { items: [{ id, ...defaults }] });         // order 1 (1000)
  const second = await ctx.api('POST', '/api/checkout', { items: [{ id, ...defaults, copies: 3 }] }); // order 2 (3000) replaces it
  assert.notEqual(first.json.order.id, second.json.order.id);
  const r = await pay(first, 'pay_stale');
  assert.equal(r.status, 200);
  await H.waitFor(() => ctx.rz.calls.refunds.some(x => x.url.includes('pay_stale')));
  assert.equal(ctx.rz.calls.refunds.find(x => x.url.includes('pay_stale')).body.amount, 1000);
  assert.equal(status(id), 'awaiting_payment');                    // the live order is untouched
  await pay(first, 'pay_stale');                                    // duplicate: no second refund
  assert.equal(ctx.rz.calls.refunds.filter(x => x.url.includes('pay_stale')).length, 1);
  assert.equal((await pay(second, 'pay_current')).status, 200);
  await H.waitFor(() => status(id) === 'done');
});

test('Razorpay not configured blocks paid checkout', async () => {
  const c2 = await H.start();
  c2.settings.set({ payment_mode: 'razorpay', razorpay_key_id: '', razorpay_key_secret: '' });
  const up = await c2.upload(await H.makePdf(1));
  const co = await c2.api('POST', '/api/checkout', { items: [{ id: up.json.job.id, ...defaults }] });
  assert.equal(co.status, 503);
  await c2.close();
});

test('free mode: checkout queues immediately and prints', async () => {
  const c2 = await H.start();
  c2.settings.set({ payment_mode: 'free', razorpay_key_id: '', razorpay_key_secret: '' });
  const up = await c2.upload(await H.makePdf(1));
  const co = await c2.api('POST', '/api/checkout', { items: [{ id: up.json.job.id, ...defaults }] });
  assert.equal(co.status, 200); assert.equal(co.json.order, undefined);
  await H.waitFor(() => c2.jobs.get(up.json.job.id).status === 'done');
  await c2.close();
});
