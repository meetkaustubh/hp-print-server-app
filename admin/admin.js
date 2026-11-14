'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const show = (el, on = true) => { el.hidden = !on; };
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'printnimbus' };
  const PRICE_KEYS = ['price_bw', 'price_color', 'min_charge'];
  let settings = null, session = null;

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/admin/login') { await boot(); throw new Error('Please sign in'); }
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.fields = data.fields; throw e; }
    return data;
  }
  function toast(msg) { const t = $('toast'); t.textContent = msg; show(t, true); clearTimeout(toast.t); toast.t = setTimeout(() => show(t, false), 3000); }
  const rupees = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach(k => e.append(k)); return e; };

  /* ---------- auth ---------- */
  async function boot() {
    session = await fetch('/api/admin/session', { credentials: 'same-origin' }).then(r => r.json());
    if (session.authed) { show($('auth'), false); show($('shell'), true); await loadAll(); return; }
    show($('shell'), false); show($('auth'), true);
    const setup = session.setup_required;
    $('authTitle').textContent = setup ? 'Set up your kiosk' : 'Sign in';
    const pi = session.edition === 'pi', lbl = session.identity_label || 'Username';
    $('authHelp').textContent = setup ? (pi ? 'Choose an admin password. You will need the setup code from the device.' : 'Choose a username and password. You will need the setup code from the app window.') : 'Admin access for this kiosk.';
    $('userRow').firstChild.textContent = lbl + ' ';
    $('username').placeholder = pi ? 'PN-XXXXXX' : 'admin';
    $('username').autocomplete = setup ? 'off' : 'username';
    show($('userRow'), !(setup && pi));
    $('userHint').textContent = pi && !setup ? 'Printed on the label of your unit.' : '';
    show($('codeRow'), setup); show($('pw2Row'), setup); $('setupHint').textContent = session.setup_hint || '';
    $('password').autocomplete = setup ? 'new-password' : 'current-password';
    $('authBtn').textContent = setup ? 'Create admin account' : 'Sign in';
  }
  $('authForm').addEventListener('submit', async e => {
    e.preventDefault(); show($('authError'), false);
    try {
      if (session.setup_required) {
        if ($('password').value !== $('password2').value) throw new Error('Passwords do not match');
        await api('POST', '/api/admin/setup', { code: $('code').value, password: $('password').value, username: $('username').value });
      } else await api('POST', '/api/admin/login', { username: $('username').value, password: $('password').value });
      $('password').value = $('password2').value = '';
      await boot();
    } catch (err) { $('authError').textContent = err.message; show($('authError'), true); }
  });
  $('logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout', {}).catch(() => {}); boot(); });

  /* ---------- tabs ---------- */
  function tab(name) {
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab').forEach(t => show(t, t.id === 'tab-' + name));
    if (name === 'jobs') loadJobs(); if (name === 'dash') loadDash(); if (name === 'poster') loadPoster();
    $('pageTitle').textContent = { dash: 'Dashboard', jobs: 'Jobs', settings: 'Settings', poster: 'QR poster' }[name] || 'Dashboard';
    window.scrollTo(0, 0);
    history.replaceState(null, '', '#' + name);
  }
  $('seeAll').addEventListener('click', () => tab('jobs'));
  $('adminTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pn_theme', next); } catch {}
  });
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); });

  async function loadAll() { await loadSettings(); tab((location.hash || '#dash').slice(1).replace(/[^a-z]/g, '') || 'dash'); }

  /* ---------- dashboard ---------- */
  async function loadDash() {
    const [stats, pr, sys] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/printers'), api('GET', '/api/admin/system')]);
    const grid = $('statGrid'); grid.replaceChildren();
    [[rupees(stats.today_revenue), 'Revenue today'], [stats.today_jobs, 'Jobs today'], [stats.today_pages, 'Pages today'], [rupees(stats.total_revenue), 'Revenue, all time'], [stats.queued, 'In queue']]
      .forEach(([v, l]) => grid.append(el('div', { className: 'stat' }, el('b', { textContent: v }), el('span', { textContent: l }))));

    const alerts = $('alerts'); alerts.replaceChildren();
    const add = (t, cls = '') => alerts.append(el('div', { className: 'alert ' + cls, textContent: t }));
    if (stats.needs_attention) add(`${stats.needs_attention} refund(s) failed. Open Jobs and use “Retry refund”, or refund from the Razorpay dashboard.`);
    if (!pr.status.ready) add(`Printer not ready: ${pr.status.detail || pr.status.state}`);
    if (settings.payment_mode === 'free') add('Payments are OFF: anyone can print for free. Turn on Razorpay in Settings.', 'warn');
    if (settings.payment_mode === 'razorpay' && !settings.razorpay_webhook_secret_set) add('No Razorpay webhook secret set. Payments made when a customer closes their browser early would not print. See Settings → Payments.', 'warn');
    if (sys.print_backend === 'dryrun') add('Running in DRY-RUN mode: nothing is sent to a real printer.', 'warn');

    const ts = $('topStatus'); ts.textContent = pr.status.ready ? 'Printer ready' : 'Printer not ready'; ts.className = 'pill ' + (pr.status.ready ? 'ok' : 'bad');
    $('printerLine').textContent = `${pr.status.ready ? '✔' : '✖'} ${settings.printer_name || 'No printer selected'} — ${pr.status.detail || pr.status.state}`;
    const sel = $('printerSel'); sel.replaceChildren(el('option', { value: '', textContent: pr.printers.length ? 'Choose a printer…' : 'No printers found in CUPS' }));
    pr.printers.forEach(p => sel.append(el('option', { value: p.name, textContent: p.name + (p.isDefault ? ' (default)' : ''), selected: p.name === settings.printer_name })));

    try { const { jobs } = await api('GET', '/api/admin/jobs'); allJobs = jobs; renderRows($('recentTable'), jobs.slice(0, 6), false); show($('recentEmpty'), jobs.length === 0); } catch {}
    const kv = $('sysList'); kv.replaceChildren();
    const rows = [['Version', sys.version], ['Open this kiosk at', sys.addresses.map(a => `http://${a}`).join('  ·  ') || 'n/a'], ['Hostname', sys.hostname], [sys.identity_label, sys.identity],
      ['Payments', sys.payment_mode === 'free' ? 'off (free)' : `Razorpay (${sys.razorpay_mode})`],
      ['Memory free', `${sys.mem_free_mb} / ${sys.mem_total_mb} MB`], ['Storage free', sys.disk ? `${sys.disk.free_mb} / ${sys.disk.total_mb} MB` : 'n/a'],
      ['CPU temperature', sys.cpu_temp_c != null ? `${sys.cpu_temp_c.toFixed(1)} °C` : 'n/a'], ['Uptime', `${Math.floor(sys.uptime_s / 3600)} h ${Math.floor(sys.uptime_s % 3600 / 60)} min`], ['Node', sys.node]];
    rows.forEach(([k, v]) => kv.append(el('dt', { textContent: k }), el('dd', { textContent: v })));
  }
  $('savePrinter').addEventListener('click', async () => {
    const name = $('printerSel').value; if (!name) return toast('Choose a printer first');
    try { settings = await api('PUT', '/api/admin/settings', { printer_name: name }); toast('Printer saved'); loadDash(); } catch (e) { toast(e.message); }
  });
  $('testPrint').addEventListener('click', async () => {
    $('printerMsg').textContent = 'Sending test page…';
    try { await api('POST', '/api/admin/test-print', {}); $('printerMsg').textContent = 'Test page sent. Check the printer.'; } catch (e) { $('printerMsg').textContent = e.message; }
  });

  /* ---------- jobs ---------- */
  const BAD = new Set(['failed', 'refund_failed', 'expired']);
  let allJobs = [], jobFilter = 'all';
  const FILTERS = [['all', 'All'], ['active', 'In progress'], ['done', 'Done'], ['problem', 'Needs attention'], ['refunded', 'Refunded']];
  const groupOf = st => BAD.has(st) && st !== 'expired' ? 'problem' : st === 'done' ? 'done' : st === 'refunded' ? 'refunded' : ['queued', 'printing', 'awaiting_payment', 'uploaded'].includes(st) ? 'active' : 'other';
  function renderFilters() {
    const box = $('jobFilters'); box.replaceChildren();
    for (const [k, label] of FILTERS) {
      const n = k === 'all' ? allJobs.length : allJobs.filter(j => groupOf(j.status) === k).length;
      box.append(el('button', { type: 'button', className: 'fchip' + (jobFilter === k ? ' on' : ''), textContent: `${label} (${n})`, onclick: () => { jobFilter = k; renderJobs(); } }));
    }
  }
  function renderJobs() {
    renderFilters();
    const q = $('jobSearch').value.trim().toLowerCase();
    const list = allJobs.filter(j => (jobFilter === 'all' || groupOf(j.status) === jobFilter) && (!q || (j.original_name || '').toLowerCase().includes(q)));
    renderRows($('jobsTable'), list, true);
    $('jobsEmpty').textContent = allJobs.length ? 'No jobs match this filter.' : 'No jobs yet.';
    show($('jobsEmpty'), list.length === 0);
  }
  $('jobSearch').addEventListener('input', renderJobs);
  async function loadJobs() { const { jobs } = await api('GET', '/api/admin/jobs'); allJobs = jobs; renderJobs(); }
  function renderRows(table, jobs, withActions) {
    const tb = table.tBodies[0]; tb.replaceChildren();
    for (const j of jobs) {
      const tr = el('tr');
      tr.append(
        el('td', { textContent: new Date(j.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }),
        el('td', { textContent: j.original_name || '—', title: j.id, className: 'fname' }),
        el('td', { textContent: j.pages_selected ? `${j.pages_selected}p × ${j.copies}${j.color ? ' colour' : ' b/w'}${j.duplex ? ' duplex' : ''}` : '—' }),
        el('td', { textContent: j.amount ? rupees(j.amount) : '—' }),
      );
      const st = el('td', { className: 'wrap' }, el('span', { className: 'badge' + (BAD.has(j.status) ? ' bad' : ['uploaded', 'awaiting_payment', 'refunded'].includes(j.status) ? ' grey' : ''), textContent: j.status.replace('_', ' ') }));
      if (withActions) { if (j.error) st.append(el('small', { textContent: j.error })); if (j.payment_id) st.append(el('small', { textContent: j.payment_id })); }
      tr.append(st);
      if (withActions) {
        const act = el('td', { className: 'acts' });
        if (j.payment_id && !j.refund_id && ['failed', 'refund_failed', 'done'].includes(j.status))
          act.append(el('button', { className: 'btn', textContent: j.status === 'refund_failed' ? 'Retry refund' : 'Refund', onclick: () => refund(j) }));
        if (j.has_file && ['failed', 'refund_failed', 'done'].includes(j.status))
          act.append(el('button', { className: 'btn', textContent: 'Reprint', onclick: () => reprint(j) }));
        if (j.has_file && !['queued', 'printing'].includes(j.status))
          act.append(el('a', { className: 'btn', textContent: 'Download', href: `/api/admin/jobs/${j.id}/file`, download: '' }),
            el('button', { className: 'btn', textContent: 'Delete file', onclick: () => delFile(j) }));
        tr.append(act);
      }
      tb.append(tr);
    }
  }
  async function refund(j) {
    if (!confirm(`Refund ${rupees(j.amount)} to the customer? This cannot be undone.`)) return;
    try { await api('POST', `/api/admin/jobs/${j.id}/refund`, {}); toast('Refund issued'); } catch (e) { toast(e.message); }
    loadJobs();
  }
  async function delFile(j) {
    if (!confirm('Delete the stored file for this job? You will not be able to reprint it.')) return;
    try { await api('DELETE', `/api/admin/jobs/${j.id}/file`); toast('File deleted'); } catch (e) { toast(e.message); }
    loadJobs();
  }
  $('deleteAll').addEventListener('click', async () => {
    if (!confirm('Delete all stored files for finished jobs? This cannot be undone.')) return;
    try { const r = await api('POST', '/api/admin/files/delete-all', {}); $('deleteAllMsg').textContent = `${r.deleted} file(s) deleted.`; } catch (e) { $('deleteAllMsg').textContent = e.message; }
  });
  async function reprint(j) { try { await api('POST', `/api/admin/jobs/${j.id}/reprint`, {}); toast('Queued for reprint'); } catch (e) { toast(e.message); } loadJobs(); }

  /* ---------- settings ---------- */
  const form = $('settingsForm');
  async function loadSettings() {
    settings = await api('GET', '/api/admin/settings');
    $('abName').textContent = settings.business_name;
    api('GET', '/api/admin/system').then(s => { $('unameNew').value = s.identity; show($('unameRow'), s.identity_label === 'Username'); }).catch(() => {});
    document.title = settings.business_name + ' · Admin';
    for (const inp of form.elements) {
      if (!inp.name) continue;
      const v = settings[inp.name];
      if (inp.type === 'checkbox') inp.checked = !!v;
      else if (PRICE_KEYS.includes(inp.name)) inp.value = v / 100;
      else if (inp.type !== 'password') inp.value = v ?? '';
      else inp.value = '';
    }
    $('secretState').textContent = settings.razorpay_key_secret_set ? 'A secret is saved. Leave blank to keep it.' : '';
    $('whState').textContent = settings.razorpay_webhook_secret_set ? 'A secret is saved. Leave blank to keep it.' : '';
    $('whUrl').textContent = `${location.origin}/api/razorpay/webhook`;
    toggleRz();
  }
  function toggleRz() { show($('rzFields'), form.elements.payment_mode.value === 'razorpay'); }
  form.elements.payment_mode.addEventListener('change', toggleRz);
  form.addEventListener('submit', async e => {
    e.preventDefault(); show($('saveError'), false); show($('saveOk'), false);
    const patch = {};
    for (const inp of form.elements) {
      if (!inp.name) continue;
      if (inp.type === 'checkbox') patch[inp.name] = inp.checked;
      else if (PRICE_KEYS.includes(inp.name)) patch[inp.name] = Math.round(Number(inp.value) * 100);
      else if (inp.type === 'number') patch[inp.name] = Number(inp.value);
      else patch[inp.name] = inp.value;
    }
    try {
      settings = await api('PUT', '/api/admin/settings', patch);
      await loadSettings(); show($('saveOk'), true); setTimeout(() => show($('saveOk'), false), 3000);
    } catch (err) {
      const f = err.fields ? ' ' + Object.entries(err.fields).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ') : '';
      $('saveError').textContent = err.message + f; show($('saveError'), true);
    }
  });
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault(); const m = $('pwMsg');
    try { await api('POST', '/api/admin/password', { current: $('pwCur').value, next: $('pwNew').value, username: $('unameNew').value }); m.textContent = 'Saved.'; m.className = 'small ok'; $('pwCur').value = $('pwNew').value = ''; }
    catch (err) { m.textContent = err.message; m.className = 'small error'; }
    show(m, true);
  });

  /* ---------- poster ---------- */
  async function loadPoster() {
    $('posterName').textContent = settings.business_name;
    const svg = await fetch('/api/admin/qr.svg', { credentials: 'same-origin' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    $('qr').replaceChildren(document.importNode(doc.documentElement, true));
    $('posterUrl').textContent = settings.public_url || location.origin;
  }
  $('printPoster').addEventListener('click', () => window.print());

  setInterval(() => { if (session?.authed && !$('tab-dash').hidden) loadDash().catch(() => {}); if (session?.authed && !$('tab-jobs').hidden) loadJobs().catch(() => {}); }, 15000);
  boot();
})();
