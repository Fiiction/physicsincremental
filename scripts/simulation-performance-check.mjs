import fs from 'node:fs';
import assert from 'node:assert/strict';
import inspector from 'node:inspector';
import { Game, createProfile } from '../src/game.js';

const data=JSON.parse(fs.readFileSync(new URL('../src/data/balance.json',import.meta.url),'utf8'));
const cpu=new inspector.Session(); cpu.connect();
const post=(method,params={})=>new Promise((resolve,reject)=>cpu.post(method,params,(error,result)=>error?reject(error):resolve(result)));
await post('Profiler.enable'); await post('Profiler.setSamplingInterval',{interval:200}); await post('Profiler.start');
const runs=[],frames=[];
for(let seed=17;seed<29;seed++) {
  const profile=createProfile();profile.chapter=4;profile.relics=data.relics.map(r=>r.id);profile.upgrades={...data.previews.endgame.upgrades};
  const game=new Game(data,profile,seed);game.buffs={...data.previews.endgame.buffs};
  let lastMotion=0,tailMax=0,guard=0;
  const start=performance.now();
  while(game.state!=='ended'&&guard++<30000) {
    if(game.state==='ready') {game.launch(game.autoAngle(),1);lastMotion=game.run.time;}
    const frame=performance.now();game.tick(1/60);frames.push(performance.now()-frame);
    if(game.balls.length||game.bossVictoryLeft>0||game.boss?.phase==='waking')lastMotion=game.run.time;
    else tailMax=Math.max(tailMax,game.run.time-lastMotion);
    game.events.length=0;
  }
  assert.equal(game.state,'ended','Endgame run exceeded its time budget');
  runs.push({seed,ms:+(performance.now()-start).toFixed(2),seconds:+game.run.time.toFixed(2),tailSeconds:+tailMax.toFixed(3),kills:game.run.kills,riftPulses:game.run.riftPulses,starBursts:game.run.starBursts});
}
const {profile}=await post('Profiler.stop');cpu.disconnect();
const nodes=new Map(profile.nodes.map(n=>[n.id,n])),costs=new Map();
for(let i=0;i<profile.samples.length;i++) {const f=nodes.get(profile.samples[i]).callFrame,key=`${f.functionName||'(anonymous)'} @ ${f.url.split('/').at(-1)}:${f.lineNumber+1}`;costs.set(key,(costs.get(key)||0)+profile.timeDeltas[i]);}
frames.sort((a,b)=>a-b);
console.log(JSON.stringify({runs,totalMs:+runs.reduce((sum,r)=>sum+r.ms,0).toFixed(2),frameP95Ms:+frames[Math.floor(frames.length*.95)].toFixed(3),frameP99Ms:+frames[Math.floor(frames.length*.99)].toFixed(3),cpuTop:[...costs].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([functionName,us])=>({functionName,ms:+(us/1000).toFixed(1)}))},null,2));
