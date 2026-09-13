import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, sanitizeProfile, upgradeStatus } from '../src/game.js';
import { advanceElapsed } from '../src/idle.js';

const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));

// Leave a difficult region, farm a cleared one, save, and return without losing the objective.
const p = createProfile(); p.chapter = 2; p.coins = 100000;
p.stageCores = 2; p.stageCombo = 17; p.stageKills = 93;
p.upgrades = { power: 12, kinetic: 6, idle: 1, idleSpeed: 3, idleYield: 4 };
const game = new Game(data, p, 441);
assert.equal(game.profile.frontierChapter, 2);
assert(!game.selectChapter(3), 'A locked region could be selected');
assert(game.selectChapter(0));
assert.equal(upgradeStatus(data, game.profile, 'magnet'), 'locked', 'Farming relocked an unlocked chapter technology');
const earned = game.profile.earned;
game.auto = true;
advanceElapsed(game, 70);
assert(game.profile.earned > earned && game.profile.runs >= 2, 'Old-region farming stopped or paid nothing');
game.profile.stageCores = 100; game.profile.stageCombo = 1000; game.run.cleared = game.run.totalBlocks;
game.endRun();
assert(!game.goalComplete && !game.advance('echo'), 'Farming repeated a breakthrough reward');
const restored = new Game(data, sanitizeProfile(structuredClone(game.profile), data));
assert(restored.restore(game.snapshot()));
assert(restored.selectChapter(2));
assert.deepEqual([restored.profile.stageCores, restored.profile.stageCombo, restored.profile.stageKills], [2, 17, 93]);
assert(restored.isFrontier && !restored.goalComplete, 'Returning should require clearing the new map');
// Use an isolated strong build to really summon and defeat this chapter's boss.
restored.profile.upgrades={power:48,kinetic:24,battery:4};restored.auto=false;
for(let i=0;i<2500&&restored.state!=='ended';i++) {if(restored.state==='ready')restored.launch(restored.autoAngle(),1);restored.tick(.1);restored.events.length=0;}
assert(restored.run.bossSpawned&&restored.run.bossDefeated&&restored.goalComplete,'A real boss kill did not qualify for travel');
assert(restored.advance('echo'));
assert.equal(restored.profile.unlockedChapter, 3);
assert.equal(restored.profile.frontierChapter, 3);
assert.equal(restored.profile.chapter, 2, 'Breakthrough entered the next region before the player chose it');
assert(restored.pendingChapterSelection && restored.state==='ended');
const waiting=restored.snapshot(),waitingCoins=restored.profile.coins;
restored.auto=true; advanceElapsed(restored,70);
assert.equal(restored.profile.coins,waitingCoins); assert.equal(restored.run.shots,waiting.run.shots);
assert.equal(restored.profile.chapter,2); assert(!restored.launch(0,1));
assert(!restored.advance('heart'),'A waiting breakthrough claimed a second reward');
const waitingResume=new Game(data,sanitizeProfile(structuredClone(restored.profile),data));
assert(waitingResume.restore(restored.snapshot()));
assert(waitingResume.pendingChapterSelection && waitingResume.state==='ended');
waitingResume.paused=true;
assert(waitingResume.selectChapter(3));
assert(!waitingResume.pendingChapterSelection && waitingResume.state==='ready');
assert(!waitingResume.paused, 'Choosing a destination from a saved modal left gameplay paused');
assert.equal(waitingResume.profile.chapter,3);
assert(waitingResume.selectChapter(2), 'Choosing the new region removed access to a cleared one');
const legacy = sanitizeProfile({ ...createProfile(), chapter: 0, prestige: 1 }, data);
assert.equal(legacy.unlockedChapter, 3, 'An old post-cycle save lost its unlocked regions');
const oldCycle = { ...createProfile(), chapter:0, prestige:1, coins:7812, upgrades:{power:31}, relics:data.relics.map(r=>r.id) };
delete oldCycle.campaignVersion;
const expandedCycle=sanitizeProfile(oldCycle,data);
assert.equal(expandedCycle.unlockedChapter,4,'An old completed campaign did not unlock the added fifth region');
assert.equal(expandedCycle.frontierChapter,4,'An old completed campaign did not receive the fifth-region objective');
assert.equal(expandedCycle.chapter,0,'The expansion moved an old active region');
assert.equal(expandedCycle.coins,oldCycle.coins); assert.equal(expandedCycle.upgrades.power,31);
assert.equal(sanitizeProfile(expandedCycle,data).frontierChapter,4,'Expansion migration was not stable');

// Ring reinforcement changes the new map, not an already saved map or an attack's native HP basis.
const unreinforcedData=structuredClone(data); delete unreinforcedData.chapters.at(-1).ringHPExponent;
for(let chapter=0;chapter<data.chapters.length;chapter++) {
  const p=createProfile();p.chapter=chapter;p.upgrades={eliteUnlock:1,eliteAccess:3};
  const previous=new Game(unreinforcedData,structuredClone(p),418),current=new Game(data,structuredClone(p),418);
  if(chapter<data.chapters.length-1) assert.deepEqual(current.blocks,previous.blocks,'Final-region reinforcement changed an earlier region');
  else {
    for(const block of current.blocks) {
      const old=previous.blocks.find(b=>b.id===block.id);
      assert.equal(current.percentDamage(block,.1),previous.percentDamage(old,.1),'Reinforcement raised percentage damage beyond the chapter-scaled native basis, including a generated rare box');
      if(block.ring===2)assert.equal(block.maxHP,old.maxHP,'Reinforcement changed the entrance');
      else assert(block.maxHP>old.maxHP,'An outer block did not receive its reinforcement');
    }
    assert(current.restore(previous.snapshot()));
    assert.deepEqual(current.blocks,previous.blocks,'Loading retroactively reinforced an old map');
    current.newRun();
    assert(current.blocks.some(b=>b.percentDamageHP<b.maxHP),'A new run did not receive the new growth');
    const saved=new Game(data,structuredClone(p));assert(saved.restore(current.snapshot()));
    assert.deepEqual(saved.blocks,current.blocks,'Saving discarded the percentage damage basis');
    current.spawnLucky(2);
    for(const b of current.blocks.filter(b=>b.native===false)) assert.equal(current.percentDamage(b,.1),b.maxHP*.1,'A spawned lucky box inherited discarded outer armor');
  }
}
// Actual percentage attacks remove the same amount from the original and reinforced target.
const percentageAttacks={
  arc:(g,b,actor)=>g.chainArc(actor),
  rift:(g,b)=>{g.openRift(b.x+16,b.y+16);g.updateRifts(data.elite.riftInterval);},
  collapse:(g,b)=>{g.level.riftCollapse=1;const r=g.openRift(b.x+16,b.y+16);r.left=.001;r.pulse=1;g.updateRifts(.01);},
  array:(g,b)=>{g.star.triangle=[{x:b.x,y:b.y},{x:b.x+40,y:b.y},{x:b.x+20,y:b.y+40}];g.star.points=g.star.triangle;g.star.damage=0;g.collapseStar();},
  finale:(g,b,actor)=>{g.combo=40;g.comboAttacks(actor);},
  salvo:(g,b)=>{g.fireSalvo([{x:b.x,y:b.y}],1,0,data.constellation.salvoHPDamage,'starSalvo');g.updateStar(data.constellation.salvoDuration);},
  retarget:(g,b)=>{
    const next={...b,id:b.id+400,hp:b.hp*2,maxHP:b.maxHP*2};
    if(next.percentDamageHP!==undefined)next.percentDamageHP*=2;
    g.blocks.push(next);g.reindex();g.fireSalvo([{x:b.x,y:b.y}],1,0,data.constellation.salvoHPDamage,'starSalvo');
    b.alive=false;g.grid.delete(b.id);const before=next.hp;g.updateStar(data.constellation.salvoDuration);return before-next.hp;
  },
  finaleSalvo:(g,b,actor)=>{g.level.finaleSalvo=1;g.combo=40;g.comboAttacks(actor);g.updateStar(data.constellation.salvoDuration);},
  direct:(g,b,actor)=>g.damage(b,100,actor)
};
for(const [name,attack] of Object.entries(percentageAttacks)) {
  const removed=[];
  for(const config of [unreinforcedData,data]) {
    const p=createProfile();p.chapter=data.chapters.length-1;
    const g=new Game(config,p,882),block=g.blocks.find(b=>b.ring===8&&b.type==='normal');
    g.blocks=[block];g.reindex();g.launch(0,1);const actor=g.makeBall(block.x+16,block.y+16,0,22,true);
    const before=block.hp,loss=attack(g,block,actor);removed.push(typeof loss==='number'?loss:before-block.hp);
  }
  assert(removed[0]>0,`${name} never damaged its target`);
  assert(Math.abs(removed[0]-removed[1])<Math.max(.001,removed[0]*1e-10),`${name} incorrectly scales with extra outer health`);
}

// Maps vary as coherent fields, preserve the opening and all four targets, and save portal locations.
const signatures = new Set(), portalEntries = new Set();
let baseChests = 0, researchedChests = 0;
for (let seed = 1; seed <= 24; seed++) {
  const profile = createProfile(); profile.chapter = 2;
  const map = new Game(data, profile, seed * 7919);
  signatures.add(map.blocks.map(b => `${b.id}:${b.tier}:${b.type}:${b.supply}`).join(','));
  portalEntries.add(JSON.stringify(map.portals[0]));
  assert.equal(map.blocks.filter(b => b.type === 'core').length, 4, 'A portal removed a core target');
  assert(!map.blocks.some(b => Math.abs(b.gx - 9) <= 1 && Math.abs(b.gy - 9) <= 1), 'Spawn cavity was blocked');
  assert(map.blocks.filter(b => b.supply === 'charge').length <= data.mechanics.extraShotsCap, 'Map promised too many batteries');
  const same = new Game(data, structuredClone(profile), seed * 7919);
  assert.deepEqual(same.blocks, map.blocks); assert.deepEqual(same.portals, map.portals);
  const resumed = new Game(data, structuredClone(profile)); assert(resumed.restore(map.snapshot()));
  assert.deepEqual(resumed.portals, map.portals); assert.deepEqual(resumed.pattern, map.pattern);
  map.newRun(); resumed.newRun(); assert.deepEqual(resumed.snapshot(), map.snapshot(), 'Next map changed after a save');
  baseChests += same.blocks.filter(b => b.type === 'gold').length;
  const rich = structuredClone(profile); rich.upgrades = { fortune: 12, comboLuck: 2, idleLuck: 2 };
  researchedChests += new Game(data, rich, seed * 7919).blocks.filter(b => b.type === 'gold').length;
}
assert.equal(signatures.size, 24, 'New seeds repeated the same layout');
assert.equal(portalEntries.size, 4, 'Portal entrances did not use all sides of spawn');
assert(researchedChests > baseChests * 2, 'Chest research was not perceptible across maps');
assert(researchedChests/24<45,'Common chests overwhelmed the mine after full research');

// Rare rewards are deliberate map targets: scarce, spread apart, and brought inward by research.
const rareContents = new Set(), rareRings = [], accessibleRings = [];
for(let chapter=0;chapter<data.chapters.length;chapter++) for(let seed=1;seed<=12;seed++) {
  const fresh=createProfile(); fresh.chapter=chapter;
  const untouched=new Game(data,fresh,seed*197);
  assert(!untouched.blocks.some(b=>b.type==='elite'),'A locked treasure appeared without research');
  assert(untouched.blocks.filter(b=>b.type==='normal').every(b=>!b.supply),'Ordinary blocks hid treasure content');
  assert(untouched.blocks.filter(b=>b.type==='gold').every(b=>!data.drops.find(d=>d.id===b.supply)?.elite),'An ordinary box promised an exclusive relic');
  const prospect=structuredClone(fresh); prospect.upgrades={eliteUnlock:1};
  const mine=new Game(data,prospect,seed*197), rare=mine.blocks.filter(b=>b.type==='elite');
  assert.equal(rare.length,data.elite.count,'The first treasure research did not generate its promised count');
  assert(rare.every(b=>b.ring>=data.elite.minRing),'An early treasure spawned inside its promised ring');
  rareRings.push(Math.min(...rare.map(b=>b.ring)));
  assert(rare.every(b=>data.drops.some(d=>d.elite&&d.id===b.supply)),'An advanced box did not contain an exclusive relic');
  rare.forEach(b=>rareContents.add(b.supply));
  const full=structuredClone(fresh); full.upgrades={eliteUnlock:1,eliteChance:3,eliteAccess:3};
  const expanded=new Game(data,full,seed*197), nearer=expanded.blocks.filter(b=>b.type==='elite');
  assert.equal(nearer.length,data.elite.count+3*data.elite.countPerLevel,'Treasure count research did not add its promised targets');
  assert(nearer.every(b=>b.ring>=data.elite.minAccessRing),'Access research covered the starting cavity');
  accessibleRings.push(Math.min(...nearer.map(b=>b.ring)));
  assert(expanded.blocks.filter(b=>b.type==='core').length===4,'Rare generation removed a main objective');
  assert.equal(data.chapters[chapter].palette.length,data.tierHP.length,'Health steps and colors use different spectra');
  const stable=new Game(data,structuredClone(full)); assert(stable.restore(expanded.snapshot()));
  assert.deepEqual(stable.blocks,expanded.blocks,'Saving changed the locations or contents of rare targets');
}
assert(rareRings.every(r=>r===data.elite.minRing),'First treasure targets were not reachable at the nearest unlocked ring');
assert(accessibleRings.every(r=>r===data.elite.minAccessRing),'Access research did not bring one target visibly inward');
assert.equal(rareContents.size,data.drops.filter(d=>d.elite).length,'Rare maps never offered one of their exclusive rewards');

// Every visible chest pays once, with the generated contents; ordinary bricks never hide items.
const drops = new Game(data, createProfile(), 712);
const actor = drops.makeBall(304, 304, 0, 22, true);
const ordinary = drops.blocks.find(b => b.type === 'normal'); ordinary.loot = 0;
drops.damage(ordinary, ordinary.hp + 1, actor);
assert.equal(drops.run.drops, 0, 'An ordinary block still used the old hidden-drop path');
const chest = drops.blocks.find(b => b.type === 'gold' && data.drops.find(d => d.id === b.supply)?.stackable);
const promised = chest.supply;
drops.shotAuto = true; drops.damage(chest, chest.hp + 1, actor);
assert.equal(drops.buffs[promised], 1, 'Idle mode lost or rerolled a promised chest item');
drops.damage(chest, 100, actor); assert.equal(drops.run.drops, 1, 'Chest paid twice');
drops.spawnLucky(2);
assert.equal(drops.blocks.filter(b => b.alive && b.type === 'gold' && b.native === false).length, 2, 'Native treasure prevented lucky chest spawning');

// Compare an actual next shot before/after one un-upgraded rare reward, on identical mines.
const rewardImpact=Object.fromEntries(['none',...data.drops.filter(d=>d.elite).map(d=>d.id)].map(id=>[id,{kills:0,damage:0,arcs:0,pulses:0}]));
let liveRiftSave=null;
for(let seed=1;seed<=12;seed++) for(const id of Object.keys(rewardImpact)) {
  const p=createProfile(); p.chapter=2;
  const matchingPower=Math.round(Math.log(data.chapters[p.chapter].hp*.2/data.economy.damage)/Math.log(data.growth.power));
  p.upgrades={power:matchingPower,kinetic:8,combo:2,split:1,splitCombo:1,shock:1,reactor:1};
  const shot=new Game(data,p,seed*1777); shot.buffs={split:1,shock:1,boost:1};
  if(id!=='none') shot.buffs[id]=1;
  shot.launch(.17+seed*.19,1);
  for(let tick=0;tick<4000&&shot.state==='flying';tick++) {
    shot.tick(data.physics.step); shot.events.length=0;
    if(liveRiftSave?.source===shot) { liveRiftSave.resumed.tick(data.physics.step); liveRiftSave.resumed.events.length=0; }
    if(id==='rift'&&shot.rifts.length&&!liveRiftSave) {
      const resumed=new Game(data,structuredClone(shot.profile)); assert(resumed.restore(shot.snapshot()));
      liveRiftSave={source:shot,resumed};
    }
  }
  assert.notEqual(shot.state,'flying','One rare reward left a shot running forever');
  rewardImpact[id].kills+=shot.run.kills;
  rewardImpact[id].damage+=shot.blocks.reduce((sum,b)=>sum+(1-Math.max(0,b.hp)/b.maxHP),0);
  rewardImpact[id].arcs+=shot.run.arcs; rewardImpact[id].pulses+=shot.run.riftPulses;
}
for(const id of Object.keys(rewardImpact).filter(id=>id!=='none')) {
  assert(rewardImpact[id].damage>rewardImpact.none.damage&&rewardImpact[id].kills>rewardImpact.none.kills,`${id} did not improve damage and actual breaks in the paired shots: ${JSON.stringify(rewardImpact)}`);
}
assert(rewardImpact.arc.arcs>0&&rewardImpact.rift.pulses>0,'A rare reward never displayed its promised attack');
assert(liveRiftSave,'A real shot never left an active rift to resume');
assert.deepEqual(liveRiftSave.resumed.snapshot(),liveRiftSave.source.snapshot(),'Rare damage, coin thresholds or pulse timers changed across a saved shot');
const impactSummary=Object.fromEntries(Object.entries(rewardImpact).map(([id,value])=>[id,{meanKills:+(value.kills/12).toFixed(1),meanHealthBarsRemoved:+(value.damage/12).toFixed(1),damageGainPercent:+((value.damage/rewardImpact.none.damage-1)*100).toFixed(1),killGainPercent:+((value.kills/rewardImpact.none.kills-1)*100).toFixed(1),arcs:value.arcs,pulses:value.pulses}]));

console.log(JSON.stringify({ finalRegionReinforcement: 'earlier regions and entrance unchanged; new outer HP, saved native percentage basis, legacy map fallback, rare and lucky boxes, every percentage attack, salvo retargeting and direct damage pass', chapterTravel: 'farm, save, return, unlock and reward protection pass; breakthrough waits for a saved explicit destination choice, idle cannot skip it, selection resumes play; old completed saves retain progress and receive region five', randomMaps: signatures.size, portalSides: portalEntries.size, chestsPerMap: { base: +(baseChests / 24).toFixed(1), researched: +(researchedChests / 24).toFixed(1) }, rareTargets:{maps:rareRings.length,baseCount:data.elite.count,researchedCount:data.elite.count+3*data.elite.countPerLevel,nearestRingBefore:Math.min(...rareRings),nearestRingAfter:Math.min(...accessibleRings),contents:[...rareContents]}, rareRewardShots:impactSummary, rareContinuity:'live rift damage and timers resume identically', drops: 'one chest rule, fixed contents, idle guarantee and lucky spawn pass' }, null, 2));
