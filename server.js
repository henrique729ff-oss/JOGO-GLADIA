const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const server = http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,players:players.size,rooms:rooms.size}));}
  res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end('Gladiadores FF WebSocket online');
});
const wss = new WebSocket.Server({server});
const players = new Map(); // id -> player
const rooms = new Map();   // roomId -> Set(ids)
const invites = new Map(); // targetId -> {from,expires}
const friends = new Map(); // id -> Set(friend ids), runtime storage

const cleanName=v=>String(v||'PLAYER').replace(/[^\p{L}\p{N} ._-]/gu,'').trim().slice(0,12)||'PLAYER';
const send=(ws,o)=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o))};
const playerList=()=>Array.from(players.values()).map(p=>({id:p.id,name:p.name,room:p.room||null}));
function presence(){const p=playerList();for(const x of players.values())send(x.ws,{type:'presence',players:p});}
function ok(ws,requestId,data){send(ws,{type:'reply',requestId,ok:true,data});}
function fail(ws,requestId,error){send(ws,{type:'reply',requestId,ok:false,error});}
function getPlayer(id){return players.get(String(id));}
function roomPlayers(room){const set=rooms.get(room);return set?Array.from(set).map(id=>players.get(id)).filter(Boolean):[];}
function broadcastRoom(room,o,except){for(const p of roomPlayers(room))if(p.id!==except)send(p.ws,o)}
function makeRoom(a,b){
  const room='x1_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
  rooms.set(room,new Set([a.id,b.id]));
  a.room=room;b.room=room;
  a.hp=b.hp=100;a.dead=b.dead=false;
  // Mesmos spawns usados pelo HTML original. Slot 0/1 define o lado.
  const spawns=[{x:-43.7,y:.15,z:-20.8,yaw:-182*Math.PI/180},{x:-42.8,y:.25,z:20.3,yaw:-361*Math.PI/180}];
  a.slot=0;b.slot=1;
  const sendStart=(p,opp,slot)=>send(p.ws,{type:'x1_start',room,slot,opponentId:opp.id,opponentName:opp.name,spawn:spawns[slot],players:[{id:opp.id,name:opp.name,x:spawns[1-slot].x,y:spawns[1-slot].y,z:spawns[1-slot].z,yaw:spawns[1-slot].yaw}]});
  sendStart(a,b,0);sendStart(b,a,1);
}
function leaveRoom(p,notify=true){
  if(!p||!p.room)return;
  const room=p.room,set=rooms.get(room);if(set)set.delete(p.id);
  p.room=null;p.hp=100;p.dead=false;
  if(set&&set.size){for(const id of set){const q=players.get(id);if(q){send(q.ws,{type:'opponent_left',id:p.id});send(q.ws,{type:'x1_end',id:p.id})}}}
  if(set&&set.size===0)rooms.delete(room);
}

wss.on('connection',ws=>{
  let me=null;
  ws.on('message',raw=>{
    let o;try{o=JSON.parse(raw.toString())}catch(e){return}
    const type=o.type;
    if(type==='hello'){
      const id=String(o.id||'').replace(/\D/g,'').slice(0,3);
      if(!/^\d{3}$/.test(id))return send(ws,{type:'hello_error',error:'invalid_id'});
      let assigned=id;
      if(players.has(assigned)){
        const free=[];for(let n=100;n<=999;n++){const q=String(n);if(!players.has(q))free.push(q)}
        if(!free.length)return send(ws,{type:'hello_error',error:'server_full'});
        assigned=free[Math.floor(Math.random()*free.length)];
      }
      me={id:assigned,name:cleanName(o.name),ws,room:null,hp:100,dead:false,slot:0};players.set(assigned,me);
      send(ws,{type:'hello_ok',id:assigned,room:null});presence();return;
    }
    if(!me)return;
    if(type==='profile'){me.name=cleanName(o.name);presence();return;}
    if(type==='lookup'){
      const id=String(o.id||'');const p=getPlayer(id);if(!p)return fail(ws,o.requestId,'notfound');return ok(ws,o.requestId,{id:p.id,name:p.name,online:true});
    }
    if(type==='invite'){
      const target=getPlayer(o.to);if(!target)return fail(ws,o.requestId,'offline');
      if(target.room)return fail(ws,o.requestId,'busy');
      invites.set(target.id,{from:me.id,expires:Date.now()+30000});
      send(target.ws,{type:'invite',from:me.id,name:me.name});
      return;
    }
    if(type==='invite_cancel'){const q=invites.get(String(o.to));if(q&&q.from===me.id)invites.delete(String(o.to));return;}
    if(type==='invite_response'){
      const fromId=String(o.from),q=invites.get(me.id);if(!q||q.from!==fromId){send(ws,{type:'invite_result',result:'declined'});return;}
      invites.delete(me.id);const from=getPlayer(fromId);if(!from){send(ws,{type:'invite_result',result:'offline'});return;}
      if(!o.ok){send(from.ws,{type:'invite_result',result:'declined'});return;}
      if(from.room||me.room){send(from.ws,{type:'invite_result',result:'busy'});return;}
      send(from.ws,{type:'invite_result',result:'accepted'});makeRoom(from,me);return;
    }
    if(type==='state'){
      if(!me.room)return;
      const x=Math.max(-1000,Math.min(1000,Number(o.x)||0)),y=Math.max(-100,Math.min(1000,Number(o.y)||0)),z=Math.max(-1000,Math.min(1000,Number(o.z)||0));
      const p={id:me.id,name:me.name,x,y,z,yaw:Number(o.yaw)||0,pitch:Number(o.pitch)||0,dead:!!me.dead};
      me.x=x;me.y=y;me.z=z;me.yaw=p.yaw;me.pitch=p.pitch;
      broadcastRoom(me.room,{type:'player_state',player:p},me.id);return;
    }
    if(type==='shot'){
      if(!me.room||me.dead)return;
      const target=getPlayer(o.target);if(!target||target.room!==me.room||target.dead)return;
      // MVP: servidor limita dano por disparo e não aceita dano negativo.
      const dmg=Math.max(1,Math.min(100,Number(o.damage)||40));target.hp=Math.max(0,target.hp-dmg);
      send(me.ws,{type:'player_damage',from:me.id,target:target.id,damage:dmg,hp:target.hp});
      send(target.ws,{type:'player_damage',from:me.id,target:target.id,damage:dmg,hp:target.hp});
      if(target.hp<=0){
        target.dead=true;
        const room=target.room;
        broadcastRoom(room,{type:'player_state',player:{id:target.id,name:target.name,x:target.x||0,y:target.y||0,z:target.z||0,yaw:target.yaw||0,dead:true}});
        setTimeout(()=>{
          if(target.room!==room)return;
          for(const p of roomPlayers(room)){p.hp=100;p.dead=false;send(p.ws,{type:'round_reset',hp:100});}
        },3200);
      }
      return;
    }
    if(type==='leave_room'){leaveRoom(me);return;}
  });
  ws.on('close',()=>{
    if(!me)return;leaveRoom(me);if(players.get(me.id)===me)players.delete(me.id);presence();
  });
});

setInterval(()=>{const now=Date.now();for(const [id,q] of invites)if(q.expires<now)invites.delete(id)},5000);
server.listen(PORT,()=>console.log(`Gladiadores FF server listening on ${PORT}`));
