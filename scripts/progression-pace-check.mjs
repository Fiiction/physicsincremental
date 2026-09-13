import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Game, createProfile, upgradeStatus, upgradeCost } from '../src/game.js';

// Compare real campaigns on identical physics, seeds, aim and spending decisions.
// The baseline is the configuration saved before the September 14 balance pass.
const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const mode = process.argv[2] || 'current', samples = Number(process.argv[3] || 12);
const gameSha256 = createHash('sha256').update(fs.readFileSync(new URL('../src/game.js', import.meta.url))).digest('hex');
const baseline = read('../reports/progression-pace-baseline-data.json');
const data = mode === 'baseline' || mode === 'proposal' ? structuredClone(baseline) : read('../src/data/balance.json');
for (const u of data.upgrades) assert.equal(u.levelDescriptions.length, u.max, `${u.id} has ranks without an explanation`);
if (mode === 'proposal') data.chapters.forEach((c, i) => {
  c.hp *= [1, 2.5, 5, 10, 20][i]; c.reward *= [1, 2.5, 5, 10, 20][i];
  c.boss.hp *= [2, 3, 4, 10, 20][i]; c.boss.percentDamageHP = c.boss.hp * .005;
});
const median = ns => ns.length ? ns.slice().sort((a,b) => a-b)[Math.floor(ns.length/2)] : null;
const round = x => Math.round(x * 100) / 100;
const results = [];
for (let i = 0; i < samples; i++) {
  const seed = 17 + i * 7919, g = new Game(data, createProfile(), seed), runs = [], purchases = [], chapters = [];
  let shots = 0, guard = 0, farmStreak = 0;
  const buy = () => {
    const purchase = id => { const cost = upgradeCost(data, g.profile, id); assert(g.buy(id)); purchases.push({run:g.profile.runs, chapter:g.profile.chapter+1, id, rank:g.level[id], cost}); };
    for (const [id,target] of [['power',1],['kinetic',1],['idle',1]]) while ((g.level[id]||0) < target) {
      if (upgradeStatus(data,g.profile,id) !== 'available') return;
      purchase(id);
    }
    while (true) {
      const next = data.upgrades.filter(u => upgradeStatus(data,g.profile,u.id)==='available').sort((a,b) => upgradeCost(data,g.profile,a.id)-upgradeCost(data,g.profile,b.id))[0];
      if (!next) return;
      purchase(next.id);
    }
  };
  while (!g.profile.prestige && g.profile.runs < 110 && guard++ < 250000) {
    const chapter = g.profile.chapter;
    if (!chapters[chapter]) chapters[chapter] = {chapter:chapter+1, entryRun:g.profile.runs+1, entryPower:g.level.power||0, entryDamageToInnerHP:g.stats.damage/median(g.blocks.filter(b=>b.type==='normal'&&b.ring===2).map(b=>b.maxHP)), entryRanks:Object.values(g.level).reduce((a,b)=>a+b,0)};
    const progress = chapters[chapter];
    if (g.state === 'ended') {
      const run = {run:g.profile.runs,chapter:chapter+1,frontier:g.isFrontier,seconds:g.run.time,shots:g.run.shots,kills:g.run.kills,coins:g.run.coins,clearPercent:round(g.clearRatio*100),power:g.level.power||0,bossSpawned:!!g.run.bossSpawned,bossDefeated:!!g.run.bossDefeated,bossHPPercent:g.boss?round(100*g.boss.hp/g.boss.maxHP):null,bossDirectHits:g.run.bossDirectHits||0,bossFightSeconds:g.run.bossSpawned?g.run.time-g.run.bossStartedTime:0};
      runs.push(run); progress.firstRun ||= run;
      if (run.bossSpawned) progress.firstBossRun ||= run.run;
      const complete = g.goalComplete;
      if (complete) {
        assert(run.bossDefeated && run.bossDirectHits > 0, 'A chapter passed without boss contact');
        Object.assign(progress, {completedRun:run.run, bossChallengeRuns:run.run-progress.firstBossRun+1, completedPower:g.level.power||0});
      }
      const before = purchases.length; buy(); run.upgradesBought = purchases.length-before;
      if (complete) {
        const choices = data.relics.filter(r=>!g.profile.relics.includes(r.id));
        assert(g.advance(choices.length ? choices[i%choices.length].id : 'fusion'));
        assert(g.selectChapter(g.profile.frontierChapter)); if (!g.profile.prestige) buy();
      } else if (!g.isFrontier && ++farmStreak >= 2) { farmStreak=0; assert(g.selectChapter(g.profile.frontierChapter)); }
      else if (g.isFrontier && !g.run.kills && chapter>0) { farmStreak=0; assert(g.selectChapter(chapter-1)); }
      else g.newRun();
      g.events.length=0; continue;
    }
    if (g.state === 'ready') {
      if (g.goalComplete && g.run.shots) { g.endRun(); continue; }
      if (g.launch(g.autoAngle(),1,false)) shots++;
    }
    g.tick(.5); g.events.length=0;
  }
  const combatSeconds = runs.reduce((sum,r)=>sum+r.seconds,0);
  results.push({seed,completed:!!g.profile.prestige,totalRuns:g.profile.runs,combatSeconds,estimatedPlaySeconds:combatSeconds+shots*1.5+g.profile.runs*12,shots,farmingRuns:runs.filter(r=>!r.frontier).length,chapters,runs,purchases});
  console.log(JSON.stringify({mode,seed,completed:!!g.profile.prestige,runs:g.profile.runs,combatMinutes:round(combatSeconds/60),chapterRuns:chapters.map(c=>c.completedRun-c.entryRun+1),bossAttempts:chapters.map(c=>c.bossChallengeRuns)}));
}
const summary = {
  samples,completed:results.filter(r=>r.completed).length,totalRunsMedian:median(results.map(r=>r.totalRuns)),
  combatMinutesMedian:round(median(results.map(r=>r.combatSeconds))/60),estimatedPlayMinutesMedian:round(median(results.map(r=>r.estimatedPlaySeconds))/60),
  totalRunsRange:[Math.min(...results.map(r=>r.totalRuns)),Math.max(...results.map(r=>r.totalRuns))],
  farmingRunsMedian:median(results.map(r=>r.farmingRuns)),
  chapters:data.chapters.map((c,j)=> {
    const cs=results.map(r=>r.chapters[j]).filter(Boolean), rs=results.flatMap(r=>r.runs.filter(r=>r.chapter===j+1&&r.frontier));
    return {chapter:j+1,hp:c.hp,reward:c.reward,bossHP:c.boss.hp,runsMedian:median(cs.map(c=>c.completedRun-c.entryRun+1)),bossAttemptsMedian:median(cs.map(c=>c.bossChallengeRuns)),firstBossWinCount:cs.filter(c=>c.bossChallengeRuns===1).length,firstRunClearPercentMedian:median(cs.map(c=>c.firstRun?.clearPercent)),entryDamageToInnerHPMedian:median(cs.map(c=>c.entryDamageToInnerHP)),firstRunCoinsMedian:median(cs.map(c=>c.firstRun?.coins)),runsWithUpgradePercent:round(100*rs.filter(r=>r.upgradesBought>0).length/rs.length),upgradeRanksPerRunMedian:median(rs.map(r=>r.upgradesBought)),longestNoUpgradeStreak:Math.max(0,...results.map(r=> {let longest=0,current=0;for(const run of r.runs.filter(r=>r.chapter===j+1&&r.frontier)){current=run.upgradesBought?0:current+1;longest=Math.max(longest,current);}return longest;})),combatMinutesMedian:round(median(results.map(r=>r.runs.filter(r=>r.chapter===j+1).reduce((s,r)=>s+r.seconds,0)))/60)};
  })
};
const report={generatedAt:new Date().toISOString(),mode,gameSha256,dataSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),assumptions:'New save, no grants, real fixed-step Game. Full-power geometric aim; power 1, kinetic 1, idle 1, then cheapest available upgrade after each run and breakthrough. Two preceding-chapter farming runs only after zero-kill frontier runs. Relic choice rotates by seed. Boss challenge runs count every run from the first encounter through victory, including failed re-summons. Combat time is actual run clocks; estimated play adds 1.5 seconds of aiming per shot and 12 seconds shopping per run. Not a human playtime guarantee or unattended economy simulation.',summary,results};
if (mode === 'current') {
  const previous = read('../reports/progression-pace-baseline.json');
  assert.equal(previous.gameSha256, gameSha256, 'Baseline must be rerun on the same game implementation');
  assert.equal(previous.summary.samples, samples, 'Baseline and candidate need the same seeds');
  report.comparison = {baseline:previous.summary, combatTimeRatio:round(summary.combatMinutesMedian/previous.summary.combatMinutesMedian), estimatedPlayTimeRatio:round(summary.estimatedPlayMinutesMedian/previous.summary.estimatedPlayMinutesMedian), runsRatio:round(summary.totalRunsMedian/previous.summary.totalRunsMedian), pairedCombatRatioMedian:round(median(results.map((r,i)=>r.combatSeconds/previous.results[i].combatSeconds)))};
}
fs.writeFileSync(new URL(`../reports/progression-pace-${mode}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
assert.equal(summary.completed,samples,'Normal progression stalled');
