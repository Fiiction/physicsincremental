const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const volume=(value,fallback)=>Number.isFinite(value)?clamp(value,0,1):fallback;
const eventCues={launch:'launch',wall:'wall',break:'break',drop:'drop',eliteopen:'rare',dividend:'dividend',shock:'shock',arc:'arc',riftopen:'rift',riftcollapse:'collapse',portal:'portal',beam:'beam',split:'split',tether:'tether',return:'return',bumper:'bumper',starformed:'star',starwindup:'star',starcollapse:'collapse',starrefract:'beam',starsalvo:'star',finale:'collapse',core:'core',awaken:'victory',bossawake:'bossAwake',bossdefeat:'victory',runend:'end'};

// One shared mixer; presentation never advances the simulation or its random seed.
export class GameAudio {
  constructor(config) {
    this.config=config;this.buffers=new Map();this.loading=new Map();this.voices=new Set();this.cooldowns=new Map();this.failures=new Set();
    this.settings={sound:true,music:false,soundVolume:.7,musicVolume:.35};this.hidden=false;this.paused=false;this.generation=0;this.bossPhase=0;
  }
  unlock() {
    if(this.destroyed)return Promise.resolve(false);
    const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
    if(!Audio)return Promise.resolve(false);
    if(!this.context){
      this.context=new Audio({latencyHint:'interactive'});const c=this.context;
      this.master=c.createGain();this.master.gain.value=0;
      this.compressor=c.createDynamicsCompressor();this.compressor.threshold.value=-10;this.compressor.knee.value=12;this.compressor.ratio.value=5;this.compressor.attack.value=.004;this.compressor.release.value=.18;
      this.sfx=c.createGain();this.musicBus=c.createGain();this.ducker=c.createGain();
      this.sfx.connect(this.master);this.ducker.connect(this.musicBus);this.musicBus.connect(this.master);this.master.connect(this.compressor);this.compressor.connect(c.destination);
      for(const file of Object.values(this.config.samples))this.load(file);
    }
    // resume() is invoked immediately, in the player's gesture, before any fetch awaits.
    return this.context.resume().then(()=>{this.update(this.game,this.visibility);return true;}).catch(()=>false);
  }
  load(file) {
    if(this.buffers.has(file))return Promise.resolve(this.buffers.get(file));
    if(this.loading.has(file))return this.loading.get(file);
    const context=this.context;
    const task=fetch(`${import.meta.env?.BASE_URL||'/'}audio/${file}`)
      .then(response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.arrayBuffer();})
      .then(bytes=>context.decodeAudioData(bytes))
      .then(buffer=>{if(!this.destroyed)this.buffers.set(file,buffer);return buffer;})
      .catch(error=>{this.failures.add(file);console.warn(`[audio] ${file}: ${error.message}`);return null;});
    this.loading.set(file,task);return task;
  }
  ramp(parameter,target,seconds=.08) {
    const now=this.context.currentTime;
    if(parameter.cancelAndHoldAtTime)parameter.cancelAndHoldAtTime(now);
    else {const value=parameter.value;parameter.cancelScheduledValues(now);parameter.setValueAtTime(value,now);}
    parameter.linearRampToValueAtTime(target,now+seconds);
  }
  update(game,visibility={}) {
    if(this.destroyed)return;
    const changed=game!==this.game||game?.profile!==this.profile||game?.profile?.chapter!==this.chapter;
    if(changed){this.stopMusic();this.stopVoices();this.cooldowns.clear();this.bossPhase=0;}
    this.game=game;this.profile=game?.profile;this.chapter=game?.profile?.chapter||0;this.visibility=visibility;
    const settings=game?.profile?.settings||this.settings;
    this.settings={sound:settings.sound!==false,music:settings.music===true,soundVolume:volume(settings.soundVolume,.7),musicVolume:volume(settings.musicVolume,.35)};
    const hidden=visibility.hidden??globalThis.document?.hidden??false;
    if(hidden&&!this.hidden){this.stopMusic();this.stopVoices();}
    this.hidden=hidden;this.paused=visibility.paused??game?.paused??false;
    const c=this.context;if(!c)return;
    const mixKey=`${hidden}:${this.settings.sound}:${this.settings.soundVolume}:${this.settings.music}:${this.settings.musicVolume}:${this.paused}:${game?.state}`;
    if(mixKey!==this.mixKey){
      this.mixKey=mixKey;this.ramp(this.master.gain,hidden?0:this.config.masterVolume,.08);
      this.ramp(this.sfx.gain,this.settings.sound?this.settings.soundVolume:0,.04);
      const menu=this.paused?this.config.music.menuMultiplier:game?.state==='ended'?this.config.music.endedMultiplier:1;
      this.ramp(this.musicBus.gain,this.settings.music?this.settings.musicVolume*menu:0,.2);
      if(!this.settings.sound)this.stopVoices('sfx');
    }
    const boss=game?.boss,active=!!boss?.alive;
    // A once-only sound accent follows each visible damage phase, even with music off.
    const phase=active?(boss.hp/boss.maxHP<.33?2:boss.hp/boss.maxHP<.66?1:0):0;
    if(active&&phase>this.bossPhase&&!this.paused)this.cue('bossPhase',{x:boss.x+16});
    this.bossPhase=phase;
    if(hidden||!this.settings.music||this.settings.musicVolume===0){if(this.loop||this.starting)this.stopMusic();return;}
    if(c.state!=='running')return;
    if(!this.loop&&!this.starting&&!this.failures.has(this.config.music.file))this.startMusic();
    if(this.loop&&this.loop.boss!==active){
      this.loop.boss=active;this.ramp(this.loop.gain.gain,this.config.music.volume*(active?this.config.music.bossMultiplier:1),.6);
      this.ramp(this.loop.filter.frequency,active?this.config.music.bossFilterHz:this.config.music.chapterFilterHz[this.chapter],.6);
    }
    if(active&&!this.paused&&boss.phase==='active'&&c.currentTime>=(this.nextPulse||0)){
      const pulse=this.config.music.bossPulse;
      this.sample(pulse.sample,{...pulse,priority:0,bus:'music'});
      this.nextPulse=c.currentTime+pulse.interval;
    }
  }
  async startMusic() {
    const generation=this.generation;this.starting=true;
    const buffer=await this.load(this.config.music.file);
    if(generation!==this.generation)return;
    this.starting=false;
    if(!buffer||this.destroyed||this.hidden||!this.settings.music||this.settings.musicVolume===0||this.loop)return;
    const c=this.context,source=c.createBufferSource(),gain=c.createGain(),filter=c.createBiquadFilter();
    source.buffer=buffer;source.loop=true;source.playbackRate.value=2**((this.config.music.chapterSemitones[this.chapter]||0)/12);
    gain.gain.value=0;filter.type='lowpass';filter.frequency.value=this.config.music.chapterFilterHz[this.chapter]||1800;filter.Q.value=.45;
    source.connect(filter);filter.connect(gain);gain.connect(this.ducker);source.start();
    this.loop={source,gain,filter,boss:null};this.ramp(gain.gain,this.config.music.volume,this.config.music.fade);
    source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
  }
  stopMusic() {
    this.generation++;this.starting=false;this.nextPulse=0;
    if(this.loop){const loop=this.loop;this.loop=null;this.ramp(loop.gain.gain,0,.16);try{loop.source.stop(this.context.currentTime+.18);}catch{}}
    this.stopVoices('music');
  }
  stopVoice(voice) {
    if(!this.voices.delete(voice))return;
    this.ramp(voice.gain.gain,0,.012);try{voice.source.stop(this.context.currentTime+.015);}catch{}
  }
  stopVoices(bus) {for(const voice of this.voices)if(!bus||voice.bus===bus)this.stopVoice(voice);}
  sample(id,options={}) {
    const c=this.context,bus=options.bus||'sfx',buffer=this.buffers.get(this.config.samples[id]);
    if(!c||c.state!=='running'||!buffer||this.hidden||this.destroyed||!(bus==='music'?this.settings.music&&this.settings.musicVolume>0:this.settings.sound&&this.settings.soundVolume>0))return false;
    const priority=options.priority||0;
    if(this.voices.size>=this.config.maxVoices){
      const oldest=[...this.voices].sort((a,b)=>a.priority-b.priority||a.started-b.started)[0];
      if(oldest.priority>priority)return false;this.stopVoice(oldest);
    }
    const source=c.createBufferSource(),gain=c.createGain(),pan=c.createStereoPanner();
    const rate=clamp(options.rate||1,.45,2.5),now=c.currentTime+(options.delay||0),duration=buffer.duration/rate;
    source.buffer=buffer;source.playbackRate.value=rate;
    const peak=options.volume??.25,release=Math.min(this.config.release,duration*.25);
    gain.gain.setValueAtTime(0,c.currentTime);gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(peak,now+Math.min(this.config.attack,duration*.2));
    gain.gain.setValueAtTime(peak,now+duration-release);gain.gain.linearRampToValueAtTime(0,now+duration);
    pan.pan.value=clamp(options.pan||0,-1,1);source.connect(gain);gain.connect(pan);pan.connect(bus==='music'?this.ducker:this.sfx);
    const voice={source,gain,pan,bus,priority,started:now};this.voices.add(voice);
    source.onended=()=>{this.voices.delete(voice);source.disconnect();gain.disconnect();pan.disconnect();};source.start(now);source.stop(now+duration+.005);return true;
  }
  cue(kind,event={}) {
    const cue=this.config.cues[kind],c=this.context;
    if(!cue||!c||c.state!=='running'||this.hidden||!this.settings.sound)return false;
    if(c.currentTime-(this.cooldowns.get(kind)??-Infinity)<cue.cooldown)return false;
    const sample=cue.samples[Math.floor(Math.random()*cue.samples.length)];
    const progress=kind==='break'?Math.min(5,Math.floor(Math.log2(1+(event.combo||0)/3))):0;
    const rate=(cue.rate||1)*2**(progress/12)*(1+(Math.random()*2-1)*(cue.jitter||0));
    const pan=Number.isFinite(event.x)?(event.x/(this.game?.data?.physics?.size||608)*2-1)*this.config.panWidth:0;
    let played=false;
    for(const [index,note] of (cue.notes||[0]).entries())played=this.sample(sample,{...cue,rate:rate*2**(note/12),pan,delay:index*(cue.noteSpacing||0)})||played;
    if(played){
      this.cooldowns.set(kind,c.currentTime);
      if(cue.duck){const now=c.currentTime;this.ramp(this.ducker.gain,this.config.music.duckMultiplier,.035);this.ducker.gain.linearRampToValueAtTime(1,now+this.config.music.duckRelease);}
    }
    return played;
  }
  events(events,game=this.game) {
    if(game!==this.game)this.update(game,this.visibility);
    if(this.hidden||this.paused)return;
    const cues=new Map(),broken=new Set(events.filter(e=>e.type==='break').map(e=>e.id));
    for(const event of events){
      let kind=eventCues[event.type];
      if(event.type==='hit'&&!event.area&&event.typeName!=='boss'&&!broken.has(event.id))kind='hit';
      if(event.type==='bosshit'&&!event.area)kind='bossHit';
      if(event.type==='drop'&&event.elite)kind='rare';
      if(event.type==='runend'&&game?.run?.bossDefeated)continue;
      if(event.type==='newrun'){this.bossPhase=0;this.cooldowns.clear();}
      if(kind&&(!cues.has(kind)||(event.combo||0)>(cues.get(kind).combo||0)))cues.set(kind,event);
    }
    const selected=[...cues].sort((a,b)=>this.config.cues[b[0]].priority-this.config.cues[a[0]].priority).slice(0,this.config.maxEventsPerFrame);
    for(const [kind,event] of selected)this.cue(kind,event);
  }
  ui(kind='tap') {return this.cue(kind);}
  status() {return {state:this.context?.state||'locked',loaded:this.buffers.size,voices:this.voices.size,music:!!this.loop,hidden:this.hidden,paused:this.paused,failed:[...this.failures]};}
  destroy() {
    if(this.destroyed)return;this.stopMusic();this.stopVoices();this.destroyed=true;
    this.context?.close().catch(()=>{});this.buffers.clear();this.loading.clear();
  }
}
