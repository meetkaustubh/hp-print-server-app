'use strict';
// Talks to CUPS through its command line tools (lp, lpstat, cancel). All calls use execFile with
// an argument array, so user input can never reach a shell.
const { execFile } = require('node:child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout.toString());
    });
  });
}

module.exports = function createCupsPrinter() {
  async function list() {
    let names = [];
    try {
      const out = await run('lpstat', ['-e']);               // destinations
      names = out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
    let defaultName = '';
    try { defaultName = (await run('lpstat', ['-d'])).split(':')[1]?.trim() || ''; } catch {}
    return names.map(n => ({ name: n, isDefault: n === defaultName }));
  }

  /** -> { ready: bool, state: 'idle'|'printing'|'stopped'|'missing'|'unknown', detail } */
  async function status(name) {
    if (!name) return { ready: false, state: 'missing', detail: 'No printer selected' };
    try {
      const out = await run('lpstat', ['-p', name, '-l']);
      const first = out.split('\n')[0] || '';
      if (/disabled|stopped/i.test(first)) return { ready: false, state: 'stopped', detail: first.trim() };
      if (/now printing/i.test(first)) return { ready: true, state: 'printing', detail: first.trim() };
      if (/idle/i.test(first)) return { ready: true, state: 'idle', detail: first.trim() };
      return { ready: true, state: 'unknown', detail: first.trim() };
    } catch (e) {
      return { ready: false, state: 'missing', detail: (e.stderr || e.message || '').trim().slice(0, 200) };
    }
  }

  async function submit({ printer, file, copies, color, duplex, paper, pages, title }) {
    const args = ['-d', printer, '-n', String(copies), '-t', title.slice(0, 60), '-o', `media=${paper}`,
      '-o', `print-color-mode=${color ? 'color' : 'monochrome'}`,
      '-o', `sides=${duplex ? 'two-sided-long-edge' : 'one-sided'}`, '-o', 'print-scaling=auto'];
    if (pages) args.push('-o', `page-ranges=${pages}`);
    args.push('--', file);
    const out = await run('lp', args);
    const m = out.match(/request id is (\S+)/);
    if (!m) throw new Error('CUPS did not return a job id');
    return m[1];
  }

  /** true while CUPS still has the job queued/printing */
  async function isActive(cupsJob) {
    const out = await run('lpstat', ['-W', 'not-completed', '-o']);
    return out.split('\n').some(l => l.startsWith(cupsJob + ' '));
  }
  async function cancel(cupsJob) { try { await run('cancel', [cupsJob]); } catch {} }

  async function testPage(printer) {
    // Plain-text test page through the same path as real jobs
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
    const f = path.join(os.tmpdir(), `pn-test-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(f, `Print Nimbus test page\n${new Date().toISOString()}\nIf you can read this, printing works.\n`);
    try { return await run('lp', ['-d', printer, '-t', 'Print Nimbus test', '--', f]); }
    finally { fs.rmSync(f, { force: true }); }
  }

  return { name: 'cups', list, status, submit, isActive, cancel, testPage };
};
