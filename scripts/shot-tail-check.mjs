import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, sanitizeProfile } from '../src/game.js';

const data=JSON.parse(fs.readFileSync(new URL('../src/data/balance.json',import.meta.url),'utf8'));
const rich={...createProfile(),coins:4e12,earned:7e12};
const savedRich=sanitizeProfile(JSON.parse(JSON.stringify(rich)),data);
assert.equal(savedRich.coins,rich.coins);assert.equal(savedRich.earned,rich.earned);
assert.equal(sanitizeProfile({...rich,coins:1e100,stageKills:4e12},data).coins,Number.MAX_SAFE_INTEGER);
assert.equal(sanitizeProfile({...rich,stageKills:4e12},data).stageKills,1e12);
for(const coins of [NaN,Infinity,-1,'4000000000000'])assert.equal(sanitizeProfile({...rich,coins},data).coins,0);
const fixtures={
  'return rift': game=>{game.balls[0].energy=0;},
  'empty return rift': game=>{Object.assign(game.blocks[0],{x:32,y:32});game.balls[0].energy=0;},
  'star collapse and its rift': game=>{
    game.balls=[];
    game.star.points=[{x:192,y:192},{x:416,y:192},{x:304,y:448}];
    game.star.triangle=structuredClone(game.star.points);
    game.star.pending=data.constellation.windup;game.star.damage=100;
  }
};
function makeGame(Engine=Game) {
  const profile=createProfile();profile.chapter=4;profile.relics=['echo'];
  profile.upgrades={riftEcho:6,riftCollapse:6,constellation:1,starRift:6,starSalvo:6,battery:1};
  const game=new Engine(data,profile,17);
  // An indestructible ordinary target isolates all remaining pulses from later
  // boss progression, extra boxes and changing projectile destinations.
  const target=game.blocks.find(b=>b.type==='normal');
  Object.assign(target,{id:7*data.physics.grid+9,gx:9,gy:7,x:288,y:224,ring:2,hp:1e9,maxHP:1e9});delete target.percentDamageHP;
  game.blocks=[target];game.reindex();game.buffs={rift:1};game.launch(0,1);
  game.events.length=0;
  return game;
}
function run(game) {
  const started=game.run.time,hitEvents=[];
  while(game.state==='flying'&&game.run.time-started<8) {
    game.tick(data.physics.step);
    hitEvents.push(...game.events.filter(e=>e.type==='hit'));game.events.length=0;
  }
  return {seconds:+(game.run.time-started).toFixed(4),pulses:game.run.riftPulses,collapses:game.run.techTriggers.riftCollapse||0,damage:hitEvents.reduce((sum,e)=>sum+e.damage,0),state:game.state};
}
const rows=[];
for(const [name,prepare] of Object.entries(fixtures)) {
  const game=makeGame();prepare(game);
  const result=run(game);rows.push({name,...result});
  assert.notEqual(result.state,'flying',`${name} kept the next shot blocked`);
  assert(result.seconds<=(data.physics.effectTailTime??.6)+data.physics.step*2,`${name} exceeded the short tail budget`);
  assert.equal(game.rifts.length+game.star.volley.length+game.star.pending,0,'A finished shot retained attacks');
  if(name!=='empty return rift') {assert(result.damage>0);assert(result.collapses>0,'The closing attack was dropped');}
}
const rift=rows.find(r=>r.name==='return rift');
assert.equal(rift.pulses,Math.floor(data.elite.riftDuration*(1+5*data.elite.riftEchoGrowth)/data.elite.riftInterval+1e-8),'Compressed return field lost a pulse');

// A reload midway through the tail must keep its remaining budget and damage.
const original=makeGame();fixtures['return rift'](original);original.tick(.2);original.events.length=0;
const resumed=new Game(data,structuredClone(original.profile));assert(resumed.restore(original.snapshot()));resumed.events.length=0;
assert.deepEqual(run(resumed),run(original));
assert.equal(resumed.state,'ready');assert(resumed.launch(1,1));assert.equal(resumed.effectTailElapsed,0);

// Returns are still actual moving attacks, and the boss victory keeps its ceremony.
const returning=makeGame();returning.balls[0].x+=160;returning.balls[0].energy=0;returning.tick(data.physics.step);
assert(returning.balls[0].returning&&returning.position.x>returning.launchOrigin.x);
assert.equal(returning.effectTailElapsed,0,'Tail acceleration changed the physical return');
const victory=makeGame();victory.bossVictoryLeft=1.4;victory.balls=[];victory.tick(.6);
assert(victory.bossVictoryLeft>.7&&victory.state==='flying','Attack tail shortened the boss ceremony');

// Line attacks must preserve grazes, points, segments that stop short, and the
// rotating guardian geometry after removing allocations from the hot path.
const geometry=makeGame(),block={x:288,y:288,type:'normal'};
for(const [from,to,hit] of [
  [{x:200,y:304},{x:400,y:304},true],
  [{x:304,y:200},{x:304,y:400},true],
  [{x:200,y:200},{x:400,y:400},true],
  [{x:304,y:304},{x:304,y:304},true],
  [{x:200,y:304},{x:280,y:304},false],
  [{x:200,y:325},{x:400,y:325},false],
  [{x:325,y:304},{x:325,y:304},false]
])assert.equal(geometry.lineHitsBlock(from,to,block,0),hit);
const boss={...block,type:'boss',rotation:Math.PI/4,size:100};
assert(geometry.lineHitsBlock({x:200,y:304},{x:400,y:304},boss,0));
assert(geometry.lineHitsBlock({x:369,y:300},{x:369,y:308},boss,0));
assert(!geometry.lineHitsBlock({x:375,y:300},{x:375,y:308},boss,0));
console.log(JSON.stringify({passed:true,rows,reload:true,physicalReturn:true,bossCeremony:true,walletRoundtrip:true},null,2));
