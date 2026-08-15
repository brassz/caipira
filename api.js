const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { createPix, listPayments, getPayment, createPayout, verifyWebhook } = require('./cajupay');

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket;

(function loadEnv() {
  try {
    const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = (process.env[m[1]] || m[2].trim());
    }
  } catch (_) {}
})();

let client;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Configure SUPABASE_URL e SUPABASE_ANON_KEY no arquivo .env');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { transport: WebSocket }
    });
  }
  return client;
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.body && req.body.token || req.query.token || '';
}

function rpcErr(error) {
  const msg = (error && (error.message || error.error_description)) || 'Erro no banco';
  return msg.replace(/^.*ERROR:\s*/i, '').split('\n')[0];
}

function asList(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function asUser(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return null; }
  }
  if (Array.isArray(data)) data = data[0];
  return data || null;
}

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'brasszgc@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function withAdminFlag(user) {
  if (!user) return user;
  if (ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())) {
    return { ...user, role: 'admin' };
  }
  return user;
}

const DEFAULT_TABLES = [
  { id: 'iniciante', name: 'Iniciante', players: 0, max: 6, seated: [], active: false },
  { id: 'mediana', name: 'Mediana', players: 0, max: 6, seated: [], active: false },
  { id: 'dificil', name: 'Difícil', players: 0, max: 6, seated: [], active: false },
  { id: 'semipro', name: 'Semipro', players: 0, max: 6, seated: [], active: false },
  { id: 'profissional', name: 'Profissional', players: 0, max: 6, seated: [], active: false }
];
let liveTablesFn = () => DEFAULT_TABLES;
function setLiveTables(fn) { liveTablesFn = fn; }
function getLiveTables() {
  try {
    const rows = liveTablesFn();
    return Array.isArray(rows) && rows.length ? rows : DEFAULT_TABLES;
  } catch (_) {
    return DEFAULT_TABLES;
  }
}

async function requireAdmin(req, res) {
  const me = await userFromToken(tokenOf(req));
  if (!me || me.role !== 'admin') {
    res.status(403).json({ error: 'Sem permissão' });
    return null;
  }
  return me;
}

function mountApi(app) {
  const receiptsDir = path.join(__dirname, 'data', 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });

  app.post('/api/register', async (req, res) => {
    try {
      const { email, username, password } = req.body || {};
      const { data, error } = await db().rpc('api_register', {
        p_email: email, p_username: username, p_password: password
      });
      if (error) return res.status(400).json({ error: rpcErr(error) });
      const login = await db().rpc('api_login', { p_email: email, p_password: password });
      if (login.error) return res.json({ user: data });
      const payload = asUser(login.data) || login.data;
      if (payload && payload.user) payload.user = withAdminFlag(payload.user);
      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Erro no cadastro' });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const { data, error } = await db().rpc('api_login', { p_email: email, p_password: password });
      if (error) return res.status(400).json({ error: rpcErr(error) });
      const payload = asUser(data) || data;
      if (payload && payload.user) payload.user = withAdminFlag(payload.user);
      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Erro no login' });
    }
  });

  app.get('/api/me', async (req, res) => {
    const { data, error } = await db().rpc('api_me', { p_token: tokenOf(req) });
    if (error) return res.status(401).json({ error: rpcErr(error) });
    res.json(withAdminFlag(asUser(data)));
  });

  app.post('/api/logout', async (req, res) => {
    await db().rpc('api_logout', { p_token: tokenOf(req) });
    res.json({ ok: true });
  });

  app.post('/api/deposit', async (req, res) => {
    const { amount, filename, fileBase64 } = req.body || {};
    let stored = '';
    if (fileBase64) {
      const ext = (filename || 'comprovante.jpg').replace(/[^\w.\-]/g, '_').slice(-40);
      stored = Date.now() + '-' + ext;
      const buf = Buffer.from(String(fileBase64).split(',').pop(), 'base64');
      fs.writeFileSync(path.join(receiptsDir, stored), buf);
    }
    const { data, error } = await db().rpc('api_deposit', {
      p_token: tokenOf(req), p_amount: Number(amount), p_path: stored
    });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ id: data });
  });

  async function confirmPixPath(pathRef) {
    const { error } = await db().rpc('api_confirm_deposit_by_path', { p_path: pathRef });
    if (error) throw new Error(rpcErr(error));
  }

  app.post('/api/pix', async (req, res) => {
    try {
      const me = await userFromToken(tokenOf(req));
      if (!me) return res.status(401).json({ error: 'Faça login.' });
      const amount = Number(req.body && req.body.amount);
      if (!amount || amount < 10) return res.status(400).json({ error: 'Depósito mínimo R$ 10,00.' });
      const doc = String((req.body && req.body.document) || '').replace(/\D/g, '');
      if (doc.length !== 11 && doc.length !== 14) {
        return res.status(400).json({ error: 'Informe um CPF válido.' });
      }
      const cents = Math.round(amount * 100);
      const pay = await createPix({
        amountCents: cents,
        userId: me.id,
        email: me.email,
        name: me.username || req.body.name,
        document: doc
      });
      const paymentId = pay.payment_id || pay.id;
      const pathRef = 'cajupay:' + paymentId;
      const { data, error } = await db().rpc('api_deposit', {
        p_token: tokenOf(req), p_amount: amount, p_path: pathRef
      });
      if (error) return res.status(400).json({ error: rpcErr(error) });
      res.json({
        id: data,
        paymentId,
        status: pay.status || 'pending',
        copyPaste: pay.pix_copy_paste || pay.pix_key || '',
        qr: pay.pix_qr_code || ''
      });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Erro ao gerar PIX' });
    }
  });

  app.get('/api/pix/status/:id', async (req, res) => {
    try {
      const me = await userFromToken(tokenOf(req));
      if (!me) return res.status(401).json({ error: 'Faça login.' });
      const hist = await db().rpc('api_my_deposits', { p_token: tokenOf(req) });
      const row = asList(hist.data).find(x => String(x.id) === String(req.params.id));
      if (!row) return res.status(404).json({ error: 'Depósito não encontrado' });
      if (row.status === 'approved') return res.json({ status: 'approved', balance: me.balance });
      const pathRef = row.receipt_path || '';
      const pid = pathRef.replace(/^cajupay:/, '');
      if (pid) {
        let found = null;
        try {
          const one = await getPayment(pid);
          found = one.payment || one.data || one;
        } catch (_) {
          const list = await listPayments().catch(() => []);
          const items = Array.isArray(list) ? list : (list.data || list.payments || []);
          found = items.find(p => String(p.payment_id || p.id) === String(pid));
        }
        const st = String((found && (found.status || found.payment_status)) || '').toLowerCase();
        if (st === 'paid' || st === 'completed' || st === 'confirmed') {
          await confirmPixPath(pathRef);
          const fresh = await userFromToken(tokenOf(req));
          return res.json({ status: 'approved', balance: fresh && fresh.balance });
        }
      }
      res.json({ status: row.status || 'pending' });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Erro' });
    }
  });

  app.post('/webhooks/cajupay', async (req, res) => {
    try {
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const event = verifyWebhook(raw, req.headers['x-cajupay-signature'], process.env.CAJUPAY_WEBHOOK_SECRET);
      const type = String(event.type || req.headers['x-cajupay-event'] || '');
      const obj = (event.data && event.data.object) || event.data || {};
      if (type.includes('pix.payment.paid')) {
        const pid = obj.cajupay_payment_id || obj.payment_id || obj.id;
        if (pid) await confirmPixPath('cajupay:' + pid);
      }
      if (type.includes('payout.paid') || type.includes('payout.failed')) {
        const poid = obj.cajupay_payout_id || obj.payout_id || obj.id;
        if (poid) {
          await db().rpc('api_confirm_withdrawal_by_payout', {
            p_payout: String(poid),
            p_ok: type.includes('payout.paid')
          });
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Webhook inválido' });
    }
  });

  app.post('/api/withdraw', async (req, res) => {
    try {
      const amount = Number(req.body && req.body.amount);
      const pixKey = String((req.body && req.body.pixKey) || '').trim();
      let document = String((req.body && req.body.document) || '').replace(/\D/g, '');
      const keyDigits = pixKey.replace(/\D/g, '');
      if (document.length !== 11 && document.length !== 14 && (keyDigits.length === 11 || keyDigits.length === 14)) {
        document = keyDigits;
      }
      if (!amount || amount < 15) return res.status(400).json({ error: 'Saque mínimo R$ 15,00.' });
      if (document.length !== 11 && document.length !== 14) {
        return res.status(400).json({ error: 'Informe o CPF do titular da chave PIX.' });
      }
      const { data, error } = await db().rpc('api_withdraw', {
        p_token: tokenOf(req), p_amount: amount, p_pix: pixKey
      });
      if (error) return res.status(400).json({ error: rpcErr(error) });
      const wid = Array.isArray(data) ? data[0] : data;
      const settle = async (status, payoutId) => {
        const r = await db().rpc('api_settle_my_withdrawal', {
          p_token: tokenOf(req), p_id: wid, p_status: status, p_payout: payoutId || ''
        });
        if (r.error) throw new Error(rpcErr(r.error));
      };
      try {
        const pay = await createPayout({
          amountCents: Math.round(amount * 100),
          pixKey,
          ownerDocument: document
        });
        const poid = String(pay.payout_id || pay.id || '');
        const st = String(pay.status || '').toLowerCase();
        if (st === 'failed' || st === 'cancelled' || st === 'canceled') {
          try { await settle('rejected', poid); } catch (_) {}
          return res.status(400).json({ error: 'A CajuPay recusou o saque. Saldo estornado.' });
        }
        try { await settle('paid', poid); } catch (se) {
          return res.json({ id: wid, status: 'pending', payoutId: poid, warning: se.message });
        }
        const me = await userFromToken(tokenOf(req));
        res.json({ id: wid, status: 'paid', payoutId: poid, balance: me && me.balance });
      } catch (e) {
        try { await settle('rejected', ''); } catch (_) {}
        return res.status(400).json({ error: e.message || 'Falha no PIX de saque. Saldo estornado.' });
      }
    } catch (e) {
      res.status(400).json({ error: e.message || 'Erro no saque' });
    }
  });

  app.get('/api/history', async (req, res) => {
    const t = tokenOf(req);
    const d = await db().rpc('api_my_deposits', { p_token: t });
    const w = await db().rpc('api_my_withdrawals', { p_token: t });
    if (d.error) return res.status(401).json({ error: rpcErr(d.error) });
    res.json({ deposits: d.data || [], withdrawals: w.data || [] });
  });

  app.get('/api/admin/users', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const { data, error } = await db().rpc('api_admin_users', { p_token: tokenOf(req) });
    if (error) return res.status(403).json({ error: rpcErr(error) });
    res.json(asList(data).map(u => {
      const row = { ...u };
      delete row.password_hash;
      return row;
    }));
  });

  app.post('/api/admin/balance', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const { userId, balance, delta } = req.body || {};
    const num = (x) => {
      const n = Number(String(x ?? '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    const dlt = num(delta);
    const bal = num(balance);
    let next = bal;
    if (dlt != null && dlt !== 0) {
      const listed = await db().rpc('api_admin_users', { p_token: tokenOf(req) });
      if (listed.error) return res.status(400).json({ error: rpcErr(listed.error) });
      const u = asList(listed.data).find(x => String(x.id) === String(userId));
      if (!u) return res.status(400).json({ error: 'Usuário não encontrado' });
      next = (Number(u.balance) || 0) + dlt;
    }
    if (next == null || !Number.isFinite(Number(next))) {
      return res.status(400).json({ error: 'Informe um valor válido' });
    }
    next = Math.round(Math.max(0, Number(next)) * 100) / 100;
    const { error } = await db().rpc('api_admin_set_balance', {
      p_token: tokenOf(req),
      p_user: userId,
      p_balance: next
    });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true, balance: next });
  });

  app.post('/api/admin/users/:id/delete', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const { error } = await db().rpc('api_admin_delete_user', {
      p_token: tokenOf(req), p_user: req.params.id
    });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true });
  });

  app.get('/api/admin/tables', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    res.json(getLiveTables());
  });

  app.get('/api/admin/deposits', async (req, res) => {
    const { data, error } = await db().rpc('api_admin_deposits', { p_token: tokenOf(req) });
    if (error) return res.status(403).json({ error: rpcErr(error) });
    res.json(asList(data));
  });

  app.post('/api/admin/deposits/:id/approve', async (req, res) => {
    const { error } = await db().rpc('api_approve_deposit', { p_token: tokenOf(req), p_id: req.params.id });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true });
  });

  app.post('/api/admin/deposits/:id/reject', async (req, res) => {
    const { error } = await db().rpc('api_reject_deposit', { p_token: tokenOf(req), p_id: req.params.id });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true });
  });

  app.get('/api/admin/withdrawals', async (req, res) => {
    const { data, error } = await db().rpc('api_admin_withdrawals', { p_token: tokenOf(req) });
    if (error) return res.status(403).json({ error: rpcErr(error) });
    res.json(asList(data));
  });

  app.post('/api/admin/withdrawals/:id/pay', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const listed = await db().rpc('api_admin_withdrawals', { p_token: tokenOf(req) });
    if (listed.error) return res.status(400).json({ error: rpcErr(listed.error) });
    const w = asList(listed.data).find(x => String(x.id) === String(req.params.id));
    if (!w) return res.status(404).json({ error: 'Saque não encontrado' });
    try {
      await createPayout({
        amountCents: Math.round(Number(w.amount) * 100),
        pixKey: w.pix_key,
        ownerDocument: req.body && req.body.document
      });
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Falha no PIX de saque' });
    }
    const { error } = await db().rpc('api_pay_withdrawal', { p_token: tokenOf(req), p_id: req.params.id });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true });
  });

  app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
    const { error } = await db().rpc('api_reject_withdrawal', { p_token: tokenOf(req), p_id: req.params.id });
    if (error) return res.status(400).json({ error: rpcErr(error) });
    res.json({ ok: true });
  });

  app.get('/api/admin/receipt/:file', async (req, res) => {
    const me = withAdminFlag(await userFromToken(req.query.token || tokenOf(req)));
    if (!me || me.role !== 'admin') return res.status(403).end();
    const file = path.basename(req.params.file);
    const full = path.join(receiptsDir, file);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.sendFile(full);
  });
}

async function buyIn(token, tableId) {
  const { data, error } = await db().rpc('api_buy_in', { p_token: token, p_table: tableId });
  if (error) throw new Error(rpcErr(error));
  return Number(data);
}

async function cashOutRpc(token, amount) {
  if (!token || !amount) return;
  await db().rpc('api_cash_out', { p_token: token, p_amount: amount });
}

async function userFromToken(token) {
  const { data, error } = await db().rpc('api_me', { p_token: token });
  if (error) return null;
  return withAdminFlag(asUser(data));
}

module.exports = { mountApi, buyIn, cashOutRpc, userFromToken, db, setLiveTables, getLiveTables };
