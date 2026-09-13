import assert from 'node:assert/strict';
import fs from 'node:fs';
import { comboEffectStrength } from '../src/combo-filter.js';
import { Renderer } from '../src/renderer.js';

const data = JSON.parse(fs.readFileSync(new URL('../src/data/balance.json', import.meta.url), 'utf8'));
const config = data.effects.comboFX;
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
for (const [combo, expected] of [[0,0],[9,0],[10,0],[11,.01],[19,.09],[20,.1],[21,.105],[39,.195],[40,.2],[41,.2025],[79,.2975],[80,.3],[100,.325],[159,.39875],[160,.4],[320,.5]]) {
  near(comboEffectStrength(combo, config), expected);
}
for (let combo=10;combo<=1024;combo++) {
  const band = Math.floor(Math.log2((combo-1) / 10));
  const expected = combo === 10 ? 0 : .01 / 2 ** band;
  near(comboEffectStrength(combo, config) - comboEffectStrength(combo-1, config), expected);
}

const view = Object.assign(Object.create(Renderer.prototype), {
  game: {data,state:'flying',paused:false,combo:0,profile:{settings:{reducedEffects:false}}},
  reducedMotion: {matches:false}, time:0, effectStrength:0, dispersionStrength:0, effectFades:{},
  comboFilter: {enabled:false,resources:{spectrum:{uniforms:{}}}},
  atmosphere: {dataset:{},style:{}}
});
for (const combo of [0,9,10,19,20,40,100,320]) {
  const previous=view.effectStrength;
  view.game.combo=combo; view.updateComboSpectrum(1/60);
  const strength=comboEffectStrength(combo,config);
  if(strength>previous) assert(view.effectStrength>previous && view.effectStrength<strength);
  view.updateComboSpectrum(config.riseDuration);
  near(view.effectStrength,strength);
  near(view.comboFilter.resources.spectrum.uniforms.uShift,combo<10?0:.9);
  near(view.comboFilter.resources.spectrum.uniforms.uHue,strength*Math.PI);
}
view.game.combo=20;view.updateComboSpectrum(config.endFadeDuration);
near(view.comboFilter.resources.spectrum.uniforms.uHue,18*Math.PI/180);
view.game.combo=100;
for (const state of ['ready','ended']) {
  view.game.state='flying'; view.updateComboSpectrum(config.riseDuration);
  view.game.state=state; view.updateComboSpectrum(1/60);
  assert(view.effectStrength>0 && view.effectStrength<.325);
  assert(view.dispersionStrength>0 && view.dispersionStrength<.3);
  assert.equal(view.comboFilter.enabled,true);
  for(let frame=0;frame<=Math.ceil(config.endFadeDuration*60);frame++) view.updateComboSpectrum(1/60);
  assert.equal(view.effectStrength,0);
  assert.equal(view.dispersionStrength,0);
  assert.equal(view.comboFilter.enabled,false);
  assert.equal(view.comboFilter.resources.spectrum.uniforms.uShift,0);
  assert.equal(view.comboFilter.resources.spectrum.uniforms.uHue,0);
  assert.equal(view.atmosphere.style.opacity,'0');
}
// Starting the next shot during the fade must not abruptly cut either filter.
view.game.state='flying'; view.game.combo=100; view.updateComboSpectrum(config.riseDuration);
view.game.state='ready'; view.updateComboSpectrum(.1);
const fadingHue=view.effectStrength, fadingDispersion=view.dispersionStrength;
view.game.state='flying'; view.game.combo=0; view.updateComboSpectrum(1/60);
assert(view.effectStrength>0 && view.effectStrength<fadingHue);
assert(view.dispersionStrength>0 && view.dispersionStrength<fadingDispersion);
view.updateComboSpectrum(config.endFadeDuration);
assert.equal(view.comboFilter.enabled,false);
// A multi-kill burst during the rise redirects from the current visible value.
view.game.combo=20; view.updateComboSpectrum(.05);
const rising=view.effectStrength;
view.game.combo=100; view.updateComboSpectrum(0);
near(view.effectStrength,rising);
view.updateComboSpectrum(config.riseDuration);
near(view.effectStrength,.325);
view.game.paused=true; view.updateComboSpectrum(1/60);
assert.equal(view.effectStrength,0);
assert.equal(view.dispersionStrength,0);
view.game.paused=false; view.updateComboSpectrum(config.riseDuration);
assert(view.effectStrength>0);
view.game.profile.settings.reducedEffects=true; view.updateComboSpectrum(1/60);
assert.equal(view.effectStrength,0);
assert.equal(view.dispersionStrength,0);
console.log('Combo curve: 1,015 continuous increments, fixed dispersion, half hue, smooth increases and finite end fades passed.');
