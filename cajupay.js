const crypto = require('crypto');

const BASE = process.env.CAJUPAY_API_URL || 'https://api.cajupay.com.br';

function keys() {
  const key = process.env.CAJUPAY_API_KEY || '';
  const secret = process.env.CAJUPAY_API_SECRET || '';
  if (!key || !secret) throw new Error('Configure CAJUPAY_API_KEY e CAJUPAY_API_SECRET no .env');
  return { key, secret };
}

function cajuMsg(data, status) {
  const pick = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return pick(v.message || v.user_message || v.error || v.code || v.msg);
    return String(v);
  };
  const msg = pick(data && (data.user_message || data.error || data.message || data.detail || data.code || data.last_error))
    || (data && data.raw) || ('CajuPay ' + status);
  if (String(msg).includes('payouts_blocked_pending_kyc')) {
    return 'CajuPay: saques bloqueados até o KYC da conta ser aprovado.';
  }
  if (String(msg).includes('insufficient') || String(msg).includes('saldo')) {
    return 'CajuPay: saldo insuficiente na carteira da CajuPay.';
  }
  return String(msg);
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
    const err = new Error(cajuMsg(data, r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

function pixKeyType(key) {
  const k = String(key || '').trim();
  const d = k.replace(/\D/g, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return 'evp';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return 'email';
  if (d.length === 14) return 'cnpj';
  if (d.length === 11) return 'cpf';
  if (d.length >= 10 && d.length <= 13) return 'phone';
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
