#!/usr/bin/env node
// Runs Print Nimbus and keeps it in sync with GitHub.
// Every SYNC_INTERVAL seconds (default 60) it checks origin/<branch>. When there are new commits it
// fast-forwards the checkout, runs `npm ci` if the dependencies changed, and restarts the app.
// It never touches .env or data/ (git-ignored) and never overwrites local edits: if the pull can't
// fast-forward cleanly it keeps running the current version and prints why.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const BRANCH = process.env.SYNC_BRANCH || 'main';
const EVERY = Math.max(15, Number(process.env.SYNC_INTERVAL) || 60) * 1000;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const log = (...a) => console.log(`[sync ${new Date().toLocaleTimeString()}]`, ...a);

function git(...args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); }
if (git('rev-parse', '--git-dir').status !== 0) { console.error('This folder is not a git clone, so it cannot sync. Clone the repository with git instead of using a zip.'); process.exit(1); }

let child = null, stopping = false, restarting = false;
function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: root, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => {
    child = null;
    if (stopping) process.exit(0);
    if (restarting) { restarting = false; return start(); }
    log(`app exited (code ${code}); restarting in 5s`); setTimeout(start, 5000);
  });
}
function restart() {
  if (!child) return start();
  const old = child; restarting = true; old.kill('SIGTERM');
  setTimeout(() => { if (old.exitCode === null && old.signalCode === null) old.kill('SIGKILL'); }, 8000);
}

function check() {
  const f = git('fetch', '--quiet', 'origin', BRANCH);
  if (f.status !== 0) return log('could not reach GitHub (will retry):', (f.stderr || '').trim().split('\n')[0]);
  const local = git('rev-parse', 'HEAD').stdout.trim(), remote = git('rev-parse', `origin/${BRANCH}`).stdout.trim();
  if (!remote || local === remote) return;
  const cur = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (cur !== BRANCH) return log(`checkout is on "${cur}", not "${BRANCH}"; not updating`);
  const before = git('rev-parse', 'HEAD:package-lock.json').stdout.trim();
  const m = git('merge', '--ff-only', `origin/${BRANCH}`);
  if (m.status !== 0) return log('update skipped, cannot fast-forward (local changes?):', (m.stderr || m.stdout).trim().split('\n')[0]);
  log(`updated ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`);
  if (git('rev-parse', 'HEAD:package-lock.json').stdout.trim() !== before) {
    log('dependencies changed, installing...');
    const i = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (i.status !== 0) return log('npm install failed; keeping the running version');
  }
  log('restarting the app'); restart();
}

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; child ? child.kill('SIGTERM') : process.exit(0); });
log(`syncing with origin/${BRANCH} every ${EVERY / 1000}s`);
start(); check(); setInterval(check, EVERY);
