'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const H = require('./helpers');

let ctx, have = true;
try { execFileSync('which', ['soffice']); } catch { have = false; }
before(async () => { ctx = await H.start(); ctx.settings.set({ enable_office: true }); });
after(async () => { await ctx.close(); });

test('office: .txt and .docx are converted to PDF via LibreOffice', { skip: !have, timeout: 150000 }, async () => {
  const t = await ctx.upload(Buffer.from('Hello from a text file.\n'.repeat(200)), 'notes.txt', 'text/plain');
  assert.equal(t.status, 201, t.text);
  assert.ok(t.json.job.pages_total >= 1);
  // make a real .docx with LibreOffice itself
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'Docx body\n'.repeat(300));
  execFileSync('soffice', ['--headless', '--convert-to', 'docx', '--outdir', dir, path.join(dir, 'a.txt')], { timeout: 120000, env: { ...process.env, HOME: dir } });
  const d = await ctx.upload(fs.readFileSync(path.join(dir, 'a.docx')), 'a.docx');
  assert.equal(d.status, 201, d.text);
  assert.ok(d.json.job.pages_total >= 1);
  // spreadsheet path (Calc uses a different export filter than Writer)
  fs.writeFileSync(path.join(dir, 'b.csv'), 'a,b,c\n' + '1,2,3\n'.repeat(50));
  execFileSync('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', dir, path.join(dir, 'b.csv')], { timeout: 120000, env: { ...process.env, HOME: dir } });
  const x = await ctx.upload(fs.readFileSync(path.join(dir, 'b.xlsx')), 'b.xlsx');
  assert.equal(x.status, 201, x.text);
  // temp files cleaned
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'tmp')).filter(f => f.startsWith('office-')).length, 0);
});
