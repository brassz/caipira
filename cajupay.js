const crypto = require('crypto');

const BASE = process.env.CAJUPAY_API_URL || 'https://api.cajupay.com.br';

function keys() {
  const key = process.env.CAJUPAY_API_KEY || '';
  const secret = process.env.CAJUPAY_API_SECRET || '';
  if (!key || !secret) throw new Error('Configure CAJUPAY_API_KEY e CAJUPAY_API_SECRET no .env');
  return { key, secret };
}

async function caju(method, path, body, extraHeaders) {
  const { key, secret } = keys();
  const opt = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      'X-API-Secret': secret,
      ...(extraHeaders || {})
    }
  };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!r.ok) {
    const msg = data.error || data.user_message || data.message || ('CajuPay ' + r.status);
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

function pixKeyType(key) {
  const k = String(key || '').trim();
  const d = k.replace(/\D/g, '');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return 'email';
  if (d.length === 11 && /^\d+$/.test(d) && !k.includes('@')) return 'cpf';
  if (d.length === 14 && /^\d+$/.test(d)) return 'cnpj';
  if (d.length >= 10 && d.length <= 13 && (k.startsWith('+') || k.startsWith('55') || /^\d+$/.test(k.replace(/\s/g, '')))) {
    if (!k.includes('@') && d.length !== 11) return 'phone';
    if (k.startsWith('+') || k.startsWith('(')) return 'phone';
  }
  return 'evp';
}

function createPix({ amountCents, userId, email, name, document, description }) {
  const idk = crypto.randomUUID();
  const doc = String(document || '').replace(/\D/g, '');
  return caju('POST', '/api/payments/pix', {
    amount_cents: amountCents,
    currency: 'BRL',
    description: description || 'Poker da Galera',
    product_ref: 'deposit',
    customer_ref: String(userId),
    consumer: {
      name: name || 'Jogador',
      email: email || 'jogador@pokerdagalera.local',
      document: doc || '00000000000'
    }
  }, { 'Idempotency-Key': idk });
}

function listPayments() {
  return caju('GET', '/api/payments?limit=50');
}

function getPayment(id) {
  return caju('GET', '/api/payments/' + encodeURIComponent(id));
}

function createPayout({ amountCents, pixKey, ownerDocument }) {
  let key = String(pixKey || '').trim();
  const type = pixKeyType(key);
  if (type === 'cpf' || type === 'cnpj' || type === 'phone') key = key.replace(/\D/g, '');
  const body = {
    amount_cents: amountCents,
    currency: 'BRL',
    wallet_kind: 'main',
    destination: { method: 'dict' },
    pix_key: key,
    pix_key_type: type
  };
  const doc = String(ownerDocument || '').replace(/\D/g, '');
  if (doc.length >= 11) body.key_owner_document = doc;
  return caju('POST', '/api/payouts', body, { 'Idempotency-Key': crypto.randomUUID() });
}

function verifyWebhook(rawBuf, sigHdr, secret) {
  if (!secret) return JSON.parse(rawBuf.toString('utf8'));
  const [tPart, vPart] = String(sigHdr || '').split(',');
  const ts = (tPart || '').replace(/^t=/, '');
  const sig = (vPart || '').replace(/^v1=/, '');
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + rawBuf.toString('utf8')).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Assinatura inválida');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error('Webhook expirado');
  return JSON.parse(rawBuf.toString('utf8'));
}

module.exports = { createPix, listPayments, getPayment, createPayout, verifyWebhook, pixKeyType };
