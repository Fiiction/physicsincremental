// Foreground and worker use exactly the same fixed-step rules, including delayed wakeups.
export function advanceElapsed(game, seconds) {
  if (!game.auto || game.paused || game.pendingChapterSelection || (game.state === 'ended' && game.goalComplete)) return;
  while (seconds > 0) {
    const step = Math.min(seconds, 2); game.tick(step); seconds -= step;
    game.events.length = 0;
    if (game.state === 'ended' && game.goalComplete) break;
  }
}
