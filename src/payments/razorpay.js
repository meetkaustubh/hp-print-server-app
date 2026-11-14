'use strict';
// Minimal Razorpay client over their REST API (no SDK, no extra dependencies).
// Security-critical bits: HMAC verification of the checkout signature and of webhooks.
const crypto = require('node:crypto');

function hmacHex(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('hex'); }
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

class Razorpay {
  constructor({ keyId, keySecret, webhookSecret, fetchImpl }) {
    this.keyId = keyId; this.keySecret = keySecret; this.webhookSecret = webhookSecret;
    this.fetch = fetchImpl || fetch;
  }
  get configured() { return !!(this.keyId && this.keySecret); }
  get isLive() { return this.keyId.startsWith('rzp_live_'); }

  async _call(method, path, body) {
    const res = await this.fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64'),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error?.description || `Razorpay error ${res.status}`);
      err.status = res.status; err.code = json?.error?.code;
      throw err;
    }
    return json;
  }

  createOrder({ amount, currency, receipt, notes }) {
    return this._call('POST', '/orders', { amount, currency, receipt, notes });
  }
  fetchPayment(paymentId) { return this._call('GET', `/payments/${encodeURIComponent(paymentId)}`); }
  refund({ paymentId, amount, receipt, notes }) {
    return this._call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, speed: 'normal', receipt, notes });
  }

  /** Signature the Checkout widget returns: HMAC_SHA256(order_id|payment_id, key_secret) */
  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    if (!this.keySecret || !orderId || !paymentId || !signature) return false;
    return safeEqualHex(hmacHex(this.keySecret, `${orderId}|${paymentId}`), String(signature));
  }
  /** Webhook signature: HMAC_SHA256(raw_body, webhook_secret) in X-Razorpay-Signature */
  verifyWebhook(rawBody, signature) {
    if (!this.webhookSecret || !signature) return false;
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), String(signature));
  }
}

module.exports = { Razorpay, hmacHex };
