const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_,res)=>res.json({ok:true,app:'omaha5-multiplayer-v4'}));

const rooms = new Map();

function makeDeck(){
  const ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits=['S','H','D','C'];
  const d=[];
  for(const r of ranks) for(const s of suits) d.push({r,s});
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function comb(a,k){
  const out=[]; const go=(s,c)=>{ if(c.length===k)return out.push(c.slice()); for(let i=s;i<a.length;i++){c.push(a[i]);go(i+1,c);c.pop();} }; go(0,[]); return out;
}
const rv={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13,A:14};
function score5(cards){
  let vals=cards.map(c=>rv[c.r]).sort((a,b)=>b-a);
  const counts={}; vals.forEach(v=>counts[v]=(counts[v]||0)+1);
  const flush=cards.every(c=>c.s===cards[0].s);
  let uniq=[...new Set(vals)];
  if(uniq[0]===14) uniq.push(1);
  let highStraight=0;
  for(let i=0;i<=uniq.length-5;i++) if(uniq[i]-uniq[i+4]===4){highStraight=uniq[i];break;}
  const groups=Object.entries(counts).map(([v,n])=>({v:+v,n})).sort((a,b)=>b.n-a.n||b.v-a.v);
  if(flush&&highStraight)return [8,highStraight];
  if(groups[0].n===4)return [7,groups[0].v,groups[1].v];
  if(groups[0].n===3&&groups[1].n===2)return [6,groups[0].v,groups[1].v];
  if(flush)return [5,...vals];
  if(highStraight)return [4,highStraight];
  if(groups[0].n===3)return [3,groups[0].v,...groups.filter(g=>g.n===1).map(g=>g.v).sort((a,b)=>b-a)];
  if(groups[0].n===2&&groups[1].n===2){
    const ps=[groups[0].v,groups[1].v].sort((a,b)=>b-a);
    const k=groups.find(g=>g.n===1).v; return [2,...ps,k];
  }
  if(groups[0].n===2)return [1,groups[0].v,...groups.filter(g=>g.n===1).map(g=>g.v).sort((a,b)=>b-a)];
  return [0,...vals];
}
function cmp(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0);if(d)return d;}return 0; }
function bestOmaha(hand,board){
  let best=null;
  for(const h of comb(hand,2)) for(const b of comb(board,3)){
    const s=score5([...h,...b]); if(!best||cmp(s,best)>0)best=s;
  }
  return best;
}
function stateFor(room){
  return {
    room:room.code, hostId:room.hostId, stage:room.stage, board:room.visibleBoard,
    players:[...room.players.values()].map(p=>({
      id:p.id,name:p.name,credits:p.credits,connected:p.connected,
      hand:p.hand||[],winner:!!p.winner,result:p.result||''
    }))
  };
}
function broadcast(room,obj){
  const s=JSON.stringify(obj);
  for(const p of room.players.values()) if(p.ws.readyState===1) p.ws.send(s);
}
function broadcastState(room){
  for(const p of room.players.values()){
    const st=stateFor(room);
    if(room.stage!=='showdown'){
      st.players=st.players.map(x=>x.id===p.id?x:{...x,hand:(x.hand||[]).map(()=>null)});
    }
    if(p.ws.readyState===1) p.ws.send(JSON.stringify({type:'state',state:st}));
  }
}
function finish(room){
  if(room.players.size<2)return;
  let best=null,winners=[];
  for(const p of room.players.values()){
    const s=bestOmaha(p.hand,room.board);
    if(!best||cmp(s,best)>0){best=s;winners=[p];}
    else if(cmp(s,best)===0)winners.push(p);
  }
  for(const p of room.players.values()){p.winner=winners.includes(p);p.result=p.winner?'Vencedor':'';}
  const prize=100;
  winners.forEach(p=>p.credits+=Math.floor(prize/winners.length));
  room.stage='showdown'; room.visibleBoard=[...room.board];
  broadcast(room,{type:'log',message:'Showdown: '+winners.map(p=>p.name).join(', ')+' venceu(ram).'});
  broadcastState(room);
}
wss.on('connection',ws=>{
  let player=null, room=null;
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==='join'){
      const code=String(m.room||'1234').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,12)||'1234';
      if(!rooms.has(code)) rooms.set(code,{code,players:new Map(),hostId:null,stage:'idle',deck:[],board:[],visibleBoard:[]});
      room=rooms.get(code);
      if(room.players.size>=6){ws.send(JSON.stringify({type:'error',message:'Sala cheia (máximo 6 jogadores).'}));return}
      const id=Math.random().toString(36).slice(2,10);
      player={id,name:String(m.name||'Jogador').slice(0,18),credits:1000,hand:[],winner:false,result:'',connected:true,ws};
      room.players.set(id,player); if(!room.hostId) room.hostId=id;
      ws.send(JSON.stringify({type:'joined',id,room:code}));
      broadcast(room,{type:'log',message:player.name+' entrou na sala.'}); broadcastState(room);
    }
    if(!player||!room)return;
    if(m.type==='start'){
      if(room.hostId!==player.id)return;
      if(room.players.size<2){ws.send(JSON.stringify({type:'error',message:'Entre com pelo menos 2 jogadores para iniciar.'}));return}
      room.deck=makeDeck(); room.board=[]; room.visibleBoard=[]; room.stage='preflop';
      for(const p of room.players.values()){p.hand=room.deck.splice(0,5);p.winner=false;p.result='';}
      room.board=room.deck.splice(0,5);
      broadcast(room,{type:'log',message:'Nova rodada iniciada. Cada jogador recebeu 5 cartas.'}); broadcastState(room);
    }
    if(m.type==='reveal'&&room.hostId===player.id){
      if(m.stage==='flop'&&room.stage==='preflop'){room.visibleBoard=room.board.slice(0,3);room.stage='flop';}
      else if(m.stage==='turn'&&room.stage==='flop'){room.visibleBoard=room.board.slice(0,4);room.stage='turn';}
      else if(m.stage==='river'&&room.stage==='turn'){room.visibleBoard=room.board.slice(0,5);room.stage='river';finish(room);return}
      broadcastState(room);
    }
  });
  ws.on('close',()=>{
    if(!player||!room)return;
    player.connected=false; room.players.delete(player.id);
    if(room.hostId===player.id) room.hostId=room.players.keys().next().value||null;
    if(room.players.size===0) rooms.delete(room.code); else {broadcast(room,{type:'log',message:player.name+' saiu da sala.'});broadcastState(room);}
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Omaha 5 Multiplayer V4 em http://localhost:${PORT}`));
