import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, sanitizeProfile } from '../src/game.js';
import { advanceElapsed } from '../src/idle.js';

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

// The same live Game now handles every frame. Autosave during an automatic boss
// shot must preserve health, rotation, future shots and rewards across a reload.
const continuous=chamber(0,{power:7,kinetic:10,idle:1});continuous.auto=true;continuous.launch(0,1);
for(let i=0;i<30;i++)continuous.tick(1/60);
assert(continuous.run.bossDamage>0,'Continuous boss simulation never dealt real damage');
const continued=new Game(data,structuredClone(continuous.profile));assert(continued.restore(continuous.snapshot()));
for(let i=0;i<900;i++) {
  const dt=i%30===0?.05:1/60;
  continuous.tick(dt);continued.tick(dt);continuous.events.length=continued.events.length=0;
}
assert.deepEqual(continued.snapshot(),continuous.snapshot(),'Automatic boss fight changed after autosave');
assert.deepEqual(continued.profile,continuous.profile,'Automatic boss fight duplicated or lost rewards after autosave');

const report={generatedAt:new Date().toISOString(),fixedHealth:'pass',realBossCollision:'pass',activeSaveResume:'pass',failureResetsBoss:'pass',noExtraShots:'pass',highSpeedLargeBlock:'pass',legacyRewardAndPendingChoice:'pass',continuousAutomaticBossSaveResume:'pass',note:'Real boss collisions and automatic boss fight persistence. Page visibility, scheduling and no frozen-time replay are tested separately in idle-session-check.'};
if(!process.argv.includes('--no-report'))fs.writeFileSync(new URL('../reports/boss-check.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
