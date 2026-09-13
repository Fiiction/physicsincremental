// One live scene, driven by animation frames or a timer when those frames stop.
// The worker owns no game state. At most one wake-up can be queued at a time.
export class FrameLoop {
  constructor(onFrame, config = {}, onInterrupt = () => {}) {
    this.onFrame = onFrame; this.config = config; this.onInterrupt = onInterrupt;
    this.running = false;
  }
  reset() { this.previous = performance.now(); this.nextFrame = this.previous + (this.config.frameMs ?? 1000 / 60); }
  frame(now = performance.now()) {
    if (now + .1 < this.nextFrame) return;
    const interval = this.config.frameMs ?? 1000 / 60;
    const seconds = Math.max(0, now - this.previous) / 1000;
    this.previous = now;
    // High-refresh displays and embedded browsers must not submit hundreds of redundant frames.
    this.nextFrame = now + interval - Math.max(0, now - this.nextFrame) % interval;
    if (seconds > (this.config.maxTickSeconds ?? 2)) {
      this.onInterrupt(seconds); this.onFrame(0); // Refresh, but never replay a freeze.
    } else if (seconds > 0) this.onFrame(seconds);
  }
  start() {
    if (this.running) return;
    this.running = true; this.reset(); this.lastAnimation = this.lastPulse = this.previous;
    const interval = this.config.frameMs ?? 1000 / 60;
    const wake = () => {
      if (this.running && performance.now() - this.lastAnimation >= interval * 2) this.frame();
    };
    const animate = () => {
      if (!this.running) return;
      this.animation = requestAnimationFrame(animate);
      this.lastAnimation = performance.now(); this.frame(this.lastAnimation);
    };
    this.animation = requestAnimationFrame(animate);
    try {
      const worker = this.worker = new Worker(new URL('./clock-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = () => {
        if (!this.running || this.worker !== worker) return;
        this.lastPulse = performance.now();
        try { wake(); } finally { worker.postMessage('ack'); }
      };
      worker.onerror = event => {
        event.preventDefault?.(); worker.terminate();
        if (this.worker === worker) this.worker = null;
        console.warn('[Physics Incremental] Frame clock unavailable; continuing with the page timer.');
      };
      worker.postMessage(interval);
    } catch { this.worker = null; }
    // Also covers a missing or suspended worker; shares the same clock, never a second simulation.
    this.fallback = setInterval(() => {
      if (!this.worker || performance.now() - this.lastPulse > 250) wake();
    }, 100);
  }
  stop() {
    this.running = false; cancelAnimationFrame(this.animation); clearInterval(this.fallback);
    this.worker?.terminate(); this.worker = null;
  }
}
