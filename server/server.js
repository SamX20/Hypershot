// Hyper Shot dedicated server.
// Runs the exact same game logic as the browser host: the "@@SHARED" block of index.html (rules, maps, physics, bots,
// authoritative Server class) is loaded into its own sandbox per room, so there is one source of truth for gameplay.
// Protocol (JSON over WebSocket, path /ws):
//   ?op=create&map=neon&mode=tdm&diff=normal&ts=5   → {t:'room',code,map,mode,diff}
//   ?op=join&code=ABCDE                               → {t:'room',...} or {t:'err',m}
//   the client then sends {t:'ready'} and from there on it's the normal game protocol (join, input, snapshots...)
const http=require('http'), fs=require('fs'), path=require('path'), vm=require('vm');
const {WebSocketServer}=require('ws');

const PORT=+process.env.PORT||8080;
const HTML=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const a=HTML.indexOf('// @@SHARED-BEGIN'), b=HTML.indexOf('// @@SHARED-END');
if(a<0||b<0) throw new Error('shared block markers not found in index.html');
const SHARED=new vm.Script(HTML.slice(a,b)+'\n;globalThis.__Server=Server;',{filename:'shared.js'});

const MAPS=['neon','yard','towers','city'], MODES=['ctf','tdm','koth'], DIFFS=['easy','normal','hard','insane'];
const CODE_CHARS='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rooms=new Map(); // code → {server, map, mode, diff, clients:Set, emptyT}

function newCode(){ let c; do{ c=Array.from({length:5},()=>CODE_CHARS[Math.random()*CODE_CHARS.length|0]).join(''); }while(rooms.has(c)); return c; }
function createRoom(map,mode,diff,ts){
  const ctx={console,Math,Date,JSON,setTimeout,clearTimeout,performance:{now:()=>Number(process.hrtime.bigint()/1000n)/1000},
    location:{search:`?map=${map}&mode=${mode}&diff=${diff}`},URLSearchParams,localStorage:{getItem(){return null},setItem(){}}};
  vm.createContext(ctx); SHARED.runInContext(ctx);
  const server=new ctx.__Server({teamSize:ts,lobby:true});
  const code=newCode(); rooms.set(code,{server,map,mode,diff,clients:new Set(),emptyT:0,created:Date.now()});
  log('room',code,map,mode,diff,'ts',ts); return code;
}
const log=(...m)=>console.log(new Date().toISOString().slice(11,19),...m);

// ---- HTTP: health check / tiny status page (Railway pings the port)
const httpServer=http.createServer((req,res)=>{
  if(req.url==='/health'){ res.writeHead(200,{'content-type':'text/plain'}); return res.end('ok'); }
  res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});
  res.end(JSON.stringify({name:'hyper-shot-server',rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.clients.size,0)}));
});

// ---- WebSocket
const wss=new WebSocketServer({server:httpServer,path:'/ws',maxPayload:16*1024});
wss.on('connection',(ws,req)=>{
  const q=new URL(req.url,'http://x').searchParams;
  const send=m=>{ if(ws.readyState===1) ws.send(JSON.stringify(m)); };
  let code;
  if(q.get('op')==='create'){
    const map=MAPS.includes(q.get('map'))?q.get('map'):'neon', mode=MODES.includes(q.get('mode'))?q.get('mode'):'ctf',
      diff=DIFFS.includes(q.get('diff'))?q.get('diff'):'normal', ts=Math.max(1,Math.min(10,+q.get('ts')||5));
    if(rooms.size>=200){ send({t:'err',m:'السيرفر مليان — جرّب بعدين'}); return ws.close(); }
    code=createRoom(map,mode,diff,ts);
  } else code=String(q.get('code')||'').toUpperCase().slice(0,8);
  const room=rooms.get(code);
  if(!room){ send({t:'err',m:'الغرفة غير موجودة'}); return ws.close(); }
  if(room.clients.size>=20){ send({t:'err',m:'الغرفة ممتلئة'}); return ws.close(); }
  send({t:'room',code,map:room.map,mode:room.mode,diff:room.diff});
  let id=null, bucket=60, lastFill=Date.now();
  ws.on('message',buf=>{
    // simple flood guard: ~60 msgs/s sustained
    const now=Date.now(); bucket=Math.min(120,bucket+(now-lastFill)*0.06); lastFill=now; if(--bucket<0) return;
    let m; try{ m=JSON.parse(buf.toString()); }catch(e){ return; }
    if(!m||typeof m!=='object') return;
    if(id===null){ if(m.t==='ready'){ id=room.server.addClient(send); room.clients.add(id); room.emptyT=0; } return; }
    try{ room.server.onMessage(id,m); }catch(e){ log('msg error',code,e.message); }
  });
  ws.on('close',()=>{ if(id!==null){ room.clients.delete(id); try{ room.server.removeClient(id); }catch(e){} } });
});

// ---- one loop ticks every room at 30 Hz; empty rooms are closed after 2 minutes
let last=Date.now();
setInterval(()=>{ const now=Date.now(), dt=Math.min(0.1,(now-last)/1000); last=now;
  for(const [code,r] of rooms){
    if(!r.clients.size){ r.emptyT+=dt; if(r.emptyT>120){ rooms.delete(code); log('room closed',code); } continue; }
    try{ r.server.tick(dt); }catch(e){ log('tick error',code,e.message); }
  } },1000/30);

httpServer.listen(PORT,()=>log('hyper-shot server on :'+PORT));
