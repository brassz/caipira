const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, app: 'omaha5-multiplayer-v4' }));

const rooms = new Map();
const TURN_MS = 18000;
const HAND_NAMES = ['Carta alta', 'Par', 'Dois pares', 'Trinca', 'Sequência', 'Flush', 'Full house', 'Quadra', 'Straight flush'];

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
function makeRoom(code) {
  return {
    code,
    players: new Map(),
    hostId: null,
    stage: 'idle',
    deck: [],
    board: [],
    visibleBoard: [],
    bets: {},
    decisions: {},
    actorId: null,
    turnEndsAt: 0,
    turnTimer: null
  };
}
function listPlayers(room) {
  return [...room.players.values()];
}
function inHand(room) {
  return listPlayers(room).filter(p => room.decisions[p.id] !== 'fold');
}
function stateFor(room) {
  return {
    room: room.code,
    hostId: room.hostId,
    stage: room.stage,
    board: room.visibleBoard,
    bets: room.bets,
    decisions: room.decisions,
    actorId: room.actorId,
    turnEndsAt: room.turnEndsAt,
    turnMs: TURN_MS,
    players: listPlayers(room).map(p => ({
      id: p.id,
      name: p.name,
      credits: p.credits,
      connected: p.connected,
      hand: p.hand || [],
      winner: !!p.winner,
      result: p.result || '',
      bet: room.bets[p.id] || 0,
      decision: room.decisions[p.id] || ''
    }))
  };
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function broadcastState(room) {
  const reveal = room.stage === 'showdown';
  for (const p of room.players.values()) {
    const st = stateFor(room);
    st.players = st.players.map(x => {
      if (x.id === p.id || reveal) return x;
      return { ...x, hand: (x.hand || []).map(() => null) };
    });
    send(p.ws, { type: 'state', state: st });
  }
}
function canReset(stage) {
  return stage === 'idle' || stage === 'betting' || stage === 'showdown' || stage === 'folded';
}
function dealIfReady(room) {
  const players = listPlayers(room);
  if (players.length < 2) return false;
  if (players.some(p => !room.bets[p.id])) return false;
  room.deck = makeDeck();
  room.board = [];
  room.visibleBoard = [];
  for (const p of players) {
    p.hand = room.deck.splice(0, 5);
    p.winner = false;
    p.result = '';
  }
  room.board = room.deck.splice(0, 5);
  room.stage = 'preflop';
  broadcast(room, { type: 'log', message: 'Apostas confirmadas. Cartas distribuídas: as suas abertas, as dos adversários fechadas.' });
  broadcastState(room);
  return true;
}
function splitAmong(amount, players) {
  if (!players.length || amount <= 0) return;
  const share = Math.floor(amount / players.length);
  let rest = amount - share * players.length;
  players.forEach(p => { p.credits += share; });
  if (rest && players[0]) players[0].credits += rest;
}
function clearTurn(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.actorId = null;
  room.turnEndsAt = 0;
}
function nextActorId(room, afterId) {
  const players = listPlayers(room);
  const start = Math.max(0, players.findIndex(p => p.id === afterId));
  for (let i = 1; i <= players.length; i++) {
    const p = players[(start + i) % players.length];
    if (p && !room.decisions[p.id]) return p.id;
  }
  return null;
}
function startTurn(room, actorId) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.actorId = actorId;
  room.turnEndsAt = Date.now() + TURN_MS;
  const current = actorId;
  room.turnTimer = setTimeout(() => {
    if (room.stage !== 'flop' || room.actorId !== current) return;
    const p = room.players.get(current);
    if (!p) return;
    applyFold(room, p, true);
  }, TURN_MS);
  const actor = room.players.get(actorId);
  if (actor) broadcast(room, { type: 'log', message: 'Vez de ' + actor.name + ' (18s).' });
  broadcastState(room);
}
function passTurn(room, fromId) {
  const nid = nextActorId(room, fromId);
  if (!nid) {
    clearTurn(room);
    maybeFinishDecisions(room);
    return;
  }
  startTurn(room, nid);
}
function applyFold(room, player, timeout) {
  const bet = room.bets[player.id] || 0;
  const penalty = Math.round(bet * 0.1);
  const refund = bet - penalty;
  player.credits += refund;
  player.result = timeout ? 'Tempo esgotado' : 'Desistiu';
  room.decisions[player.id] = 'fold';
  const others = inHand(room);
  splitAmong(penalty, others);
  broadcast(room, {
    type: 'log',
    message: player.name + (timeout ? ' não agiu a tempo e desistiu' : ' desistiu') + ': 90% (' + refund + ') voltaram, 10% (' + penalty + ') foram para os adversários.'
  });
  passTurn(room, player.id);
}
function applyPlay(room, player) {
  room.decisions[player.id] = 'play';
  player.result = 'Disputa';
  broadcast(room, { type: 'log', message: player.name + ' vai disputar. Passando para o próximo.' });
  passTurn(room, player.id);
}
function maybeFinishDecisions(room) {
  const players = listPlayers(room);
  if (players.some(p => !room.decisions[p.id])) return;
  const live = players.filter(p => room.decisions[p.id] === 'play');
  if (live.length <= 1) {
    const winner = live[0];
    if (winner) {
      winner.credits += room.bets[winner.id] || 0;
      winner.winner = true;
      winner.result = 'Venceu (adversário desistiu)';
      broadcast(room, { type: 'log', message: winner.name + ' venceu: os demais desistiram. A aposta foi devolvida.' });
    }
    room.stage = 'folded';
    broadcastState(room);
    return;
  }
  room.stage = 'live';
  broadcast(room, { type: 'log', message: 'Todos disputaram. Abra o TURN e depois o RIVER.' });
  broadcastState(room);
}
function showdown(room) {
  const live = listPlayers(room).filter(p => room.decisions[p.id] === 'play');
  if (!live.length) return;
  let best = null;
  let winners = [];
  for (const p of live) {
    const s = bestOmaha(p.hand, room.board);
    p.result = handLabel(s);
    if (!best || cmp(s, best) > 0) {
      best = s;
      winners = [p];
    } else if (cmp(s, best) === 0) winners.push(p);
  }
  const pot = live.reduce((sum, p) => sum + (room.bets[p.id] || 0), 0);
  splitAmong(pot, winners);
  winners.forEach(p => { p.winner = true; });
  room.stage = 'showdown';
  room.visibleBoard = [...room.board];
  broadcast(room, {
    type: 'log',
    message: 'Showdown: ' + winners.map(p => p.name + ' (' + p.result + ')').join(', ') + ' venceu(ram). Combinação: 2 da mão + 3 comunitárias.'
  });
  broadcastState(room);
}

wss.on('connection', ws => {
  let player = null;
  let room = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'join') {
      const code = String(m.room || '1234').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || '1234';
      if (!rooms.has(code)) rooms.set(code, makeRoom(code));
      room = rooms.get(code);
      if (room.players.size >= 6) {
        send(ws, { type: 'error', message: 'Sala cheia (máximo 6 jogadores).' });
        return;
      }
      if (!canReset(room.stage) && room.stage !== 'betting') {
        send(ws, { type: 'error', message: 'Espere a rodada atual terminar para entrar.' });
        return;
      }
      const id = Math.random().toString(36).slice(2, 10);
      player = { id, name: String(m.name || 'Jogador').slice(0, 18), credits: 1000, hand: [], winner: false, result: '', connected: true, ws };
      room.players.set(id, player);
      if (!room.hostId) room.hostId = id;
      send(ws, { type: 'joined', id, room: code });
      broadcast(room, { type: 'log', message: player.name + ' entrou na sala.' });
      broadcastState(room);
      return;
    }
    if (!player || !room) return;

    if (m.type === 'start') {
      if (room.hostId !== player.id) return;
      if (!canReset(room.stage)) {
        send(ws, { type: 'error', message: 'Termine a rodada atual antes de começar outra.' });
        return;
      }
      if (room.players.size < 2) {
        send(ws, { type: 'error', message: 'É preciso pelo menos 2 jogadores.' });
        return;
      }
      room.deck = [];
      room.board = [];
      room.visibleBoard = [];
      room.bets = {};
      room.decisions = {};
      clearTurn(room);
      room.stage = 'betting';
      for (const p of room.players.values()) {
        p.hand = [];
        p.winner = false;
        p.result = '';
      }
      broadcast(room, { type: 'log', message: 'Mesa limpa. Cada jogador digita a aposta e toca em CONFIRMAR.' });
      broadcastState(room);
    }

    if (m.type === 'bet') {
      if (room.stage !== 'betting') {
        send(ws, { type: 'error', message: 'Toque em NOVA RODADA antes de apostar.' });
        return;
      }
      if (room.bets[player.id]) {
        send(ws, { type: 'error', message: 'Você já confirmou a aposta desta rodada.' });
        return;
      }
      const amount = Math.floor(Number(m.amount));
      if (!Number.isFinite(amount) || amount < 1) {
        send(ws, { type: 'error', message: 'Informe um valor de aposta válido.' });
        return;
      }
      if (amount > player.credits) {
        send(ws, { type: 'error', message: 'Saldo insuficiente.' });
        return;
      }
      player.credits -= amount;
      room.bets[player.id] = amount;
      broadcast(room, { type: 'log', message: player.name + ' apostou ' + amount + '.' });
      if (!dealIfReady(room)) broadcastState(room);
    }

    if (m.type === 'reveal' && room.hostId === player.id) {
      if (m.stage === 'flop' && room.stage === 'preflop') {
        room.visibleBoard = room.board.slice(0, 3);
        room.stage = 'flop';
        broadcast(room, { type: 'log', message: 'Flop aberto. Cada um decide na sua vez.' });
        const first = listPlayers(room)[0];
        if (first) startTurn(room, first.id);
        else broadcastState(room);
      } else if (m.stage === 'turn' && room.stage === 'live') {
        room.visibleBoard = room.board.slice(0, 4);
        room.stage = 'turn';
        broadcastState(room);
      } else if (m.stage === 'river' && room.stage === 'turn') {
        room.visibleBoard = room.board.slice(0, 5);
        showdown(room);
      }
    }

    if (m.type === 'decision') {
      if (room.stage !== 'flop') {
        send(ws, { type: 'error', message: 'Só é possível decidir depois do flop.' });
        return;
      }
      if (room.actorId !== player.id) {
        send(ws, { type: 'error', message: 'Espere a sua vez.' });
        return;
      }
      if (room.decisions[player.id]) {
        send(ws, { type: 'error', message: 'Você já decidiu nesta rodada.' });
        return;
      }
      if (m.choice === 'fold') applyFold(room, player, false);
      else if (m.choice === 'play') applyPlay(room, player);
    }
  });

  ws.on('close', () => {
    if (!player || !room) return;
    player.connected = false;
    const wasActor = room.actorId === player.id;
    room.players.delete(player.id);
    delete room.bets[player.id];
    delete room.decisions[player.id];
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value || null;
    if (room.players.size === 0) {
      clearTurn(room);
      rooms.delete(room.code);
    } else {
      broadcast(room, { type: 'log', message: player.name + ' saiu da sala.' });
      if (wasActor && room.stage === 'flop') passTurn(room, player.id);
      else broadcastState(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Omaha 5 Multiplayer V4 em http://localhost:${PORT}`));
