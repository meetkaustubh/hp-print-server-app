'use strict';
// Server-side price calculation. The browser never decides what a job costs.
function rates(s, bulk) {
  return { bw: bulk ? (s.bulk_price_bw || s.price_bw) : s.price_bw, color: bulk ? (s.bulk_price_color || s.price_color) : s.price_color };
}
/** Price multiplier for a colour page whose coloured area is `cov` (0..1): heavier colour costs more. */
function colourMultiplier(s, cov) {
  const c = (cov || 0) * 100;
  const extra = [[s.color_medium_pct, s.color_medium_extra], [s.color_medhigh_pct, s.color_medhigh_extra], [s.color_high_pct, s.color_high_extra]]
    .filter(([pct]) => c >= pct).reduce((m, [, e]) => Math.max(m, e), 0);   // the highest surcharge among the levels this page reaches
  return 1 + extra / 100;
}
/**
 * pages = number of selected pages. colourMap = { page: coveredFraction } for the selected pages that contain colour
 * (reported by the browser), or null when unknown.
 */
function computePrice(s, { pages, copies, color, colourMap = null, bulk = false }) {
  const r = rates(s, bulk);
  let per;
  if (!color) per = pages * r.bw;
  else if (!colourMap) per = pages * r.color;
  else {
    const covs = Object.values(colourMap);
    const plain = s.color_billing === 'per_page' ? r.bw : r.color;   // pages without colour
    per = (pages - covs.length) * plain + covs.reduce((n, cov) => n + r.color * colourMultiplier(s, cov), 0);
  }
  const raw = Math.round(per * copies);
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

module.exports = { isBulk, colourMultiplier, computePrice, parsePageRange, compactRange };
