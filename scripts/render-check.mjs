import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const target = process.argv[2];
const server = target ? null : await preview({ base: '/physicsincremental/', preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(target || 'http://127.0.0.1:4174/physicsincremental/');
  await page.waitForFunction(() => window.corebound?.renderer?.time > 0, null, { timeout: 15000 });
  const result = await page.evaluate(() => {
    const { renderer, game } = window.corebound;
    const canvas = renderer.app.renderer.extract.canvas({ target: renderer.app.stage });
    const ctx = canvas.getContext('2d');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 128 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) colored++;
    }
    return { blocks: renderer.blockViews.size, colored, shots: game.shots };
  });
  assert(result.blocks > 100, 'Mine blocks must be created');
  assert(result.colored > 10000, 'The rendered canvas must contain visible colored blocks');
  await page.locator('#canvas-host canvas').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(shots => window.corebound.game.shots < shots && window.corebound.game.hits > 0, result.shots, { timeout: 15000 });
  await page.screenshot({ path: 'reports/render-check.png' });
  assert.deepEqual(errors, [], 'Browser must not report runtime errors');
  console.log('Production rendering and keyboard launch passed:', result);
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve());
}
