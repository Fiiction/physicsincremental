// Menus pause the picture, but only an intentional pause belongs in an idle save.
export function idleSnapshot(game, paused = game.paused) {
  return { ...game.snapshot(), paused };
}

// A scheduler pause is not play time: no saved-time replay or accumulated time debt.
export function advanceRealtime(game, seconds, silent = true) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > (game.data.idleRuntime?.maxTickSeconds ?? 2)) return 0;
  if (!game.auto || game.paused || game.pendingChapterSelection || (game.state === 'ended' && game.goalComplete)) return 0;
  game.tick(seconds);
  if (silent) game.events.length = 0;
  return seconds;
}

// Headless playtests may intentionally simulate a duration; live play uses advanceRealtime.
export function advanceElapsed(game, seconds) {
  if (!game.auto || game.paused || game.pendingChapterSelection || (game.state === 'ended' && game.goalComplete)) return;
  while (seconds > 0) {
    const step = Math.min(seconds, 2); game.tick(step); seconds -= step;
    game.events.length = 0;
    if (game.state === 'ended' && game.goalComplete) break;
  }
}
