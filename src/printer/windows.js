'use strict';
// Windows laptop backend. Printing is done by pdf-to-printer (bundles SumatraPDF); status and queue
// checks use PowerShell's PrintManagement cmdlets (Windows 8 / Server 2012 and newer).
// Printer names and document names are passed through environment variables, never interpolated into
// the PowerShell command text, so they cannot inject commands.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function ps(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, ...env } },
      (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr })) : resolve(stdout.toString().trim()));
  });
}

// Microsoft's PrinterStatus enum values that mean "do not send paper here"
const BAD_STATES = new Map([[1, 'paused'], [2, 'error'], [4, 'paper jam'], [5, 'out of paper'], [7, 'paper problem'], [8, 'offline'], [12, 'output bin full'], [13, 'not available'], [19, 'out of toner'], [21, 'needs attention'], [22, 'out of memory'], [23, 'door open'], [24, 'unknown']]);
const BAD_WORDS = /paused|error|jam|paperout|paperproblem|offline|binfull|notavailable|notoner|userintervention|outofmemory|dooropen|serverunknown/i;

/** Pure parser for `Get-Printer | ConvertTo-Json` output (exported for tests). */
function parsePrinterStatus(json) {
  let p; try { p = JSON.parse(json); } catch { return { ready: false, state: 'unknown', detail: 'Could not read printer status' }; }
  if (Array.isArray(p)) p = p[0];
  if (!p) return { ready: false, state: 'missing', detail: 'Printer not found' };
  const st = p.PrinterStatus;
  if (p.WorkOffline === true) return { ready: false, state: 'stopped', detail: 'Printer is offline' };
  const bad = typeof st === 'number' ? BAD_STATES.get(st) : (BAD_WORDS.test(String(st)) ? String(st) : null);
  if (bad) return { ready: false, state: 'stopped', detail: `Printer: ${bad}` };
  const printing = st === 11 || /printing/i.test(String(st));
  return { ready: true, state: printing ? 'printing' : 'idle', detail: `${p.Name || 'Printer'}: ${printing ? 'printing' : 'ready'}` };
}

module.exports = function createWindowsPrinter() {
  const lib = () => {
    try { return require('pdf-to-printer'); }
    catch { throw new Error('The "pdf-to-printer" package is not installed. Run "npm install" on the Windows laptop.'); }
  };

  async function list() {
    try {
      const l = lib();
      const [printers, def] = await Promise.all([l.getPrinters(), l.getDefaultPrinter().catch(() => null)]);
      return printers.map(p => ({ name: p.name, isDefault: !!def && def.name === p.name }));
    } catch { return []; }
  }

  async function status(name) {
    if (!name) return { ready: false, state: 'missing', detail: 'No printer selected' };
    try {
      const out = await ps('Get-Printer -Name $env:PN_PRINTER | Select-Object Name,PrinterStatus,WorkOffline | ConvertTo-Json -Compress', { PN_PRINTER: name });
      return parsePrinterStatus(out);
    } catch (e) {
      return { ready: false, state: 'missing', detail: String(e.stderr || e.message || '').trim().slice(0, 200) };
    }
  }

  async function submit({ printer, file, copies, color, duplex, paper, pages }) {
    const opts = { printer, copies, monochrome: !color, side: duplex ? 'duplexlong' : 'simplex', paperSize: paper, scale: 'shrink' };
    if (pages) opts.pages = pages;
    await lib().print(file, opts);
    // Spooler job names normally contain the file name, which is a random hex string we can look for.
    return `win:${printer}:${path.basename(file, '.pdf')}`;
  }

  const splitRef = ref => ({ printer: ref.slice(4, ref.lastIndexOf(':')), doc: ref.slice(ref.lastIndexOf(':') + 1) });

  /** true while a spooler job for our file is still queued/printing */
  async function isActive(jobRef) {
    const { printer, doc } = splitRef(jobRef);
    try {
      const out = await ps('@(Get-PrintJob -PrinterName $env:PN_PRINTER | Where-Object { $_.DocumentName -like ("*" + $env:PN_DOC + "*") }).Count', { PN_PRINTER: printer, PN_DOC: doc });
      return Number(out) > 0;
    } catch { return false; }
  }

  async function cancel(jobRef) {
    const { printer, doc } = splitRef(jobRef);
    try { await ps('Get-PrintJob -PrinterName $env:PN_PRINTER | Where-Object { $_.DocumentName -like ("*" + $env:PN_DOC + "*") } | Remove-PrintJob', { PN_PRINTER: printer, PN_DOC: doc }); } catch {}
  }

  async function testPage(printer) {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    const pg = d.addPage([595, 842]);
    pg.drawText('Print Nimbus test page', { x: 60, y: 760, size: 24, font: f });
    pg.drawText(new Date().toISOString(), { x: 60, y: 730, size: 12, font: f });
    pg.drawText('If you can read this, printing works.', { x: 60, y: 710, size: 12, font: f });
    const file = path.join(os.tmpdir(), `pn-test-${Date.now()}.pdf`);
    fs.writeFileSync(file, await d.save());
    try { await lib().print(file, { printer, scale: 'shrink' }); } finally { fs.rmSync(file, { force: true }); }
  }

  return { name: 'windows', list, status, submit, isActive, cancel, testPage };
};
module.exports.parsePrinterStatus = parsePrinterStatus;
