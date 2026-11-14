'use strict';
// Server-side price calculation. The browser never decides what a job costs.
function computePrice(s, { pages, copies, color }) {
  const unit = color ? s.price_color : s.price_bw;
  const raw = pages * copies * unit;
  return Math.max(raw, raw > 0 ? s.min_charge : 0);
}

/** "1-3,5,8-9" -> sorted unique page numbers within [1,total]. Returns null if invalid. */
function parsePageRange(input, total) {
  if (input == null || String(input).trim() === '') return Array.from({ length: total }, (_, i) => i + 1);
  const text = String(input).replace(/\s+/g, '');
  if (text.length > 100 || !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) return null;
  const set = new Set();
  for (const part of text.split(',')) {
    const [a, b] = part.split('-').map(Number);
    const lo = a, hi = b ?? a;
    if (lo < 1 || hi < lo || hi > total) return null;
    for (let p = lo; p <= hi; p++) set.add(p);
  }
  return [...set].sort((x, y) => x - y);
}

/** Compact "1-3,5" form for CUPS page-ranges. */
function compactRange(pages) {
  const out = [];
  let start = pages[0], prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const p = pages[i];
    if (p === prev + 1) { prev = p; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = p;
  }
  return out.join(',');
}

module.exports = { computePrice, parsePageRange, compactRange };
