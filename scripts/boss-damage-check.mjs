import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Game, createProfile, sanitizeProfile } from '../src/game.js';

const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const fraction = data.boss.clearDamageFraction;
assert.equal(fraction, .01, 'Clearing a small block must remove 1% of current boss health');
const close = (actual, expected, message) => assert(Math.abs(actual - expected) <= Math.max(1e-10, Math.abs(expected) * 1e-11), `${message}: ${actual} != ${expected}`);

function chamber({ awake = true, chapter = 0 } = {}) {
  const profile = createProfile();
  profile.chapter = chapter;
  profile.upgrades = { power: 4, kinetic: 8 };
  const game = new Game(data, profile, 9351);
  game.blocks = [];
  game.reindex();
  game.portals = [];
  game.position = { x: 100, y: data.physics.size / 2 };
  assert(game.spawnBoss(true));
  if (awake) game.tick(game.bossRules.wakeDuration + .05);
  game.events = [];
  return game;
}

function small(game, id, type = 'normal', hp = 10, native = true) {
  const gx = 12 + id % 3, gy = 8 + Math.floor(id / 3);
  const block = { id, gx, gy, x: gx * 32, y: gy * 32, ring: 4, tier: 0, hp, maxHP: hp, type, supply: type === 'elite' ? 'overdrive' : 'boost', native, loot: 1, alive: true };
  game.blocks.push(block);
  game.grid.set(id, block);
  return block;
}

const source = (game, main = true) => game.makeBall(400, 304, 0, game.stats.energy, main);

// Damage that leaves a brick standing, and repeating a dead target, must not
// erode the boss. Both native and generated boxes have the same kill rule.
const individual = chamber();
const player = source(individual), split = source(individual, false);
let expected = individual.boss.hp;
for (const [i, type] of ['normal', 'gold', 'core', 'elite'].entries()) {
  const block = small(individual, i, type, 10, i !== 1);
  individual.damage(block, 4, split, true, 'shock');
  close(individual.boss.hp, expected, `A damaged ${type} counted as destroyed`);
  assert(individual.damage(block, 6, split, true, 'shock'));
  expected *= 1 - fraction;
  close(individual.boss.hp, expected, `${type} did not remove current-health damage`);
  assert.equal(individual.damage(block, 1e12, player), false);
  close(individual.boss.hp, expected, 'A dead box was counted twice');
}
assert.equal(individual.combo, 0, 'A split without splitCombo unexpectedly gained combo');
close(individual.run.bossDamage, individual.boss.maxHP - expected, 'Boss damage accounting lost clear damage');
assert.equal(individual.run.bossChipKills, 4);
assert.equal(individual.run.bossDirectHits, 0);
assert.equal(individual.events.filter(event => event.type === 'bosschip').length, 4, 'A cleared box emitted duplicate or missing weakening feedback');
assert.equal(individual.events.filter(event => event.type === 'hit' && event.id === individual.boss.id).length, 0, 'Remote weakening masqueraded as physical impact feedback');

// The spawn animation is not a free opening for remote attacks or clear damage.
const waking = chamber({ awake: false });
const wakeHP = waking.boss.hp;
waking.damage(small(waking, 0), 10, source(waking));
waking.damage(waking.boss, 1e15, source(waking), true, 'finale');
waking.damage(waking.boss, 1e15, source(waking));
assert.equal(waking.boss.hp, wakeHP);
assert.equal(waking.boss.phase, 'waking');

// All existing indirect routes converge on Game.damage(area=true), including
// damage stored by older flying saves. A clearless remote hit does nothing.
const remote = chamber();
for (const tech of ['shock', 'bomb', 'beam', 'finale', 'arc', 'rift', 'riftEcho', 'riftCollapse', 'starSalvo', 'constellation', 'tether', 'return']) {
  remote.damage(remote.boss, remote.boss.maxHP * 100, source(remote), true, tech);
  assert.equal(remote.boss.hp, remote.boss.maxHP, `${tech} directly damaged the boss`);
}
remote.damage(remote.boss, 1e15, { ...source(remote), synthetic: true });
assert.equal(remote.boss.hp, remote.boss.maxHP, 'A synthetic projectile bypassed the direct-impact gate');
assert.equal(remote.events.filter(event => event.type === 'bosshit' || event.type === 'bossdefeat').length, 0, 'An immune hit emitted false boss damage feedback');

// Use the real explosion recursion: every little bomb explodes into its still
// living neighbours and the giant block, yet only each destroyed box counts.
const chained = chamber();
for (let id = 0; id < 6; id++) small(chained, id, 'bomb', .1);
const beforeChain = chained.boss.hp;
chained.blast(416, 304, source(chained), 100, 200, true);
assert.equal(chained.blocks.filter(block => block.type !== 'boss' && !block.alive).length, 6);
close(chained.boss.hp, beforeChain * (1 - fraction) ** 6, 'Explosion recursion applied extra or omitted weakening');
assert.equal(chained.run.bossChipKills, 6);
assert.equal(chained.run.bossDirectDamage, 0);
assert(!chained.run.bossDefeated);

// Clearing the rest of a complete generated map cannot be the winning move,
// even when the boss was already below one health point.
const fullProfile = createProfile();
const cleared = new Game(data, fullProfile, 3389);
assert(cleared.spawnBoss(true));
cleared.tick(cleared.bossRules.wakeDuration + .05);
cleared.boss.hp = .25;
const boxes = cleared.blocks.filter(block => block.alive && block.type !== 'boss');
for (const block of boxes) { block.type = 'normal'; block.hp = block.maxHP = 1; }
for (const block of boxes) cleared.damage(block, 1, source(cleared), true, 'constellation');
close(cleared.boss.hp, .25 * (1 - fraction) ** boxes.length, 'Clearing did not compound on remaining health');
assert(cleared.boss.alive && !cleared.run.bossDefeated && !cleared.goalComplete);
assert.equal(cleared.blocks.filter(block => block.alive && block.type !== 'boss').length, 0);

// Real ball contact still supplies the finishing blow, for main and split
// balls. A ball moving away from a face cannot repeat that hit.
for (const main of [true, false]) {
  const direct = chamber();
  direct.boss.rotation = 0;
  const center = direct.boss.x + 16;
  const ball = direct.makeBall(center - direct.boss.size / 2 - data.physics.radius / 2, direct.boss.y + 16, 0, direct.stats.energy, main);
  const before = direct.boss.hp;
  assert(direct.collideBoss(ball, direct.boss));
  const expectedDamage = direct.stats.damage * direct.runPower * (main ? 1 : data.mechanics.splitDamage) * direct.bossRules.directDamageMultiplier;
  close(before - direct.boss.hp, expectedDamage, `${main ? 'Main' : 'Split'} physical contact damage changed`);
  assert(ball.dx < 0, 'A direct boss collision failed to reflect the ball');
  const after = direct.boss.hp;
  direct.collideBoss(ball, direct.boss);
  assert.equal(direct.boss.hp, after, 'A reflected ball double-hit the same face');
  direct.boss.hp = expectedDamage / 2;
  ball.x = center - direct.boss.size / 2 - data.physics.radius / 2;
  ball.dx = 1;
  assert(direct.collideBoss(ball, direct.boss));
  assert(direct.run.bossDefeated && !direct.boss.alive, 'A physical finishing blow did not win');
  assert.equal(direct.run.bossDirectHits, 2);
  assert.equal(direct.events.filter(event => event.type === 'bossdefeat').length, 1);
}

// Resume an already-flying save without adding a rules-version flag. The old
// snapshot must inherit the new gate and still match uninterrupted simulation.
const flying = chamber();
small(flying, 0);
small(flying, 1);
assert(flying.launch(0, 1));
flying.star.volley = [{ x: 50, y: 304, tx: 304, ty: 304, targetId: flying.boss.id, left: .02, duration: .2, damage: 1e15, baseDamage: 1e15, hpDamage: .1, tech: 'starSalvo' }];
const oldSnapshot = flying.snapshot();
for (const key of ['bossChipDamage', 'bossDirectDamage', 'bossChipKills', 'bossDirectHits']) delete oldSnapshot.run[key];
const resumed = new Game(data, sanitizeProfile(structuredClone(flying.profile), data), 1);
assert(resumed.restore(structuredClone(oldSnapshot)));
for (const game of [flying, resumed]) {
  const before = game.boss.hp;
  game.damage(game.boss, 1e15, game.balls[0], true, 'starSalvo');
  assert.equal(game.boss.hp, before, 'A resumed old remote attack bypassed the boss gate');
  game.damage(game.blocks.find(block => block.id === 0), 10, game.balls[0], true, 'rift');
  close(game.boss.hp, before * (1 - fraction), 'Old flying save skipped current-health weakening');
  game.updateStar(.03);
  assert(!game.blocks.find(block => block.id === 1).alive, 'An old boss-targeted bolt failed to retarget a small block');
  close(game.boss.hp, before * (1 - fraction) ** 2, 'Old boss-targeted projectile dealt more than its one retargeted clear');
}
for (let frame = 0; frame < 90; frame++) { flying.tick(data.physics.step); resumed.tick(data.physics.step); }
assert.deepEqual(resumed.snapshot(), flying.snapshot(), 'Boss rules diverged across in-flight save/resume');
assert(flying.run.bossDamage > flying.boss.maxHP * fraction, 'The launched ball never reached the boss after resume');

console.log(JSON.stringify({ currentHealthWeakening: 'pass', survivingAndRepeatedHits: 'pass', splitWithoutCombo: 'pass', wakingProtection: 'pass', indirectSourceGate: 'pass', realExplosionChain: 'pass', fullMapCannotFinish: 'pass', physicalMainAndSplitFinish: 'pass', oldFlightResume: 'pass', clearedBoxes: boxes.length }, null, 2));
