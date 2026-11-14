'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./helpers');

let ctx;
before(async () => { ctx = await H.start(); ctx.settings.set({ payment_mode: 'free', printer_name: 'Test' }); });
after(async () => { await ctx.close(); });
const X = { 'X-Requested-With': 'printnimbus' };
async function printed() {
  const up = await ctx.upload(await H.makePdf(1), 'r.pdf');
  const id = up.json.job.id;
  await ctx.api('POST', '/api/checkout', { items: [{ id, copies: 1, color: false, duplex: false }] }, X);
  await H.waitFor(() => ctx.jobs.get(id).status === 'done');
  return id;
}

test('default: finished jobs lose their file', async () => {
  const id = await printed();
  const p = ctx.jobs.get(id).file_path;
  ctx.jobs.dropFile(id);                      // what the timer/sweep does
  assert.equal(fs.existsSync(p), false);
});

test('retain_files keeps the file through the purge timer and sweep; admin can delete it', async () => {
  ctx.settings.set({ retain_files: true, retention_minutes: 1 });
  const id = await printed();
  const p = ctx.jobs.get(id).file_path;
  ctx.jobs.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(Date.now() - 3600_000, id);
  await ctx.jobs.sweep();
  assert.equal(fs.existsSync(p), true, 'sweep must not delete retained files');
  assert.equal(ctx.jobs.dropAllFinished() >= 1, true);
  assert.equal(fs.existsSync(p), false);
});

test('admin file endpoints require login', async () => {
  for (const [m, u] of [['GET', '/api/admin/jobs/x/file'], ['DELETE', '/api/admin/jobs/x/file'], ['POST', '/api/admin/files/delete-all']])
    assert.equal((await ctx.api(m, u, m === 'GET' ? undefined : {}, X)).status, 401);
});
