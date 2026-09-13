import { Game } from './game.js';
import { advanceElapsed } from './idle.js';

let game, through, epoch, timer, ending = false, published = 0, sequence = 0;
function pump() {
  const target = Date.now(), deadline = performance.now() + 24;
  while (through < target && performance.now() < deadline) {
    const milliseconds = Math.min(2000, target - through);
    advanceElapsed(game, milliseconds / 1000); through += milliseconds;
  }
  if (through >= target && (ending || target - published >= 1000)) {
    postMessage({ epoch, sequence: ++sequence, through, profile: game.profile, run: game.snapshot(), finished: ending });
    published = target;
    if (ending) return;
  }
  timer = setTimeout(pump, through < target ? 0 : 250);
}
self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    epoch = data.epoch; through = data.through;
    game = new Game(data.balance, data.profile); game.restore(data.run);
    pump();
  } else if (data.type === 'finish') { ending = true; clearTimeout(timer); pump(); }
};
