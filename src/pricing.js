'use strict';
// Server-side price calculation. The browser never decides what a job costs.
function rates(s, bulk) {
  return { bw: bulk ? (s.bulk_price_bw || s.price_bw) : s.price_bw, color: bulk ? (s.bulk_price_color || s.price_color) : s.price_color };
}
/** colourPages = how many of the selected pages contain colour (only used when colour billing is per page). */
function computePrice(s, { pages, copies, color, colourPages = null, bulk = false }) {
  const r = rates(s, bulk);
  let per;
  if (!color) per = pages * r.bw;
  else if (s.color_billing === 'per_page' && colourPages != null) per = colourPages * r.color + (pages - colourPages) * r.bw;
  else per = pages * r.color;
  const raw = per * copies;
  return Math.max(raw, raw > 0 ? s.min_charge : 0);
}
/** Bulk rates apply when the whole order is big enough. */
const isBulk = (s, totalPages) => s.bulk_min_pages > 0 && totalPages >= s.bulk_min_pages;

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

module.exports = { isBulk, computePrice, parsePageRange, compactRange };
