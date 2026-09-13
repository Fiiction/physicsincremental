// Only the player's intentional pause belongs in a save, not a temporary menu pause.
export function idleSnapshot(game, paused = game.paused) {
  return { ...game.snapshot(), paused };
}

// Headless playtests may intentionally simulate a duration; live play uses FrameLoop.
export function advanceElapsed(game, seconds) {
  if (!game.auto || game.paused || game.pendingChapterSelection || (game.state === 'ended' && game.goalComplete)) return;
  while (seconds > 0) {
    const step = Math.min(seconds, 2); game.tick(step); seconds -= step;
    game.events.length = 0;
    if (game.state === 'ended' && game.goalComplete) break;
  }
}
