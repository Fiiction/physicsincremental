import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as gameModule from '../src/game.js';
import * as idleModule from '../src/idle.js';

// Execute the actual page lifecycle and actual worker with a controllable clock.
// DOM / Pixi are inert here; browser layout and interaction are checked separately.
const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const key = 'corebound.save.v1', startTime = 1_000_000;
const source = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL(`../src/${name}`, import.meta.url).href));
const { Game, createProfile } = gameModule;
function seedSave({ paused = false, auto = true } = {}) {
  const profile = createProfile(); profile.upgrades = { power: 2, kinetic: 2, idle: 1 };
  const game = new Game(data, profile, 886); game.auto = auto; game.paused = paused;
  return { profile: game.profile, run: game.snapshot(), savedAt: startTime };
}
function resume(saved) { const game = new Game(data, structuredClone(saved.profile)); game.restore(structuredClone(saved.run)); return game; }
function element() {
  const attributes = new Map();
  return { style: { setProperty() {} }, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { attributes.set(k, v); }, getAttribute(k) { return attributes.get(k); },
    addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; },
    showModal() { this.open = true; }, close() { this.open = false; }, animate() {}, focus() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 900, height: 900 }; },
    clientWidth: 900, clientHeight: 900, open: false };
}
async function page(saved, { now = startTime, hidden = false, focused = true, backgroundMarker = false } = {}) {
  let clock = now, nextTimer = 0;
  const timers = new Map(), elements = new Map(), workers = [], windowEvents = new Map();
  const storage = new Map([[key, JSON.stringify(saved)]]), session = new Map(backgroundMarker ? [[key + '.background', '1']] : []);
  const store = map => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) });
  const timeout = (fn, delay = 0, interval = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay, interval }); return id; };
  const environment = { console: { ...console, info() {} }, URL, structuredClone,
    Date: class extends Date { static now() { return clock; } }, performance,
    setTimeout: (fn, delay) => timeout(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timeout(fn, delay, delay), clearInterval: id => timers.delete(id),
    ...gameModule, ...idleModule, data };
  class Worker {
    constructor() {
      this.alive = true; this.packets = []; workers.push(this);
      const context = vm.createContext({ ...environment, self: {}, postMessage: packet => {
        const copy = structuredClone(packet); this.packets.push(copy);
        timeout(() => { if (this.alive) this.onmessage?.({ data: copy }); });
      } });
      vm.runInContext(source('idle-worker.js'), context); this.context = context;
    }
    postMessage(packet) { timeout(() => { if (this.alive) this.context.self.onmessage({ data: structuredClone(packet) }); }); }
    terminate() { this.alive = false; }
  }
  class Renderer {
    constructor(game) { this.game = game; this.app = { canvas: element() }; this.audio = { update() {}, ui() {} }; }
    async init() { return this; }
    rebuild() {} render() {} events() {} unlockAudio() {}
  }
  const document = { hidden, hasFocus: () => focused, documentElement: element(), body: element(),
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector() { return element(); }, querySelectorAll() { return []; }, addEventListener() {} };
  const context = vm.createContext({ ...environment, Worker, Renderer, document, navigator: {},
    window: { addEventListener(type, fn) { const list = windowEvents.get(type) || []; list.push(fn); windowEvents.set(type, list); } }, localStorage: store(storage), sessionStorage: store(session),
    requestAnimationFrame() {}, researchBranches: [], researchGroup() {}, researchScene() { return ''; },
    attachResearchCamera() {}, applyResearchCamera() {}, zoomResearch() {}, focusResearchNode() {} });
  vm.runInContext(source('main.js') + `\nglobalThis.sessionTest = { game: () => game, save, action, openModal, closeModal, onAction, syncBackground, checkpoint: () => background?.checkpoint };`, context);
  for (let guard = 0; !context.window.corebound && guard < 10; guard++) await Promise.resolve();
  assert(context.window.corebound, 'Page initialization did not finish');
  function flush() {
    for (let guard = 0; guard < 10000; guard++) {
      const due = [...timers].find(([, timer]) => timer.at <= clock);
      if (!due) return;
      const [id, timer] = due; timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: clock + timer.interval });
      timer.fn();
    }
    throw new Error('Lifecycle failed to drain current scheduled work');
  }
  flush();
  return { ...context.sessionTest, workers, elements, storage, session,
    flush, jump(ms) { clock += ms; }, wake(ms) { clock += ms; flush(); },
    advance(ms) { for (let left = ms; left > 0;) { const step = Math.min(left, data.idleRuntime?.intervalMs || 250); clock += step; left -= step; flush(); } },
    hide(value) { document.hidden = value; context.sessionTest.syncBackground(); flush(); },
    focus(value) { focused = value; for (const fn of windowEvents.get(value ? 'focus' : 'blur') || []) fn({ type: value ? 'focus' : 'blur' }); flush(); },
    saved() { return JSON.parse(storage.get(key)); }, marker() { return session.has(key + '.background'); } };
}
function compareProgress(actual, expected, label) {
  assert.equal(actual.profile.coins, expected.profile.coins, `${label}: duplicated / lost income`);
  assert.equal(actual.profile.runs, expected.profile.runs, `${label}: duplicated / lost run`);
  assert.equal(actual.run.shots, expected.run.shots, `${label}: duplicated / lost shot`);
  assert.equal(actual.run.kills, expected.run.kills, `${label}: different destroyed blocks`);
  assert.equal(actual.seed, expected.seed, `${label}: different random progression`);
}

const initial = seedSave(), menu = await page(initial);
menu.openModal('settings'); menu.save();
assert.equal(menu.saved().run.paused, false, 'Opening settings persisted an unintended manual pause');
menu.hide(true); menu.advance(20_000);
const firstLiveSave = menu.saved();
assert(firstLiveSave.run.run.shots > 0, 'Background made no real shots before returning to the page');
menu.advance(40_000);
assert(menu.saved().profile.earned > firstLiveSave.profile.earned, 'Income did not continue growing in the saved background checkpoints');
assert(menu.saved().profile.runs >= 1 && menu.saved().run.run.shots > 0, 'A failed background run did not automatically restart');
assert(menu.saved().run.run.drops > 0, 'Live background play never applied a real drop');
assert(menu.checkpoint().runtime.simulatedSeconds >= 59.99, 'Worker did not simulate continuously while away');
assert.equal(menu.checkpoint().runtime.interruptedSeconds, 0, 'Normal scheduler ticks were discarded');
menu.hide(false);
const oracle = resume(initial); idleModule.advanceElapsed(oracle, 60);
assert(oracle.profile.earned > 0, 'Fixture did not earn real idle income');
compareProgress(menu.game(), oracle, 'settings → background → foreground');
assert(menu.game().paused, 'Returning to an open menu resumed foreground physics');
menu.closeModal(); assert(!menu.game().paused, 'Closing settings failed to resume automatic play');
const oldPacket = menu.workers[0].packets[0];
menu.workers[0].onmessage({ data: { ...oldPacket, profile: { ...oldPacket.profile, coins: 99999999 } } });
compareProgress(menu.game(), oracle, 'late previous-worker packet');

const unfocusedMenu = await page(initial);
unfocusedMenu.openModal('settings'); unfocusedMenu.focus(false);
assert(unfocusedMenu.checkpoint(), 'Visible but unfocused menu did not start background mining');
for (let second = 0; second < 60; second++) { unfocusedMenu.wake(1000); unfocusedMenu.onAction('frame', .016); }
unfocusedMenu.focus(true);
compareProgress(unfocusedMenu.game(), oracle, 'visible settings → unfocused with live frames → focused');
assert(unfocusedMenu.game().paused, 'Regaining focus resumed physics behind settings');
unfocusedMenu.closeModal(); assert(!unfocusedMenu.game().paused, 'Closing settings did not resume after focus handoff');

const failedWorker = await page(initial);
failedWorker.openModal('settings'); failedWorker.hide(true); failedWorker.advance(10_000);
failedWorker.workers[0].onerror({ preventDefault() {} }); failedWorker.advance(50_000); failedWorker.hide(false); failedWorker.advance(250);
const fallbackOracle = resume(initial); idleModule.advanceElapsed(fallbackOracle, 60.25);
compareProgress(failedWorker.game(), fallbackOracle, 'worker failure → checkpoint fallback');
assert(failedWorker.game().paused, 'Worker fallback lost the still-open menu pause');

const paused = await page(seedSave({ paused: true }));
paused.openModal('settings'); paused.hide(true); paused.wake(60_000); paused.hide(false); paused.closeModal();
assert(paused.game().paused, 'Explicit manual pause was lost during menu handoff');
assert.equal(paused.game().profile.earned, 0, 'Manual pause earned background income');
const disabled = await page(seedSave({ auto: false }));
disabled.jump(60_000); disabled.action('auto'); disabled.flush();
assert.equal(disabled.game().profile.earned, 0, 'Enabling Auto paid time when Auto had been off');

const frozen = await page(initial, { now: startTime + 60_000, backgroundMarker: true });
compareProgress(frozen.game(), resume(initial), 'discarded tab reload must not pay missed time');
frozen.save();
const secondReload = await page(frozen.saved(), { now: startTime + 60_000, backgroundMarker: frozen.marker() });
compareProgress(secondReload.game(), resume(initial), 'same timestamp reload must not award twice');
const closed = await page(initial, { now: startTime + 60_000 });
assert.equal(closed.game().profile.earned, 0, 'Ordinary closed-page time was paid as an active hidden session');
const frozenLive = await page(initial); frozenLive.hide(true); frozenLive.wake(60_000);
assert.equal(frozenLive.checkpoint().runtime.simulatedSeconds, 0, 'Frozen interval was simulated on wakeup');
assert.equal(frozenLive.checkpoint().runtime.interruptedSeconds, 60, 'Frozen interval was not recorded as skipped');
assert.equal(frozenLive.saved().profile.earned, 0, 'Frozen interval paid income');
frozenLive.advance(60_000); frozenLive.hide(false);
compareProgress(frozenLive.game(), oracle, 'normal live ticks resume without old time debt');

const stoppedFrames = await page(initial);
stoppedFrames.jump(60_000); stoppedFrames.onAction('frame', .016); stoppedFrames.flush();
assert.equal(stoppedFrames.game().profile.earned, 0, 'Stopped animation frames received delayed income');
assert.equal(stoppedFrames.game().run.shots, 0, 'Stopped animation frames replayed missed shots');
const hiddenStartup = await page(initial, { hidden: true });
hiddenStartup.advance(60_000); hiddenStartup.hide(false);
compareProgress(hiddenStartup.game(), oracle, 'initially hidden page');
const choiceSave = seedSave(); choiceSave.profile.pendingChapterSelection = true; choiceSave.run.state = 'ended';
const choosing = await page(choiceSave, { now: startTime + 60_000, backgroundMarker: true });
choosing.hide(true); choosing.wake(60_000); choosing.hide(false);
assert(choosing.game().pendingChapterSelection, 'Background play skipped the required chapter choice');
assert.equal(choosing.game().profile.earned, 0, 'Pending chapter selection earned idle income');

const report = { generatedAt: new Date().toISOString(), actualPageAndWorker: 'pass',
  menuPausePersistence: 'pass', hiddenMenuIncome: 'pass', manualPause: 'pass', staleWorkerPacket: 'pass',
  visibleUnfocusedMenuWithLiveFrames: 'pass',
  failedWorkerFallback: 'pass', noRetroactiveAutoIncome: 'pass',
  savesGrowWhileAway: 'pass', normalContinuousWorkerTicks: 'pass',
  failedRunAutoRestartAndDrops: 'pass',
  discardedSessionNoReplay: 'pass', frozenIntervalSkippedAndLiveResume: 'pass', duplicateReload: 'pass', ordinaryClosedPage: 'pass',
  stoppedAnimationFramesNoReplay: 'pass', hiddenStartup: 'pass', explicitChapterChoice: 'pass', minuteIncome: oracle.profile.earned };
fs.writeFileSync(new URL('../reports/idle-session-check.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
