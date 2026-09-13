import { Game } from './game.js';
import { advanceRealtime } from './idle.js';

let game, through, epoch, timer, ending = false, published = 0, sequence = 0, runtime;
function pump() {
  const now = Date.now(), seconds = Math.max(0, now - through) / 1000;
  through = now;
  runtime.simulatedSeconds += advanceRealtime(game, seconds);
  if (seconds > (game.data.idleRuntime?.maxTickSeconds ?? 2)) runtime.interruptedSeconds += seconds;
  runtime.ticks++;
  const finished = ending;
  if (finished || now - published >= (game.data.idleRuntime?.publishMs ?? 1000)) {
    postMessage({ epoch, sequence: ++sequence, through, profile: game.profile, run: game.snapshot(), runtime, finished });
    published = now;
    if (finished) return;
  }
  timer = setTimeout(pump, game.data.idleRuntime?.intervalMs ?? 250);
}
self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    clearTimeout(timer);
    epoch = data.epoch; through = Date.now(); ending = !!data.ending; published = 0; sequence = 0;
    runtime = {ticks:0,simulatedSeconds:0,interruptedSeconds:0};
    game = new Game(data.balance, data.profile); game.restore(data.run);
    pump();
  } else if (data.type === 'finish') { ending = true; clearTimeout(timer); pump(); }
};
