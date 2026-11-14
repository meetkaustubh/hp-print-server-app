'use strict';
// Starter legal pages. These are TEMPLATES: the operator must review them (ideally with a lawyer)
// or point the Terms/Privacy/Refund URLs in the admin panel at their own pages.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(page, s) {
  const name = esc(s.business_name);
  const contact = s.support_contact ? esc(s.support_contact) : 'the contact shown on the kiosk';
  const ret = s.retention_minutes;
  const pages = {
    privacy: ['Privacy Policy', `
      <p>${name} lets you print documents from your phone or computer. This page explains what we handle.</p>
      <h2>What we collect</h2>
      <p>The document you upload, your print options, and payment references (order and payment IDs) supplied by Razorpay. We do not receive your card, UPI or bank details; those go directly to Razorpay.</p>
      <h2>How long we keep it</h2>
      <p>Uploaded files are deleted automatically about ${ret} minute(s) after printing finishes or fails, and unpaid uploads are deleted within 30 minutes. We keep a record of job metadata (page count, amount, payment reference, time) for accounting and refunds, but never the document contents.</p>
      <h2>Who sees your documents</h2>
      <p>Your document is sent only to the printer attached to this kiosk. It is not shared with third parties. Do not upload documents you are not comfortable having processed on a shared device.</p>
      <h2>Contact</h2><p>Questions: ${contact}.</p>`],
    terms: ['Terms of Use', `
      <p>By using ${name} you agree to these terms.</p>
      <h2>Service</h2><p>You can upload files, pay, and collect printed pages from the kiosk. Prices are shown before you pay and are charged per printed page and copy.</p>
      <h2>Your content</h2><p>You confirm you have the right to print what you upload and will not print unlawful material. We may refuse or cancel jobs at our discretion.</p>
      <h2>Quality</h2><p>Output depends on the printer and your document. Fonts and layout in converted documents can differ from what you see on screen; for exact results upload a PDF.</p>
      <h2>Liability</h2><p>The service is provided as is. To the extent permitted by law, our liability is limited to the amount you paid for the affected job.</p>
      <h2>Contact</h2><p>${contact}.</p>`],
    refund: ['Refund Policy', `
      <p>If a print fails because of a printer or system problem, we refund the full amount automatically to your original payment method. Refunds normally reach your account in 5-7 business days, depending on your bank.</p>
      <p>If the automatic refund does not go through, note the payment ID shown on screen and contact ${contact}.</p>
      <p>Jobs that printed successfully are not refundable, because pages cannot be recalled. Check the preview and options before paying.</p>`],
  };
  const [title, body] = pages[page] || [];
  if (!title) return null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${name}</title><link rel="stylesheet" href="/style.css"></head><body class="legal"><main class="card"><a class="back" href="/">&larr; Back</a><h1>${title}</h1>${body}</main></body></html>`;
}
module.exports = { render };
