import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GameAudio } from '../src/audio.js';
const config=JSON.parse(fs.readFileSync(new URL('../src/data/audio.json',import.meta.url)));
for(const file of [...Object.values(config.samples),config.music.file])assert.equal(fs.readFileSync(new URL(`../public/audio/${file}`,import.meta.url)).subarray(0,4).toString(),'OggS',`Missing local OGG: ${file}`);
for(const cue of Object.values(config.cues))for(const sample of cue.samples)assert(config.samples[sample]);

// A minimal mixer double verifies lifecycle/routing, not subjective sound or decoding.
class Param {constructor(value=1){this.value=value;}setValueAtTime(v){this.value=v;}linearRampToValueAtTime(v){this.value=v;}cancelAndHoldAtTime(){}cancelScheduledValues(){}}
class Node {constructor(){this.gain=new Param();this.frequency=new Param();this.Q=new Param();this.pan=new Param();this.playbackRate=new Param();}connect(){}disconnect(){}start(){this.started=true;}stop(){this.stopped=true;}}
class Context {
  constructor(){this.state='suspended';this.currentTime=0;this.destination=new Node();}
  createGain(){return new Node();}createBufferSource(){return new Node();}createBiquadFilter(){return new Node();}createStereoPanner(){return new Node();}
  createDynamicsCompressor(){return Object.assign(new Node(),Object.fromEntries(['threshold','knee','ratio','attack','release'].map(k=>[k,new Param()])));}
  decodeAudioData(){return Promise.resolve({duration:.3});}resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
}
const previous={AudioContext:globalThis.AudioContext,fetch:globalThis.fetch};
const requests=[];globalThis.AudioContext=Context;globalThis.fetch=async url=>{requests.push(url);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};};
try {
  const game={profile:{chapter:0,settings:{sound:true,music:false,soundVolume:.7,musicVolume:.35}},data:{physics:{size:608}},state:'ready',paused:false};
  const audio=new GameAudio(config);audio.update(game);assert.equal(audio.status().state,'locked');
  await audio.unlock();await Promise.all(audio.loading.values());
  assert.equal(requests.length,Object.keys(config.samples).length,'Disabled music was downloaded');
  assert(requests.every(url=>url.startsWith('/audio/')),'A runtime request escaped the local audio directory');
  audio.events([{type:'break',id:1,x:150,combo:10},{type:'hit',id:1,x:150}],game);
  assert.equal(audio.voices.size,1,'One broken block also played its ordinary hit');
  audio.events(Array.from({length:300},()=>({type:'split',x:300})),game);assert.equal(audio.voices.size,2,'A burst of split events was not merged');
  for(let i=0;i<30;i++){audio.context.currentTime+=.3;audio.ui('buy');}assert(audio.voices.size<=config.maxVoices,'Polyphony was unbounded');
  const before=audio.voices.size;audio.events([{type:'upgrade'}],game);assert.equal(audio.voices.size,before,'A purchase played twice');
  audio.stopVoices();game.boss={alive:true,phase:'active',hp:60,maxHP:100,x:288};audio.update(game);
  assert(audio.cooldowns.has('bossPhase'),'Default-off music suppressed the boss damage cue');
  game.profile.settings.sound=false;game.profile.settings.music=true;audio.update(game);
  await Promise.all(audio.loading.values());await Promise.resolve();assert(audio.loop,'Music depended on sound effects being enabled');
  audio.context.currentTime+=1;audio.update(game);assert([...audio.voices].every(v=>v.bus==='music'));
  const music=audio.loop.source;audio.update(game,{hidden:true});assert(music.stopped);assert(!audio.loop);assert.equal(audio.voices.size,0);
  assert.equal(audio.ui('tap'),false,'Hidden UI played sound');
  audio.update(game,{hidden:false,paused:true});await Promise.resolve();await Promise.resolve();assert(audio.loop);
  game.profile.settings.sound=true;audio.update(game,{hidden:false,paused:true});assert(audio.ui('tap'),'Pause also muted UI feedback');
  const count=audio.voices.size;audio.events([{type:'bossawake'}],game);assert.equal(audio.voices.size,count,'Paused combat event played');
  const old=audio.loop.source,next={...game,profile:{...game.profile,chapter:1}};audio.update(next,{hidden:false});assert(old.stopped,'Changing chapters retained the old music source');
  await Promise.resolve();await Promise.resolve();
  next.profile.settings.music=false;audio.update(next);assert(!audio.loop,'Music toggle left a source running');
  assert(audio.ui('error'),'Music toggle also muted SFX');
  const delayed=new GameAudio(config);delayed.context=audio.context;let resolveLoad;
  delayed.load=()=>new Promise(resolve=>{resolveLoad=resolve;});delayed.settings.music=true;
  const pending=delayed.startMusic();delayed.stopMusic();delayed.starting=true;resolveLoad({duration:1});await pending;
  assert(delayed.starting,'A stale load cleared the newer scene loading flag');assert(!delayed.loop,'A stale load started old music');
  audio.destroy();assert.equal(audio.status().state,'closed');assert.equal(audio.voices.size,0);
  console.log(JSON.stringify({localAssets:14,gestureUnlock:'pass',defaultMusicOff:'pass',independentControls:'pass',bossCueWithMusicOff:'pass',boundedPolyphony:'pass',mergedEvents:'pass',singlePurchaseCue:'pass',hiddenAndMenu:'pass',chapterReplacement:'pass',staleDecode:'pass',destroy:'pass'},null,2));
} finally {globalThis.AudioContext=previous.AudioContext;globalThis.fetch=previous.fetch;}
