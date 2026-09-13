import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Container, Graphics } from 'pixi.js';
import { Game, createProfile } from '../src/game.js';
import { Renderer } from '../src/renderer.js';
import { GameAudio } from '../src/audio.js';

const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const audioConfig = JSON.parse(fs.readFileSync(new URL('../src/data/audio.json', import.meta.url), 'utf8'));
const visual = data.boss.visual;
globalThis.document = { hidden: false }; // Visibility input only; no DOM or audio device is created.

function chamber(chapter) {
  const profile = createProfile();
  profile.chapter = chapter;
  profile.settings.sound = profile.settings.particles = false;
  const game = new Game(data, profile, 913);
  // Isolated diagnostic arena; no browser, player save, or campaign rewards.
  game.blocks = []; game.reindex(); game.events = [];
  game.spawnBoss(true); game.tick(data.boss.wakeDuration + .05); game.events = [];
  // Real drawing commands and view lifecycle, without creating a DOM/GPU application.
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    game, audio: new GameAudio(audioConfig), blockLayer: new Container(), blockViews: new Map(), bossBackdrop: new Graphics(),
    rings: [], floaters: [], comboTexts: [], cashFlights: new Set(), particles: [],
    mechanismSeen: new Set(), reducedMotion: { matches: false }, updateComboSpectrum() {}, warmCombo() {}
  });
  renderer.rebuild();
  return { game, renderer, boss: game.boss };
}

function paintedFills(view) {
  return view.body.context.instructions.filter(i => i.action === 'fill').map(i => ({
    color: i.data.style.color,
    side: i.data.path.instructions.find(p => p.action === 'rect').data[2]
  }));
}
function geometry(game) {
  return { x: game.boss.x, y: game.boss.y, rotation: game.boss.rotation,
    position: { ...game.position }, origin: { ...game.launchOrigin } };
}
function deliver(game, renderer) { renderer.events(game.events.splice(0)); }
function hit(game, dx, dy, area = false, amount = game.boss.maxHP * 1e-8) {
  const boss = game.boss;
  game.damage(boss, amount, { main: true, x: boss.x + 16 - dx * 100,
    y: boss.y + 16 - dy * 100, dx, dy }, area);
}

// Inspect actual Pixi fill paths: fixed colored bands and one linear white hole.
for (let chapter = 0; chapter < data.chapters.length; chapter++) {
  const { game, renderer, boss } = chamber(chapter), view = renderer.blockViews.get(boss.id);
  const bands = paintedFills(view), originalGeometry = geometry(game);
  assert(bands.every(p => p.color !== 0xffffff), 'Healthy boss has a false white damage core');
  for (const damage of [.1, .25, .5, .9]) {
    // Later guardians amplify direct contact; target the same actual HP loss in every chapter.
    hit(game, 1, 0, false, (boss.hp - boss.maxHP * (1 - damage)) / game.bossRules.directDamageMultiplier);
    deliver(game, renderer); renderer.updateBossBody(view);
    const painted = paintedFills(view), hole = painted.at(-1);
    assert.equal(hole.color, 0xffffff);
    assert(Math.abs(hole.side - boss.size * visual.hollowMax * damage) < 1e-8, 'White hole is not proportional to damage');
    assert.deepEqual(painted.slice(0, -1), bands, 'Damage moved the palette bands');
    assert.deepEqual(geometry(game), originalGeometry, 'Drawing moved the physical boss');
  }
  renderer.blockLayer.destroy({ children: true }); renderer.bossBackdrop.destroy(); renderer.audio.destroy();
}

const { game, renderer, boss } = chamber(0);
let view = renderer.blockViews.get(boss.id);
const nominal = geometry(game), x = boss.x + 16, y = boss.y + 16;
hit(game, 0, 1, true, boss.maxHP * .0001);
hit(game, 1, 0);
deliver(game, renderer); renderer.updateBossBody(view, .045);
assert(view.container.x > x && view.container.y === y, 'Direct contact lost its recoil direction');

let peak = 0, maxStep = 0, previous = { x: view.container.x, y: view.container.y };
const step = 1 / 120, frameCount = 180, hitsPerFrame = 200;
for (let frame = 0; frame < frameCount; frame++) {
  for (let i = 0; i < hitsPerFrame; i++) hit(game, frame % 2 ? 1 : -1, i % 3 === 0 ? .2 : 0, i % 2 === 0);
  deliver(game, renderer); renderer.updateBossBody(view, step);
  const next = { x: view.container.x, y: view.container.y };
  peak = Math.max(peak, Math.hypot(next.x - x, next.y - y));
  maxStep = Math.max(maxStep, Math.hypot(next.x - previous.x, next.y - previous.y));
  previous = next;
  assert.deepEqual(geometry(game), nominal);
  assert.equal(view.container.rotation, boss.rotation);
}
assert(peak > visual.punchDistance * .5, 'Dense hits suppressed the visible recoil');
assert(peak <= visual.punchDistance, 'Recoil exceeded its configured bound');
assert(maxStep < visual.punchDistance * Math.PI * 2 * step / visual.punchDuration * 1.1 + .1, 'Dense hits caused a position jump');

game.paused = true;
const frozen = { x: view.container.x, y: view.container.y, punch: view.punch };
game.tick(.5); renderer.updateBossBody(view, .5);
assert.deepEqual({ x: view.container.x, y: view.container.y, punch: view.punch }, frozen);
game.paused = false; renderer.updateBossBody(view, 1);
assert.equal(view.container.x, x); assert.equal(view.container.y, y);

for (const setting of ['reducedEffects', 'system']) {
  hit(game, -1, 0); deliver(game, renderer);
  game.profile.settings.reducedEffects = setting === 'reducedEffects';
  renderer.reducedMotion.matches = setting === 'system';
  renderer.updateBossBody(view, .04);
  assert.equal(view.container.x, x); assert.equal(view.container.y, y); assert.equal(view.punch, 0);
}
game.profile.settings.reducedEffects = false; renderer.reducedMotion.matches = false;
hit(game, 1, 0); deliver(game, renderer); renderer.updateBossBody(view, .03);
renderer.rebuild(); view = renderer.blockViews.get(boss.id);
assert.equal(view.punch, 0); assert.equal(view.container.x, x); assert.equal(view.container.y, y);
assert.deepEqual(geometry(game), nominal);

console.log(JSON.stringify({ chapters: data.chapters.length, paintedHole: 'linear 10/25/50/90%; fixed palette bands',
  realDamageEvents: frameCount * hitsPerFrame, peakOffset: +peak.toFixed(3), maxFrameStep: +maxStep.toFixed(3),
  directionPauseGentleRebuildPhysics: 'pass' }, null, 2));
renderer.blockLayer.destroy({ children: true }); renderer.bossBackdrop.destroy(); renderer.audio.destroy();
