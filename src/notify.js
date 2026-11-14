'use strict';
// Optional outbound alert: POSTs to a URL the operator configures (ntfy.sh, Slack, Discord, etc.)
async function notify(settings, text) {
  const url = settings.get('notify_webhook');
  if (!url) return;
  try {
    const host = new URL(url).hostname;
    const isNtfy = /(^|\.)ntfy\./.test(host);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': isNtfy ? 'text/plain; charset=utf-8' : 'application/json', ...(isNtfy ? { Title: settings.get('business_name') } : {}) },
      body: isNtfy ? text : JSON.stringify({ text: `${settings.get('business_name')}: ${text}`, content: `${settings.get('business_name')}: ${text}` }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.error('notify failed:', e.message); }
}
module.exports = { notify };
