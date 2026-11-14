'use strict';
// Development/demo backend: "prints" by copying the PDF into DATA_DIR/printed.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

module.exports = function createDryRunPrinter() {
  let n = 0;
  const state = { ready: true, fail: false };
  return {
    name: 'dryrun',
    _state: state, // tests can flip this
    async list() { return [{ name: 'DryRun-Printer', isDefault: true }]; },
    async status() { return state.ready ? { ready: true, state: 'idle', detail: 'dry-run printer (nothing is physically printed)' } : { ready: false, state: 'stopped', detail: 'simulated outage' }; },
    async submit(job) {
      if (state.fail || (state.failIf && state.failIf(job))) throw new Error('simulated print failure');
      const dir = path.join(config.DATA_DIR, 'printed'); fs.mkdirSync(dir, { recursive: true });
      const id = `DryRun-${++n}`;
      fs.copyFileSync(job.file, path.join(dir, `${id}.pdf`));
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...job, file: undefined }, null, 2));
      return id;
    },
    async isActive() { return false; },
    async cancel() {},
    async testPage() { return 'dry-run test page'; },
  };
};
