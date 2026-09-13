import assert from 'node:assert/strict';
import { BitmapFont, BitmapText, Container, Text, ViewSystem } from 'pixi.js';
import { Renderer } from '../src/renderer.js';
import data from '../src/data/balance.json' with { type: 'json' };

// Real Pixi scene/text and canvas sizing, without a browser or GPU. Only the
// renderer entry point and digit-atlas generation need stand-ins.
const savedWindow = globalThis.window;
const originalInstall = BitmapFont.install, originalUninstall = BitmapFont.uninstall;
const fonts = [];
BitmapFont.install = options => fonts.push(['install', options.resolution]);
BitmapFont.uninstall = name => fonts.push(['uninstall', name]);
globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
try {
  let bounds = { left: 23, top: 17, width: 608, height: 608 }, calls = 0;
  const canvas = { width: 0, height: 0, style: {}, getBoundingClientRect: () => bounds };
  const nativeView = new ViewSystem();
  nativeView.init({ canvas, width: 608, height: 608, resolution: 2, autoDensity: true });
  const game = { data, chapter: data.chapters[0], level: {}, profile: { settings: {} } };
  const view = new Renderer(game, { getBoundingClientRect: () => bounds }, () => {});
  view.app = {
    canvas, stage: new Container(), renderer: {
      get resolution() { return nativeView.resolution; },
      set resolution(value) { nativeView.resolution = value; },
      resize(width, height, resolution) { calls++; nativeView.resize(width, height, resolution); }
    }
  };
  view.blockLayer = new Container(); view.textLayer = new Container();
  view.app.stage.addChild(view.blockLayer, view.textLayer);
  const nested = new Container(), oldText = new Text({ text: '旧文字' });
  nested.addChild(oldText); view.textLayer.addChild(nested);
  const combo = new BitmapText({ text: '×40', style: { fontFamily: 'ComboDigits', fontSize: 20 } });
  view.textLayer.addChild(combo); view.comboTexts.push({ node: combo });

  function size(width, dpr, height = width) {
    bounds = { ...bounds, width, height }; window.devicePixelRatio = dpr;
    view.resize();
    assert.equal(canvas.width, Math.round(width * dpr));
    assert.equal(canvas.height, Math.round(height * dpr));
    assert.equal(nativeView.screen.width, canvas.width / dpr);
    assert.equal(nativeView.screen.height, canvas.height / dpr);
    assert.equal(parseFloat(canvas.style.width), canvas.width / dpr);
    assert.equal(parseFloat(canvas.style.height), canvas.height / dpr);
    assert.equal(view.app.stage.scale.x, width / 608);
    assert.equal(view.app.stage.scale.y, height / 608);
    assert.equal(oldText.resolution, Math.ceil(dpr * Math.max(1, width / 608, height / 608)));
    assert.deepEqual(view.point({ clientX: bounds.left + width / 2, clientY: bounds.top + height / 2 }), { x: 304, y: 304 });
  }

  size(608, 2);
  // Same 1216 physical pixels, different CSS size and DPR: Pixi's source resize
  // alone skips updating its texture frame and CSS. The game must handle this.
  size(1216, 1);
  size(900, 1);
  combo._didTextUpdate = false; combo.didViewUpdate = false;
  size(900, 3); // Monitor change without a CSS ResizeObserver notification.
  assert.equal(combo._didTextUpdate, true, 'existing combo uses regenerated atlas');
  assert.equal(view.comboFontResolution, 5);
  const fontChanges = fonts.length;
  size(320, 3);
  assert.equal(fonts.length, fontChanges, 'shrinking does not churn the atlas');
  size(900.4, 1.25); // Fractional CSS pixels and fractional desktop scaling.

  view.addBlock({ id: 1, x: 0, y: 0, type: 'gold', tier: 0, hp: 10, maxHP: 10 });
  const notice = view.float(100, 100, '新文字', 0x333333, 16);
  view.showDrop({ x: 300, y: 300 }, { id: 'test', icon: '◇', name: '道具', color: 0x446688 });
  const drop = view.floaters.find(f => f.id === 'test');
  for (const node of [view.blockViews.get(1).label, notice.node, ...drop.node.children.filter(n => n instanceof Text)]) {
    assert.equal(node.resolution, view.textResolution, 'new text inherits current density');
  }
  const beforeHidden = calls;
  bounds.width = 0; view.resize();
  assert.equal(calls, beforeHidden, 'hidden layout does not collapse the surface');
  assert.equal(fonts.filter(f => f[0] === 'install').length, 2);
  assert.equal(fonts.filter(f => f[0] === 'uninstall').length, 1);
  view.app.stage.destroy({ children: true }); nativeView.destroy();
  console.log('Renderer resize passed: native backing pixels, same-pixel DPR transition, scene/input mapping, existing/new text, and shared combo atlas.');
} finally {
  BitmapFont.install = originalInstall; BitmapFont.uninstall = originalUninstall;
  if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
}
