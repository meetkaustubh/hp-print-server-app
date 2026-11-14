'use strict';
const config = require('../config');
module.exports = function createPrinter() {
  switch (config.PRINT_BACKEND) {
    case 'dryrun': return require('./dryrun')();
    case 'windows': return require('./windows')();
    case 'cups': return require('./cups')();
    default: throw new Error(`Unknown PRINT_BACKEND "${config.PRINT_BACKEND}" (use windows, cups or dryrun)`);
  }
};
