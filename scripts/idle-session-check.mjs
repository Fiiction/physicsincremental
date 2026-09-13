import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as gameModule from '../src/game.js';
import * as idleModule from '../src/idle.js';

// Actual page, scheduler, clock worker and physics with a controlled clock.
// Renderer calls are observed, not drawn; real playback / GPU / throttling need browser QA.
const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const key = 'corebound.save.v1', startTime = 1_000_000;
const source = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(new URL(`../src/${name}`, import.meta.url).href));
const { Game, createProfile } = gameModule;
function seedSave({ paused = false, auto = true } = {}) {
  const profile = createProfile(); profile.upgrades = { power: 2, kinetic: 2, idle: 1 };
  const game = new Game(data, profile, 886); game.auto = auto; game.paused = paused;
  return { profile: game.profile, run: game.snapshot(), savedAt: startTime };
}
function resume(saved) { const game = new Game(data, structuredClone(saved.profile)); assert(game.restore(structuredClone(saved.run))); return game; }
function element() {
  const attributes = new Map();
  return { style: { setProperty() {} }, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '',
    setAttribute(k, v) { attributes.set(k, v); }, getAttribute(k) { return attributes.get(k); },
    addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; },
    showModal() { this.open = true; }, close() { this.open = false; }, animate() {}, focus() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 900, height: 900 }; },
    clientWidth: 900, clientHeight: 900, open: false };
}
async function page(saved, { now = startTime, hidden = false, focused = true, workerAvailable = true } = {}) {
  let clock = now, nextTimer = 0, animationEnabled = !hidden;
  const timers = new Map(), animations = new Map(), elements = new Map(), workers = [], windowEvents = new Map(), documentEvents = new Map();
  const storage = new Map([[key, JSON.stringify(saved)]]), session = new Map([[key + '.background', '1']]);
  const observation = { draws: 0, renders: 0, rebuilds: 0, seconds: 0, events: {}, audioUpdates: 0, frameObserver: null };
  const store = map => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) });
  const timeout = (fn, delay = 0, interval = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + Math.max(.001, delay), interval }); return id; };
  const addEvent = (map, type, fn) => { const list = map.get(type) || []; list.push(fn); map.set(type, list); };
  const environment = { console: { ...console, info() {}, warn() {} }, URL, structuredClone,
    Date: class extends Date { static now() { return clock; } }, performance: { now: () => clock },
    setTimeout: (fn, delay) => timeout(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timeout(fn, delay, delay), clearInterval: id => timers.delete(id),
    ...gameModule, ...idleModule, data };
  class Worker {
    constructor(url) {
      if (!workerAvailable) throw new Error('Worker unavailable in this fixture');
      assert.equal(new URL(url).pathname.split('/').at(-1), 'clock-worker.js', 'A state-owning background worker was started');
      this.alive = true; this.messages = []; workers.push(this);
      const context = vm.createContext({ ...environment, self: {},
        setTimeout: (fn, delay) => timeout(() => { if (this.alive) fn(); }, delay),
        postMessage: packet => { this.messages.push(packet); timeout(() => { if (this.alive) this.onmessage?.({ data: packet }); }); } });
      vm.runInContext(source('clock-worker.js'), context); this.context = context;
    }
    postMessage(packet) { this.messages.push(packet); timeout(() => { if (this.alive) this.context.self.onmessage({ data: packet }); }); }
    terminate() { this.alive = false; }
  }
  class Renderer {
    constructor(game) {
      this.game = game; this.app = { canvas: element(), render() { observation.draws++; } };
      this.audio = { update() { observation.audioUpdates++; }, ui() {} };
    }
    async init() { return this; }
    rebuild() { observation.rebuilds++; }
    render(dt) { observation.renders++; observation.seconds += dt; observation.frameObserver?.(dt); }
    events(events) { for (const event of events) observation.events[event.type] = (observation.events[event.type] || 0) + 1; }
    unlockAudio() {}
  }
  const document = { hidden, hasFocus: () => focused, documentElement: element(), body: element(),
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector() { return element(); }, querySelectorAll() { return []; }, addEventListener(type, fn) { addEvent(documentEvents, type, fn); } };
  const context = vm.createContext({ ...environment, Worker, Renderer, document, navigator: {},
    window: { addEventListener(type, fn) { addEvent(windowEvents, type, fn); } }, localStorage: store(storage), sessionStorage: store(session),
    requestAnimationFrame(fn) { const id = ++nextTimer; animations.set(id, { fn, at: clock + 1000 / 60 }); return id; },
    cancelAnimationFrame(id) { animations.delete(id); }, researchBranches: [], researchGroup() {}, researchScene() { return ''; },
    attachResearchCamera() {}, applyResearchCamera() {}, zoomResearch() {}, focusResearchNode() {} });
  vm.runInContext(source('frame-loop.js') + '\n' + source('main.js') + '\nglobalThis.sessionTest = { game: () => game, save, action, openModal, closeModal, onAction, loop: () => loop };', context);
  for (let guard = 0; !context.window.corebound && guard < 10; guard++) await Promise.resolve();
  assert(context.window.corebound, 'Page initialization did not finish');
  function flush() {
    for (let guard = 0; guard < 10000; guard++) {
      const due = [...timers].find(([, timer]) => timer.at <= clock);
      if (due) {
        const [id, timer] = due; timers.delete(id);
        if (timer.interval) timers.set(id, { ...timer, at: clock + timer.interval });
        timer.fn(); continue;
      }
      const animation = animationEnabled && [...animations].find(([, timer]) => timer.at <= clock);
      if (!animation) return;
      animations.delete(animation[0]); animation[1].fn(clock);
    }
    throw new Error('Frame scheduling failed to drain current work');
  }
  function advance(ms) {
    const target = clock + ms;
    while (clock < target) {
      const next = Math.min(target, ...[...timers.values(), ...(animationEnabled ? animations.values() : [])].map(timer => timer.at));
      clock = Math.max(clock, next); flush();
    }
  }
  const dispatch = (map, type) => { for (const fn of map.get(type) || []) fn({ type }); };
  flush();
  return { ...context.sessionTest, workers, elements, observation, storage,
    flush, advance, wake(ms) { clock += ms; flush(); },
    animations(value) { animationEnabled = value; },
    hide(value) { document.hidden = value; animationEnabled = !value; dispatch(documentEvents, 'visibilitychange'); flush(); },
    focus(value) { focused = value; dispatch(windowEvents, value ? 'focus' : 'blur'); flush(); },
    saved() { return JSON.parse(storage.get(key)); }, state() { return context.window.corebound.getState(); },
    destroy() { context.sessionTest.loop().stop(); } };
}
function compareProgress(actual, expected, label) {
  assert.equal(actual.profile.coins, expected.profile.coins, `${label}: duplicated / lost income`);
  assert.equal(actual.profile.runs, expected.profile.runs, `${label}: duplicated / lost run`);
  assert.equal(actual.run.shots, expected.run.shots, `${label}: duplicated / lost shot`);
  assert.equal(actual.run.kills, expected.run.kills, `${label}: different destroyed blocks`);
  assert.equal(actual.seed, expected.seed, `${label}: different random progression`);
}
function noHandoff(page, identity) {
  assert.equal(page.game(), identity, 'Presence changes replaced the live Game');
  assert.equal(page.observation.rebuilds, 0, 'Presence changes rebuilt the scene');
  assert(!/idle-sync|恢复后台进度|spinner/.test(page.elements.get('arena-overlay').innerHTML), 'The return path displayed a loading handoff');
  assert.equal(page.state().execution, 'continuous');
  assert(page.workers.every(worker => worker.messages.every(packet => typeof packet === 'number' || ['ack', 'frame'].includes(packet))), 'Clock worker transferred game state');
}

const initial = seedSave(), continuous = await page(initial), identity = continuous.game(), oracle = resume(initial);
continuous.observation.frameObserver = dt => { oracle.tick(dt); oracle.events.length = 0; };
continuous.advance(2000); continuous.focus(false); continuous.advance(2000); continuous.hide(true);
const beforeHidden = continuous.observation.draws;
continuous.advance(60_000); const firstLiveSave = continuous.saved();
assert(firstLiveSave.profile.earned > 0, 'No real income was saved before returning');
continuous.advance(240_000);
const incomeBeforeReturn = continuous.game().profile.earned, drawBeforeReturn = continuous.observation.draws;
assert(continuous.saved().profile.earned > firstLiveSave.profile.earned, 'Saved income did not keep growing while away');
assert(continuous.game().profile.runs > 1 && continuous.observation.events.drop > 0 && continuous.observation.events.runend > 1, 'Automatic play did not receive drops and continue after failed runs');
assert(drawBeforeReturn - beforeHidden > 8500, 'Hidden frames were not sent through the renderer');
assert.equal(continuous.observation.renders, continuous.observation.draws, 'Scene updates and actual render calls diverged');
assert(Math.abs(continuous.observation.seconds - 304) < .1, 'RAF and timer clocks duplicated or lost ordinary elapsed time');
continuous.hide(false); continuous.focus(true);
assert.equal(continuous.game().profile.earned, incomeBeforeReturn, 'Returning paid additional catch-up income');
compareProgress(continuous.game(), oracle, 'Five minutes of live frames'); noHandoff(continuous, identity); continuous.destroy();

const manual = await page(seedSave({ auto: false })), manualIdentity = manual.game();
manual.onAction('launch', { angle: .4, power: 1 }); manual.advance(50);
const shotBefore = manual.game().shotTime, drawsBefore = manual.observation.draws;
manual.focus(false); manual.hide(true); manual.advance(700);
assert(manual.game().shotTime > shotBefore, 'A manually launched ball stopped when Auto was off and the page lost focus');
assert(manual.observation.draws > drawsBefore, 'Manual hidden flight stopped rendering');
manual.hide(false); manual.focus(true); noHandoff(manual, manualIdentity); manual.destroy();

const menu = await page(initial); menu.openModal('settings'); menu.save();
assert.equal(menu.saved().run.paused, false, 'Opening settings persisted an unintended manual pause');
assert(!menu.game().paused, 'The menu paused enabled automatic play');
menu.advance(30_000); const menuFirst = menu.game().profile.earned;
menu.focus(false); menu.hide(true); menu.advance(30_000); menu.hide(false); menu.focus(true);
assert(menu.game().profile.earned > menuFirst, 'Automatic play stopped behind the menu');
assert(!menu.game().paused, 'Returning changed the menu Auto policy'); menu.closeModal(); assert(!menu.game().paused); menu.destroy();

const paused = await page(seedSave({ paused: true })); paused.openModal('settings'); paused.hide(true); paused.advance(60_000); paused.hide(false); paused.closeModal();
assert(paused.game().paused, 'Explicit manual pause was lost'); assert.equal(paused.game().profile.earned, 0, 'Manual pause earned income');
assert(paused.observation.draws > 100, 'Intentional pause prevented the scene from rendering'); paused.destroy();
const manualMenu = await page(seedSave({ auto: false })); manualMenu.openModal('settings');
assert(manualMenu.game().paused, 'A nonautomatic game did not pause in its menu'); manualMenu.hide(true); manualMenu.advance(10_000); manualMenu.hide(false); manualMenu.closeModal();
assert(!manualMenu.game().paused, 'Closing the menu did not restore the player pause state'); manualMenu.destroy();

const disabled = await page(seedSave({ auto: false })); disabled.hide(true); disabled.advance(60_000); disabled.hide(false); disabled.action('auto');
assert.equal(disabled.game().profile.earned, 0, 'Enabling Auto paid time while Auto was off'); disabled.destroy();

const frozen = await page(initial); frozen.hide(true); frozen.wake(60_000);
assert.equal(frozen.game().profile.earned, 0, 'A frozen interval paid income');
assert.equal(frozen.game().run.shots, 0, 'A frozen interval replayed launches');
assert(frozen.game().logs.some(log => log.event === 'runtime_interrupted' && log.replayed === false), 'The skipped freeze was not recorded');
assert(frozen.observation.draws > 0, 'Resuming from a freeze failed to redraw');
frozen.advance(60_000); assert(frozen.game().profile.earned > 0, 'Live play did not resume after a skipped freeze'); frozen.destroy();
const reload = await page(initial, { now: startTime + 300_000, hidden: true });
compareProgress(reload.game(), resume(initial), 'Reloading an old save'); reload.destroy();

const fallback = await page(initial, { workerAvailable: false }); fallback.hide(true); fallback.advance(60_000);
assert(fallback.game().profile.earned > 0 && fallback.observation.draws > 500, 'Page timer fallback did not advance and draw the same scene'); fallback.destroy();
const stalled = await page(initial); stalled.hide(true); stalled.workers[0].terminate(); stalled.advance(60_000);
assert(stalled.game().profile.earned > 0, 'A silent clock worker stopped the fallback scheduler'); stalled.destroy();

const choiceSave = seedSave(); choiceSave.profile.pendingChapterSelection = true; choiceSave.run.state = 'ended';
const choosing = await page(choiceSave, { hidden: true }); choosing.advance(60_000);
assert(choosing.game().pendingChapterSelection && choosing.game().profile.earned === 0, 'Automatic play skipped the explicit breakthrough choice'); choosing.destroy();

const report = { generatedAt: new Date().toISOString(), actualPageFrameLoopAndClockWorker: 'pass',
  sameGameAcrossFocusAndVisibility: 'pass', loadingHandoffRemoved: 'pass', clockWorkerHasNoGameState: 'pass',
  fiveMinutesContinuousNoReturnReplay: 'pass', liveSaveIncome: 'pass', manualFlightInBackground: 'pass',
  hiddenSceneUpdateAndRender: 'pass', rafAndTimerSingleClock: 'pass', automaticMenuPolicy: 'pass',
  manualPause: 'pass', failedRunAutoRestartAndDrops: 'pass', noRetroactiveAutoIncome: 'pass',
  frozenIntervalSkippedAndLiveResume: 'pass', oldSaveNoReplay: 'pass', missingAndStalledWorkerFallback: 'pass',
  explicitChapterChoice: 'pass', incomeBeforeReturning: incomeBeforeReturn, hiddenRenderCalls: drawBeforeReturn - beforeHidden,
  scope: 'Deterministic integration: actual production scripts with mocked browser scheduler, DOM and renderer. Does not establish browser throttling, GPU output or audible playback.' };
if (!process.argv.includes('--no-report')) fs.writeFileSync(new URL('../reports/idle-session-check.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
