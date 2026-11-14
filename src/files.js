'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PDFDocument, degrees } = require('pdf-lib');
const config = require('./config');

const PAPER = { A4: [595.28, 841.89], Letter: [612, 792], A3: [841.89, 1190.55], Legal: [612, 1008] };
const OFFICE_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);

class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.userFacing = true; this.status = status; }
}

/** Identify a file by content, never by what the browser claims. */
async function sniff(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fh.read(buf, 0, 2048, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.subarray(0, 1024).includes('%PDF-')) return 'pdf';
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip-office';
    if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole-office';
    if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
    if (bytesRead > 0 && !head.includes(0)) return 'text';
    return 'unknown';
  } finally { await fh.close(); }
}

let officeChain = Promise.resolve(); // only one LibreOffice at a time: it is RAM-hungry

/** Run soffice in its own process group so a timeout kills soffice.bin too, not just the launcher. */
function runSoffice(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(config.SOFFICE_BIN, args, { env, detached: true, stdio: 'ignore' });
    let done = false;
    const finish = ok => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', code => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finish(code === 0); });
  });
}

function convertOffice(inputPath, ext) {
  const run = async () => {
    const work = await fsp.mkdtemp(path.join(config.DATA_DIR, 'tmp', 'office-'));
    try {
      const src = path.join(work, `input.${ext}`);
      await fsp.copyFile(inputPath, src);
      await runSoffice([
        `-env:UserInstallation=file://${work}/profile`,
        '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
        '--convert-to', 'pdf', '--outdir', work, src,
      ], { PATH: process.env.PATH, HOME: work, LANG: 'C.UTF-8' }, 150_000);
      const out = path.join(work, 'input.pdf');
      if (!fs.existsSync(out)) throw new UserError('We could not convert that document. Try exporting it to PDF first.', 422);
      const dest = path.join(config.DATA_DIR, 'tmp', `${crypto.randomBytes(8).toString('hex')}.pdf`);
      await fsp.copyFile(out, dest);
      return dest;
    } finally { await fsp.rm(work, { recursive: true, force: true }).catch(() => {}); }
  };
  const p = officeChain.then(run, run);
  officeChain = p.catch(() => {});
  return p;
}

/** EXIF orientation (1-8) of a JPEG, or 1 when absent/unreadable. Phones store photos "sideways" plus this flag. */
function jpegOrientation(buf) {
  try {
    let o = 2;
    while (o + 4 < buf.length && buf[o] === 0xff) {
      const marker = buf[o + 1], len = buf.readUInt16BE(o + 2);
      if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
        const t = o + 10, le = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = p => le ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
        const u32 = p => le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        const ifd = t + u32(t + 4), n = u16(ifd);
        for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; } }
        return 1;
      }
      if (marker === 0xda) break;
      o += 2 + len;
    }
  } catch { /* fall through */ }
  return 1;
}

async function imageToPdf(filePath, kind, paper) {
  const bytes = await fsp.readFile(filePath);
  const pdf = await PDFDocument.create();
  const img = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const orient = kind === 'jpg' ? jpegOrientation(bytes) : 1;
  // Upright size after applying the EXIF rotation (5-8 swap width/height)
  const swap = orient >= 5;
  const iw = swap ? img.height : img.width, ih = swap ? img.width : img.height;
  let [pw, ph] = PAPER[paper] || PAPER.A4;
  if (iw > ih) [pw, ph] = [ph, pw];
  const margin = 28;
  const scale = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih);
  const bw = iw * scale, bh = ih * scale;              // bounding box of the upright picture
  const bx = (pw - bw) / 2, by = (ph - bh) / 2;
  const w = img.width * scale, h = img.height * scale; // drawn (pre-rotation) size
  const page = pdf.addPage([pw, ph]);
  // Mirrored orientations (2,4,5,7) are rare; they are treated as their non-mirrored rotation.
  if (orient === 3 || orient === 4) page.drawImage(img, { x: bx + bw, y: by + bh, width: w, height: h, rotate: degrees(180) });
  else if (orient === 6 || orient === 5) page.drawImage(img, { x: bx, y: by + bh, width: w, height: h, rotate: degrees(-90) });
  else if (orient === 8 || orient === 7) page.drawImage(img, { x: bx + bw, y: by, width: w, height: h, rotate: degrees(90) });
  else page.drawImage(img, { x: bx, y: by, width: w, height: h });
  return Buffer.from(await pdf.save());
}

async function countPdfPages(filePath) {
  const bytes = await fsp.readFile(filePath);
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount();
  } catch (e) {
    if (/encrypted/i.test(e.message)) throw new UserError('This PDF is password-protected. Please remove the password and try again.', 422);
    throw new UserError('That PDF looks damaged or unsupported.', 422);
  }
}

/**
 * Take an uploaded temp file and return { pdfPath, pages }. The result is always a PDF we generated
 * or validated, stored under a random name in DATA_DIR/jobs.
 */
async function normalise({ tmpPath, originalName, settings }) {
  const ext = (path.extname(originalName || '').slice(1) || '').toLowerCase();
  const allowed = new Set(settings.acceptedExtensions());
  if (!allowed.has(ext)) throw new UserError(`.${ext || '?'} files are not supported. Allowed: ${[...allowed].join(', ')}.`, 415);

  const kind = await sniff(tmpPath);
  const okPairs = {
    pdf: kind === 'pdf',
    jpg: kind === 'jpg', jpeg: kind === 'jpg', png: kind === 'png',
  };
  const isOffice = OFFICE_EXT.has(ext);
  if (!isOffice && !okPairs[ext]) throw new UserError('The file content does not match its extension.', 415);
  if (isOffice) {
    const ok = (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(ext) && kind === 'zip-office')
      || (['doc', 'xls', 'ppt'].includes(ext) && kind === 'ole-office')
      || (ext === 'rtf' && kind === 'rtf') || (ext === 'txt' && kind === 'text');
    if (!ok) throw new UserError('The file content does not match its extension.', 415);
  }

  const out = path.join(config.DATA_DIR, 'jobs', `${crypto.randomBytes(16).toString('hex')}.pdf`);
  const cleanup = [];
  try {
    let pdfSource = tmpPath;
    if (kind === 'jpg' || kind === 'png') {
      await fsp.writeFile(out, await imageToPdf(tmpPath, kind, settings.get('default_paper')), { mode: 0o600 });
    } else if (isOffice) {
      pdfSource = await convertOffice(tmpPath, ext);
      cleanup.push(pdfSource);
      await fsp.copyFile(pdfSource, out);
    } else {
      await fsp.copyFile(tmpPath, out);
    }
    await fsp.chmod(out, 0o600);
    const pages = await countPdfPages(out);
    if (pages < 1) throw new UserError('That document has no pages.', 422);
    return { pdfPath: out, pages };
  } catch (e) {
    await fsp.rm(out, { force: true });
    throw e;
  } finally {
    for (const f of cleanup) await fsp.rm(f, { force: true }).catch(() => {});
  }
}

module.exports = { normalise, UserError, PAPER, jpegOrientation };
