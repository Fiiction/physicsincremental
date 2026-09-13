import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, upgradeStatus, upgradeCost } from '../src/game.js';

// Use the normal geometric pilot and the same affordable-research policy as playtest.mjs.
const original=JSON.parse(fs.readFileSync(new URL('../src/data/balance.json',import.meta.url),'utf8'));
const variants={baseline:[1,1,1,1,1],moderate:[1,1.6,2.6,4.2,6.8],strong:[1,2.2,4.8,10.6,23.4],refined:{hp:[1,1.5,2.5,3.5,4.5],boss:[1,1.15,1.2,1.2,1.15],percentScale:[1,1,.65,.45,1]},current:[1,1,1,1,1]};
const variant=process.argv[2]||'current',samples=Number(process.argv[3]||12);
const candidate=variants[variant]||JSON.parse(variant);
const factors=Array.isArray(candidate)?candidate:candidate.hp;
const bossFactors=Array.isArray(candidate)?candidate:candidate.boss;
const data=structuredClone(original);
if(variant!=='current')data.chapters.forEach((chapter,index)=>{
  chapter.hp=[1,40,10000,1600000,100000000][index]*factors[index];
  chapter.boss.hp=[4000,500000,200000000,20000000000,150000000000][index]*bossFactors[index];
  chapter.boss.percentDamageHP=chapter.boss.hp*.005;
  chapter.percentDamageScale=Array.isArray(candidate)?1:(candidate.percentScale?.[index]??1);
});
const median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
const results=[];
for(let index=0;index<samples;index++) {
  const seed=17+index*7919,g=new Game(data,createProfile(),seed),chapters=[],runs=[];
  let farms=0,farmingStreak=0,seconds=0,shots=0,guard=0;
  const buy=()=>{
    for(const [id,target] of [['power',1],['kinetic',1],['idle',1]]) while((g.level[id]||0)<target) {
      if(upgradeStatus(data,g.profile,id)!=='available')return;
      g.buy(id);
    }
    while(true) {
      const next=data.upgrades.filter(u=>upgradeStatus(data,g.profile,u.id)==='available').sort((a,b)=>upgradeCost(data,g.profile,a.id)-upgradeCost(data,g.profile,b.id))[0];
      if(!next)return;
      g.buy(next.id);
    }
  };
  while(g.profile.prestige===0&&g.profile.runs<80&&guard++<150000) {
    const chapter=g.profile.chapter;
    if(!chapters[chapter]) {
      const inner=g.blocks.filter(b=>b.type==='normal'&&b.ring===2).map(b=>b.maxHP);
      chapters[chapter]={chapter:chapter+1,entryRun:g.profile.runs+1,entryPower:g.level.power||0,entryDamage:g.stats.damage,damageToInnerHP:g.stats.damage/median(inner),entryRanks:Object.values(g.level).reduce((a,b)=>a+b,0),firstShots:[]};
    }
    const progress=chapters[chapter];
    if(g.state==='ended') {
      const run={chapter:chapter+1,run:g.profile.runs,coins:g.run.coins,power:g.level.power||0,clearPercent:g.clearRatio*100,shots:g.run.shots,bossSpawned:!!g.run.bossSpawned,bossDefeated:!!g.run.bossDefeated,bossHPPercent:g.boss?100*g.boss.hp/g.boss.maxHP:null,bossDirectHits:g.run.bossDirectHits,techRanks:Object.values(g.level).reduce((a,b)=>a+b,0)};
      runs.push(run);
      if(!progress.firstRun)progress.firstRun=run;
      if(g.run.bossSpawned&&!progress.firstBossRun)progress.firstBossRun=g.profile.runs;
      if(!g.isFrontier)farms++;
      const complete=g.goalComplete;
      if(complete) {
        assert(g.run.bossDefeated&&g.run.bossDirectHits>0,'A stage passed without real boss contact');
        Object.assign(progress,{completedRun:g.profile.runs,completedPower:g.level.power||0,completedRanks:run.techRanks,challengeRuns:g.profile.runs-progress.firstBossRun+1});
      }
      buy();
      if(complete) {
        const choices=data.relics.filter(r=>!g.profile.relics.includes(r.id));
        assert(g.advance(choices.length?choices[index%choices.length].id:'fusion'));
        assert(g.selectChapter(g.profile.frontierChapter));
        if(!g.profile.prestige)buy();
      } else if(!g.isFrontier&&++farmingStreak>=2) { farmingStreak=0;assert(g.selectChapter(g.profile.frontierChapter)); }
      else if(g.isFrontier&&g.run.kills===0&&chapter>0) { farmingStreak=0;assert(g.selectChapter(chapter-1)); }
      else g.newRun();
      g.events.length=0;
      continue;
    }
    if(g.state==='ready') {
      if(g.goalComplete&&g.run.shots) {g.endRun();continue;}
      const kills=g.run.kills,coins=g.run.coins;
      g.launch(g.autoAngle(),1,false);shots++;
      while(g.state==='flying') {g.tick(.5);seconds+=.5;g.events.length=0;}
      if(progress.entryRun===g.profile.runs+(g.state==='ended'?0:1)&&progress.firstShots.length<3) progress.firstShots.push({shot:g.run.shots,kills:g.run.kills-kills,coins:g.run.coins-coins,clearPercent:g.clearRatio*100});
    } else {g.tick(.5);seconds+=.5;g.events.length=0;}
  }
  results.push({seed,completed:g.profile.prestige>0,totalRuns:g.profile.runs,farmingRuns:farms,seconds,shots,chapters,runs});
  console.log(JSON.stringify({variant,seed,completed:g.profile.prestige>0,runs:g.profile.runs,farms,stages:chapters.map(c=>({entryPower:c.entryPower,entryHitRatio:+c.damageToInnerHP.toFixed(2),firstClear:+c.firstRun?.clearPercent.toFixed(1),runs:c.completedRun-c.entryRun+1,bossRuns:c.challengeRuns}))}));
}
const summary={completed:results.filter(r=>r.completed).length,samples,totalRunsMedian:median(results.map(r=>r.totalRuns)),totalRunsRange:[Math.min(...results.map(r=>r.totalRuns)),Math.max(...results.map(r=>r.totalRuns))],farmingRunsMedian:median(results.map(r=>r.farmingRuns)),farmingRunsMax:Math.max(...results.map(r=>r.farmingRuns)),combatMinutesMedian:median(results.map(r=>r.seconds))/60,chapters:data.chapters.map((c,i)=>{
  const observations=results.map(r=>r.chapters[i]).filter(Boolean);
  return {chapter:i+1,hp:c.hp,bossHP:c.boss.hp,chapterJump:i?c.hp/data.chapters[i-1].hp:1,entryPowerMedian:median(observations.map(o=>o.entryPower)),damageToInnerHPMedian:median(observations.map(o=>o.damageToInnerHP)),firstThreeShotsKillsMedian:median(observations.map(o=>o.firstShots.reduce((n,s)=>n+s.kills,0))),firstRunClearPercentMedian:median(observations.map(o=>o.firstRun.clearPercent)),firstRunCoinsMedian:median(observations.map(o=>o.firstRun.coins)),runsInChapterMedian:median(observations.map(o=>o.completedRun-o.entryRun+1)),runsInChapterRange:[Math.min(...observations.map(o=>o.completedRun-o.entryRun+1)),Math.max(...observations.map(o=>o.completedRun-o.entryRun+1))],ranksGainedMedian:median(observations.map(o=>o.completedRanks-o.entryRanks)),bossChallengeRunsMedian:median(observations.map(o=>o.challengeRuns)),bossChallengeRunsRange:[Math.min(...observations.map(o=>o.challengeRuns)),Math.max(...observations.map(o=>o.challengeRuns))],firstBossVictoryCount:observations.filter(o=>o.challengeRuns===1).length};
})};
const report={generatedAt:new Date().toISOString(),variant,factors,strategy:'Real Game simulation, full-power geometric aim, initial power/kinetic/idle then cheapest eligible research; zero-kill frontier runs trigger two earlier-region farming runs. Each boss must die to physical contact with the remaining launch budget. No free money, granted research or forced boss summons.',summary,results};
const output=new URL(`../reports/chapter-growth-${variant==='current'?'balance':variant in variants?variant:'candidate'}.json`,import.meta.url);
if(variant==='current') {
  if(fs.existsSync(output)) {
    const previous=JSON.parse(fs.readFileSync(output,'utf8'));
    report.comparison=previous.comparison; report.notes=previous.notes;
  }
  report.parameters={chapterHP:data.chapters.map(c=>c.hp),bossHP:data.chapters.map(c=>c.boss.hp),percentDamageScale:data.chapters.map(c=>c.percentDamageScale??1),bossDirectDamageMultipliers:data.chapters.map(c=>c.boss.directDamageMultiplier??data.boss.directDamageMultiplier)};
  report.sourceVerification={victories:results.reduce((count,r)=>count+r.runs.filter(run=>run.bossDefeated).length,0),allVictoriesHadRealBallContacts:results.every(r=>r.runs.filter(run=>run.bossDefeated).every(run=>run.bossDirectHits>0)),allFrontierFirstRunsEarnedResources:results.every(r=>r.chapters.every(c=>c.firstRun.coins>0)),requiredEarlierRegionFarmingRuns:results.reduce((sum,r)=>sum+r.farmingRuns,0)};
  report.rerun=`node scripts/chapter-growth-check.mjs current ${samples}`;
}
fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify(summary,null,2));
assert.equal(summary.completed,samples,'A candidate stranded a normal progression route');
