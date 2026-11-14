'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const show = (el, on = true) => { el.hidden = !on; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const h = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } kids.flat().forEach(c => c != null && e.append(c)); return e; };

  let cfg = null, docs = [], pollTimer = null, working = false, busy = false, pdfjs = null, pdfjsFailed = false, batchId = null;
  const KEY_BATCH = 'pn_batch', KEY_CART = 'pn_cart';
  const TERMINAL = ['done', 'failed', 'refunded', 'refund_failed', 'expired'];

  const money = paise => { const v = paise / 100; return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cfg?.currency || 'INR', minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v); };
  const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;

  /* ---------- tiny helpers: page sets <-> "1-3,5" ---------- */
  const compact = set => { const a = [...set].sort((x, y) => x - y); const out = []; for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? `${a[i]}` : `${a[i]}-${a[j]}`); i = j + 1; } return out.join(','); };
  function parseRange(text, total) {
    const t = text.replace(/\s+/g, ''); if (!t) return null;
    if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(t)) return false;
    const set = new Set();
    for (const part of t.split(',')) { const [a, b] = part.split('-').map(Number); const hi = b ?? a; if (a < 1 || hi < a || hi > total) return false; for (let p = a; p <= hi; p++) set.add(p); }
    return set;
  }
  const allPages = n => new Set(Array.from({ length: n }, (_, i) => i + 1));

  /* ---------- network ---------- */
  async function api(method, url, body) {
    const init = { method, headers: {} };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res; try { res = await fetch(url, init); } catch { throw new Error('No connection. Check your internet and try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  function xhrUpload(file, onProgress, hold) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); if (hold) hold(x); const fd = new FormData(); fd.append('file', file);
      x.open('POST', '/api/uploads');
      x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Upload failed. Please try again.')); };
      x.onerror = () => reject(new Error('No connection. Check your internet and try again.'));
      x.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      x.ontimeout = () => reject(new Error('The upload timed out. Please try again.'));
      x.timeout = 180000; x.send(fd);
    });
  }

  /* ---------- config ---------- */
  async function loadConfig() {
    try { cfg = await api('GET', '/api/config'); } catch { $('pill').textContent = 'Offline'; $('pill').classList.add('bad'); return; }
    document.title = cfg.business_name; $('bizName').textContent = cfg.business_name; $('tagline').textContent = cfg.tagline;
    $('pill').textContent = cfg.ready ? 'Printer ready' : 'Unavailable'; $('pill').classList.toggle('bad', !cfg.ready);
    $('file').accept = cfg.accepts.map(e => '.' + e).join(','); $('file').disabled = !cfg.ready;
    $('drop').style.opacity = cfg.ready ? '' : '.5';
    $('acceptHint').textContent = `${cfg.accepts.map(e => e.toUpperCase()).join(', ')} · up to ${cfg.max_file_mb} MB each`;
    const pp = $('paperHint'); if (pp) { pp.textContent = cfg.paper_left == null ? '' : cfg.paper_left > 0 ? `${plural(cfg.paper_left, 'sheet')} of paper in the printer` : 'Printer is out of paper'; pp.classList.toggle('low', cfg.paper_left != null && cfg.paper_left < 20); show(pp, cfg.paper_left != null); }
    if (!cfg.ready && !docs.length) showPickError(cfg.payment_ready ? 'This printer is not available right now. Please try again in a few minutes.' : 'Payments are not set up on this kiosk yet.');
  }
  function showPickError(msg) { $('pickError').textContent = msg || ''; show($('pickError'), !!msg); }

  /* ---------- pdf.js (self-hosted, lazy) ---------- */
  async function getPdfjs() {
    if (pdfjs || pdfjsFailed) return pdfjs;
    try {
      pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    } catch (e) { console.warn('pdf.js unavailable, previews disabled', e); pdfjsFailed = true; }
    return pdfjs;
  }
  async function openPdf(jobId) {
    const lib = await getPdfjs(); if (!lib) return null;
    try { return await lib.getDocument({ url: `/api/jobs/${jobId}/pdf`, isEvalSupported: false, enableXfa: false, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise; }
    catch (e) { console.warn('could not open pdf for preview', e); return null; }
  }
  /** Show the customer's own first page the moment they pick the file (before the upload finishes). */
  async function localPreview(d) {
    try {
      const f = d.file, name = f.name.toLowerCase();
      if (/\.(jpe?g|png)$/.test(name)) { d.thumb = URL.createObjectURL(f); d.localUrl = d.thumb; refreshDoc(d); return; }
      if (!name.endsWith('.pdf')) return;
      const lib = await getPdfjs(); if (!lib || d.cancelled) return;
      const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false, enableXfa: false, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
      const c = document.createElement('canvas'); await renderPage(pdf, 1, 520, c);
      if (!d.cancelled && !d.thumb) { d.thumb = c.toDataURL('image/jpeg', 0.8); refreshDoc(d); }
      pdf.destroy();
    } catch (e) { /* preview is optional; the server preview follows */ }
  }
  async function renderPage(pdf, n, width, canvas) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    page.cleanup();
    return ctx;
  }
  /** colour / blank detection on a rendered thumbnail */
  function analyse(ctx, w, hgt) {
    const d = ctx.getImageData(0, 0, w, hgt).data; let colour = 0, ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colour++;
      if ((r + g + b) / 3 < 235) ink++;
    }
    return { colour: colour >= 12, blank: ink <= 2 };
  }

  /* ---------- documents ---------- */
  let seq = 0;
  function newDoc(file) {
    return { key: ++seq, file, name: file.name, id: null, pages: 0, state: 'queued', step: 0, progress: 0, error: '', pdf: null, thumb: null,
      colourPages: new Set(), blankPages: new Set(), analysed: false, expanded: false, opts: { copies: 1, color: false, duplex: false, selected: null }, el: null, ui: {} };
  }
  const selSet = d => d.opts.selected || allPages(d.pages);
  const unitPrice = d => d.opts.color ? cfg.price_color : cfg.price_bw;
  const docCost = d => selSet(d).size * d.opts.copies * unitPrice(d);

  function addFiles(list) {
    showPickError('');
    const files = [...list]; if (!files.length) return;
    let room = cfg.max_docs - docs.length;
    for (const f of files) {
      if (room <= 0) { showPickError(`You can print up to ${cfg.max_docs} documents per order.`); break; }
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!cfg.accepts.includes(ext)) { showPickError(`${f.name}: .${ext} files are not supported. Try ${cfg.accepts.join(', ')}.`); continue; }
      if (f.size > cfg.max_file_mb * 1048576) { showPickError(`${f.name} is larger than ${cfg.max_file_mb} MB.`); continue; }
      if (f.size === 0) { showPickError(`${f.name} is empty.`); continue; }
      const d = newDoc(f); docs.push(d); room--; mountDoc(d);
    }
    layout(); pump();
  }
  async function pump() {
    if (working) return; working = true;
    try { for (;;) { const d = docs.find(x => x.state === 'queued'); if (!d) break; await processDoc(d); } } finally { working = false; }
  }

  /** upload -> server reads/converts -> browser checks colour + blank pages */
  async function processDoc(d) {
    d.state = 'processing'; d.step = 0; refreshDoc(d); localPreview(d);
    const stepped = async (n, t0) => { d.step = n; refreshDoc(d); const wait = 380 - (Date.now() - t0); if (wait > 0) await sleep(wait); };
    try {
      let t = Date.now();
      const res = await xhrUpload(d.file, p => { d.progress = p; if (p >= 1 && d.step === 0) { d.step = 1; } refreshDoc(d); }, x => { d.xhr = x; });
      if (d.cancelled) { fetch(`/api/jobs/${res.job.id}`, { method: 'DELETE' }).catch(() => {}); return; }
      d.id = res.job.id; d.name = res.job.original_name || d.name; d.pages = res.job.pages_total; d.step = 1; refreshDoc(d);
      await stepped(2, t);                                          // "Reading pages" done
      t = Date.now();
      if (d.cancelled) return;
      d.pdf = await openPdf(d.id);
      if (d.cancelled) { try { d.pdf?.destroy(); } catch {} return; }
      if (d.pdf) await checkPages(d);
      await stepped(3, t);                                          // "Checking colours" done
      d.state = 'ready'; d.step = 4; 
      if (d.analysed && d.colourPages.size === 0) d.opts.color = false;
      refreshDoc(d); saveCart(); layout();
    } catch (e) { if (d.cancelled || e.cancelled) return; d.state = 'error'; d.error = e.message; refreshDoc(d); }
  }
  async function checkPages(d) {
    const c = document.createElement('canvas');
    try {
      const first = await renderPage(d.pdf, 1, 520, c); d.thumb = c.toDataURL('image/jpeg', 0.8); refreshDoc(d);
      const small = document.createElement('canvas');
      const n = Math.min(d.pages, 150);
      for (let p = 1; p <= n; p++) {
        d.ui.scanText && (d.ui.scanText.textContent = `Checking page ${p} of ${n}`);
        const ctx = await renderPage(d.pdf, p, 70, small);
        const r = analyse(ctx, small.width, small.height);
        if (r.colour) d.colourPages.add(p); if (r.blank) d.blankPages.add(p);
        if (p % 4 === 0) await sleep(0);
      }
      d.analysed = true; void first;
    } catch (e) { console.warn('page analysis skipped', e); }
  }

  /* ---------- rendering the cart (video-card style) ---------- */
  const extOf = d => ((d.name.split('.').pop() || '').slice(0, 4) || 'file').toUpperCase();
  function mountDoc(d) {
    const ui = d.ui;
    ui.img = h('img', { alt: '', hidden: true });
    ui.pagesBadge = h('span', { class: 'badge pages' }); ui.colourBadge = h('span', { class: 'badge colour', text: '🎨 Colour', hidden: true });
    ui.thumb = h('button', { class: 'vthumb', type: 'button', 'aria-label': 'Edit print options', onclick: () => openSheet(d) },
      ui.img, h('div', { class: 'beam', 'aria-hidden': 'true' }), h('i', { class: 'c tl' }), h('i', { class: 'c tr' }), h('i', { class: 'c bl' }), h('i', { class: 'c br' }),
      ui.colourBadge, ui.pagesBadge, h('span', { class: 'editchip', text: 'Edit options' }));
    ui.avatar = h('div', { class: 'avatar', text: extOf(d), 'aria-hidden': 'true' });
    ui.title = h('h3', { class: 'vtitle' }); ui.meta = h('p', { class: 'muted vsub' }); ui.price = h('strong', { class: 'vprice' });
    ui.menuBtn = h('button', { class: 'more', type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: '⋮', onclick: e => { e.stopPropagation(); toggleMenu(d); } });
    ui.menu = h('div', { class: 'menu', role: 'menu', hidden: true },
      h('button', { role: 'menuitem', type: 'button', text: 'Edit options', onclick: () => { closeMenus(); openSheet(d); } }),
      h('button', { role: 'menuitem', type: 'button', class: 'danger', text: 'Remove', onclick: () => { closeMenus(); removeDoc(d); } }));
    ui.steps = h('ul', { class: 'scansteps' }, ['Uploading', 'Reading pages', 'Checking colours & blank pages'].map((t, i) => h('li', { 'data-i': i }, h('span', { class: 'tick', 'aria-hidden': 'true' }), h('span', { text: t }))));
    ui.barFill = h('i'); ui.bar = h('div', { class: 'bar' }, ui.barFill); ui.scanText = h('p', { class: 'muted small', text: '' });
    ui.cancel = h('button', { class: 'link danger cancelbtn', type: 'button', text: 'Cancel', onclick: () => removeDoc(d) });
    ui.err = h('div', { class: 'error', role: 'alert' });
    ui.retry = h('button', { class: 'link', type: 'button', text: 'Try again', onclick: () => { d.state = 'queued'; d.progress = 0; refreshDoc(d); pump(); } });
    ui.rm = h('button', { class: 'link danger', type: 'button', text: 'Remove', onclick: () => removeDoc(d) });
    d.el = h('article', { class: 'vcard', 'data-state': 'queued' },
      ui.thumb,
      h('div', { class: 'vmeta' }, ui.avatar, h('div', { class: 'vtext' }, ui.title, ui.meta), h('div', { class: 'vright' }, ui.price, ui.menuBtn, ui.menu)),
      h('div', { class: 'processing' }, ui.steps, ui.bar, ui.scanText, ui.cancel), ui.err, h('div', { class: 'dfail' }, ui.retry, ui.rm));
    $('cartList').append(d.el); refreshDoc(d);
  }
  const clampCopies = v => Math.max(1, Math.min(cfg.max_copies, parseInt(v, 10) || 1));
  function toggleMenu(d) { const open = d.ui.menu.hidden; closeMenus(); if (open) { show(d.ui.menu, true); d.ui.menuBtn.setAttribute('aria-expanded', 'true'); d.ui.menu.querySelector('button').focus(); } }
  function closeMenus() { docs.forEach(x => { if (x.ui.menu) { show(x.ui.menu, true === false); x.ui.menuBtn.setAttribute('aria-expanded', 'false'); } }); }
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

  function refreshDoc(d) {
    const ui = d.ui; if (!ui.title) return;
    const ready = d.state === 'ready'; d.el.dataset.state = d.state;
    ui.title.textContent = d.name; ui.title.title = d.name;
    if (d.thumb && ui.img.hidden) { ui.img.src = d.thumb; ui.img.hidden = false; }
    ui.thumb.classList.toggle('scanning', d.state === 'processing' || d.state === 'queued'); ui.thumb.classList.toggle('done', ready);
    ui.thumb.disabled = !ready;
    ui.steps.querySelectorAll('li').forEach((li, i) => { li.classList.toggle('on', d.step === i && d.state === 'processing'); li.classList.toggle('ok', d.step > i); });
    ui.barFill.style.width = `${d.step === 0 ? Math.round(d.progress * 100) : 100}%`; ui.bar.classList.toggle('indet', d.step === 1 || d.step === 2);
    if (d.state === 'queued') ui.meta.textContent = 'Waiting…';
    else if (d.state === 'processing') ui.meta.textContent = d.step === 0 ? `Uploading ${Math.round(d.progress * 100)}%` : d.step === 1 ? 'Reading pages…' : 'Checking colours & blank pages…';
    else if (d.state === 'error') ui.meta.textContent = 'Could not process this file';
    else { const n = selSet(d).size; ui.meta.textContent = `${d.opts.color ? 'Colour' : 'B&W'} · ${plural(d.opts.copies, 'copy', 'copies')}${d.opts.duplex ? ' · double-sided' : ''}`; ui.pagesBadge.textContent = n === d.pages ? plural(d.pages, 'page') : `${n} of ${d.pages} pages`; }
    show(ui.pagesBadge, ready); show(ui.colourBadge, ready && d.opts.color);
    ui.err.textContent = d.error; show(ui.err, d.state === 'error');
    ui.price.textContent = ready ? (docCost(d) ? money(docCost(d)) : 'Free') : '';
    show(ui.menuBtn, ready);
    layoutTotals();
    if (sheetDoc === d) updateSheet();
  }
  function insights(d) {
    const out = [], sel = selSet(d);
    if (d.analysed) {
      const colourSel = [...d.colourPages].filter(p => sel.has(p));
      if (!d.colourPages.size) out.push(h('p', { class: 'chip good', text: d.opts.color ? '✔ No colour found in this file. B&W would look the same and cost less.' : '✔ No colour detected: black & white is all you need.' }));
      else if (d.opts.color && !colourSel.length) out.push(h('p', { class: 'chip warn', text: 'The pages you picked have no colour. B&W would cost less.' }));
      else out.push(h('p', { class: 'chip' }, `🎨 Colour on ${plural(d.colourPages.size, 'page')}${d.colourPages.size <= 6 ? ': ' + compact(d.colourPages) : ''}`, d.colourPages.size < d.pages ? h('button', { class: 'link', type: 'button', text: 'Print only these', onclick: () => { d.opts.selected = new Set(d.colourPages); d.opts.color = true; syncRadios(d); refreshDoc(d); saveCart(); } }) : null));
      const blankSel = [...d.blankPages].filter(p => sel.has(p));
      if (blankSel.length) out.push(h('p', { class: 'chip' }, `📄 ${plural(blankSel.length, 'blank page')} found`, h('button', { class: 'link', type: 'button', text: 'Skip blank pages', onclick: () => { const s2 = new Set(sel); blankSel.forEach(p => s2.delete(p)); if (!s2.size) return; d.opts.selected = s2.size === d.pages ? null : s2; refreshDoc(d); saveCart(); } })));
    }
    return out;
  }
  function syncRadios(d) {
    if (sheetDoc !== d) return;
    $('sheetBody').querySelectorAll('input[name="s-color"]').forEach(r => { r.checked = (r.value === 'true') === d.opts.color; });
    $('sheetBody').querySelectorAll('input[name="s-duplex"]').forEach(r => { r.checked = (r.value === 'true') === d.opts.duplex; });
  }
  function removeDoc(d) {
    d.cancelled = true; try { d.xhr?.abort(); } catch {}
    if (d.id) fetch(`/api/jobs/${d.id}`, { method: 'DELETE' }).catch(() => {});
    try { d.pdf?.destroy(); } catch {}
    if (d.localUrl) URL.revokeObjectURL(d.localUrl);
    if (sheetDoc === d) sheet.close();
    docs = docs.filter(x => x !== d); d.el.remove(); layout(); saveCart();
  }

  /* ---------- per-document options sheet ---------- */
  const sheet = $('sheet'); let sheetDoc = null, sheetRefs = {};
  function openSheet(d) {
    if (d.state !== 'ready') return;
    sheetDoc = d; const r = sheetRefs = {};
    $('sheetSub').textContent = d.name;
    const seg = (field, a, b) => h('div', { class: 'seg' }, [[a, false], [b, true]].map(([t, v]) => h('label', {}, h('input', { type: 'radio', name: `s-${field}`, value: String(v), checked: d.opts[field] === v, onchange: () => { d.opts[field] = v; refreshDoc(d); saveCart(); } }), h('span', {}, t[0], t[1] ? h('small', { text: t[1] }) : null))));
    r.copies = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: d.opts.copies, 'aria-label': 'Copies', oninput: () => { d.opts.copies = clampCopies(r.copies.value); refreshDoc(d); saveCart(); } });
    const setCopies = n => { d.opts.copies = clampCopies(n); r.copies.value = d.opts.copies; refreshDoc(d); saveCart(); };
    r.pagesBtn = h('button', { class: 'pagesbtn', type: 'button', onclick: () => openPicker(d) });
    r.chips = h('div', { class: 'chips' });
    $('sheetBody').replaceChildren(
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Copies' }), h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Fewer copies', text: '−', onclick: () => setCopies(d.opts.copies - 1) }), r.copies, h('button', { type: 'button', 'aria-label': 'More copies', text: '+', onclick: () => setCopies(d.opts.copies + 1) }))),
      cfg.allow_color ? h('div', { class: 'field' }, h('span', { class: 'label', text: 'Colour' }), seg('color', ['Black & white', '₹' + (cfg.price_bw / 100) + '/page'], ['Colour', '₹' + (cfg.price_color / 100) + '/page'])) : null,
      cfg.allow_duplex ? h('div', { class: 'field' }, h('span', { class: 'label', text: 'Sides' }), seg('duplex', ['Single-sided'], ['Double-sided'])) : null,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Pages' }), r.pagesBtn),
      r.chips,
      h('button', { class: 'link danger rmbtn', type: 'button', text: 'Remove this file', onclick: () => removeDoc(d) }));
    updateSheet(); sheet.showModal();
  }
  function updateSheet() {
    const d = sheetDoc; if (!d) return; const r = sheetRefs, n = selSet(d).size;
    r.pagesBtn.replaceChildren(h('span', { text: d.opts.selected ? `${plural(n, 'page')} of ${d.pages}: ${compact(d.opts.selected).slice(0, 28)}` : `All ${plural(d.pages, 'page')}` }), h('span', { class: 'chev', text: d.pdf ? 'Choose pages ›' : 'Change ›' }));
    r.chips.replaceChildren(...insights(d));
    $('sheetDetail').textContent = `${plural(n * d.opts.copies, 'page')} to print`; $('sheetPrice').textContent = docCost(d) ? money(docCost(d)) : 'Free';
  }
  $('sheetDone').addEventListener('click', () => sheet.close());
  $('sheetClose').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });
  sheet.addEventListener('close', () => { sheetDoc = null; });

  /* ---------- "apply to all" chip bar ---------- */
  function renderBulk() {
    const ready = docs.filter(d => d.state === 'ready'), bar = $('bulk');
    const specs = [];
    if (cfg.allow_color) specs.push(['All B&W', d => !d.opts.color, d => { d.opts.color = false; }], ['All colour', d => d.opts.color, d => { d.opts.color = true; }]);
    if (cfg.allow_duplex) specs.push(['All single-sided', d => !d.opts.duplex, d => { d.opts.duplex = false; }], ['All double-sided', d => d.opts.duplex, d => { d.opts.duplex = true; }]);
    show(bar, ready.length > 1 && specs.length > 0); if (bar.hidden) return;
    bar.replaceChildren(...specs.map(([label, test, apply]) => h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(ready.every(test)), text: label, onclick: () => { ready.forEach(d => { apply(d); refreshDoc(d); }); saveCart(); } })));
  }

  /* ---------- totals / layout ---------- */
  function layout() {
    const has = docs.length > 0;
    document.body.classList.toggle('is-empty', !has);
    show($('emptyState'), !has); show($('addMore'), has && docs.length < cfg.max_docs); show($('paybar'), has);
    layoutTotals();
  }
  function layoutTotals() {
    if (!cfg) return;
    const ready = docs.filter(d => d.state === 'ready'), pending = docs.some(d => d.state === 'queued' || d.state === 'processing'), failed = docs.some(d => d.state === 'error');
    let total = ready.reduce((n, d) => n + docCost(d), 0); if (total > 0) total = Math.max(total, cfg.min_charge);
    const sheets = ready.reduce((n, d) => n + selSet(d).size * d.opts.copies, 0);
    $('sumDetail').textContent = ready.length ? `${plural(ready.length, 'document')} · ${plural(sheets, 'page')} to print` : '';
    $('sumTotal').textContent = ready.length ? (total ? money(total) : 'Free') : '';
    const free = cfg.payment_mode === 'free' || total === 0;
    $('payBtn').textContent = pending ? 'Getting your files ready…' : failed ? 'Remove the file with the problem' : free ? 'Print now' : `Pay ${money(total)} & print`;
    $('cancelAll').disabled = busy;
    const needSheets = ready.reduce((n, d) => n + Math.ceil(selSet(d).size * d.opts.copies / (d.opts.duplex ? 2 : 1)), 0);
    const noPaper = cfg.paper_left != null && ready.length && needSheets > cfg.paper_left;
    if (noPaper) { $('optsError').textContent = cfg.paper_left > 0 ? `Only ${plural(cfg.paper_left, 'sheet')} of paper left in the printer; this order needs ${needSheets}. Reduce pages or copies.` : 'The printer is out of paper right now. Please try again later.'; } else if ($('optsError').textContent.startsWith('Only ') || $('optsError').textContent.startsWith('The printer is out')) $('optsError').textContent = '';
    show($('optsError'), !!$('optsError').textContent);
    $('payBtn').disabled = noPaper || busy || pending || failed || !ready.length;
    renderBulk();
  }

  /* ---------- page picker ---------- */
  const picker = $('picker'); let pk = null, pkObserver = null;
  function openPicker(d) {
    if (d.state !== 'ready') return;
    pk = { d, draft: new Set(selSet(d)), cells: new Map(), rendered: new Set() };
    $('pickerSub').textContent = `${d.name} · ${plural(d.pages, 'page')}`;
    const grid = $('pkGrid'); grid.replaceChildren();
    for (let p = 1; p <= d.pages; p++) {
      const cv = document.createElement('canvas'); cv.width = 100; cv.height = 140;
      const b = h('button', { type: 'button', class: 'pg', 'aria-pressed': 'false', 'aria-label': `Page ${p}`, 'data-p': p, onclick: () => togglePage(p) }, cv, h('span', { class: 'pn', text: p }), d.colourPages.has(p) ? h('i', { class: 'dot', title: 'Has colour' }) : null, d.blankPages.has(p) ? h('em', { class: 'blk', text: 'blank' }) : null, h('i', { class: 'check', 'aria-hidden': 'true', text: '✓' }));
      pk.cells.set(p, b); grid.append(b);
    }
    const tools = $('pkTools'); tools.replaceChildren(
      tbtn('All', () => setDraft(allPages(d.pages))), tbtn('None', () => setDraft(new Set())), tbtn('Odd', () => setDraft(new Set([...allPages(d.pages)].filter(p => p % 2 === 1)))), tbtn('Even', () => setDraft(new Set([...allPages(d.pages)].filter(p => p % 2 === 0)))),
      d.colourPages.size ? tbtn('Colour pages', () => setDraft(new Set(d.colourPages))) : null,
      d.blankPages.size ? tbtn('Skip blank', () => setDraft(new Set([...pk.draft].filter(p => !d.blankPages.has(p))))) : null);
    $('pkRange').value = d.opts.selected ? compact(d.opts.selected) : '';
    applyDraft();
    pkObserver?.disconnect();
    pkObserver = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { const p = Number(e.target.dataset.p); pkObserver.unobserve(e.target); lazyThumb(p); } }), { root: picker, rootMargin: '300px' });
    pk.cells.forEach(c => pkObserver.observe(c));
    picker.showModal();
  }
  const tbtn = (t, fn) => h('button', { type: 'button', class: 'tool', text: t, onclick: fn });
  async function lazyThumb(p) {
    if (!pk || pk.rendered.has(p) || !pk.d.pdf) return; pk.rendered.add(p);
    const cv = pk.cells.get(p)?.querySelector('canvas'); if (!cv) return;
    try { await renderPage(pk.d.pdf, p, 120 * Math.min(window.devicePixelRatio || 1, 2), cv); } catch { /* leave blank */ }
  }
  function togglePage(p) { pk.draft.has(p) ? pk.draft.delete(p) : pk.draft.add(p); pk.fromGrid = true; applyDraft(); }
  function setDraft(s) { pk.draft = s; applyDraft(); }
  function applyDraft() {
    pk.cells.forEach((b, p) => { const on = pk.draft.has(p); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); });
    const n = pk.draft.size;
    $('pickerDone').textContent = n ? `Use ${plural(n, 'page')}` : 'Select at least one page'; $('pickerDone').disabled = !n;
    if (document.activeElement !== $('pkRange')) $('pkRange').value = n === pk.d.pages ? '' : compact(pk.draft);
  }
  $('pkRange').addEventListener('input', e => {
    const s = parseRange(e.target.value, pk.d.pages);
    e.target.classList.toggle('bad', s === false);
    if (s) { pk.draft = s; applyDraft(); } else if (s === null) { pk.draft = allPages(pk.d.pages); applyDraft(); }
  });
  $('pickerDone').addEventListener('click', () => {
    const d = pk.d; d.opts.selected = pk.draft.size === d.pages ? null : new Set(pk.draft);
    picker.close(); refreshDoc(d); saveCart();
  });
  $('pickerClose').addEventListener('click', () => picker.close());
  picker.addEventListener('click', e => { if (e.target === picker) picker.close(); });
  picker.addEventListener('close', () => { pkObserver?.disconnect(); pk = null; });

  /* ---------- checkout ---------- */
  async function pay() {
    if (busy) return; busy = true; layoutTotals(); $('optsError').textContent = ''; show($('optsError'), false);
    const items = docs.filter(d => d.state === 'ready').map(d => ({ id: d.id, copies: d.opts.copies, color: d.opts.color, duplex: d.opts.duplex, page_range: d.opts.selected ? compact(d.opts.selected) : '' }));
    try {
      const res = await api('POST', '/api/checkout', { items });
      batchId = res.batch.id;
      if (!res.order) return beginStatus();
      openRazorpay(res);
    } catch (e) { $('optsError').textContent = e.message; show($('optsError'), true); busy = false; layoutTotals(); }
  }
  function openRazorpay({ order, batch }) {
    if (typeof window.Razorpay !== 'function') { $('optsError').textContent = 'The payment window could not load. Check your internet connection and try again.'; show($('optsError'), true); busy = false; layoutTotals(); return; }
    const rzp = new window.Razorpay({
      key: order.key_id, order_id: order.id, amount: order.amount, currency: order.currency, name: cfg.business_name,
      description: `${plural(batch.jobs.length, 'document')}`, theme: { color: '#0f766e' },
      modal: { ondismiss: () => { busy = false; layoutTotals(); } },
      handler: resp => confirm(batch.id, resp),
    });
    rzp.on('payment.failed', r => { $('optsError').textContent = (r.error && r.error.description) || 'The payment did not go through. You have not been charged. Please try again.'; show($('optsError'), true); });
    rzp.open();
  }
  async function confirm(id, resp) {
    batchId = id; showScreen('status'); renderStatus({ awaiting_payment: true, jobs: [], finished: false });
    for (let i = 0; i < 4; i++) {
      try {
        const r = await api('POST', '/api/checkout/confirm', { batch_id: id, razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature });
        if (r.stale) { showScreen('cart'); busy = false; layoutTotals(); $('optsError').textContent = r.message; show($('optsError'), true); return; }
        break;
      } catch { if (i < 3) await sleep(1500 * (i + 1)); /* the webhook may still confirm it; keep polling */ }
    }
    beginStatus();
  }

  /* ---------- status ---------- */
  const SICON = { spin: '<div class="spinner" aria-hidden="true"></div>', ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>', bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>' };
  function showScreen(name) { show($('screenCart'), name === 'cart'); show($('screenStatus'), name === 'status'); window.scrollTo({ top: 0 }); }
  function beginStatus() { try { sessionStorage.setItem(KEY_BATCH, batchId); sessionStorage.removeItem(KEY_CART); } catch {} busy = false; showScreen('status'); poll(); }
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const { batch } = await api('GET', `/api/batches/${batchId}`);
      renderStatus(batch);
      if (batch.finished) { try { sessionStorage.removeItem(KEY_BATCH); } catch {} return; }
    } catch { /* transient */ }
    pollTimer = setTimeout(poll, 2000);
  }
  function renderStatus(b) {
    const js = b.jobs || [], by = s => js.filter(j => j.status === s).length;
    const done = by('done'), bad = js.filter(j => ['failed', 'refunded', 'refund_failed', 'expired'].includes(j.status)).length;
    const printing = js.some(j => j.status === 'printing'), queued = js.some(j => j.status === 'queued');
    let title, text, icon = SICON.spin, isBad = false;
    if (b.awaiting_payment || !js.length) { title = 'Confirming payment'; text = 'This only takes a moment.'; }
    else if (!b.finished) { title = printing ? 'Printing…' : 'Payment received'; text = printing ? 'Your pages are on their way out.' : 'Waiting for the printer to be free.'; }
    else if (done === js.length) { title = 'All done!'; text = js.find(j => j.pickup_message)?.pickup_message || 'Please collect your pages.'; icon = SICON.ok; }
    else if (done > 0) { title = `${plural(done, 'document')} printed`; text = `${plural(bad, 'document')} could not be printed${b.refunded_amount ? ` and ${money(b.refunded_amount)} is being refunded automatically (5–7 working days)` : ''}.`; icon = SICON.ok; }
    else { title = 'Printing failed'; isBad = true; icon = SICON.bad; text = b.refunded_amount ? `Your ${money(b.refunded_amount)} is being refunded automatically (5–7 working days).` : 'Something went wrong while printing.'; }
    const icn = $('statusIcon'); icn.className = 'bigicon' + (isBad ? ' bad' : ''); icn.innerHTML = icon;
    $('statusTitle').textContent = title; $('statusText').textContent = text;
    $('statusDocs').replaceChildren(...js.map(j => h('li', { class: `sd ${j.status}` }, h('span', { class: 'sdn', text: j.original_name }), h('span', { class: 'sds', text: statusWord(j) }))));
    const reached = b.awaiting_payment ? 0 : !b.finished ? (printing ? 2 : 1) : 3;
    $('steps').querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', reached > i || (i === 0 && reached >= 1)));
    show($('steps'), !isBad && !(b.finished && bad && !done));
    const failedJob = js.find(j => j.status === 'refund_failed');
    const ref = $('statusRef');
    if (failedJob) { ref.textContent = `A refund needs manual handling. Payment ID: ${failedJob.payment_id}${failedJob.support_contact ? ' · Contact: ' + failedJob.support_contact : ''}`; show(ref, true); } else show(ref, false);
    show($('again'), !!b.finished);
  }
  const statusWord = j => ({ awaiting_payment: 'Waiting for payment', queued: 'In queue', printing: 'Printing…', done: 'Printed ✓', failed: 'Failed', refunded: 'Refunded', refund_failed: 'Refund pending', expired: 'Expired' }[j.status] || j.status);
  function reset() { clearTimeout(pollTimer); batchId = null; busy = false; docs.forEach(d => { try { d.pdf?.destroy(); } catch {} }); docs = []; $('cartList').replaceChildren(); try { sessionStorage.removeItem(KEY_BATCH); sessionStorage.removeItem(KEY_CART); } catch {} showPickError(''); loadConfig(); layout(); showScreen('cart'); }

  /* ---------- keep the cart across a refresh ---------- */
  function saveCart() {
    try {
      const ready = docs.filter(d => d.state === 'ready');
      if (!ready.length) return sessionStorage.removeItem(KEY_CART);
      sessionStorage.setItem(KEY_CART, JSON.stringify(ready.map(d => ({ id: d.id, c: d.opts.copies, col: d.opts.color, dup: d.opts.duplex, sel: d.opts.selected ? compact(d.opts.selected) : '' }))));
    } catch {}
  }
  async function restore() {
    let b, c; try { b = sessionStorage.getItem(KEY_BATCH); c = JSON.parse(sessionStorage.getItem(KEY_CART) || 'null'); } catch {}
    if (b) { batchId = b; try { await api('GET', `/api/batches/${b}`); beginStatus(); return; } catch { sessionStorage.removeItem(KEY_BATCH); } }
    if (!c) return;
    for (const it of c) {
      try {
        const { job } = await api('GET', `/api/jobs/${it.id}`); if (job.status !== 'uploaded' && job.status !== 'awaiting_payment') continue;
        const d = newDoc({ name: job.original_name }); d.id = job.id; d.name = job.original_name; d.pages = job.pages_total; d.state = 'processing'; d.step = 2;
        d.opts = { copies: clampCopies(it.c), color: !!it.col && cfg.allow_color, duplex: !!it.dup && cfg.allow_duplex, selected: it.sel ? (parseRange(it.sel, d.pages) || null) : null };
        docs.push(d); mountDoc(d);
        d.pdf = await openPdf(d.id); if (d.pdf) await checkPages(d);
        d.state = 'ready'; d.step = 4; refreshDoc(d);
      } catch { /* gone */ }
    }
    layout();
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
    setInterval(() => { if (!busy && document.visibilityState === 'visible') loadConfig().then(layoutTotals).catch(() => {}); }, 30000);
    $('addMore').addEventListener('click', () => $('file').click());
    $('cancelAll').addEventListener('click', () => { if (busy) return; docs.slice().forEach(removeDoc); showPickError(''); });
    $('theme').addEventListener('click', () => { const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; const next = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pn_theme', next); } catch {} });
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (cfg?.ready) addFiles(e.dataTransfer.files); });
    $('payBtn').addEventListener('click', pay);
    $('again').addEventListener('click', reset);
  }
  (async () => {
    wire(); await loadConfig();
    if (!cfg) return;
    if (cfg.payment_mode === 'razorpay') { const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.async = true; document.head.appendChild(s); }
    setInterval(() => { if (!docs.length && !batchId) loadConfig(); }, 30000);
    layout(); restore();
  })();
})();
