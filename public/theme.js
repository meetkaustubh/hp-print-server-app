// Applies the saved light/dark choice before first paint (kept as a file because the CSP forbids inline scripts)
try { var t = localStorage.getItem('pn_theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) {}
