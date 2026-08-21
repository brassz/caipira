const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) {}

const { mountApi, buyIn, cashOutRpc, userFromToken, setLiveTables, getLiveTables, canSeeHands } = require('./api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
app.use(express.json({
  limit: '8mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
mountApi(app);
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), {
  maxAge: '7d', immutable: true, etag: true
}));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));
const TURN_MS = 18000;
const TABLES = {
  iniciante: { sb: 25, bb: 50, buy: 10 },
  mediana: { sb: 50, bb: 100, buy: 25 },
  dificil: { sb: 100, bb: 200, buy: 55 },
  semipro: { sb: 250, bb: 500, buy: 100 },
  profissional: { sb: 500, bb: 1000, buy: 200 }
};
const HAND_NAMES = ['Carta alta', 'Par', 'Dois pares', 'Trinca', 'Sequência', 'Flush', 'Full house', 'Quadra', 'Straight flush'];

app.get('/health', (_, res) => res.json({ ok: true, app: 'poker-da-galera' }));

const rooms = new Map();
const TABLE_NAMES = {
  iniciante: 'Iniciante', mediana: 'Mediana', dificil: 'Difícil',
  semipro: 'Semipro', profissional: 'Profissional'
};
setLiveTables(() => Object.keys(TABLES).map(id => {
  const room = rooms.get(id);
  const seated = room ? [...room.players.values()].map(p => p.name) : [];
  return {
    id, name: TABLE_NAMES[id] || id,
    players: seated.length, max: 6, seated,
    active: seated.length > 0
  };
}));

function makeDeck() {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const suits = ['S', 'H', 'D', 'C'];
  const d = [];
  for (const r of ranks) for (const s of suits) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function comb(a, k) {
  const out = [];
  const go = (s, c) => {
    if (c.length === k) return out.push(c.slice());
    for (let i = s; i < a.length; i++) {
      c.push(a[i]);
      go(i + 1, c);
      c.pop();
    }
  };
  go(0, []);
  return out;
}
const rv = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
function score5(cards) {
  const vals = cards.map(c => rv[c.r]).sort((a, b) => b - a);
  const counts = {};
  vals.forEach(v => (counts[v] = (counts[v] || 0) + 1));
  const flush = cards.every(c => c.s === cards[0].s);
  let uniq = [...new Set(vals)];
  if (uniq[0] === 14) uniq.push(1);
  let highStraight = 0;
  for (let i = 0; i <= uniq.length - 5; i++) if (uniq[i] - uniq[i + 4] === 4) {
    highStraight = uniq[i];
    break;
  }
  const groups = Object.entries(counts).map(([v, n]) => ({ v: +v, n })).sort((a, b) => b.n - a.n || b.v - a.v);
  if (flush && highStraight) return [8, highStraight];
  if (groups[0].n === 4) return [7, groups[0].v, groups[1].v];
  if (groups[0].n === 3 && groups[1].n === 2) return [6, groups[0].v, groups[1].v];
  if (flush) return [5, ...vals];
  if (highStraight) return [4, highStraight];
  if (groups[0].n === 3) return [3, groups[0].v, ...groups.filter(g => g.n === 1).map(g => g.v).sort((a, b) => b - a)];
  if (groups[0].n === 2 && groups[1].n === 2) {
    const ps = [groups[0].v, groups[1].v].sort((a, b) => b - a);
    const k = groups.find(g => g.n === 1).v;
    return [2, ...ps, k];
  }
  if (groups[0].n === 2) return [1, groups[0].v, ...groups.filter(g => g.n === 1).map(g => g.v).sort((a, b) => b - a)];
  return [0, ...vals];
}
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
function bestOmaha(hand, board) {
  let best = null;
  for (const h of comb(hand, 2)) for (const b of comb(board, 3)) {
    const s = score5([...h, ...b]);
    if (!best || cmp(s, best) > 0) best = s;
  }
  return best;
}
function handLabel(score) {
  return score ? HAND_NAMES[score[0]] : '';
}
function makeRoom(code, sb, bb) {
  return {
    code,
    sbAmount: sb,
    bbAmount: bb,
    players: new Map(),
    hostId: null,
    stage: 'idle',
    deck: [],
    board: [],
    visibleBoard: [],
    pot: 0,
    currentBet: 0,
    minRaise: bb,
    dealerId: null,
    sbId: null,
    bbId: null,
    actorId: null,
    turnEndsAt: 0,
    turnTimer: null,
    nextHandTimer: null,
    banner: null
  };
}
function list(room) {
  return [...room.players.values()];
}
function active(room) {
  return list(room).filter(p => !p.folded && p.inHand);
}
function canAct(p) {
  return p && p.inHand && !p.folded && !p.allIn && p.credits > 0;
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcastState(room) {
  const reveal = room.stage === 'showdown';
  const stBase = {
    room: room.code,
    stage: room.stage,
    board: room.visibleBoard,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    bb: room.bbAmount,
    buyIn: (TABLES[room.code] && TABLES[room.code].buy) || 0,
    limit: 'pot',
    actorId: room.actorId,
    turnEndsAt: room.turnEndsAt,
    turnMs: TURN_MS,
    banner: room.banner,
    dealerId: room.dealerId,
    sbId: room.sbId,
    bbId: room.bbId
  };
  for (const p of room.players.values()) {
    const st = {
      ...stBase,
      toCall: p ? Math.max(0, room.currentBet - p.streetBet) : 0,
      potMaxTo: p ? potMaxTo(room, p) : 0,
      players: list(room).map(x => ({
        id: x.id,
        name: x.name,
        avatar: x.avatar || '01',
        credits: x.credits,
        hand: x.id === p.id || reveal || p.seeHands ? x.hand : (x.hand || []).map(() => null),
        winner: !!x.winner,
        folded: !!x.folded,
        allIn: !!x.allIn,
        streetBet: x.streetBet,
        invested: x.invested,
        lastAction: x.lastAction || '',
        inHand: !!x.inHand
      }))
    };
    send(p.ws, { type: 'state', state: st });
  }
}
function clearTimers(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
  room.turnTimer = null;
  room.nextHandTimer = null;
  room.actorId = null;
  room.turnEndsAt = 0;
}
function putChips(room, p, n) {
  const x = Math.min(Math.max(0, Math.floor(n)), p.credits);
  p.credits -= x;
  p.streetBet += x;
  p.invested += x;
  room.pot += x;
  if (p.credits === 0) p.allIn = true;
  return x;
}
function nextFrom(room, id, pred) {
  const ps = list(room);
  if (!ps.length) return null;
  let i = ps.findIndex(p => p.id === id);
  if (i < 0) i = 0;
  for (let k = 1; k <= ps.length; k++) {
    const p = ps[(i + k) % ps.length];
    if (pred(p)) return p;
  }
  return null;
}
function bettingClosed(room) {
  const live = active(room);
  if (live.length <= 1) return true;
  const actors = live.filter(canAct);
  if (!actors.length) return true;
  return actors.every(p => p.actedThisStreet && p.streetBet === room.currentBet);
}
function startTurn(room, p) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (!p) {
    room.actorId = null;
    finishStreet(room);
    return;
  }
  room.actorId = p.id;
  room.turnEndsAt = Date.now() + TURN_MS;
  const current = p.id;
  const stage = room.stage;
  room.turnTimer = setTimeout(() => {
    if (room.actorId !== current || room.stage !== stage) return;
    const pl = room.players.get(current);
    if (!pl) return;
    if (pl.streetBet >= room.currentBet) doCheck(room, pl);
    else doFold(room, pl);
  }, TURN_MS);
  broadcastState(room);
}
function beginStreetAction(room) {
  const live = active(room);
  if (live.length <= 1) {
    awardFold(room);
    return;
  }
  if (live.filter(canAct).length <= 1 && live.some(p => p.allIn)) {
    runout(room);
    return;
  }
  const first = nextFrom(room, room.stage === 'preflop' ? room.bbId : room.dealerId, canAct);
  startTurn(room, first);
}
function finishStreet(room) {
  const live = active(room);
  if (live.length <= 1) {
    awardFold(room);
    return;
  }
  if (room.stage === 'river' || live.every(p => p.allIn || !canAct(p))) {
    runout(room);
    return;
  }
  nextStreet(room);
}
function afterAct(room) {
  const live = active(room);
  if (live.length <= 1) {
    awardFold(room);
    return;
  }
  if (bettingClosed(room)) {
    finishStreet(room);
    return;
  }
  const nxt = nextFrom(room, room.actorId, canAct);
  startTurn(room, nxt);
}
function resetStreet(room) {
  for (const p of list(room)) {
    p.streetBet = 0;
    p.actedThisStreet = false;
    if (p.inHand && !p.folded) p.lastAction = '';
  }
  room.currentBet = 0;
  room.minRaise = room.bbAmount;
}
function nextStreet(room) {
  resetStreet(room);
  if (room.stage === 'preflop') {
    room.visibleBoard = room.board.slice(0, 3);
    room.stage = 'flop';
  } else if (room.stage === 'flop') {
    room.visibleBoard = room.board.slice(0, 4);
    room.stage = 'turn';
  } else if (room.stage === 'turn') {
    room.visibleBoard = room.board.slice(0, 5);
    room.stage = 'river';
  } else {
    runout(room);
    return;
  }
  beginStreetAction(room);
}
function runout(room) {
  room.visibleBoard = [...room.board];
  showdown(room);
}
function winnersOf(players, board) {
  let best = null;
  let winners = [];
  for (const p of players) {
    const s = bestOmaha(p.hand, board);
    p.result = handLabel(s);
    if (!best || cmp(s, best) > 0) {
      best = s;
      winners = [p];
    } else if (cmp(s, best) === 0) winners.push(p);
  }
  return winners;
}
function splitAmong(amount, players) {
  if (!players.length || amount <= 0) return 0;
  const share = Math.floor(amount / players.length);
  let rest = amount - share * players.length;
  players.forEach(p => { p.credits += share; });
  if (rest) players[0].credits += rest;
  return share;
}
function showdown(room) {
  clearTimers(room);
  const elig = active(room);
  if (!elig.length) return;
  const snapshot = list(room).filter(p => p.inHand).map(p => ({ p, left: p.invested }));
  let paid = 0;
  let lastShare = 0;
  let lastWinners = elig;
  while (snapshot.some(x => x.left > 0)) {
    const layer = snapshot.filter(x => x.left > 0);
    const minIn = Math.min(...layer.map(x => x.left));
    const pot = minIn * layer.length;
    layer.forEach(x => { x.left -= minIn; });
    const ids = new Set(layer.map(x => x.p.id));
    const eligHere = elig.filter(p => ids.has(p.id));
    if (!eligHere.length) continue;
    const w = winnersOf(eligHere, room.board);
    lastShare = splitAmong(pot, w);
    lastWinners = w;
    paid += pot;
  }
  lastWinners.forEach(p => { p.winner = true; });
  room.stage = 'showdown';
  room.visibleBoard = [...room.board];
  room.banner = { names: lastWinners.map(p => p.name), amount: lastShare };
  broadcastState(room);
  scheduleNext(room);
}
function awardFold(room) {
  clearTimers(room);
  const w = active(room)[0];
  if (w) {
    w.credits += room.pot;
    w.winner = true;
    room.banner = { names: [w.name], amount: room.pot };
  }
  room.stage = 'showdown';
  broadcastState(room);
  scheduleNext(room);
}
function scheduleNext(room) {
  if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
  room.nextHandTimer = setTimeout(() => startHand(room), 4000);
}
function doFold(room, p) {
  p.folded = true;
  p.lastAction = 'fold';
  p.actedThisStreet = true;
  afterAct(room);
}
function doCheck(room, p) {
  if (p.streetBet < room.currentBet) return;
  p.lastAction = 'check';
  p.actedThisStreet = true;
  afterAct(room);
}
function doCall(room, p) {
  const need = room.currentBet - p.streetBet;
  if (need <= 0) {
    doCheck(room, p);
    return;
  }
  putChips(room, p, need);
  p.lastAction = p.allIn ? 'allin' : 'call';
  p.actedThisStreet = true;
  afterAct(room);
}
function potMaxTo(room, p) {
  const toCall = Math.max(0, room.currentBet - p.streetBet);
  const maxPut = toCall + (room.pot + toCall);
  return Math.min(p.streetBet + p.credits, p.streetBet + maxPut);
}
function doRaise(room, p, to) {
  to = Math.floor(Number(to));
  const stackTo = p.streetBet + p.credits;
  const cap = potMaxTo(room, p);
  if (!Number.isFinite(to)) return;
  to = Math.min(to, cap, stackTo);
  const need = to - p.streetBet;
  if (need <= 0) return;
  const raiseBy = to - room.currentBet;
  const isAllIn = to === stackTo;
  if (to < room.currentBet) return;
  if (to > room.currentBet && raiseBy < room.minRaise && !isAllIn) return;
  putChips(room, p, need);
  if (to > room.currentBet) {
    if (raiseBy >= room.minRaise) room.minRaise = raiseBy;
    room.currentBet = p.streetBet;
    for (const o of list(room)) if (o.id !== p.id && canAct(o)) o.actedThisStreet = false;
  }
  p.lastAction = p.allIn ? 'allin' : (raiseBy > 0 ? 'raise' : 'call');
  p.actedThisStreet = true;
  afterAct(room);
}
function startHand(room) {
  clearTimers(room);
  const seated = list(room).filter(p => p.credits > 0);
  if (seated.length < 2) {
    room.stage = 'idle';
    room.banner = null;
    room.visibleBoard = [];
    room.pot = 0;
    broadcastState(room);
    return;
  }
  room.banner = null;
  room.deck = makeDeck();
  room.board = [];
  room.visibleBoard = [];
  room.pot = 0;
  room.stage = 'preflop';
  for (const p of list(room)) {
    p.hand = [];
    p.winner = false;
    p.result = '';
    p.folded = p.credits <= 0;
    p.allIn = false;
    p.inHand = p.credits > 0;
    p.streetBet = 0;
    p.invested = 0;
    p.actedThisStreet = false;
    p.lastAction = '';
  }
  const order = list(room).filter(p => p.inHand);
  let d = order.findIndex(p => p.id === room.dealerId);
  d = (d + 1) % order.length;
  room.dealerId = order[d].id;
  if (order.length === 2) {
    room.sbId = order[d].id;
    room.bbId = order[(d + 1) % 2].id;
  } else {
    room.sbId = order[(d + 1) % order.length].id;
    room.bbId = order[(d + 2) % order.length].id;
  }
  const sb = room.players.get(room.sbId);
  const bb = room.players.get(room.bbId);
  putChips(room, sb, room.sbAmount);
  putChips(room, bb, room.bbAmount);
  sb.lastAction = 'sb';
  bb.lastAction = 'bb';
  room.currentBet = Math.max(sb.streetBet, bb.streetBet, room.bbAmount);
  room.minRaise = room.bbAmount;
  for (const p of order) p.hand = room.deck.splice(0, 5);
  room.board = room.deck.splice(0, 5);
  beginStreetAction(room);
}

async function cashOut(player) {
  if (!player || !player.token) return;
  const amount = (player.credits || 0) / 100;
  player.credits = 0;
  if (amount <= 0) return;
  try { await cashOutRpc(player.token, amount); } catch (_) {}
}

wss.on('connection', ws => {
  let player = null;
  let room = null;
  ws.on('message', async raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const tableId = String(m.table || '').replace(/[^a-z]/g, '');
      const cfg = TABLES[tableId];
      if (!cfg || !m.token) {
        send(ws, { type: 'error', message: 'Mesa ou login inválido.' });
        return;
      }
      const me = await userFromToken(m.token);
      if (!me) {
        send(ws, { type: 'error', message: 'Faça login novamente.' });
        return;
      }
      if (!rooms.has(tableId)) rooms.set(tableId, makeRoom(tableId, cfg.sb, cfg.bb));
      room = rooms.get(tableId);
      if (room.players.size >= 6) {
        send(ws, { type: 'error', message: 'Mesa cheia.' });
        return;
      }
      if ([...room.players.values()].some(p => p.userId === me.id)) {
        send(ws, { type: 'error', message: 'Você já está nesta mesa.' });
        return;
      }
      let buyin;
      try { buyin = await buyIn(m.token, tableId); }
      catch (e) {
        send(ws, { type: 'error', message: e.message || 'Saldo insuficiente.' });
        return;
      }
      const id = String(me.id).slice(0, 8);
      player = {
        id,
        userId: me.id,
        token: m.token,
        name: me.username || 'Jogador',
        avatar: me.avatar || '01',
        seeHands: canSeeHands(me),
        credits: Math.round(Number(buyin) * 100),
        hand: [],
        winner: false,
        folded: true,
        allIn: false,
        inHand: false,
        streetBet: 0,
        invested: 0,
        actedThisStreet: false,
        lastAction: '',
        connected: true,
        ws
      };
      room.players.set(id, player);
      if (!room.hostId) room.hostId = id;
      send(ws, { type: 'joined', id, room: tableId });
      if (room.stage === 'idle' || room.stage === 'showdown') startHand(room);
      else broadcastState(room);
      return;
    }
    if (!player || !room) return;
    if (m.type === 'act') {
      if (room.actorId !== player.id) return;
      if (!canAct(player)) return;
      if (m.action === 'fold') doFold(room, player);
      else if (m.action === 'check') doCheck(room, player);
      else if (m.action === 'call') doCall(room, player);
      else if (m.action === 'raise') doRaise(room, player, m.to);
      return;
    }
    if (m.type === 'rebuy') {
      if (player.credits > 0) {
        send(ws, { type: 'rebuy-fail', message: 'Você ainda tem fichas na mesa.' });
        return;
      }
      try {
        const buyin = await buyIn(player.token, room.code);
        player.credits = Math.round(Number(buyin) * 100);
        player.folded = true;
        player.allIn = false;
        player.inHand = false;
        send(ws, { type: 'rebuy-ok' });
        if (room.stage === 'idle' || room.stage === 'showdown') startHand(room);
        else broadcastState(room);
      } catch (e) {
        send(ws, { type: 'rebuy-fail', message: e.message || 'Saldo insuficiente.', needDeposit: true });
      }
    }
  });
  ws.on('close', async () => {
    if (!player || !room) return;
    const wasActor = room.actorId === player.id;
    room.players.delete(player.id);
    await cashOut(player);
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value || null;
    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    if (wasActor && room.stage !== 'idle' && room.stage !== 'showdown') afterAct(room);
    else broadcastState(room);
  });
});

app.get('/api/admin/tables', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    const me = await userFromToken(token);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Sem permissão' });
    res.json(getLiveTables());
  } catch (e) {
    res.status(500).json({ error: e.message || 'Erro nas mesas' });
  }
});

process.on('uncaughtException', (e) => console.error('erro', e.message || e));
process.on('unhandledRejection', (e) => console.error('erro', e && e.message || e));
server.listen(PORT, '0.0.0.0', () => console.log(`Poker da Galera em http://localhost:${PORT}`));
