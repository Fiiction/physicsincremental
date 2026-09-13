import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, sanitizeProfile } from '../src/game.js';
import { advanceElapsed } from '../src/idle.js';
import { Worker } from 'node:worker_threads';

const data=JSON.parse(fs.readFileSync(new URL('../src/data/balance.json',import.meta.url),'utf8'));
function chamber(chapter=0,upgrades={power:4,kinetic:8}) {
  const profile=createProfile();profile.chapter=chapter;profile.upgrades=upgrades;
  const game=new Game(data,profile,731);
  // An isolated collision chamber, not a campaign shortcut or player save.
  game.blocks=game.blocks.filter(b=>b.ring>=8);game.reindex();game.portals=[];
  game.position={x:100,y:data.physics.size/2};
  assert(game.spawnBoss(true));game.tick(data.boss.wakeDuration+.05);
  return game;
}

const weak=chamber(),strong=chamber(0,{power:48,kinetic:24});
assert.equal(weak.boss.maxHP,strong.boss.maxHP,'Boss health scaled with the player attack');
assert.equal(weak.boss.maxHP,data.chapters[0].boss.hp);
assert.equal(weak.percentDamage(weak.boss,.25),data.chapters[0].boss.percentDamageHP*.25);
assert.equal(weak.shots,weak.stats.shots,'Summoning granted extra shots');

weak.launch(0,1);
for(let i=0;i<300&&!(weak.run.bossDamage>0);i++)weak.tick(data.physics.step);
assert(weak.run.bossDamage>0&&weak.boss.hp>0,'The ball did not make a real nonfatal boss hit');
const saved=weak.snapshot(),resumed=new Game(data,sanitizeProfile(structuredClone(weak.profile),data));
assert(resumed.restore(saved));
for(let i=0;i<80;i++){weak.tick(.025);resumed.tick(.025);}
assert.deepEqual(resumed.snapshot(),weak.snapshot(),'Boss health, rotation or the moving ball changed after save/resume');

const remaining=weak.boss.hp;weak.endRun();assert(!weak.goalComplete&&remaining>0);
weak.newRun();assert(!weak.boss&& !weak.run.bossSpawned,'A failed boss leaked into the next fresh map');
assert(!weak.spawnBoss(),'A fresh map summoned its boss before its real clear threshold');
weak.spawnBoss(true);assert.equal(weak.boss.hp,weak.boss.maxHP,'The next encounter retained damage from the failed run');

const fast=chamber(0,{power:0,kinetic:24});fast.position={x:200,y:304};
const before=fast.boss.hp;fast.launch(0,1);fast.tick(1/30);
assert(fast.boss.hp<before,'A fast ball missed the large rotating block');
assert(fast.balls.every(ball=>!ball.main||ball.x<304),'A fast ball crossed through the boss');

// Legacy eligible runs keep their old reward, while new runs use boss progression.
const oldGame=new Game(data,createProfile(),818),old=oldGame.snapshot();
delete old.run.bossVersion;old.run.cleared=old.run.totalBlocks;old.run.shots=1;old.state='ended';
const oldProfile=structuredClone(oldGame.profile);oldProfile.stageCores=100;oldProfile.stageCombo=1000;
const migrated=new Game(data,oldProfile,1);assert(migrated.restore(old));
assert(migrated.goalComplete,'An already eligible legacy save lost its reward');
assert(migrated.advance('echo'));const wallet=migrated.profile.coins;
migrated.auto=true;advanceElapsed(migrated,60);
assert.equal(migrated.profile.coins,wallet);assert(migrated.pendingChapterSelection);
assert(migrated.selectChapter(migrated.profile.frontierChapter));assert(migrated.run.bossVersion>=1);

// Run real boss physics continuously in the browser worker; old timestamps must not replay.
const background=chamber(0,{power:7,kinetic:10,idle:1});background.auto=true;background.launch(0,1);
const workerURL=new URL('../src/idle-worker.js',import.meta.url).href;
const worker=new Worker(`const {parentPort}=require('node:worker_threads');global.self={};global.postMessage=m=>parentPort.postMessage(m);parentPort.on('message',data=>self.onmessage({data}));import(${JSON.stringify(workerURL)}).then(()=>parentPort.postMessage({ready:true}));`,{eval:true});
const started=Date.now()-8000;
let packet, finishTimer;
try {
  packet=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Boss background handoff timed out')),10000);
    worker.on('error',error=>{clearTimeout(timeout);reject(error);});
    worker.on('message',message=>{
      if(message.ready) {
        worker.postMessage({type:'start',epoch:1,balance:data,profile:structuredClone(background.profile),run:background.snapshot(),through:started});
        finishTimer=setTimeout(()=>worker.postMessage({type:'finish'}),550);
      }
      else if(message.finished){clearTimeout(timeout);resolve(message);}
    });
  });
} finally { clearTimeout(finishTimer); await worker.terminate(); }
assert(packet.runtime.simulatedSeconds>=.4&&packet.runtime.simulatedSeconds<2,'Worker replayed the old boss timestamp or did not run');
assert.equal(packet.runtime.interruptedSeconds,0,'Ordinary boss worker ticks were discarded');
advanceElapsed(background,packet.runtime.simulatedSeconds);
const backgroundBoss=packet.run.blocks.find(b=>b.type==='boss');
assert(background.run.bossDamage>0,'Background boss simulation never dealt real damage');
assert.equal(backgroundBoss.hp,background.boss.hp,'Background boss damage diverged');
assert.equal(backgroundBoss.rotation,background.boss.rotation,'Background boss rotation diverged');
assert.equal(packet.run.run.bossShots,background.run.bossShots,'Boss handoff duplicated a shot');
assert.equal(packet.profile.coins,background.profile.coins,'Boss handoff duplicated a reward');

const report={generatedAt:new Date().toISOString(),fixedHealth:'pass',realBossCollision:'pass',activeSaveResume:'pass',failureResetsBoss:'pass',noExtraShots:'pass',highSpeedLargeBlock:'pass',legacyRewardAndPendingChoice:'pass',activeBossBackgroundWorker:'pass',workerLiveSeconds:packet.runtime.simulatedSeconds,oldWorkerTimestampIgnored:'pass',note:'Real boss collisions, save continuity and continuous live worker handoff; no frozen-time replay or player-facing trial mode.'};
fs.writeFileSync(new URL('../reports/boss-check.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
