'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let ctx;
before(async () => { ctx = await H.start(); ctx.settings.set({ payment_mode: 'free', printer_name: 'Test', price_bw: 100, price_color: 500, min_charge: 0, max_pages: 200 }); });
after(async () => { await ctx.close(); });
const X = { 'X-Requested-With': 'printnimbus' };
const upload = async pages => (await ctx.upload(await H.makePdf(pages), 'f.pdf')).json.job.id;
const checkout = (items, hdr = X) => ctx.api('POST', '/api/checkout', { items }, hdr);

test('colour billing per page: only pages with colour pay the colour rate', async () => {
  ctx.settings.set({ color_billing: 'per_page', payment_mode: 'razorpay' }); H.enableRazorpay(ctx);
  const id = await upload(10);
  const r = await checkout([{ id, copies: 1, color: true, duplex: false, colour_pages: { 2: 0.05, 3: 0.05, 99: 1 } }]);   // 99 is not a page: ignored
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.batch.amount, 2 * 500 + 8 * 100);
  const id2 = await upload(10);
  const all = await checkout([{ id: id2, copies: 2, color: true, duplex: false }]);                    // nothing reported: whole job at colour rate
  assert.equal(all.json.batch.amount, 10 * 2 * 500);
});

test('colour billing "all": every page at colour rate', async () => {
  ctx.settings.set({ color_billing: 'all' });
  const id = await upload(4);
  assert.equal((await checkout([{ id, copies: 1, color: true, duplex: false, colour_pages: { 1: 0.05 } }])).json.batch.amount, 4 * 500);
});

test('bulk rate applies to the whole order once it reaches the page threshold', async () => {
  ctx.settings.set({ bulk_min_pages: 20, bulk_price_bw: 60, bulk_price_color: 300, color_billing: 'all' });
  const a = await upload(8), b = await upload(5);
  const small = await checkout([{ id: a, copies: 1, color: false, duplex: false }, { id: b, copies: 1, color: true, duplex: false }]);   // 13 pages: normal
  assert.equal(small.json.batch.amount, 8 * 100 + 5 * 500);
  const c = await upload(8), d = await upload(5);
  const big = await checkout([{ id: c, copies: 2, color: false, duplex: false }, { id: d, copies: 1, color: true, duplex: false }]);     // 21 pages: bulk
  assert.equal(big.json.batch.amount, 16 * 60 + 5 * 300);
  ctx.settings.set({ bulk_min_pages: 0 });
});

test('admin print is free and needs a valid upload', async () => {
  ctx.settings.set({ payment_mode: 'razorpay' });
  const id = await upload(3);
  const noLogin = await ctx.api('POST', '/api/admin/print', { id }, X);
  assert.equal(noLogin.status, 401);
  const job = ctx.jobs.adminPrint(id, { copies: 2, color: false, duplex: false });
  assert.equal(job.amount, 0);
  await H.waitFor(() => ctx.jobs.get(id).status === 'done');
  assert.equal(ctx.jobs.get(id).source, 'admin');
  assert.equal(ctx.jobs.stats().total_revenue >= 0, true);
});

test('test mode: simulated payment, success and failure paths, refund outcomes, no real revenue', async () => {
  ctx.settings.set({ test_mode: true, test_print_outcome: 'success', payment_mode: 'razorpay' });
  const run = async () => {
    const id = await upload(2);
    const r = await checkout([{ id, copies: 1, color: false, duplex: false }]);
    assert.equal(r.status, 200); assert.equal(r.json.order.test, true); assert.match(r.json.order.id, /^order_test_/);
    return { id, batch: r.json.batch.id };
  };
  // declined payment
  let t = await run();
  assert.equal((await ctx.api('POST', '/api/checkout/test-pay', { batch_id: t.batch, outcome: 'fail' }, X)).json.ok, false);
  assert.equal(ctx.jobs.get(t.id).status, 'awaiting_payment');
  // paid + printed
  assert.equal((await ctx.api('POST', '/api/checkout/test-pay', { batch_id: t.batch, outcome: 'success' }, X)).json.ok, true);
  await H.waitFor(() => ctx.jobs.get(t.id).status === 'done', 8000);
  // print fails -> automatic simulated refund
  ctx.settings.set({ test_print_outcome: 'fail' });
  t = await run(); await ctx.api('POST', '/api/checkout/test-pay', { batch_id: t.batch, outcome: 'success' }, X);
  await H.waitFor(() => ctx.jobs.get(t.id).status === 'refunded', 8000);
  assert.match(ctx.jobs.get(t.id).refund_id, /^rfnd_test_/);
  // print fails and refund fails -> needs attention
  ctx.settings.set({ test_refund_outcome: 'fail' });
  t = await run(); await ctx.api('POST', '/api/checkout/test-pay', { batch_id: t.batch, outcome: 'success' }, X);
  await H.waitFor(() => ctx.jobs.get(t.id).status === 'refund_failed', 8000);
  assert.equal(ctx.jobs.stats().total_revenue, 0, 'test payments never count as revenue');
  // test endpoints are dead when test mode is off
  ctx.settings.set({ test_mode: false });
  assert.equal((await ctx.api('POST', '/api/checkout/test-pay', { batch_id: t.batch, outcome: 'success' }, X)).status, 403);
});

test('heavy colour surcharge: +20% / +50% / +100% by how much of the page is coloured', async () => {
  ctx.settings.set({ payment_mode: 'razorpay', color_billing: 'per_page', bulk_min_pages: 0 });
  const id = await upload(6);
  // page1 light (5%), page2 medium (15%), page3 medium-high (40%), page4 high (80%); pages 5-6 no colour
  const r = await checkout([{ id, copies: 1, color: true, duplex: false, colour_pages: { 1: 0.05, 2: 0.15, 3: 0.4, 4: 0.8 } }]);
  assert.equal(r.json.batch.amount, 500 + 600 + 750 + 1000 + 2 * 100);
  // billing "all": uncoloured pages also pay the colour price
  ctx.settings.set({ color_billing: 'all' });
  const id2 = await upload(3);
  const r2 = await checkout([{ id: id2, copies: 2, color: true, duplex: false, colour_pages: { 1: 0.8 } }]);
  assert.equal(r2.json.batch.amount, 2 * (1000 + 500 + 500));
  // an extra of 0 switches a level off
  ctx.settings.set({ color_high_extra: 0 });
  const id3 = await upload(1);
  assert.equal((await checkout([{ id: id3, copies: 1, color: true, duplex: false, colour_pages: { 1: 0.8 } }])).json.batch.amount, 750);
});
