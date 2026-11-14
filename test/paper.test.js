'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let ctx;
before(async () => { ctx = await H.start(); ctx.settings.set({ payment_mode: 'free', printer_name: 'Test' }); });
after(async () => { await ctx.close(); });
const X = { 'X-Requested-With': 'printnimbus' };
const order = async (pages, extra = {}) => {
  const up = await ctx.upload(await H.makePdf(pages), 'p.pdf');
  return ctx.api('POST', '/api/checkout', { items: [{ id: up.json.job.id, copies: 1, color: false, duplex: false, ...extra }] }, X);
};

test('paper counter: hidden when tracking is off', async () => {
  const cfg = await ctx.api('GET', '/api/config');
  assert.equal(cfg.json.paper_left, null);
});

test('paper counter: orders over the remaining sheets are refused, double-sided counts half', async () => {
  ctx.settings.set({ paper_tracking: true, paper_in_tray: 5 });
  assert.equal((await ctx.api('GET', '/api/config')).json.paper_left, 5);
  const big = await order(6);
  assert.equal(big.status, 409); assert.match(big.json.error, /Only 5 sheets/);
  const duplex = await order(8, { duplex: true });          // 8 pages double-sided = 4 sheets
  assert.equal(duplex.status, 200, JSON.stringify(duplex.json));
});

test('paper counter: printed sheets come off the tray', async () => {
  await H.waitFor(() => ctx.settings.get('paper_in_tray') === 1);
  assert.equal(ctx.settings.get('paper_in_tray'), 1);
  const empty = await order(2);
  assert.equal(empty.status, 409);
  ctx.settings.set({ paper_in_tray: 0 });
  const none = await order(1);
  assert.equal(none.status, 409); assert.match(none.json.error, /out of paper/);
});
