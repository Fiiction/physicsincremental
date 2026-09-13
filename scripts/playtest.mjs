import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, upgradeStatus, upgradeCost, sanitizeProfile } from '../src/game.js';
import { advanceElapsed } from '../src/idle.js';
import { Worker } from 'node:worker_threads';

const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const PLAN = [['power',1],['kinetic',1],['idle',1]];
function buyPlanned(game, onBuy, onEligible) {
  for(const [id,target] of PLAN) while((game.level[id]||0)<target) { if(upgradeStatus(data,game.profile,id)!=='available') return;game.buy(id);onBuy?.(id); }
  while(true) {
    if(onEligible) for(const u of data.upgrades) if(['available','poor'].includes(upgradeStatus(data,game.profile,u.id))) onEligible(u);
    const next=data.upgrades.filter(u=>upgradeStatus(data,game.profile,u.id)==='available').sort((a,b)=>upgradeCost(data,game.profile,a.id)-upgradeCost(data,game.profile,b.id))[0];
    if(!next) return; game.buy(next.id);onBuy?.(next.id);
  }
}
const quantile = (numbers, q) => numbers.slice().sort((a,b) => a-b)[Math.min(numbers.length - 1, Math.floor(numbers.length * q))];
const samples = Math.max(1, Math.min(200, Number(process.argv[2]) || 30));
const campaignOnly = process.argv.includes('--campaign-only');
const results = [];
const phases = [];
const farmComparisons = [];
const endgameFollowup = [];
function compareFarming(profile,seed,label) {
  const regions=[];
  for(let chapter=0;chapter<=profile.chapter;chapter++) {
    const p=structuredClone(profile); p.chapter=chapter;
    const g=new Game(data,p,seed);
    let simulated=0,guard=0;
    while(g.state!=='ended'&&guard++<2000) {
      if(g.state==='ready') { simulated+=g.stats.idleDelay; g.launch(g.autoAngle(),1,true); }
      if(g.state==='flying') { g.tick(.25);simulated+=.25; }
      g.events.length=0;
    }
    assert.equal(g.state,'ended','A same-profile farming run failed to finish');
    regions.push({chapter:chapter+1,coins:g.run.coins,comboCoins:g.run.comboCoins,shots:g.run.shots,clearPercent:+(g.clearRatio*100).toFixed(1),seconds:+simulated.toFixed(2),coinsPerMinute:Math.round(g.run.coins/simulated*60)});
  }
  const current=regions.at(-1),best=regions.reduce((a,b)=>a.coinsPerMinute>b.coinsPerMinute?a:b);
  return {label,frontier:profile.chapter+1,power:profile.upgrades.power||0,comboMint:profile.upgrades.comboMint||0,bestChapter:best.chapter,currentVsBest:+(current.coinsPerMinute/best.coinsPerMinute).toFixed(3),regions};
}
for (let seedIndex = 0; seedIndex < samples; seedIndex++) {
  const seed = 17 + seedIndex * 7919, game = new Game(data, createProfile(), seed);
  const result = { seed, firstRunCoins: 0, firstBuyRun: 0, idleUnlockRun: 0, chapterCompletedAt: [], breakthroughs: [], purchases:[], shops:[], eligibleResearch:{}, runResults:[], bossEncounters:[], firstBossEncounterAt:[], farmingRuns:0, firstFinaleTriggers:{}, constellationUnlockedAt:0, eliteUnlockedAt:0, firstEliteOpenedAt:0, firstMintAt:0, eliteItems:[], firstEliteItems:{}, eliteOpened:0, comboCoins:0, arcs:0, riftPulses:0, finales:0, starBursts:0, techTriggers:{}, seconds: 0, shots: 0, emptyShots: 0, longestShot: 0, maxBalls: 0, kills: 0 };
  const buy = () => {
    const shop={index:result.shops.length,chapter:game.profile.chapter+1,run:game.profile.runs,coinsBefore:game.profile.coins};
    result.shops.push(shop);
    buyPlanned(game, id => {
    result.firstBuyRun ||= game.profile.runs; if (id === 'idle') result.idleUnlockRun ||= game.profile.runs; if(id==='constellation') result.constellationUnlockedAt ||= game.profile.runs; if(id==='eliteUnlock') result.eliteUnlockedAt ||= game.profile.runs;
    const u=data.upgrades.find(u=>u.id===id),level=game.level[id];
    result.purchases.push({id,level,chapter:game.profile.chapter+1,run:game.profile.runs,shop:shop.index,group:u.viewGroup,cost:Math.round(u.cost*u.growth**(level-1))});
    }, u => {
      if(result.eligibleResearch[u.id])return;
      let remaining=game.profile.coins,affordableRanks=0;
      for(let level=game.level[u.id]||0;level<u.max;level++) {
        const cost=Math.round(u.cost*u.growth**level); if(cost>remaining)break;
        remaining-=cost; affordableRanks++;
      }
      result.eligibleResearch[u.id]={chapter:game.profile.chapter+1,run:game.profile.runs,shop:shop.index,coins:game.profile.coins,affordableRanks};
    });
    shop.spent=shop.coinsBefore-game.profile.coins;
  };
  let beforeShot = 0, beforeShotBoss=0, beforeShotTime=0, beforeShotTech={}, bossShotHitSources={}, bossHitSources={}, wasFlying = false, farmingRuns=0, bossAtSpawn=null;
  for (let guard = 0; guard < 100000 && game.profile.prestige === 0 && game.profile.runs < 65; guard++) {
    if (game.state === 'ended') {
      result.runResults.push({chapter:game.profile.chapter+1,run:game.profile.runs,coins:game.run.coins,clearPercent:+(game.clearRatio*100).toFixed(1),power:game.level.power||0,damageToInnerHP:+(game.stats.damage/game.chapter.hp).toFixed(3),combo:game.run.combo,bossSpawned:!!game.run.bossSpawned,bossDefeated:!!game.run.bossDefeated,bossRemainingPercent:game.boss?+(Math.max(0,game.boss.hp)/game.boss.maxHP*100).toFixed(1):null});
      if(game.run.bossSpawned) result.bossEncounters.push({chapter:game.profile.chapter+1,run:game.profile.runs,...bossAtSpawn,defeated:!!game.run.bossDefeated,hp:game.boss.maxHP,remainingHP:Math.max(0,game.boss.hp),remainingPercent:+(Math.max(0,game.boss.hp)/game.boss.maxHP*100).toFixed(1),damage:game.run.bossDamage,hitSources:{...bossHitSources},power:game.level.power,kinetic:game.level.kinetic,seconds:+(game.run.time-game.run.bossStartedTime).toFixed(2),shots:phases.filter(p=>p.seed===seed&&p.run===game.profile.runs&&p.chapter===game.profile.chapter&&p.bossFightSeconds>0).map(p=>({shot:p.shot,damage:p.bossDamage,seconds:p.bossFightSeconds,remainingPercent:p.bossRemainingPercent,hitSources:p.bossHitSources,shotTechTriggers:p.bossPhaseTechTriggers}))});
      if(!game.isFrontier)result.farmingRuns++;
      result.starBursts += game.run.starBursts;
      result.eliteOpened += game.run.elites; result.comboCoins += game.run.comboCoins;
      result.arcs += game.run.arcs; result.riftPulses += game.run.riftPulses; result.finales += game.run.finales;
      for(const [id,count] of Object.entries(game.run.techTriggers)) result.techTriggers[id]=(result.techTriggers[id]||0)+count;
      if (game.profile.runs === 1) result.firstRunCoins = game.run.coins;
      if(game.goalComplete) result.breakthroughs.push({chapter:game.profile.chapter,clearPercent:+(game.clearRatio*100).toFixed(1),shots:game.run.shots,power:game.level.power||0,kinetic:game.level.kinetic||0,relicTriggers:{...game.run.relicTriggers},techTriggers:{...game.run.techTriggers}});
      if(seedIndex<3&&game.goalComplete&&game.profile.chapter>=2) farmComparisons.push(compareFarming(game.profile,seed,`campaign-built-${seed}`));
      buy();
      if (game.goalComplete) {
        assert(game.run.bossDefeated,'Breakthrough happened without defeating this run\'s boss');
        const choices=data.relics.filter(r=>!game.profile.relics.includes(r.id));
        result.chapterCompletedAt.push(game.profile.runs);
        assert(game.advance(choices.length ? choices[seedIndex%choices.length].id : 'fusion'));
        assert(game.selectChapter(game.profile.frontierChapter), 'Breakthrough required selecting an unlocked destination');
        if(game.profile.prestige===0)buy();
        if(seedIndex<3&&game.profile.chapter>=2&&game.profile.prestige===0) farmComparisons.push(compareFarming(game.profile,seed,`campaign-${seed}`));
      }
      else if(!game.isFrontier && ++farmingRuns>=2) { farmingRuns=0; assert(game.selectChapter(game.profile.frontierChapter)); }
      else if(game.isFrontier && game.run.kills===0 && game.profile.chapter>0) { farmingRuns=0; assert(game.selectChapter(game.profile.chapter-1)); }
      else game.newRun();
      bossAtSpawn=null;bossHitSources={};
      game.events.length = 0;
      continue;
    }
    if (game.state === 'ready') {
      if (game.goalComplete && game.run.shots) game.endRun();
      else { beforeShot = game.profile.totalKills; beforeShotBoss=game.run.bossDamage||0;beforeShotTime=game.run.time;beforeShotTech={...game.run.techTriggers};bossShotHitSources={};game.launch(game.autoAngle(), 1, false); result.shots++; wasFlying = true; }
    }
    if (game.state === 'flying') {
      game.tick(0.5); result.seconds += 0.5;
      for(const event of game.events) if(event.type==='bosshit') for(const counts of [bossShotHitSources,bossHitSources]) {
        const entry=counts[event.source||'unknown'] ||= {hits:0,damage:0};entry.hits++;entry.damage+=event.damage;
      }
      if(game.run.bossSpawned&&!bossAtSpawn) {
        const run=game.profile.runs+(game.state==='ended'?0:1);
        result.firstBossEncounterAt[game.profile.chapter] ||= run;
        bossAtSpawn={spawnShot:game.run.bossStartedShot,spawnTime:game.run.bossStartedTime,remainingShotsAtSpawn:game.shots,clearAtSpawn:+(game.clearRatio*100).toFixed(1)};
      }
      for(const u of data.upgrades.filter(u=>u.viewGroup==='finale')) if(game.run.techTriggers[u.id]&&!result.firstFinaleTriggers[u.id]) result.firstFinaleTriggers[u.id]={run:game.profile.runs+(game.state==='ended'?0:1),chapter:game.profile.chapter+1,shot:game.run.shots};
      if(game.run.elites) result.firstEliteOpenedAt ||= game.profile.runs+(game.state==='ended'?0:1);
      if(game.run.comboCoins) result.firstMintAt ||= game.profile.runs+(game.state==='ended'?0:1);
      for(const item of data.drops.filter(d=>d.elite)) if(game.buffs[item.id]&&!result.eliteItems.includes(item.id)) {
        result.eliteItems.push(item.id);
        result.firstEliteItems[item.id]={run:game.profile.runs+(game.state==='ended'?0:1),chapter:game.profile.chapter,shot:game.run.shots};
      }
      result.maxBalls = Math.max(result.maxBalls, game.balls.length);
      assert((game.run.charges || 0) <= data.mechanics.extraShotsCap && game.shots+game.run.shots <= data.economy.maxShotsPerRun,'Battery allowance was exceeded');
      assert(game.balls.every(b => Number.isFinite(b.x) && Number.isFinite(b.y) && b.x >= 0 && b.x <= data.physics.size && b.y >= 0 && b.y <= data.physics.size), 'Ball escaped or became invalid: ' + JSON.stringify({ seed, chapter: game.profile.chapter, balls: game.balls.filter(b => b.x < 0 || b.x > data.physics.size || b.y < 0 || b.y > data.physics.size) }));
      if (game.state !== 'flying' && wasFlying) { const bossDamage=(game.run.bossDamage||0)-beforeShotBoss;result.emptyShots += Number(game.profile.totalKills === beforeShot&&bossDamage===0); result.longestShot = Math.max(result.longestShot, game.shotTime); wasFlying = false; phases.push({seed,chapter:game.profile.chapter,run:game.profile.runs+(game.state==='ended'?0:1),shot:game.run.shots,kills:game.profile.totalKills-beforeShot,buffs:{...game.buffs},techTriggers:{...game.run.techTriggers},seconds:+game.shotTime.toFixed(2),bossDamage,bossHitSources:{...bossShotHitSources},bossFightSeconds:game.run.bossSpawned?+Math.max(0,game.run.time-Math.max(beforeShotTime,game.run.bossStartedTime)).toFixed(2):0,bossRemainingPercent:game.boss?+(Math.max(0,game.boss.hp)/game.boss.maxHP*100).toFixed(1):null,bossPhaseTechTriggers:game.run.bossSpawned?Object.fromEntries(Object.entries(game.run.techTriggers).map(([id,n])=>[id,n-(beforeShotTech[id]||0)]).filter(([,n])=>n>0)):{}}); }
    }
    game.events.length = 0;
  }
  result.runs = game.profile.runs; result.kills = game.profile.totalKills; result.completed = game.profile.prestige >= 1;
  assert(result.completed, `Campaign stalled for seed ${seed}: ${JSON.stringify({runs:game.profile.runs,chapter:game.profile.chapter+1,kills:game.run.kills,coins:game.profile.coins,upgrades:game.level,lastPurchases:result.purchases.slice(-8),bossEncounters:result.bossEncounters.slice(-5)})}`);
  assert.equal(result.chapterCompletedAt.length,data.chapters.length,'Campaign skipped a region');
  assert(result.maxBalls <= data.physics.maxBalls, 'Too many balls');
  assert((game.run.charges || 0) <= data.mechanics.extraShotsCap, 'Battery drops extended the run beyond its allowance');
  results.push(result);
  if(seedIndex<3&&!campaignOnly) {
    // Keep playing the deepest unlocked region with the earned build, without granting money.
    const follow=new Game(data,structuredClone(game.profile),seed);
    assert(follow.selectChapter(data.chapters.length-1));
    for(let run=1;run<=5;run++) {
      while(follow.state!=='ended') {
        if(follow.state==='ready')follow.launch(follow.autoAngle(),1);
        follow.tick(.25);follow.events.length=0;
      }
      let basicSpent=0,mechanismSpent=0;
      buyPlanned(follow,id=>{
        const u=data.upgrades.find(u=>u.id===id),cost=Math.round(u.cost*u.growth**((follow.level[id]||0)-1));
        if(u.viewGroup==='core')basicSpent+=cost; else mechanismSpent+=cost;
      });
      endgameFollowup.push({seed,run,coins:follow.run.coins,basicSpent,mechanismSpent,remaining:follow.profile.coins,power:follow.level.power,advancedRanks:Object.fromEntries(data.upgrades.filter(u=>(u.chapter||0)>=2&&u.max>1&&u.viewGroup!=='core').map(u=>[u.id,follow.level[u.id]||0]))});
      if(run<5)follow.newRun();
    }
  }
}
const bossProgress=data.chapters.map((chapter,index)=>{
  const observations=results.map(r=>({first:r.firstBossEncounterAt[index],kill:r.chapterCompletedAt[index],encounters:r.bossEncounters.filter(e=>e.chapter===index+1)}));
  const challengeRuns=observations.map(o=>o.kill-o.first+1),wins=observations.map(o=>o.encounters.find(e=>e.defeated)),hitSources={};
  for(const observation of observations)for(const encounter of observation.encounters)for(const [source,counts] of Object.entries(encounter.hitSources)){
    const total=hitSources[source] ||= {hits:0,damage:0};total.hits+=counts.hits;total.damage+=counts.damage;
  }
  return {chapter:chapter.name,boss:chapter.boss?.name,hp:chapter.boss?.hp,threshold:chapter.boss?.threshold,
    firstEncounterRunMedian:quantile(observations.map(o=>o.first),.5),firstKillRunMedian:quantile(observations.map(o=>o.kill),.5),
    challengeRunsMedian:quantile(challengeRuns,.5),challengeRunsRange:[Math.min(...challengeRuns),Math.max(...challengeRuns)],twoToFourRunChallenges:challengeRuns.filter(n=>n>=2&&n<=4).length,
    encounterAttemptsMedian:quantile(observations.map(o=>o.encounters.length),.5),remainingShotsAtFirstEncounterMedian:quantile(observations.map(o=>o.encounters[0]?.remainingShotsAtSpawn??0),.5),
    firstEncounterRemainingHPPercentMedian:quantile(observations.map(o=>o.encounters[0]?.remainingPercent??100),.5),firstEncounterBossSecondsMedian:quantile(observations.map(o=>o.encounters[0]?.seconds??0),.5),
    victoriousBossSecondsMedian:quantile(wins.map(e=>e.seconds),.5),victoriousBossShotsMedian:quantile(wins.map(e=>e.shots.length),.5),
    breakthroughClearPercentMedian:quantile(results.map(r=>r.breakthroughs.find(b=>b.chapter===index).clearPercent),.5),
    allFailedRemainingHPPercent:observations.flatMap(o=>o.encounters.filter(e=>!e.defeated).map(e=>e.remainingPercent)),hitSources};
});
if(campaignOnly) {
  const report={generatedAt:new Date().toISOString(),samples,bossProgress,results,phases};
  if(!process.argv.includes('--no-report'))fs.writeFileSync(new URL('../reports/boss-calibration.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify({completed:results.filter(r=>r.completed).length,bossProgress,chapterCompletedAt:results.map(r=>r.chapterCompletedAt)},null,2));process.exit(0);
}
if(samples>=3) for(const u of data.upgrades.filter(u=>u.viewGroup==='finale')) assert(results.some(r=>r.firstFinaleTriggers[u.id]),`${u.id} was researched but never experienced in natural campaign play`);

// One player-facing continuity check: saving in flight must resume the exact same shot.
const original = new Game(data, createProfile(), 12345);
original.launch(0.77, 1); original.tick(0.337);
const pausedState = JSON.stringify(original.snapshot()); original.paused = true; original.tick(2); original.paused = false;
assert.deepEqual(original.snapshot(), JSON.parse(pausedState), 'Pause changed the world or its countdown');
const restore = new Game(data, sanitizeProfile(JSON.parse(JSON.stringify(original.profile)), data));
assert(restore.restore(original.snapshot()));
while (original.state === 'flying') { original.tick(0.25); restore.tick(0.25); original.events.length = restore.events.length = 0; }
assert.deepEqual(restore.blocks, original.blocks, 'A saved shot resumed differently');
assert.deepEqual(restore.run, original.run, 'Saved rewards changed');
assert.deepEqual(restore.profile, sanitizeProfile(original.profile, data), 'Saved progression changed');

// Idle must drive its own next launch and next run, with no external launch calls.
const idleProfile = createProfile(); idleProfile.upgrades = { power: 1, kinetic: 1, idle: 1 };
const idle = new Game(data, idleProfile, 777); idle.auto = true;
for (let i = 0; i < 1200 && idle.profile.runs < 2; i++) { idle.tick(0.5); idle.events.length = 0; }
assert(idle.profile.runs >= 2 || idle.goalComplete, 'Autopilot stopped before a meaningful player choice');
assert(idle.profile.earned > 0, 'Autopilot earned nothing');

// Late-game stress uses the same finite run limits and collision rules as ordinary play.
const stress = [];
for (let seed = 1; seed <= 10; seed++) {
  const p = createProfile(); p.chapter = data.chapters.length-1; p.prestige=1; p.relics=data.relics.map(r=>r.id); p.upgrades = Object.fromEntries(data.upgrades.map(u => [u.id, u.max]));
  const g = new Game(data, p, seed); g.buffs = Object.fromEntries(data.drops.filter(d=>d.stackable).map(d=>[d.id,d.cap||data.mechanics.buffCap]));
  let guard = 0, maxBalls = 0;
  while (g.state !== 'ended' && guard++ < 5000) {
    if (g.state === 'ready') g.launch(g.autoAngle(), 1);
    g.tick(0.1); maxBalls = Math.max(maxBalls, g.balls.length); g.events.length = 0;
  }
  assert.equal(g.state, 'ended', 'Late-game run did not finish');
  assert(g.run.shots <= data.economy.maxShotsPerRun);
  assert(maxBalls <= data.physics.maxBalls);
  assert(g.run.bossDefeated,'Fully upgraded play could no longer defeat the final boss');
  stress.push({ seed, kills: g.run.kills, clearPercent:+(g.clearRatio*100).toFixed(1), combo: g.run.combo, shots: g.run.shots, maxBalls, relicTriggers:g.run.relicTriggers,techTriggers:g.run.techTriggers });
}
const opening = [];
let maxStopSpeed = 0, maxStopTravel = 0;
for(let i=0;i<60;i++) {
  const g = new Game(data,createProfile(),17); g.launch(i/60*Math.PI*2,1);
  while(g.state==='flying') {
    const before={...g.position}, speed=g.speedForEnergy(g.balls[0].energy);
    g.tick(data.physics.step); g.events.length=0;
    if(g.state!=='flying') {
      maxStopSpeed=Math.max(maxStopSpeed,speed); maxStopTravel=Math.max(maxStopTravel,Math.hypot(g.position.x-before.x,g.position.y-before.y));
    }
  }
  opening.push(g.hits);
}
assert(Math.min(...opening)>=2 && Math.max(...opening)<=3,'Fresh ball should rebound only two or three times');
assert.equal(data.economy.damage / data.chapters[0].hp,0.6);
assert(maxStopSpeed<4 && maxStopTravel<.05,'The ball stopped at visible speed or snapped to its resting position');

// Fast balls must see a solid wall even when one update spans several bricks.
const fastData=structuredClone(data); fastData.physics.step=1/30;
for(let i=0;i<9;i++) {
  const p=createProfile(); p.chapter=2; p.upgrades={kinetic:data.upgrades.find(u=>u.id==='kinetic').max};
  const g=new Game(fastData,p,100+i), column=12, cell=data.physics.size/data.physics.grid;
  g.blocks=Array.from({length:data.physics.grid},(_,gy)=>({id:gy*data.physics.grid+column,gx:column,gy,x:column*cell,y:gy*cell,hp:1e12,maxHP:1e12,type:'normal',alive:true,native:true,ring:3,loot:1}));
  g.grid=new Map(g.blocks.map(b=>[b.id,b])); g.portals=[];
  g.position={x:335,y:140+i*30}; g.launch((i-4)*.17,1);
  for(let tick=0;tick<6;tick++) {
    g.tick(fastData.physics.step);
    assert(g.balls.every(b=>b.x>=data.physics.radius && b.x<=column*cell+cell*(1-data.physics.blockSize)/2-data.physics.radius+.1 && b.y>=data.physics.radius && b.y<=data.physics.size-data.physics.radius),'A fast ball crossed a solid wall or escaped the arena');
  }
  assert(g.hits>0 && g.blocks.some(b=>b.hp<b.maxHP),'A fast ball missed the wall it crossed');
}

// Local collision steps must not multiply time, rolling loss, or mechanism timers.
const fastProfile=createProfile(); fastProfile.chapter=2; fastProfile.upgrades={kinetic:data.upgrades.find(u=>u.id==='kinetic').max};
const fastClock=new Game(data,fastProfile,122);
fastClock.blocks=fastClock.blocks.filter(b=>b.gx===18 && b.gy===18); fastClock.grid=new Map(fastClock.blocks.map(b=>[b.id,b])); fastClock.portals=[];
fastClock.position={x:100,y:100}; fastClock.launch(.31,1);
const fastBall=fastClock.balls[0], expectedEnergy={...fastBall}, direction={dx:fastBall.dx,dy:fastBall.dy};
fastBall.portalCooldown=.5; fastClock.consumeRollingEnergy(expectedEnergy,data.physics.step);
let rollingCalls=0,starCalls=0;
const rollFast=fastClock.consumeRollingEnergy.bind(fastClock),starFast=fastClock.updateStar.bind(fastClock);
fastClock.consumeRollingEnergy=(ball,dt)=>{rollingCalls++;rollFast(ball,dt);}; fastClock.updateStar=dt=>{starCalls++;starFast(dt);};
fastClock.tick(data.physics.step);
assert.equal(rollingCalls,1); assert.equal(starCalls,1);
assert.equal(fastBall.energy,expectedEnergy.energy);
assert.equal(fastClock.shotTime,data.physics.step); assert.equal(fastClock.run.time,data.physics.step);
assert.equal(fastBall.portalCooldown,.5-data.physics.step);
assert.deepEqual({dx:fastBall.dx,dy:fastBall.dy},direction,'Later chapters bent a freely moving ball');
assert(Math.hypot(fastBall.x-100,fastBall.y-100)>data.physics.radius*2,'High energy did not produce a visibly faster ball');
const fastResume=new Game(data,structuredClone(fastClock.profile)); assert(fastResume.restore(fastClock.snapshot()));
fastClock.tick(.05); fastResume.tick(.05);
assert.deepEqual(fastResume.snapshot(),fastClock.snapshot(),'High-speed collision movement changed after loading');

// Save during a naturally formed array's windup, then finish the same shot and its salvo.
const starProfile=createProfile(); starProfile.chapter=2; starProfile.relics=data.relics.map(r=>r.id);
starProfile.upgrades=Object.fromEntries(data.upgrades.map(u=>[u.id,u.max])); starProfile.upgrades.power=data.previews.constellationPower;
const starRun=new Game(data,starProfile,87),beamTimes=[];
const emitStar=starRun.emit.bind(starRun); starRun.emit=(type,payload)=>{if(type==='beam')beamTimes.push(starRun.shotTime);emitStar(type,payload);};
starRun.buffs={split:2,shock:2,boost:2}; starRun.launch(.53,1);
for(let i=0;i<3000 && starRun.state==='flying' && !starRun.star.pending;i++) starRun.tick(data.physics.step);
assert(starRun.star.pending>0,'The constellation never began its windup');
starRun.tick(.175);
const resumedStar=new Game(data,structuredClone(starRun.profile)); assert(resumedStar.restore(starRun.snapshot()));
for(let i=0;i<1500 && starRun.state==='flying' && !starRun.star.volley.length;i++) { starRun.tick(.025); resumedStar.tick(.025); }
assert(starRun.star.volley.length>0,'The array did not launch tracking lances');
assert.equal(new Set(starRun.star.volley.map(b=>b.targetId)).size,starRun.star.volley.length,'One volley targeted the same block repeatedly');
assert(!starRun.balls.some(b=>b.starBorn),'Tracking lances occupied physical ball slots');
const resumedVolley=new Game(data,structuredClone(starRun.profile)); assert(resumedVolley.restore(starRun.snapshot()));
for(let i=0;i<1500 && starRun.state==='flying';i++) {
  starRun.tick(.025); resumedStar.tick(.025); resumedVolley.tick(.025);
  assert(starRun.star.casts<=starRun.starCastLimit,'Constellation exceeded its per-shot limit');
}
assert(starRun.state!=='flying' && !starRun.star.volley.length,'The array or its volley failed to finish');
assert(starRun.shotTime<=data.physics.maxShotTime+data.relicMechanics.returnMaxTime+data.physics.step,'Tracking lances extended the shot deadline');
assert.deepEqual(resumedStar.snapshot(),starRun.snapshot(),'Array windup, reward or salvo changed after loading');
assert.deepEqual(resumedVolley.snapshot(),starRun.snapshot(),'An in-flight tracking volley changed after loading');
assert(beamTimes.length>1 && beamTimes.slice(1).every((t,i)=>t-beamTimes[i]>=data.mechanics.beamCooldown-1e-8),'Combo lasers recursively fired within their cooldown');
assert(starRun.run.techTriggers.starSalvo>0 && starRun.run.techTriggers.constellation>0,'Successful array mechanics were not counted');

// Boundary clipping must not turn a zero-area line into a damaging triangle.
const geometryProfile=createProfile(); geometryProfile.relics=['echo']; geometryProfile.upgrades={constellation:1,starReturn:1,returnFormation:3,starSplit:3,chain:1};
const geometry=new Game(data,geometryProfile,19); geometry.launch(0,1);
geometry.star.points=[];
for(const point of [{x:6,y:6},{x:6,y:80},{x:602,y:602}]) geometry.addStarPoint(point);
assert.equal(geometry.star.triangle,null,'Clipped support points formed a degenerate array');
assert(!geometry.inStar({x:304,y:304},[{x:8,y:8},{x:8,y:8},{x:600,y:600}]),'A line claimed to enclose a block');
geometry.star.triangle=[{x:200,y:200},{x:400,y:200},{x:304,y:400}]; geometry.events=[];
const returning=geometry.makeBall(400,304,Math.PI,1,false); geometry.beginReturn(returning);
while(returning.returning) geometry.updateReturn(returning,data.physics.step);
assert.equal(geometry.star.charge,data.constellation.returnCharge,'Returning split failed to conduct once');
assert.equal(geometry.events.filter(e=>e.type==='starfeed'&&e.kind==='starReturn').length,1,'One returning split conducted repeatedly');
geometry.star.casts=geometry.starCastLimit; geometry.star.charge=data.constellation.maxCharge; geometry.updateStar(.01);
assert.equal(geometry.star.pending,0,'A fully charged array bypassed the per-shot activation limit');

// A tracking lance hits only its selected target and cannot feed another array or laser.
const lanceTarget=geometry.blocks.find(b=>b.alive&&b.type==='normal'); lanceTarget.loot=1;
geometry.star.charge=0; geometry.star.triangle=null; geometry.events=[];
geometry.star.volley=[{x:304,y:304,tx:lanceTarget.x+16,ty:lanceTarget.y+16,targetId:lanceTarget.id,left:data.constellation.salvoDuration,duration:data.constellation.salvoDuration,damage:lanceTarget.hp+1,baseDamage:lanceTarget.hp+1,hpDamage:0,tech:'starSalvo'}];
const beforeLanceKills=geometry.run.kills;
geometry.updateStar(data.constellation.salvoDuration);
assert.equal(geometry.run.kills-beforeLanceKills,1,'A tracking lance swept unrelated blocks');
assert.equal(geometry.star.charge,0,'A constellation-fed lance charged another constellation');
assert(!geometry.events.some(e=>e.type==='beam'||e.type==='starfeed'),'A tracking lance recursively triggered another mechanism');
assert(geometry.events.some(e=>e.type==='starsalvohit'&&e.killed),'Lance arrival did not report its actual hit');
const [lost,reserved]=geometry.blocks.filter(b=>b.alive&&b.type==='normal');
const trackingBolt=b=>({x:304,y:304,tx:b.x+16,ty:b.y+16,targetId:b.id,left:data.constellation.salvoDuration,duration:data.constellation.salvoDuration,damage:1,baseDamage:1,hpDamage:0,tech:'starSalvo'});
geometry.star.volley=[trackingBolt(lost),trackingBolt(reserved)];
lost.alive=false; geometry.grid.delete(lost.id); geometry.events=[];
geometry.updateStar(.1);
assert(geometry.star.volley[0].targetId!==lost.id && geometry.star.volley[0].targetId!==reserved.id,'A lance failed to reacquire a distinct live target');
for(const block of geometry.blocks)block.alive=false; geometry.grid.clear();
geometry.updateStar(data.constellation.salvoDuration);
assert(!geometry.events.some(e=>e.type==='starsalvohit'),'An empty mine reported a fictional lance hit');
const legacyState=starRun.snapshot(); delete legacyState.beamAt; delete legacyState.star.volley; delete legacyState.run.techTriggers;
const legacy=new Game(data,structuredClone(starRun.profile)); assert(legacy.restore(legacyState));
assert.deepEqual(legacy.star.volley,[]); assert.deepEqual(legacy.run.techTriggers,{}); assert.equal(legacy.beamAt,0);

// Old cumulative objectives cannot skip the real boss, even in a powerful fresh run.
const gateProfile=createProfile(); gateProfile.stageKills=100000; gateProfile.stageCores=100; gateProfile.stageCombo=1000;
gateProfile.upgrades={power:24,kinetic:12,battery:4};
const gate=new Game(data,gateProfile,17);
assert(!gate.goalComplete,'Old cumulative progress bypassed the current mine');
for(let i=0;i<2500&&gate.state!=='ended';i++) {if(gate.state==='ready')gate.launch(gate.autoAngle(),1);gate.tick(.1);gate.events.length=0;}
assert(gate.run.bossSpawned&&gate.run.bossDefeated&&gate.goalComplete,'Clearing the mine and defeating its boss failed to award breakthrough');

// Resume during the new return phase, including tether, springs, fusion and magnet harvesting.
const relicProfile=createProfile(); relicProfile.chapter=1; relicProfile.prestige=1; relicProfile.relics=data.relics.map(r=>r.id); relicProfile.upgrades={power:5,kinetic:2,magnet:2,splitCombo:1};
const relicRun=new Game(data,relicProfile,991); relicRun.launch(0.12,1);
for(let i=0;i<3000 && !relicRun.balls.some(b=>b.returning);i++) { relicRun.tick(data.physics.step); relicRun.events.length=0; }
assert(relicRun.balls.some(b=>b.returning),'Return core never activated');
const resumedRelics=new Game(data,structuredClone(relicRun.profile)); assert(resumedRelics.restore(relicRun.snapshot()));
while(relicRun.state==='flying') { relicRun.tick(.1); resumedRelics.tick(.1); relicRun.events.length=resumedRelics.events.length=0; }
assert.deepEqual(resumedRelics.snapshot(),relicRun.snapshot(),'Returning shot or its springs changed after loading');
assert.equal(relicRun.run.relicTriggers.echo,1,'One launch entered return more than once');
assert.equal(relicRun.run.relicTriggers.fusion,1,'Return did not activate the fused spring network exactly once');
assert(relicRun.run.relicTriggers.heart>0,'Real rebounds did not cut a tether');
assert(Math.hypot(relicRun.position.x-relicRun.launchOrigin.x,relicRun.position.y-relicRun.launchOrigin.y)<.01,'Return did not finish at its launch point');
assert(!relicRun.blocks.some(b=>b.alive && Math.abs(b.x+16-relicRun.position.x)<15 && Math.abs(b.y+16-relicRun.position.y)<15),'Return finished inside a surviving block');

// Exercise continuous live worker physics and a final handoff; old timestamps are ignored.
const backgroundProfile=createProfile(); backgroundProfile.upgrades={power:2,kinetic:2,idle:1};
const baseline=new Game(data,backgroundProfile,886); baseline.auto=true; baseline.launch(baseline.autoAngle(),1,true);
const state=baseline.snapshot(), workerURL=new URL('../src/idle-worker.js',import.meta.url).href;
const worker=new Worker(`const {parentPort}=require('node:worker_threads'); global.self={}; global.postMessage=m=>parentPort.postMessage(m); parentPort.on('message',data=>self.onmessage({data})); import(${JSON.stringify(workerURL)}).then(()=>parentPort.postMessage({ready:true}));`,{eval:true});
const started=Date.now()-70000;
let finalPacket, finishTimer;
try { finalPacket=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Background handoff timed out')),10000);
  worker.on('error',reject);
  worker.on('message',packet=>{
    if(packet.ready) {
      worker.postMessage({type:'start',epoch:1,balance:data,profile:structuredClone(backgroundProfile),run:state,through:started});
      finishTimer=setTimeout(()=>worker.postMessage({type:'finish'}),550);
    }
    else if(packet.finished) { clearTimeout(timeout); resolve(packet); }
  });
}); } finally { clearTimeout(finishTimer); await worker.terminate(); }
assert(finalPacket.runtime.simulatedSeconds>=.4&&finalPacket.runtime.simulatedSeconds<2,'Worker replayed old time or did not run');
assert.equal(finalPacket.runtime.interruptedSeconds,0,'Normal live worker ticks were discarded');
advanceElapsed(baseline,finalPacket.runtime.simulatedSeconds);
assert.equal(finalPacket.profile.coins,baseline.profile.coins,'Background rewards diverged');
assert.equal(finalPacket.profile.totalKills,baseline.profile.totalKills,'Background destruction diverged');
assert.equal(finalPacket.run.seed,baseline.seed,'Background random sequence diverged');
assert.equal(finalPacket.run.run.shots,baseline.run.shots,'Background launched twice during handoff');
assert(finalPacket.run.shotTime>0,'Background ball physics made no live progress');
const legacyFarmer=createProfile(); legacyFarmer.chapter=4; legacyFarmer.relics=data.relics.map(r=>r.id);
legacyFarmer.upgrades=Object.fromEntries(data.upgrades.filter(u=>u.viewGroup!=='finale').map(u=>[u.id,Math.min(u.max,3)]));
Object.assign(legacyFarmer.upgrades,{power:32,kinetic:12,battery:4,salvage:12,fortune:12,combo:8,goldCombo:4,split:4,reactor:4,magnet:4,prism:4,elitePower:4,comboMint:4,idleYield:4});
farmComparisons.push(compareFarming(legacyFarmer,44077,'retained-previous-upgrades'));
const retainedLateBuild=[];
for(let seed=1;seed<=6;seed++) {
  const p=createProfile();p.chapter=data.chapters.length-1;p.prestige=1;p.relics=data.relics.map(r=>r.id);
  p.upgrades=Object.fromEntries(data.upgrades.map(u=>[u.id,u.max]));p.upgrades.power=34;
  const g=new Game(data,p,seed*2311),progress=[];
  for(let run=1;run<=6;run++) {
    while(g.state!=='ended') {
      if(g.state==='ready') { if(g.goalComplete&&g.run.shots)g.endRun();else g.launch(g.autoAngle(),1); }
      if(g.state==='flying')g.tick(.25);g.events.length=0;
    }
    progress.push({run,clearPercent:+(g.clearRatio*100).toFixed(1),coins:g.run.coins,shots:g.run.shots,power:g.level.power});
    if(g.goalComplete)break;
    buyPlanned(g);g.newRun();
  }
  assert(g.goalComplete,'A retained late build stalled in the final region');
  retainedLateBuild.push({seed:seed*2311,entryPower:34,entryDamage:data.economy.damage*data.growth.power**34*(1+data.growth.prestigeDamage),otherResearch:'all previously purchased maximum ranks; no granted buffs or coins',progress});
}
const healthCurves=data.chapters.map((chapter,index)=>{
  const rings=Array.from({length:8},(_,i)=>({ring:i+2,health:[]}));
  for(let seed=1;seed<=12;seed++) {
    const p=createProfile();p.chapter=index;
    for(const b of new Game(data,p,seed*197).blocks) if(b.type==='normal')rings[b.ring-2].health.push(b.maxHP/chapter.hp);
  }
  return {chapter:chapter.name,baseHP:chapter.hp,jumpFromPrevious:index?chapter.hp/data.chapters[index-1].hp:1,ringHPExponent:chapter.ringHPExponent??1,rings:rings.map(({ring,health})=>({ring,min:+Math.min(...health).toFixed(2),median:+quantile(health,.5).toFixed(2),max:+Math.max(...health).toFixed(2)}))};
});
const report = {
  generatedAt: new Date().toISOString(), samples, strategy: 'Full-power geometric aim; unlock basic power, energy and idle, then buy the cheapest available research. If a frontier run breaks nothing, farm the preceding region twice and retry. Clear native blocks to summon each fixed-health boss; defeat it using the remaining shots of that run before advancing. Farming comparisons use the same saved upgrades, full automatic shots and actual idle delays in each unlocked region. No cheats in campaign runs.',
  summary: {
    bossProgress,
    completed: results.filter(r => r.completed).length,
    firstRunCoinsMedian: quantile(results.map(r => r.firstRunCoins), 0.5),
    firstBuyRunMedian: quantile(results.map(r => r.firstBuyRun), 0.5),
    firstBuyRunP90: quantile(results.map(r => r.firstBuyRun), 0.9),
    idleUnlockRunMedian: quantile(results.map(r => r.idleUnlockRun), 0.5),
    idleUnlockRunP90: quantile(results.map(r => r.idleUnlockRun), 0.9),
    campaignRunsMedian: quantile(results.map(r => r.runs), 0.5),
    farmingRunsMedian:quantile(results.map(r=>r.farmingRuns),.5),
    farmingRunsMax:Math.max(...results.map(r=>r.farmingRuns)),
    simulationMinutesMedian: +(quantile(results.map(r => r.seconds), 0.5) / 60).toFixed(2),
    totalShots: results.reduce((s,r) => s + r.shots, 0),
    emptyShots: results.reduce((s,r) => s + r.emptyShots, 0),
    maxBalls: Math.max(...results.map(r => r.maxBalls)),
    constellationCampaignActivations: results.reduce((sum,r)=>sum+r.starBursts,0),
    chapterCompletedRunMedians:data.chapters.map((c,i)=>({chapter:c.name,run:quantile(results.map(r=>r.chapterCompletedAt[i]),.5),runsInChapter:quantile(results.map(r=>r.chapterCompletedAt[i]-(r.chapterCompletedAt[i-1]||0)),.5)})),
    eliteUnlockRunMedian:quantile(results.map(r=>r.eliteUnlockedAt),.5),
    firstEliteOpenedRunMedian:quantile(results.map(r=>r.firstEliteOpenedAt),.5),
    firstMintRunMedian:quantile(results.map(r=>r.firstMintAt),.5),
    eliteOpened:results.reduce((s,r)=>s+r.eliteOpened,0),
    eliteItems:[...new Set(results.flatMap(r=>r.eliteItems))],
    firstEliteItems:data.drops.filter(d=>d.elite).map(d=>({id:d.id,runMedian:quantile(results.flatMap(r=>r.firstEliteItems[d.id]?[r.firstEliteItems[d.id].run]:[]),.5),chapterMedian:quantile(results.flatMap(r=>r.firstEliteItems[d.id]?[r.firstEliteItems[d.id].chapter+1]:[]),.5)})),
    comboCoins:results.reduce((s,r)=>s+r.comboCoins,0),
    eliteArcs:results.reduce((s,r)=>s+r.arcs,0),
    riftPulses:results.reduce((s,r)=>s+r.riftPulses,0),
    finaleCasts:results.reduce((s,r)=>s+r.finales,0),
    techTriggers:Object.fromEntries(data.upgrades.filter(u=>['联动','宝库联动','终局联动'].includes(u.branch)&&!['eliteUnlock','eliteChance','eliteAccess','elitePower'].includes(u.id)).map(u=>[u.id,results.reduce((sum,r)=>sum+(r.techTriggers[u.id]||0),0)])),
    researchByChapter:data.chapters.map((c,i)=>{
      const all=results.map(r=>r.purchases.filter(p=>p.chapter===i+1)),mechanisms=all.map(list=>list.filter(p=>['links','stars','finale'].includes(p.group)));
      const spent=(list,core)=>list.filter(p=>(p.group==='core')===core).reduce((sum,p)=>sum+p.cost,0);
      return {chapter:c.name,totalRanksMedian:quantile(all.map(list=>list.length),.5),mechanismRanksMedian:quantile(mechanisms.map(list=>list.length),.5),mechanismIds:[...new Set(mechanisms.flat().map(p=>p.id))],highestMechanismRank:Math.max(0,...mechanisms.flat().map(p=>p.level)),finaleRanksMedian:quantile(all.map(list=>list.filter(p=>p.group==='finale').length),.5),basicSpentMedian:quantile(all.map(list=>spent(list,true)),.5),mechanismAndTreasureSpentMedian:quantile(all.map(list=>spent(list,false)),.5)};
    }),
    researchPacing:data.upgrades.filter(u=>(u.chapter||0)>=1&&u.max>1&&u.viewGroup!=='core').map(u=>{
      const observed=results.flatMap(r=>{
        const eligibility=r.eligibleResearch[u.id],buys=r.purchases.filter(p=>p.id===u.id);if(!eligibility||!buys.length)return[];
        const first=buys[0],initial=buys.filter(p=>p.shop===first.shop);
        return [{eligibleWallet:eligibility.coins,affordableAtUnlock:eligibility.affordableRanks,firstShoppingRanks:initial.length,firstShopMaxed:initial.at(-1).level===u.max,finalRank:buys.at(-1).level,shoppingVisits:new Set(buys.map(p=>p.shop)).size,progressedOverRuns:buys.at(-1).run-first.run}];
      });
      return {id:u.id,max:u.max,prices:Array.from({length:u.max},(_,i)=>Math.round(u.cost*u.growth**i)),campaigns:observed.length,eligibleWalletMedian:quantile(observed.map(r=>r.eligibleWallet),.5),affordableAtUnlockMedian:quantile(observed.map(r=>r.affordableAtUnlock),.5),firstShoppingRanksMedian:quantile(observed.map(r=>r.firstShoppingRanks),.5),firstShopMaxedCount:observed.filter(r=>r.firstShopMaxed).length,finalRankMedian:quantile(observed.map(r=>r.finalRank),.5),shoppingVisitsMedian:quantile(observed.map(r=>r.shoppingVisits),.5),progressedOverRunsMedian:quantile(observed.map(r=>r.progressedOverRuns),.5)};
    }),
    entryExperience:data.chapters.map((c,i)=>{
      const first=results.map(r=>r.runResults.find(run=>run.chapter===i+1));
      return {chapter:c.name,firstRunClearPercentMedian:quantile(first.map(r=>r.clearPercent),.5),firstRunIncomeMedian:quantile(first.map(r=>r.coins),.5),firstRunDamageToInnerHPMedian:quantile(first.map(r=>r.damageToInnerHP),.5)};
    }),
    fifthChapterProgress:Array.from({length:Math.max(...results.map(r=>r.runResults.filter(run=>run.chapter===5).length))},(_,i)=>{
      const runs=results.flatMap(r=>r.runResults.filter(run=>run.chapter===5)[i]?[r.runResults.filter(run=>run.chapter===5)[i]]:[]);
      return {run:i+1,samples:runs.length,clearPercentMedian:quantile(runs.map(r=>r.clearPercent),.5),incomeMedian:quantile(runs.map(r=>r.coins),.5),powerMedian:quantile(runs.map(r=>r.power),.5)};
    }),
    healthCurves,
    finaleMilestones:data.upgrades.filter(u=>u.viewGroup==='finale').map(u=>{
      const buys=results.flatMap(r=>{const p=r.purchases.find(p=>p.id===u.id);return p?[p]:[];}),procs=results.flatMap(r=>r.firstFinaleTriggers[u.id]?[r.firstFinaleTriggers[u.id]]:[]);
      return {id:u.id,firstBuyRunMedian:quantile(buys.map(p=>p.run),.5),firstTriggerRunMedian:quantile(procs.map(p=>p.run),.5),firstTriggerChapterMedian:quantile(procs.map(p=>p.chapter),.5),campaignsTriggered:procs.length};
    }),
    farmingComparisons:farmComparisons.map(f=>({label:f.label,frontier:f.frontier,power:f.power,comboMint:f.comboMint,bestChapter:f.bestChapter,currentVsBest:f.currentVsBest})),
    minimumBreakthroughClearPercent: Math.min(...results.flatMap(r=>r.breakthroughs.map(b=>b.clearPercent))),
    longestShot: +Math.max(...results.map(r => r.longestShot)).toFixed(2),
    openingHits: { min:Math.min(...opening),max:Math.max(...opening),mean:+(opening.reduce((a,b)=>a+b,0)/opening.length).toFixed(2) },
    stopMotion: { maximumFinalSpeed:+maxStopSpeed.toFixed(3),maximumFinalTravel:+maxStopTravel.toFixed(4) },
    highSpeedMotion: 'nine solid-wall approaches + bounded position + single clock and energy drain + straight flight + save continuation pass',
    constellationContinuity: 'windup and volley resume + distinct targets + reacquisition + no false hit or recursive charge + clipped geometry + split return + deadline + laser cooldown pass',
    saveResume: 'pass', pause: 'pass', idleContinuation: 'pass', breakthroughGate: 'real clear spawns boss; only its real defeat qualifies; old cumulative progress cannot skip it', relicContinuity: 'return + tether + springs + fusion pass', backgroundWorker: 'continuous live physics + final handoff; stale timestamp ignored', lateGameStress: '10 / 10 pass'
  },
  note: 'Simulated combat time excludes player aiming, reading, shopping and relic decisions. Boss hitSources count real damage events on the boss; shotTechTriggers describe the whole shot, not guaranteed boss hits. Remaining shots at summon exclude the already flying shot. Boss challenge length counts runs from first encounter through first victory, including a new run that fails to summon. Automated checks do not establish subjective fun or browser frame rate.',
  results, stress, phases, farmComparisons, endgameFollowup, retainedLateBuild
};
if(!process.argv.includes('--no-report')) {
  fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../reports/playtest.json', import.meta.url), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report.summary, null, 2));
console.log(process.argv.includes('--no-report') ? 'Checks passed; existing report preserved.' : 'Player-loop report saved to reports/playtest.json');
