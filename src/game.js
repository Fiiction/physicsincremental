// Pure simulation: the browser, idle pilot and headless playtests share this module.
export function createProfile() {
  return { version: 1, campaignVersion: 2, coins: 0, earned: 0, upgrades: {}, chapter: 0, stageKills: 0, stageCores: 0, stageCombo: 0, bestCombo: 0, bestRun: 0, totalKills: 0, runs: 0, prestige: 0, relics: [], history: [], seenDrops: [], settings: { sound: true, music: false, soundVolume: 0.7, musicVolume: 0.35, shake: true, particles: true, reducedEffects: false } };
}

export function sanitizeProfile(raw, data) {
  if (!raw || raw.version !== 1) throw new Error('这份存档的版本无法识别');
  const p = createProfile();
  for (const key of ['coins', 'earned', 'stageKills', 'stageCores', 'stageCombo', 'bestCombo', 'bestRun', 'totalKills', 'runs', 'prestige']) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) p[key] = Math.max(0, Math.min(1e12, Math.floor(raw[key])));
  }
  p.chapter = Math.max(0, Math.min(data.chapters.length - 1, Math.floor(Number(raw.chapter) || 0)));
  p.unlockedChapter = Math.max(p.chapter, p.prestige ? Math.min(3, data.chapters.length - 1) : 0, Math.min(data.chapters.length - 1, Math.floor(Number(raw.unlockedChapter) || 0)));
  p.frontierChapter = Math.max(0, Math.min(p.unlockedChapter, Math.floor(Number(raw.frontierChapter ?? p.chapter) || 0)));
  p.pendingChapterSelection = raw.pendingChapterSelection === true;
  // A completed four-region save can explore the added region without moving
  // its current ball, spending resources, or repeating already-earned rewards.
  if ((raw.campaignVersion || 1) < 2 && p.prestige > 0 && data.chapters.length > 4) p.unlockedChapter = p.frontierChapter = 4;
  p.chapterProgress = {};
  for (let i = 0; i < data.chapters.length; i++) {
    const progress = raw.chapterProgress?.[i];
    if (progress) p.chapterProgress[i] = Object.fromEntries(['stageKills', 'stageCores', 'stageCombo'].map(key => [key, Math.max(0, Math.min(1e12, Math.floor(Number(progress[key]) || 0)))]));
  }
  for (const u of data.upgrades) p.upgrades[u.id] = Math.max(0, Math.min(u.max, Math.floor(Number(raw.upgrades?.[u.id]) || 0)));
  p.relics = [...new Set((Array.isArray(raw.relics) ? raw.relics : []).filter(id => data.relics.some(r => r.id === id)))];
  p.seenDrops = [...new Set((Array.isArray(raw.seenDrops) ? raw.seenDrops : []).filter(id => data.drops.some(d => d.id === id)))];
  p.history = Array.isArray(raw.history) ? raw.history.slice(-30).filter(h => h && Number.isFinite(h.coins) && Number.isFinite(h.kills) && Number.isFinite(h.combo)).map(h => ({ coins: h.coins, kills: h.kills, combo: h.combo, comboCoins: Number(h.comboCoins) || 0, shots: Number(h.shots) || 0, time: Number(h.time) || 0, chapter: Math.max(0, Math.min(data.chapters.length - 1, Number(h.chapter) || 0)), auto: !!h.auto })) : [];
  for (const key of Object.keys(p.settings)) if (typeof p.settings[key] === 'boolean' && typeof raw.settings?.[key] === 'boolean') p.settings[key] = raw.settings[key];
  for (const key of ['soundVolume','musicVolume']) if (Number.isFinite(raw.settings?.[key])) p.settings[key] = Math.max(0,Math.min(1,raw.settings[key]));
  return p;
}

export function upgradeCost(data, profile, id) {
  const u = data.upgrades.find(x => x.id === id);
  return u ? Math.round(u.cost * u.growth ** (profile.upgrades[id] || 0)) : Infinity;
}

export function upgradeStatus(data, profile, id) {
  const u = data.upgrades.find(x => x.id === id);
  if (!u) return 'unknown';
  if ((profile.upgrades[id] || 0) >= u.max) return 'max';
  if ((u.chapter || 0) > Math.max(profile.unlockedChapter || 0, profile.chapter) && profile.prestige === 0) return 'chapter';
  if (u.requiresRelic && !profile.relics.includes(u.requiresRelic)) return 'relic';
  if (u.requires.some(req => !profile.upgrades[req])) return 'locked';
  return profile.coins >= upgradeCost(data, profile, id) ? 'available' : 'poor';
}

export class Game {
  constructor(data, profile = createProfile(), seed = Date.now()) {
    this.data = data;
    this.profile = profile;
    profile.unlockedChapter = Math.max(profile.unlockedChapter || 0, profile.chapter, profile.prestige ? Math.min(3, data.chapters.length - 1) : 0);
    profile.frontierChapter ??= profile.chapter;
    profile.chapterProgress ||= {};
    this.seed = seed >>> 0 || 1;
    this.events = [];
    this.logs = [];
    this.auto = false;
    this.paused = false;
    this.newRun();
  }
  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  get chapter() { return this.data.chapters[this.profile.chapter]; }
  get level() { return this.profile.upgrades; }
  get bossEnabled() { return this.run?.bossVersion===1; }
  get boss() { return this.bossBlock || null; }
  get bossRules() { return {...this.data.boss,...this.chapter.boss}; }
  get beamEvery() { return Math.min(this.profile.chapter>=3 ? this.data.mechanics.beamEvery : Infinity, this.level.prism ? this.data.mechanics.portableBeamEvery-2*(this.level.prism-1) : this.data.mechanics.portableBeamEvery); }
  get starCastLimit() {
    const m=this.data.constellation,rank=this.level.starCombo||0,start=m.extraCastStart??4;
    return m.maxActivationsPerShot+(rank>=start ? 1+Math.floor((rank-start)/(m.extraCastEvery??2)) : 0);
  }
  get fusion() { return this.profile.prestige > 0 && this.data.relics.every(r => this.profile.relics.includes(r.id)); }
  chestChance(ring = 2) {
    const d = this.data;
    return Math.min(d.mechanics.chestCap, (d.economy.chestChance + (this.level.fortune || 0) * d.growth.fortune + (this.level.comboLuck || 0) * d.growth.chestDensity + (ring >= d.generation.deepRing ? (this.level.idleLuck || 0) * d.growth.deepChests : 0)) * this.chapter.chests);
  }
  get stats() {
    const p = this.profile, u = this.level, d = this.data;
    return {
      damage: d.economy.damage * d.growth.power ** (u.power || 0) * (1 + p.prestige * d.growth.prestigeDamage),
      energy: d.physics.energy * (1 + d.growth.kinetic) ** (u.kinetic || 0),
      shots: Math.min(d.economy.maxShotsPerRun, d.economy.shots + (u.battery || 0)),
      yield: 1 + (u.salvage || 0) * d.growth.salvage,
      idleYield: Math.min(1, d.economy.idleYield + (u.idleYield || 0) * d.growth.idleYield),
      idleDelay: Math.max(d.growth.minIdleDelay, d.economy.idleDelay - (u.idleSpeed || 0) * d.growth.idleSpeed)
    };
  }
  emit(type, payload = {}) {
    this.events.push({ type, ...payload });
    if (this.events.length > 400) {
      const disposable = this.events.findIndex(e => ['hit','break','magnet'].includes(e.type));
      this.events.splice(disposable < 0 ? 0 : disposable, 1);
    }
  }
  triggerTech(id, payload = {}) {
    if (!this.level[id]) return;
    this.run.techTriggers[id] = (this.run.techTriggers[id] || 0) + 1;
    if (this.techEventTime !== this.run.time) { this.techEventTime = this.run.time; this.techEvents = {}; }
    const existing = this.techEvents[id];
    if (existing && this.events.includes(existing)) {
      existing.count++;
      if (payload.amount) existing.amount = (existing.amount || 0) + payload.amount;
      return;
    }
    this.emit('tech', { ...payload, id, count: 1 });
    this.techEvents[id] = this.events[this.events.length - 1];
  }
  log(event, details = {}) {
    this.logs.push({ seq: (this.logSeq = (this.logSeq || 0) + 1), time: Math.round((this.run?.time || 0) * 100) / 100, event, ...details });
    if (this.logs.length > 200) this.logs.shift();
  }
  buy(id) {
    if (upgradeStatus(this.data, this.profile, id) !== 'available') return false;
    const cost = upgradeCost(this.data, this.profile, id);
    this.profile.coins -= cost;
    this.level[id] = (this.level[id] || 0) + 1;
    this.log('upgrade', { id, level: this.level[id], cost });
    this.emit('upgrade', { id });
    return true;
  }
  newRun() {
    // A breakthrough is committed before choosing a destination. Only
    // selectChapter may release that checkpoint, including after a reload.
    if ((this.pendingChapterSelection && this.run) || this.bossVictoryLeft>0) return false;
    const n = this.data.physics.grid, s = this.data.physics.size / n, c = (n - 1) / 2, m = this.data.mechanics;
    this.blocks = [];
    this.bossBlock = null;
    this.bossVictoryLeft = 0;
    this.balls = [];
    this.position = { x: this.data.physics.size / 2, y: this.data.physics.size / 2 };
    this.state = this.pendingChapterSelection ? 'ended' : 'ready';
    this.idleTime = 0;
    this.combo = 0;
    this.shots = this.stats.shots;
    this.buffs = {};
    this.activeBuffs = {};
    this.run = { coins: 0, comboCoins: 0, kills: 0, cleared: 0, totalBlocks: 0, cores: 0, combo: 0, shots: 0, time: 0, chapter: this.profile.chapter, auto: false, drops: 0, charges: 0, supplies: 0, elites: 0, arcs: 0, riftPulses: 0, finales: 0, techTriggers: {} };
    Object.assign(this.run,{bossVersion:this.data.boss&&this.chapter.boss?1:0,bossSpawned:false,bossDefeated:false,bossStartedShot:0,bossStartedTime:0,bossDamage:0,bossChipDamage:0,bossDirectDamage:0,bossChipKills:0,bossDirectHits:0,bossShots:0});
    this.bumpers = this.fusion ? [{ x: this.position.x + s, y: this.position.y, charges: this.data.relicMechanics.bumperCharges, armed: true }] : [];
    this.launchOrigin = { ...this.position };
    this.star = { points:[],triangle:null,charge:0,pending:0,cooldown:0,casts:0,volley:[] };
    this.rifts = [];
    this.arcSplits = 0;
    this.mintClaimed = this.burstClaimed = this.finaleClaimed = 0;
    this.techEventTime = -1; this.techEvents = {}; this.beamAt = 0; this.beamArcAt = 0;
    this.returnedSplits=0; this.tetherSplits=0;
    this.shotAuto = false;
    const keys = [[c - 5, c], [c + 5, c], [c, c - 5], [c, c + 5]];
    this.pattern = { angle: this.random() * Math.PI * 2, phase: this.random() * this.data.generation.patternPhase, mirror: this.random() < 0.5 ? -1 : 1 };
    const turns = Math.floor(this.random() * 4), mirror = this.random() < 0.5 ? -1 : 1;
    const rotate = ([x, y], count = turns) => { x *= mirror; for (let i = 0; i < count; i++) [x, y] = [-y, x]; return [x, y]; };
    const supplies = this.chapter.supplies.map(([x, y], i) => rotate([x + (i > 1 ? Math.floor(this.random() * 3) - 1 : 0), y]));
    this.portals = [];
    if (this.profile.chapter >= 2) {
      const entry = rotate([1, 0], Math.floor(this.random() * 4));
      const exit = rotate([this.data.generation.portalExitMin + Math.floor(this.random() * this.data.generation.portalExitVariants), 3 + Math.floor(this.random() * 2)], Math.floor(this.random() * 4));
      this.portals = [entry, exit].map(([x, y]) => ({ x: (c + x + 0.5) * s, y: (c + y + 0.5) * s }));
    }
    this.generatedCharges = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const ring = Math.max(Math.abs(x - c), Math.abs(y - c));
      if (ring <= 1) continue;
      if (this.portals.some(p => Math.abs(x * s + s / 2 - p.x) <= s && Math.abs(y * s + s / 2 - p.y) <= s)) continue;
      let type = 'normal';
      if (keys.some(k => k[0] === x && k[1] === y)) type = 'core';
      else if (supplies.some(([sx, sy]) => x === c + sx && y === c + sy) || this.random() < this.chestChance(ring)) type = 'gold';
      else if (this.profile.chapter >= 1 && ring > 2 && this.random() < m.bombChance) type = 'bomb';
      const tier = this.patternTier(x - c, y - c);
      const baseHP = ring === 2 ? 1 : this.data.ringHP[ring] * this.data.tierHP[tier];
      const nativeHP = Math.round(Math.max(1, baseHP) * this.chapter.hp * (type === 'core' ? m.coreHP : type === 'bomb' ? m.bombHP : type === 'gold' ? m.supplyHP : 1) * (1 + this.profile.prestige * this.data.growth.prestigeHP) * 100) / 100;
      const reinforcement = ring === 2 ? 1 : this.data.ringHP[ring] ** ((this.chapter.ringHPExponent ?? 1) - 1);
      const hp = Math.round(nativeHP * reinforcement * 100) / 100;
      const supplyIndex = supplies.findIndex(([sx, sy]) => x === c + sx && y === c + sy);
      const supply = type === 'gold' ? supplyIndex >= 0 ? ['split','boost','shock','pierce'][supplyIndex % 4] : this.rollChest() : null;
      const percentDamageScale = this.chapter.percentDamageScale ?? 1;
      this.blocks.push({ id: y * n + x, gx: x, gy: y, x: x * s, y: y * s, ring, tier, hp, maxHP: hp, ...(reinforcement>1 || percentDamageScale<1 ? {percentDamageHP:nativeHP*percentDamageScale} : {}), type, supply, native: true, loot: 1, alive: true });
    }
    this.generateElites();
    // A grid is enough for this fixed 19×19 arena; no general-purpose physics scene is needed.
    this.reindex();
    this.run.totalBlocks = this.blocks.length;
    this.run.relicTriggers = { echo: 0, heart: 0, mint: 0, fusion: 0 };
    this.run.starBursts=0;
    this.log('run_start', { chapter: this.profile.chapter, shots: this.shots });
    this.emit('newrun');
  }
  reindex() { this.grid = new Map(this.blocks.filter(b => b.alive).map(b => [b.id, b])); this.bossBlock=this.blocks.find(b=>b.type==='boss')||null; }
  spawnBoss(force=false) {
    if(this.pendingChapterSelection || this.run.bossSpawned || !this.chapter.boss || (!force&&(!this.bossEnabled||this.clearRatio<this.bossRules.threshold))) return false;
    const m=this.bossRules,p=this.data.physics,cell=p.size/p.grid,center=p.size/2,scale=1+this.profile.prestige*this.data.growth.prestigeHP;
    const size=m.sizeCells*cell,hp=m.hp*scale;
    this.bossBlock={id:p.grid*p.grid,gx:Math.floor(p.grid/2),gy:Math.floor(p.grid/2),x:center-16,y:center-16,ring:0,tier:this.data.tierHP.length-1,hp,maxHP:hp,percentDamageHP:m.percentDamageHP*scale,type:'boss',native:false,loot:1,alive:true,size,rotation:0,phase:'waking',wakeLeft:m.wakeDuration,wakeDuration:m.wakeDuration};
    this.blocks.push(this.bossBlock); this.grid.set(this.bossBlock.id,this.bossBlock);
    Object.assign(this.run,{bossVersion:1,bossSpawned:true,bossStartedShot:this.run.shots,bossStartedTime:this.run.time,bossShots:this.state==='flying'?1:0});
    const radius=size/Math.SQRT2+m.clearance;
    for(const block of this.blocks) if(block.alive&&block.type!=='boss'&&block.type!=='core') {
      const dx=Math.max(0,Math.abs(block.x+16-center)-cell*p.blockSize/2),dy=Math.max(0,Math.abs(block.y+16-center)-cell*p.blockSize/2);
      if(Math.hypot(dx,dy)<=radius) {block.alive=false;block.bossCleared=true;this.grid.delete(block.id);}
    }
    if(this.portals.some(portal=>Math.hypot(portal.x-center,portal.y-center)<radius+this.data.mechanics.portalRadius+this.data.mechanics.portalExit)) this.portals=[];
    this.bumpers=this.bumpers.filter(b=>Math.hypot(b.x-center,b.y-center)>radius+this.data.relicMechanics.bumperRadius);
    this.emit('bossawake',{id:this.boss.id,x:center,y:center,size,rotation:0,phase:'waking',hp,maxHP:hp,duration:m.wakeDuration});
    this.log('boss_awake',{name:m.name,hp,shot:this.run.shots,remainingShots:this.shots,clearRatio:this.clearRatio});
    return true;
  }
  activateBoss() {
    const boss=this.boss,p=this.data.physics;
    if(!boss?.alive) return;
    const x=boss.x+16,y=boss.y+16,radius=boss.size/Math.SQRT2+p.radius+.4;
    const push=point=>{
      const dx=point.x-x,dy=point.y-y,distance=Math.hypot(dx,dy);
      if(distance<radius) {point.x=x+(distance?dx/distance:1)*radius;point.y=y+(distance?dy/distance:0)*radius;}
    };
    push(this.position);push(this.launchOrigin);
    for(const ball of this.balls) push(ball);
    const main=this.balls.find(b=>b.main);if(main)this.position={x:main.x,y:main.y};
    boss.phase='active';boss.wakeLeft=0;
    this.emit('bossphase',{id:boss.id,x,y,size:boss.size,rotation:boss.rotation,phase:'active'});
    this.log('boss_active',{shot:this.run.shots,remainingShots:this.shots});
  }
  settleOutsideBoss(point,dt=Infinity) {
    const boss=this.boss;
    if(boss?.phase!=='active') return;
    const dx=point.x-boss.x-16,dy=point.y-boss.y-16,distance=Math.hypot(dx,dy),radius=boss.size/Math.SQRT2+this.data.physics.radius+.4;
    if(distance>=radius) return;
    const move=(radius-distance)*Math.min(1,dt*12);
    point.x+=(distance?dx/distance:1)*move;point.y+=(distance?dy/distance:0)*move;
    const contact=this.bossContact(point,boss);
    if(contact) {point.x+=contact.nx*(contact.radius-contact.distance+.05);point.y+=contact.ny*(contact.radius-contact.distance+.05);}
  }
  defeatBoss(boss) {
    boss.hp=0;boss.alive=false;boss.phase='defeated';this.grid.delete(boss.id);
    this.run.bossDefeated=true;this.run.kills++;this.profile.totalKills++;
    const coins=this.reward(this.chapter.reward*this.bossRules.rewardMultiplier);
    const main=this.balls.find(b=>b.main);if(main)this.position={x:main.x,y:main.y};
    this.balls=[];this.star.pending=0;this.star.volley=[];this.rifts=[];
    this.bossVictoryLeft=this.bossRules.victoryDuration;
    this.state='flying';
    this.emit('bossdefeat',{id:boss.id,x:boss.x+16,y:boss.y+16,size:boss.size,rotation:boss.rotation,phase:'defeated',coins,duration:this.bossVictoryLeft});
    this.log('boss_defeat',{shot:this.run.shots,remainingShots:this.shots,coins,bossDamage:this.run.bossDamage,bossChipDamage:this.run.bossChipDamage,bossDirectDamage:this.run.bossDirectDamage,bossDirectHits:this.run.bossDirectHits,bossShots:this.run.bossShots});
  }
  blockDistance(block,x,y) {
    if(block.type!=='boss') return Math.hypot(block.x+16-x,block.y+16-y);
    const dx=x-block.x-16,dy=y-block.y-16,c=Math.cos(block.rotation),s=Math.sin(block.rotation),half=block.size/2;
    return Math.hypot(Math.max(0,Math.abs(dx*c+dy*s)-half),Math.max(0,Math.abs(-dx*s+dy*c)-half));
  }
  lineHitsBlock(from,to,block,padding=this.data.relicMechanics.lineRadius) {
    const center={x:block.x+16,y:block.y+16},rotation=block.type==='boss'?block.rotation:0,c=Math.cos(rotation),s=Math.sin(rotation);
    const local=point=>({x:(point.x-center.x)*c+(point.y-center.y)*s,y:-(point.x-center.x)*s+(point.y-center.y)*c});
    const a=local(from),b=local(to),half=(block.type==='boss'?block.size:this.data.physics.size/this.data.physics.grid*this.data.physics.blockSize)/2+padding;
    let enter=0,leave=1;
    for(const axis of ['x','y']) {
      const delta=b[axis]-a[axis];
      if(Math.abs(delta)<1e-8) {if(Math.abs(a[axis])>half)return false;}
      else {const lo=(-half-a[axis])/delta,hi=(half-a[axis])/delta;enter=Math.max(enter,Math.min(lo,hi));leave=Math.min(leave,Math.max(lo,hi));}
    }
    return enter<=leave;
  }
  blockInStar(block,triangle=this.star.triangle) {
    return block.type!=='boss' && !!triangle && this.inStar({x:block.x+16,y:block.y+16},triangle);
  }
  patternTier(x, y) {
    const rotatedX = x * Math.cos(this.pattern.angle) - y * Math.sin(this.pattern.angle);
    y = (x * Math.sin(this.pattern.angle) + y * Math.cos(this.pattern.angle)) * this.pattern.mirror; x = rotatedX;
    const ax = Math.abs(x), ay = Math.abs(y), radius = Math.hypot(x, y), angle = Math.atan2(y, x);
    if (radius <= Math.sqrt(8) + 0.001) return 0;
    let band;
    switch (this.chapter.pattern) {
      case 'chevron': band = radius * 0.36 + Math.min(Math.hypot(x-3,y),Math.hypot(x+3,y)) * 0.64; break;
      case 'spiral': band = radius + Math.sin(angle * 2 + radius * 0.55 + this.pattern.phase) * 1.2; break;
      case 'facets': band = (ax + ay) * 0.67 + (x * y > 0 ? ax : ay) * 0.16; break;
      case 'corona': case 'aurora': band = radius * 0.35 + Math.max(Math.abs(x+1.2),Math.abs(y-1)) * 0.78; break;
      default: band = radius - Math.cos(angle * 4 + this.pattern.phase * 0.2) * 0.85;
    }
    const spectrum = Math.max(0, Math.min(0.999, (band - 2 + this.pattern.phase * 0.1) / 10.5));
    return Math.floor(spectrum * this.data.tierHP.length);
  }
  generateElites() {
    if (!this.level.eliteUnlock) return;
    const m = this.data.elite, center = (this.data.physics.grid-1)/2;
    const ring = Math.max(m.minAccessRing, m.minRing-(this.level.eliteAccess||0)*m.inwardPerLevel);
    const candidates = this.blocks.filter(b=>b.type==='normal' && b.ring>=ring);
    const count = Math.min(m.maxCount, m.count+(this.level.eliteChance||0)*m.countPerLevel);
    const contents = this.data.drops.filter(d=>d.elite).map(d=>d.id);
    const chosen = [];
    for(let i=0;i<count && candidates.length;i++) {
      // One treasure is always on the nearest eligible ring, close to a radial
      // route. Others remain sparse and separated, giving aiming a clear prize.
      const route = candidates.filter(b=>b.ring===ring && Math.min(Math.abs(b.gx-center),Math.abs(b.gy-center))<=1);
      const spaced = candidates.filter(b=>chosen.every(p=>Math.hypot(p.gx-b.gx,p.gy-b.gy)>=3));
      const pool = i===0 && route.length ? route : spaced.length ? spaced : candidates;
      const block = pool[Math.floor(this.random()*pool.length)];
      candidates.splice(candidates.indexOf(block),1); chosen.push(block);
      block.type='elite'; block.hp=block.maxHP=Math.round(block.maxHP*m.hpMultiplier*100)/100;
      if(block.percentDamageHP!==undefined) block.percentDamageHP=Math.round(block.percentDamageHP*m.hpMultiplier*100)/100;
      if (!contents.length) contents.push(...this.data.drops.filter(d=>d.elite).map(d=>d.id));
      block.supply=contents.splice(Math.floor(this.random()*contents.length),1)[0];
    }
  }
  get elitePower() { return 1+(this.level.elitePower||0)*this.data.elite.powerPerLevel; }
  get runPower() {
    const ordinary=Object.entries(this.activeBuffs).filter(([id])=>!this.data.drops.find(d=>d.id===id)?.elite).reduce((sum,[,n])=>sum+Number(n),0);
    return (1+ordinary*this.data.mechanics.buffDamage) * (this.activeBuffs.overdrive ? 1+(this.data.elite.overdriveDamage-1)*this.elitePower : 1);
  }
  reward(amount) {
    const value = amount * this.stats.yield * (this.shotAuto ? this.stats.idleYield : 1);
    // Carry fractional idle rewards so a 20% yield never turns small blocks into zero income.
    this.fraction = (this.fraction || 0) + value;
    const coins = Math.floor(this.fraction);
    this.fraction -= coins;
    this.profile.coins += coins;
    this.profile.earned += coins;
    this.run.coins += coins;
    return coins;
  }
  launch(angle, power = 1, automated = false) {
    if (this.pendingChapterSelection || this.state !== 'ready' || this.paused || this.boss?.phase==='waking' || this.bossVictoryLeft>0 || this.shots <= 0 || !Number.isFinite(angle) || !Number.isFinite(power)) return false;
    if (automated && !this.level.idle) return false;
    this.shotAuto = automated;
    this.run.auto ||= automated;
    this.shots--;
    this.run.shots++;
    if(this.run.bossSpawned&&!this.run.bossDefeated)this.run.bossShots++;
    this.combo = 0;
    this.mintClaimed = this.burstClaimed = this.finaleClaimed = 0;
    this.arcSplits = 0; this.rifts = [];
    this.hits = 0;
    this.nextBeam = this.beamEvery;
    this.beamAt = 0;
    this.beamArcAt = 0;
    this.activeBuffs = { ...this.buffs };
    // The resting ball eases out of the rotating sweep; its return anchor must
    // already be safe if the player launches immediately after the last shot.
    this.settleOutsideBoss(this.position);
    this.launchOrigin = { ...this.position };
    for (const bumper of this.bumpers) { bumper.charges = this.data.relicMechanics.bumperCharges; bumper.sharedCharges=(this.level.springHarvest||0)*this.data.combinations.springChargesPerLevel; bumper.starCharged=false; }
    this.returnedSplits=0; this.tetherSplits=0; this.star.casts=0;
    if (!this.star.points.length) this.addStarPoint(this.launchOrigin);
    const energy = this.stats.energy * (1 + (this.activeBuffs.boost || 0) * this.data.mechanics.boost) * Math.max(0.3, Math.min(1, power));
    this.balls = [this.makeBall(this.position.x, this.position.y, angle, energy, true)];
    this.state = 'flying';
    this.shotTime = 0;
    this.idleTime = 0;
    this.log('launch', { angle: +angle.toFixed(3), energy: Math.round(energy), auto: automated, buffs: Object.keys(this.activeBuffs) });
    this.emit('launch', { x: this.position.x, y: this.position.y });
    return true;
  }
  makeBall(x, y, angle, energy, main, depth = 0) {
    const tetherEligible=!main && this.tetherSplits < (this.level.splitTether||0)*this.data.combinations.splitParticipants;
    if(tetherEligible) this.tetherSplits++;
    const arcEligible=!main && this.arcSplits<(this.level.arcSplit||0);
    if(arcEligible) this.arcSplits++;
    return { x, y, dx: Math.cos(angle), dy: Math.sin(angle), energy, initialEnergy: energy, main, depth, splitCount: 0, portalCooldown: 0, tetherEligible, arcEligible, arcAt:0, bounceCount:0 };
  }
  // Extra ring reinforcement adds health without raising percentage attacks'
  // damage basis. Older maps and unreinforced blocks retain their exact rules.
  percentDamage(block, fraction) { return (block?.percentDamageHP ?? block?.maxHP ?? 0) * fraction; }
  weakenBoss(block, ball) {
    const boss=this.boss;
    if(!boss?.alive || boss.phase!=='active') return;
    // Clearing can weaken the guardian, but even fractional health needs a real impact to finish.
    const remaining=Math.max(Number.MIN_VALUE,boss.hp*(1-this.bossRules.clearDamageFraction));
    const damage=boss.hp-remaining;
    if(!(damage>0)) return;
    boss.hp=remaining;
    this.run.bossDamage+=damage; this.run.bossChipDamage+=damage; this.run.bossChipKills++;
    this.emit('bosshit',{id:boss.id,x:boss.x+16,y:boss.y+16,damage,remainingHP:boss.hp,maxHP:boss.maxHP,area:true,main:!!ball.main,source:'mineChip'});
    this.emit('bosschip',{x:block.x+16,y:block.y+16,tx:boss.x+16,ty:boss.y+16,damage});
  }
  damage(block, damage, ball, area = false, sourceTech) {
    if (!block?.alive || this.bossVictoryLeft>0 || (block.type==='boss'&&(block.phase!=='active'||area||ball.synthetic))) return false;
    if(block.type==='boss') damage*=this.bossRules.directDamageMultiplier;
    if(area && this.level.fracture) {
      const enhanced = damage * (1 + (1-block.hp/block.maxHP)*this.level.fracture*this.data.combinations.fractureDamage);
      const extra = Math.min(block.hp, enhanced) - Math.min(block.hp, damage);
      if (extra > 0) this.triggerTech('fracture', { x:block.x+16,y:block.y+16,blockId:block.id,amount:extra });
      damage = enhanced;
    }
    const actualDamage=Math.min(block.hp,damage);
    block.hp -= damage;
    if(block.type==='boss') {
      this.run.bossDamage+=actualDamage; this.run.bossDirectDamage+=actualDamage; this.run.bossDirectHits++;
      this.emit('bosshit',{id:block.id,x:block.x+16,y:block.y+16,damage:actualDamage,remainingHP:Math.max(0,block.hp),maxHP:block.maxHP,area,main:!!ball.main,source:sourceTech||ball.sourceTech||(area?'area':'direct')});
    }
    const dx = area ? block.x + 16 - ball.x : ball.dx, dy = area ? block.y + 16 - ball.y : ball.dy, length = Math.hypot(dx, dy) || 1;
    this.emit('hit', { id: block.id, x: block.x + 16, y: block.y + 16, dx: dx / length, dy: dy / length, damage, typeName: block.type, area });
    if (block.hp > 0) return false;
    if(block.type==='boss') {this.defeatBoss(block);return true;}
    block.alive = false;
    this.grid.delete(block.id);
    this.weakenBoss(block,ball);
    this.run.kills++;
    if (block.native !== false) this.run.cleared++;
    this.profile.totalKills++;
    this.profile.stageKills++;
    const beforeCombo = this.combo;
    if (ball.main || this.level.splitCombo) {
      this.combo += 1 + (block.type === 'gold' ? (this.level.goldCombo||0)*3 : 0) + (block.type === 'elite' ? (this.level.treasureCombo||0)*this.data.elite.comboPerLevel : 0);
      this.run.combo = Math.max(this.run.combo, this.combo);
      this.profile.bestCombo = Math.max(this.profile.bestCombo, this.combo);
      this.profile.stageCombo = Math.max(this.profile.stageCombo, this.combo);
    }
    if (block.type === 'elite' && this.combo>beforeCombo && this.level.treasureCombo) this.triggerTech('treasureCombo',{x:block.x+16,y:block.y+16,amount:this.combo-beforeCombo-1});
    if (this.level.magnet && !ball.synthetic) { ball.energy = Math.min(ball.initialEnergy * this.data.growth.magnetEnergyCap, ball.energy + this.level.magnet * this.data.growth.magnet); this.emit('magnet', { x: block.x + 16, y: block.y + 16, tx: ball.x, ty: ball.y }); }
    if(!ball.starBorn && !this.refracting) {
      this.chargeStar(ball.main ? 1 : (this.level.starSplit||0)*this.data.constellation.splitCharge, {kind:ball.main?'break':'starSplit',x:block.x+16,y:block.y+16});
      if(this.level.starCombo) {
        const thresholds=this.data.constellation.comboThresholds;
        const threshold=thresholds[Math.min(this.level.starCombo-1,thresholds.length-1)];
        const crossed=Math.floor(this.combo/threshold)-Math.floor(beforeCombo/threshold);
        for(let i=0;i<crossed;i++) this.chargeStar(this.data.constellation.comboCharge,{kind:'starCombo',x:block.x+16,y:block.y+16});
      }
    }
    const multiplier = Math.min(this.data.economy.comboRewardCap, 1 + Math.floor(this.combo / this.data.economy.comboEvery) * this.data.economy.comboBonus);
    const coins = this.reward((1 + block.ring * this.data.mechanics.ringReward) * this.chapter.reward * multiplier);
    this.emit('break', { id: block.id, x: block.x + 16, y: block.y + 16, typeName: block.type, coins, combo: this.combo, comboAdded: this.combo - beforeCombo, ring: block.ring });
    this.comboRewards(block);
    if (block.type === 'core') {
      this.run.cores++; this.profile.stageCores++;
      this.reward(this.data.mechanics.coreReward * this.chapter.reward);
      this.log('core_break', { cores: this.profile.stageCores });
      this.emit('core', { x: block.x + 16, y: block.y + 16 });
    }
    if (block.type === 'gold' || block.type === 'elite') this.drop(block);
    if ((block.type === 'gold' || block.type === 'elite') && this.profile.relics.includes('mint') && this.bumpers.length < this.data.relicMechanics.bumperMax) {
      this.bumpers.push({ x: block.x + 16, y: block.y + 16, charges: this.data.relicMechanics.bumperCharges, sharedCharges:(this.level.springHarvest||0)*this.data.combinations.springChargesPerLevel, starCharged:false, armed: false });
      this.emit('bumpergrow', { x: block.x + 16, y: block.y + 16 });
      this.log('bumper_grow', { id: block.id, count: this.bumpers.length });
    }
    if (block.type === 'bomb') this.blast(block.x + 16, block.y + 16, ball, this.stats.damage * this.runPower * this.data.mechanics.bombDamage, this.data.mechanics.bombRadius, true);
    if (!ball.starBorn && !this.refracting && (this.profile.chapter >= 3 || this.level.prism) && this.combo >= this.nextBeam && this.shotTime >= this.beamAt) {
      this.beamAt = this.shotTime + this.data.mechanics.beamCooldown;
      this.nextBeam = this.combo + this.beamEvery;
      this.emit('beam', { x: block.x + 16, y: block.y + 16 });
      this.refractStar(block.x+16,block.y+16,ball);
      for (const other of this.blocks) if (other.alive && (other.gx === block.gx || other.gy === block.gy || (other.type==='boss' && (this.lineHitsBlock({x:0,y:block.y+16},{x:this.data.physics.size,y:block.y+16},other,3) || this.lineHitsBlock({x:block.x+16,y:0},{x:block.x+16,y:this.data.physics.size},other,3))))) this.damage(other, this.stats.damage * this.runPower * this.data.mechanics.beamDamage, ball, true,'beam');
      if(this.level.beamArc && this.shotTime>=this.beamArcAt) {
        this.beamArcAt=this.shotTime+this.data.lateGame.beamArcCooldown;
        const strength=this.level.beamArc*this.data.lateGame.beamArcPerLevel+(this.activeBuffs.arc ? this.data.lateGame.beamArcBuffBonus : 0);
        this.chainArc({...ball,x:block.x+16,y:block.y+16},strength,'beamArc');
      }
    }
    return true;
  }
  comboRewards(block) {
    const m=this.data.combo, x=block.x+16,y=block.y+16;
    const reached=Math.floor(this.combo/m.mintEvery), previous=Math.floor(this.mintClaimed/m.mintEvery);
    // Claim before issuing effects: a single collision can synchronously break
    // dozens of bricks, and none may cash the same combo threshold twice.
    this.mintClaimed=reached*m.mintEvery;
    if (this.level.comboMint && reached>previous) {
      const count=reached-previous;
      const coins=this.reward((previous+1+reached)*count/2*m.mintEvery*this.chapter.reward*m.mintPerCombo*this.level.comboMint);
      this.run.comboCoins+=coins;
      this.emit('dividend',{x,y,coins,combo:reached*m.mintEvery,count});
      this.triggerTech('comboMint',{x,y,amount:coins,count});
      if(this.level.mintStar) {
        const charged=this.chargeStar(count*this.level.mintStar*m.mintStarCharge,{kind:'mintStar',x,y});
        if(charged) this.triggerTech('mintStar',{x,y,amount:charged});
      }
    }
  }
  comboAttacks(ball, area=false) {
    if(area || ball.synthetic || ball.starBorn || this.refracting) return;
    const m=this.data.combo,{x,y}=ball;
    const burst=Math.floor(this.combo/m.burstEvery),finale=Math.floor(this.combo/m.finaleEvery);
    const doBurst=!!this.level.comboBurst && burst>this.burstClaimed;
    const doFinale=this.profile.chapter>=4 && finale>this.finaleClaimed;
    // Capture both thresholds before either attack. Their collateral kills can
    // only unlock another effect at the next real contact, never recursively.
    if(doBurst) this.burstClaimed=burst;
    if(doFinale) this.finaleClaimed=finale;
    const source={x,y,dx:0,dy:0,main:ball.main,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
    if (doBurst) {
      this.triggerTech('comboBurst',{x,y,combo:this.combo});
      this.blast(x,y,source,this.stats.damage*this.runPower*m.burstDamage*this.level.comboBurst,m.burstRadius,false,'comboBurst');
    }
    if (doFinale) {
      const size=this.data.physics.size,segments=[];
      for(const slope of [-1,1]) {
        const endpoints=[];
        for(const px of [0,size]) { const py=y+slope*(px-x); if(py>=0&&py<=size) endpoints.push({x:px,y:py}); }
        for(const py of [0,size]) { const px=x+(py-y)/slope; if(px>=0&&px<=size&&!endpoints.some(p=>Math.hypot(p.x-px,p.y-py)<.01)) endpoints.push({x:px,y:py}); }
        if(endpoints.length>=2) segments.push({x:endpoints[0].x,y:endpoints[0].y,tx:endpoints[1].x,ty:endpoints[1].y});
      }
      const before=this.run.kills;
      for(const target of this.blocks) if(target.alive && (target.type==='boss' ? segments.some(segment=>this.lineHitsBlock(segment,{x:segment.tx,y:segment.ty},target,this.data.physics.size/this.data.physics.grid*.6)) : Math.min(Math.abs((target.x+16-x)-(target.y+16-y)),Math.abs((target.x+16-x)+(target.y+16-y)))/Math.SQRT2<=this.data.physics.size/this.data.physics.grid*.6)) {
        this.damage(target,this.stats.damage*this.runPower*m.finaleDamage+this.percentDamage(target,m.finaleHPDamage),source,true,'finale');
      }
      this.run.finales++;
      this.emit('finale',{x,y,segments,kills:this.run.kills-before});
      this.log('finale',{combo:this.combo,kills:this.run.kills-before});
      if(this.level.finaleSalvo) {
        const late=this.data.lateGame,strength=1+(this.level.finaleSalvo-1)*late.finaleSalvoPowerPerLevel;
        const origins=segments.flatMap(s=>[{x:s.x,y:s.y},{x:s.tx,y:s.ty}]);
        const projectiles=this.fireSalvo(origins.length?origins:[{x,y}],late.finaleSalvoBase+this.level.finaleSalvo*late.finaleSalvoPerLevel,this.stats.damage*this.runPower*late.finaleSalvoDamage*strength,late.finaleSalvoHPDamage*strength,'finaleSalvo');
        if(projectiles) this.triggerTech('finaleSalvo',{x,y,projectiles});
      }
    }
  }
  blast(x, y, ball, damage, radius = this.data.mechanics.shockRadius, bomb = false, tech) {
    radius *= 1 + (this.level.reactor || 0) * this.data.growth.reactorRadius;
    damage *= 1 + (this.level.reactor || 0) * this.data.growth.reactorDamage;
    this.emit('shock', { x, y, radius, bomb, tech });
    for (const block of this.blocks) if (block.alive && this.blockDistance(block,x,y) <= radius) this.damage(block, damage, ball, true,tech||(bomb?'bomb':'shock'));
  }
  rollChest() {
    // Contents are chosen once with the map: manual play, idle and sight share the same loot.
    const pool = this.data.drops.filter(d => !d.elite && (d.id !== 'charge' || (this.generatedCharges < this.data.mechanics.extraShotsCap && this.stats.shots < this.data.economy.maxShotsPerRun)));
    const total = pool.reduce((sum, d) => sum + d.weight, 0);
    let roll = this.random() * total;
    const item = pool.find(d => (roll -= d.weight) <= 0) || this.data.drops[0];
    if (item.id === 'charge') this.generatedCharges++;
    return item.id;
  }
  drop(block) {
    if (block.type !== 'gold' && block.type !== 'elite') return;
    let item = this.data.drops.find(d => d.id === block.supply) || this.data.drops[0];
    const original=item, elite=block.type==='elite', cap=item.cap||this.data.mechanics.buffCap;
    const duplicate=item.stackable && (this.buffs[item.id]||0)>=cap;
    if (duplicate) item = this.data.drops[0];
    this.run.drops++;
    if (!this.profile.seenDrops.includes(item.id)) this.profile.seenDrops.push(item.id);
    if (block.type === 'gold') this.run.supplies = (this.run.supplies || 0) + 1;
    if (elite) this.run.elites++;
    if (item.stackable) this.buffs[item.id] = Math.min(item.cap||this.data.mechanics.buffCap, (this.buffs[item.id] || 0) + 1);
    let coins=0;
    if (item.id === 'cache') coins=this.reward((elite ? this.data.elite.duplicateValue*this.elitePower : item.value) * this.chapter.reward);
    if (item.id === 'charge') {
      const max = this.data.economy.maxShotsPerRun - this.run.shots;
      if (this.shots >= max || this.run.charges >= this.data.mechanics.extraShotsCap) this.reward(this.data.drops[0].value * this.chapter.reward);
      else { this.run.charges++; this.shots = Math.min(max, this.shots + item.value); }
    }
    if (item.id === 'lucky') this.spawnLucky(item.value);
    this.emit('drop', { id: item.id, x: block.x + 16, y: block.y + 16, level: this.buffs[item.id] || 0, supply: true, elite, duplicate, coins });
    if(elite) {
      this.emit('eliteopen',{x:block.x+16,y:block.y+16,id:original.id,duplicate,coins});
      if(this.level.eliteSeeds) {
        const count=this.spawnLucky(this.level.eliteSeeds*this.data.elite.seedsPerLevel,{x:block.x+16,y:block.y+16});
        if(count) this.triggerTech('eliteSeeds',{x:block.x+16,y:block.y+16,count});
      }
    }
    this.log('drop', { id: item.id, source: elite ? 'elite' : 'chest', level: this.buffs[item.id] || 0, duplicate, coins });
  }
  spawnLucky(count, origin) {
    const cap=this.data.economy.maxLuckyBlocks+(this.level.eliteSeeds||0)*this.data.elite.seedsPerLevel;
    count = Math.min(count, cap - this.blocks.filter(b => b.alive && b.type === 'gold' && b.native === false).length);
    const n = this.data.physics.grid, size = this.data.physics.size / n;
    const empty = [];
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const id = y * n + x, px = x * size + 16, py = y * size + 16;
      if(this.boss?.alive && Math.hypot(px-this.boss.x-16,py-this.boss.y-16)<this.boss.size/Math.SQRT2+size/Math.SQRT2+this.data.boss.clearance) continue;
      if (!this.grid.has(id) && !this.bumpers.some(b => Math.hypot(px-b.x,py-b.y)<size) && Math.hypot(px-this.launchOrigin.x,py-this.launchOrigin.y)>38 && Math.hypot(px - this.position.x, py - this.position.y) > 38 && !this.balls.some(b => Math.hypot(px - b.x, py - b.y) < 40) && !this.portals?.some(p => Math.hypot(px - p.x, py - p.y) < 30)) empty.push({ id, gx: x, gy: y, x: x * size, y: y * size });
    }
    let spawned=0;
    if(origin) empty.sort((a,b)=>Math.hypot(a.x+16-origin.x,a.y+16-origin.y)-Math.hypot(b.x+16-origin.x,b.y+16-origin.y));
    for (let i = 0; i < count && empty.length; i++) {
      const index = origin ? Math.floor(this.random()*Math.min(6,empty.length)) : Math.floor(this.random() * empty.length), cell = empty.splice(index, 1)[0];
      const hp = this.chapter.hp * this.data.mechanics.supplyHP;
      const options = this.data.drops.filter(d => d.stackable && !d.elite && (this.buffs[d.id] || 0) < this.data.mechanics.buffCap);
      const supply = options.length ? options[Math.floor(this.random() * options.length)].id : 'cache';
      const block = { ...cell, ring: 2, tier: 0, hp, maxHP: hp, type: 'gold', supply, native: false, loot: 0, alive: true };
      const old = this.blocks.findIndex(b => b.id === block.id);
      if (old >= 0) this.blocks[old] = block; else this.blocks.push(block);
      this.grid.set(block.id, block);
      spawned++;
      this.emit('spawn', { id: block.id, x: block.x + 16, y: block.y + 16, elite:!!origin, from:origin });
    }
    return spawned;
  }
  collide(ball, block) {
    if(block.type==='boss') return this.collideBoss(ball,block);
    const { blockSize, size, grid, radius } = this.data.physics, width = size / grid, gap = width * (1 - blockSize);
    const left = block.x + gap / 2, top = block.y + gap / 2, right = block.x + width - gap / 2, bottom = block.y + width - gap / 2;
    const qx = Math.max(left, Math.min(right, ball.x)), qy = Math.max(top, Math.min(bottom, ball.y));
    let nx = ball.x - qx, ny = ball.y - qy, distance = Math.hypot(nx, ny);
    if (distance >= radius) return false;
    const outside = distance > 0.0001 && (ball.x + nx / distance * (radius - distance + 0.05) < radius || ball.x + nx / distance * (radius - distance + 0.05) > size - radius || ball.y + ny / distance * (radius - distance + 0.05) < radius || ball.y + ny / distance * (radius - distance + 0.05) > size - radius);
    if (distance < 0.0001 || outside) {
      const edges = [{ d: ball.x - left, x: -1, y: 0 }, { d: right - ball.x, x: 1, y: 0 }, { d: ball.y - top, x: 0, y: -1 }, { d: bottom - ball.y, x: 0, y: 1 }];
      // Boundary bricks have no playable space behind their outer face. Resolve into the arena.
      const edge = edges.filter(e => {
        const x = ball.x + e.x * (radius + e.d + 0.05), y = ball.y + e.y * (radius + e.d + 0.05);
        return x >= radius && x <= size - radius && y >= radius && y <= size - radius;
      }).sort((a, b) => a.d - b.d)[0];
      if (!edge) return false;
      nx = edge.x; ny = edge.y; distance = -edge.d;
    } else { nx /= distance; ny /= distance; }
    return this.resolveContact(ball,block,nx,ny,distance,radius);
  }
  collideBoss(ball,block) {
    const contact=this.bossContact(ball,block);
    return contact ? this.resolveContact(ball,block,contact.nx,contact.ny,contact.distance,contact.radius) : false;
  }
  bossContact(ball,block) {
    if(!block.alive || block.phase!=='active') return false;
    const c=Math.cos(block.rotation),s=Math.sin(block.rotation),half=block.size/2,radius=this.data.physics.radius;
    const dx=ball.x-block.x-16,dy=ball.y-block.y-16,x=dx*c+dy*s,y=-dx*s+dy*c;
    let nx=x-Math.max(-half,Math.min(half,x)),ny=y-Math.max(-half,Math.min(half,y)),distance=Math.hypot(nx,ny);
    if(distance>=radius) return false;
    if(distance<.0001) {
      if(half-Math.abs(x)<half-Math.abs(y)) {nx=x>=0?1:-1;ny=0;distance=-(half-Math.abs(x));}
      else {nx=0;ny=y>=0?1:-1;distance=-(half-Math.abs(y));}
    } else {nx/=distance;ny/=distance;}
    return {nx:nx*c-ny*s,ny:nx*s+ny*c,distance,radius};
  }
  resolveContact(ball,block,nx,ny,distance,radius) {
    const approaching = ball.dx * nx + ball.dy * ny;
    const m = this.data.mechanics;
    const damage = this.stats.damage * this.runPower * (1 + Math.min(m.comboDamageCap, this.combo * m.comboDamage) * (this.level.combo || 0)) * (ball.main ? 1 : m.splitDamage * (1 + Math.max(0, (this.activeBuffs.split || 1) - 1) * m.splitStackDamage));
    const destroyed = approaching < 0 ? this.damage(block, damage, ball) : false;
    const piercing = destroyed && ball.main && this.activeBuffs.pierce;
    if (!piercing) {
      ball.x += nx * (radius - distance + 0.05);
      ball.y += ny * (radius - distance + 0.05);
      if (approaching < 0) { ball.dx -= 2 * approaching * nx; ball.dy -= 2 * approaching * ny; }
    } else this.emit('pierce', { x: ball.x, y: ball.y, dx: ball.dx, dy: ball.dy });
    if (approaching >= 0) return true;
    this.consumeImpactEnergy(ball, this.data.physics.hitCost);
    this.bounceEffects(ball, !piercing);
    return true;
  }
  bounceEffects(ball, reflected = true) {
    if(this.bossVictoryLeft>0) return;
    const m = this.data.mechanics;
    ball.bounceCount=(ball.bounceCount||0)+1;
    if (ball.main) this.hits++;
    if(ball.main && !ball.starBorn) {
      if(this.hits%this.data.constellation.pointEvery===0) this.addStarPoint(ball);
      this.chargeStar(this.data.constellation.impactCharge,{kind:'impact',x:ball.x,y:ball.y});
    }
    if (!ball.synthetic && !ball.starBorn && this.activeBuffs.arc && (ball.main || ball.arcEligible) && ball.bounceCount%this.data.elite.arcEvery===0 && this.shotTime>=(ball.arcAt||0)) this.chainArc(ball);
    if (ball.main && !ball.synthetic && this.activeBuffs.rift && ball.bounceCount%this.data.elite.riftEvery===0) this.openRift(ball.x,ball.y);
    if ((ball.main || ball.tetherEligible) && reflected && this.profile.relics.includes('heart') && this.shotTime >= (ball.tetherAt || 0)) {
      ball.tetherAt = this.shotTime + this.data.relicMechanics.tetherCooldown;
      this.cutLine(this.launchOrigin, ball, ball, this.stats.damage * this.runPower * (ball.main ? this.data.relicMechanics.tetherDamage : this.data.combinations.splitTetherDamage),undefined,ball.main?'heart':'splitTether');
      this.emit('tether', { x: this.launchOrigin.x, y: this.launchOrigin.y, tx: ball.x, ty: ball.y, split: !ball.main });
      if(!ball.main) this.triggerTech('splitTether',{x:ball.x,y:ball.y,tx:this.launchOrigin.x,ty:this.launchOrigin.y});
      this.run.relicTriggers.heart++;
    }
    if (ball.main && (this.activeBuffs.shock || (this.level.shock && this.hits % Math.max(2,m.shockEvery-this.level.shock+1) === 0))) this.blast(ball.x, ball.y, ball, this.stats.damage * this.runPower * m.shockDamage, m.shockRadius * (1 + Math.max(0, (this.activeBuffs.shock || 1) - 1) * m.shockStackRadius));
    if(!ball.main && this.level.splitShock && ball.bounceCount%this.data.combinations.splitShockEvery===0) {
      this.blast(ball.x,ball.y,ball,this.stats.damage*this.runPower*this.level.splitShock*this.data.combinations.splitShockDamage,m.shockRadius,false,'splitShock');
      this.triggerTech('splitShock',{x:ball.x,y:ball.y});
    }
    const canSplit = ball.main ? (this.activeBuffs.split || (this.level.split && ball.splitCount < m.permanentSplits*this.level.split)) : (this.level.chain && ball.depth < m.splitDepth+this.level.chain-1 && ball.splitCount < 1);
    if (canSplit && this.balls.length < this.data.physics.maxBalls && ball.energy > m.splitMinEnergy) {
      const a = Math.atan2(ball.dy, ball.dx) + (this.random() > 0.5 ? 1 : -1) * (0.45 + this.random() * 0.6);
      const child=this.makeBall(ball.x, ball.y, a, Math.min(m.splitEnergy, ball.energy * m.splitFraction), false, ball.depth + 1); child.starBorn=!!ball.starBorn; this.balls.push(child);
      ball.splitCount++;
      this.emit('split', { x: ball.x, y: ball.y });
    }
    // All physical contacts arrive here, including phase-piercing hits that do
    // not reflect the ball. Area damage never calls this path.
    this.comboAttacks(ball);
  }
  chainArc(ball, strength=1, tech) {
    const m=this.data.elite,points=[{x:ball.x,y:ball.y}],seen=new Set(),before=this.run.kills;
    let origin=points[0];
    ball.arcAt=this.shotTime+m.arcCooldown;
    for(let i=0;i<m.arcTargets;i++) {
      const target=this.blocks.filter(b=>b.alive&&b.type!=='boss'&&!seen.has(b.id)&&this.blockDistance(b,origin.x,origin.y)<=m.arcRange).sort((a,b)=>this.blockDistance(a,origin.x,origin.y)-this.blockDistance(b,origin.x,origin.y))[0];
      if(!target) break;
      seen.add(target.id);
      const point={x:target.x+16,y:target.y+16}; points.push(point);
      const source={...origin,dx:point.x-origin.x,dy:point.y-origin.y,main:ball.main,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
      this.damage(target,(this.stats.damage*this.runPower*m.arcDamage+this.percentDamage(target,m.arcHPDamage))*this.elitePower*strength,source,true,tech||'arc');
      origin=point;
    }
    if(points.length<2) return;
    this.run.arcs++;
    this.emit('arc',{points,targets:seen.size,kills:this.run.kills-before,split:!ball.main,tech});
    if(tech) this.triggerTech(tech,{x:ball.x,y:ball.y,targets:seen.size,kills:this.run.kills-before});
    else if(!ball.main) this.triggerTech('arcSplit',{x:ball.x,y:ball.y,targets:seen.size});
    this.log('arc',{targets:seen.size,kills:this.run.kills-before,split:!ball.main,tech});
  }
  openRift(x,y,echo=false,tech) {
    if(this.bossVictoryLeft>0) return null;
    const m=this.data.elite;
    if(this.rifts.length>=m.riftMax && !echo && !tech) return null;
    const extension=echo ? 1+Math.max(0,(this.level.riftEcho||1)-1)*m.riftEchoGrowth : 1;
    const duration=m.riftDuration*extension;
    const strength=tech==='starRift' ? 1+this.level.starRift*this.data.lateGame.starRiftPerLevel : 1;
    const radiusScale=tech==='starRift' ? 1+this.level.starRift*this.data.lateGame.starRiftRadiusPerLevel : 1;
    const rift={x,y,left:duration,duration,pulse:m.riftInterval,radius:m.riftRadius*extension*radiusScale,damage:this.stats.damage*this.runPower*m.riftDamage*this.elitePower*strength,hpDamage:m.riftHPDamage*this.elitePower*strength,echo,tech};
    if(this.rifts.length>=m.riftMax) this.rifts.shift();
    this.rifts.push(rift);
    this.emit('riftopen',{...rift});
    this.log('rift_open',{x:Math.round(x),y:Math.round(y),radius:rift.radius,duration,echo,tech});
    if(echo) this.triggerTech('riftEcho',{x,y,radius:rift.radius});
    if(tech) this.triggerTech(tech,{x,y,radius:rift.radius});
    return rift;
  }
  updateRifts(dt) {
    for(const rift of this.rifts) {
      rift.left-=dt; rift.pulse-=dt;
      while(rift.pulse<=1e-8 && rift.left>=-1e-8) {
        rift.pulse+=this.data.elite.riftInterval;
        const source={x:rift.x,y:rift.y,dx:0,dy:0,main:true,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
        const before=this.run.kills; let targets=0;
        for(const block of this.blocks) if(block.alive&&block.type!=='boss'&&this.blockDistance(block,rift.x,rift.y)<=rift.radius) {
          targets++; this.damage(block,rift.damage+this.percentDamage(block,rift.hpDamage),source,true,rift.tech||(rift.echo?'riftEcho':'rift'));
        }
        this.run.riftPulses++;
        this.emit('riftpulse',{x:rift.x,y:rift.y,radius:rift.radius,left:Math.max(0,rift.left),duration:rift.duration,targets,kills:this.run.kills-before,echo:rift.echo,tech:rift.tech});
      }
    }
    const expired=this.rifts.filter(r=>r.left<=1e-8);
    this.rifts=this.rifts.filter(r=>r.left>1e-8);
    // Only natural expiry collapses a field. Replacing one cannot recursively
    // detonate the next field or accelerate the fixed per-shot time budget.
    if(this.level.riftCollapse) for(const rift of expired) {
      const before=this.run.kills,rank=this.level.riftCollapse,late=this.data.lateGame;
      const source={x:rift.x,y:rift.y,dx:0,dy:0,main:true,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
      let targets=0;
      for(const block of this.blocks) if(block.alive&&block.type!=='boss'&&this.blockDistance(block,rift.x,rift.y)<=rift.radius) {
        targets++;
        this.damage(block,rift.damage*rank*late.riftCollapsePerLevel+this.percentDamage(block,rank*late.riftCollapseHPPerLevel),source,true,'riftCollapse');
      }
      this.emit('riftcollapse',{x:rift.x,y:rift.y,radius:rift.radius,targets,kills:this.run.kills-before,tech:'riftCollapse'});
      this.triggerTech('riftCollapse',{x:rift.x,y:rift.y,targets,kills:this.run.kills-before});
      this.log('rift_collapse',{targets,kills:this.run.kills-before,rank});
    }
  }
  chargeStar(amount, source = {}) {
    if(!this.level.constellation || this.refracting || amount<=0) return 0;
    const before=this.star.charge;
    this.star.charge=Math.min(this.data.constellation.maxCharge,before+amount);
    const gained=this.star.charge-before;
    if(gained<=0) return 0;
    const {kind='break',x=this.position.x,y=this.position.y}=source;
    const points=this.star.triangle || this.star.points;
    const target=points.length ? points.reduce((near,p)=>Math.hypot(p.x-x,p.y-y)<Math.hypot(near.x-x,near.y-y)?p:near) : this.launchOrigin;
    this.emit('starfeed',{kind,x,y,tx:target.x,ty:target.y,amount:gained,charge:this.star.charge});
    if(['starCombo','starSplit','starBumper','starReturn'].includes(kind)) this.triggerTech(kind,{x,y,amount:gained});
    return gained;
  }
  inStar(point, triangle=this.star.triangle) {
    if(!triangle) return false;
    const [a,b,c]=triangle;
    if(Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))<1e-7) return false;
    const signs=triangle.map((a,i)=>{const b=triangle[(i+1)%3];return (b.x-a.x)*(point.y-a.y)-(b.y-a.y)*(point.x-a.x);});
    return signs.every(s=>s>=-1e-7) || signs.every(s=>s<=1e-7);
  }
  crossesStar(from,to) {
    const triangle=this.star.triangle;
    if(!triangle) return false;
    if(this.inStar(from)||this.inStar(to)) return true;
    return triangle.some((a,i)=>{
      const b=triangle[(i+1)%3],rx=to.x-from.x,ry=to.y-from.y,sx=b.x-a.x,sy=b.y-a.y,den=rx*sy-ry*sx;
      if(Math.abs(den)<1e-8) return false;
      const t=((a.x-from.x)*sy-(a.y-from.y)*sx)/den,u=((a.x-from.x)*ry-(a.y-from.y)*rx)/den;
      return t>=0&&t<=1&&u>=0&&u<=1;
    });
  }
  addStarPoint(point) {
    if(!this.level.constellation || this.star.triangle || this.star.pending>0) return;
    const m=this.data.constellation,points=this.star.points;
    if(points.some(p=>Math.hypot(p.x-point.x,p.y-point.y)<m.minSpacing)) return;
    points.push({x:point.x,y:point.y}); if(points.length>3) points.shift();
    this.emit('starpoint',{x:point.x,y:point.y});
    if(points.length<3) return;
    const [a,b,c]=points,area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
    if(area<m.minArea) return;
    const center={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3},size=this.data.physics.size;
    const expansion=Math.max(m.expansion,Math.sqrt(m.minFieldArea/area));
    const triangle=points.map(p=>({x:Math.max(8,Math.min(size-8,center.x+(p.x-center.x)*expansion)),y:Math.max(8,Math.min(size-8,center.y+(p.y-center.y)*expansion))}));
    const [ta,tb,tc]=triangle;
    if(Math.abs((tb.x-ta.x)*(tc.y-ta.y)-(tb.y-ta.y)*(tc.x-ta.x))/2<m.minArea) return;
    if(!this.blocks.some(b=>b.alive&&this.blockInStar(b,triangle))) return;
    this.star.triangle=triangle;
    this.log('star_formed',{points:points.map(p=>({x:Math.round(p.x),y:Math.round(p.y)}))});
    this.emit('starformed',{triangle});
  }
  updateStar(dt) {
    const arrived=[];
    for(const bolt of this.star.volley) {
      if(!this.grid.has(bolt.targetId)||this.grid.get(bolt.targetId).type==='boss') {
        const progress=Math.max(0,Math.min(1,1-bolt.left/bolt.duration));
        const x=bolt.x+(bolt.tx-bolt.x)*progress,y=bolt.y+(bolt.ty-bolt.y)*progress;
        const reserved=new Set(this.star.volley.filter(b=>b!==bolt).map(b=>b.targetId));
        const target=this.blocks.filter(b=>b.alive&&b.type!=='boss'&&!reserved.has(b.id)).sort((a,b)=>Math.hypot(a.x+16-x,a.y+16-y)-Math.hypot(b.x+16-x,b.y+16-y))[0];
        if(target) {
          bolt.x=x; bolt.y=y; bolt.tx=target.x+16; bolt.ty=target.y+16; bolt.targetId=target.id; bolt.duration=bolt.left;
          bolt.damage=bolt.baseDamage+this.percentDamage(target,bolt.hpDamage);
        }
      }
      bolt.left-=dt; if(bolt.left<=0) arrived.push(bolt);
    }
    this.star.volley=this.star.volley.filter(b=>b.left>0);
    for(const bolt of arrived) {
      const block=this.grid.get(bolt.targetId);
      if(!block?.alive||block.type==='boss') continue;
      const source={x:bolt.x,y:bolt.y,dx:bolt.tx-bolt.x,dy:bolt.ty-bolt.y,main:true,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
      const killed=this.damage(block,bolt.damage,source,true,bolt.tech||'starSalvo');
      this.emit('starsalvohit',{x:bolt.tx,y:bolt.ty,killed:!!killed,tech:bolt.tech});
    }
    if(!this.level.constellation || this.bossVictoryLeft>0) return;
    const star=this.star,m=this.data.constellation;
    star.cooldown=Math.max(0,star.cooldown-dt);
    if(star.pending>0) { star.pending=Math.max(0,star.pending-dt); if(!star.pending) this.collapseStar(); return; }
    if(!star.triangle || star.casts>=this.starCastLimit || star.cooldown>0) return;
    if(!this.blocks.some(b=>b.alive&&this.blockInStar(b))) { star.triangle=null; return; }
    const tail=this.level.starSalvo ? m.salvoDuration : 0;
    if(star.charge>=m.chargeRequired && this.shotTime+m.windup+tail+this.data.physics.step<this.data.physics.maxShotTime+this.data.relicMechanics.returnMaxTime) { star.charge-=m.chargeRequired; star.pending=m.windup; star.damage=this.stats.damage*this.runPower*m.damage; this.emit('starwindup',{triangle:star.triangle}); }
  }
  collapseStar() {
    const star=this.star,triangle=star.triangle,points=star.points.map(p=>({...p}));
    if(!triangle) return;
    const center={x:triangle.reduce((s,p)=>s+p.x,0)/3,y:triangle.reduce((s,p)=>s+p.y,0)/3};
    const source={...center,dx:0,dy:0,main:true,energy:0,initialEnergy:0,synthetic:true,starBorn:true};
    star.triangle=null; star.points=[]; star.casts++; star.cooldown=this.data.constellation.cooldown;
    const before=this.run.kills;
    let hits=0;
    for(const block of this.blocks) if(block.alive&&this.blockInStar(block,triangle)) { hits++; this.damage(block,star.damage+this.percentDamage(block,this.data.constellation.hpDamage),source,true,'constellation'); }
    this.run.starBursts++;
    this.emit('starcollapse',{triangle,x:center.x,y:center.y,hits,kills:this.run.kills-before});
    this.triggerTech('constellation',{x:center.x,y:center.y,hits,kills:this.run.kills-before});
    this.log('star_collapse',{hits,kills:this.run.kills-before,cast:star.casts,damage:Math.round(star.damage)});
    if(this.level.starRift) this.openRift(center.x,center.y,false,'starRift');
    const projectiles=this.fireSalvo(points.length?points:triangle,(this.level.starSalvo||0)*this.data.constellation.salvoPerLevel,this.stats.damage*this.runPower*this.data.constellation.salvoDamage,this.data.constellation.salvoHPDamage,'starSalvo');
    if(projectiles) this.triggerTech('starSalvo',{x:center.x,y:center.y,projectiles});
  }
  fireSalvo(origins,count,baseDamage,hpDamage,tech) {
    if(this.bossVictoryLeft>0) return 0;
    const duration=this.data.constellation.salvoDuration;
    if(!origins.length || !(this.shotTime+duration<=this.data.physics.maxShotTime+this.data.relicMechanics.returnMaxTime)) return 0;
    const reserved=new Set(this.star.volley.map(b=>b.targetId));
    const targets=this.blocks.filter(b=>b.alive&&b.type!=='boss'&&!reserved.has(b.id));
    const capacity=Math.max(0,(this.data.constellation.maxProjectiles??24)-this.star.volley.length);
    let projectiles=0;
    for(let i=0;i<Math.min(count,capacity)&&targets.length;i++) {
      const p=origins[i%origins.length];
      targets.sort((a,b)=>Math.hypot(a.x+16-p.x,a.y+16-p.y)-Math.hypot(b.x+16-p.x,b.y+16-p.y));
      const target=targets.shift();
      const bolt={x:p.x,y:p.y,tx:target.x+16,ty:target.y+16,targetId:target.id,left:duration,duration,baseDamage,hpDamage,damage:baseDamage+this.percentDamage(target,hpDamage),tech};
      this.star.volley.push(bolt); this.emit('starsalvo',{...bolt}); projectiles++;
    }
    return projectiles;
  }
  refractStar(x,y,ball) {
    if(!this.level.starPrism || !this.star.triangle || this.refracting || (!this.crossesStar({x:0,y},{x:this.data.physics.size,y})&&!this.crossesStar({x,y:0},{x,y:this.data.physics.size}))) return;
    const triangle=this.star.triangle,seen=[];
    this.refracting=true;
    try { for(let i=0;i<3;i++) this.cutLine(triangle[i],triangle[(i+1)%3],ball,this.stats.damage*this.runPower*this.level.starPrism*this.data.constellation.prismDamage,seen,'starPrism'); }
    finally { this.refracting=false; }
    this.emit('starrefract',{triangle});
    this.triggerTech('starPrism',{x,y});
  }
  speedForEnergy(energy) {
    const p = this.data.physics;
    const remaining = Math.max(0, Math.min(1, (p.maxShotTime - (this.shotTime || 0)) / p.softStopTime));
    // Rolling energy follows v²; the shot limit eases down before its deadline.
    return Math.min(p.maxSpeed, p.speed * Math.sqrt(Math.max(0, energy) / p.energy)) * remaining * remaining * (3 - 2 * remaining);
  }
  consumeRollingEnergy(ball, dt) {
    const p = this.data.physics;
    let speed = p.speed * Math.sqrt(Math.max(0, ball.energy) / p.energy);
    // Drag only affects upgraded speeds; base shots keep their gentle, finite stop.
    // Integrating the excess separately keeps even huge saved energies stable.
    const excess = Math.max(0, speed - p.speed);
    speed -= excess - excess / (1 + (p.highSpeedDrag || 0) * excess * dt);
    speed = Math.max(0, speed - p.rollingDeceleration * dt);
    ball.energy = p.energy * (speed / p.speed) ** 2;
  }
  consumeImpactEnergy(ball, cost) {
    ball.energy -= Math.min(cost, Math.max(0, ball.energy) * this.data.physics.lowEnergyLossRatio);
  }
  cutLine(from, to, ball, damage, seen, tech) {
    for (const block of this.blocks) {
      if (!block.alive || seen?.includes(block.id)) continue;
      if (this.lineHitsBlock(from,to,block)) { seen?.push(block.id); this.damage(block, damage, ball, true,tech); }
    }
  }
  beginReturn(ball) {
    ball.returning = true; ball.returned = true; ball.returnHits = []; ball.energy = 1;
    if(!ball.main) this.returnedSplits++;
    if(!ball.main) this.triggerTech('returnFormation',{x:ball.x,y:ball.y,tx:this.launchOrigin.x,ty:this.launchOrigin.y});
    if(!ball.starBorn && !ball.starCharged && this.level.starReturn) {
      ball.starCharged=true;
      this.addStarPoint(ball);
      this.chargeStar(this.level.starReturn*this.data.constellation.returnCharge,{kind:'starReturn',x:ball.x,y:ball.y});
    }
    this.run.relicTriggers.echo++;
    this.log('return_start', { x: +ball.x.toFixed(1), y: +ball.y.toFixed(1), origin: this.launchOrigin });
    this.emit('return', { x: ball.x, y: ball.y, tx: this.launchOrigin.x, ty: this.launchOrigin.y, split: !ball.main });
  }
  updateReturn(ball, dt) {
    const from = { x: ball.x, y: ball.y }, dx = this.launchOrigin.x-ball.x, dy = this.launchOrigin.y-ball.y, distance = Math.hypot(dx,dy);
    const step = Math.min(distance, this.data.relicMechanics.returnSpeed * dt);
    ball.dx = dx/(distance || 1); ball.dy = dy/(distance || 1);
    ball.x += ball.dx*step; ball.y += ball.dy*step;
    this.cutLine(from, ball, ball, this.stats.damage*this.runPower*(ball.main ? this.data.relicMechanics.returnDamage : this.data.combinations.returnFormationDamage), ball.returnHits,ball.main?'echo':'returnFormation');
    if(ball.main) this.position = { x: ball.x, y: ball.y };
    if (distance <= step) {
      ball.returning = false;
      this.emit('returnend', { x: ball.x, y: ball.y });
      if (ball.main && this.activeBuffs.rift && this.level.riftEcho) this.openRift(ball.x,ball.y,true);
      if (ball.main && this.fusion) {
        for (const bumper of [...this.bumpers]) {
          this.cutLine(ball, bumper, ball, this.stats.damage*this.runPower*this.data.relicMechanics.fusionDamage,undefined,'fusion');
          this.emit('tether', { x: ball.x, y: ball.y, tx: bumper.x, ty: bumper.y, fusion: true });
        }
        this.run.relicTriggers.fusion++;
      }
      // Harvested energy belongs to outbound flight; it must not resurrect an arrived ball.
      ball.energy = 0;
    }
  }
  collideBumpers(ball) {
    const m = this.data.relicMechanics, radius = m.bumperRadius + this.data.physics.radius;
    for (const bumper of this.bumpers) {
      if (!bumper.armed) continue;
      const dx = ball.x-bumper.x, dy = ball.y-bumper.y, distance = Math.hypot(dx,dy);
      // A newly grown bumper only catches a ball travelling into it, never the ball leaving its box.
      if (distance >= radius || distance < 0.001) continue;
      const nx=dx/distance, ny=dy/distance, approaching=ball.dx*nx+ball.dy*ny;
      if (approaching >= 0) continue;
      ball.x=bumper.x+nx*(radius+.05); ball.y=bumper.y+ny*(radius+.05);
      ball.dx-=2*approaching*nx; ball.dy-=2*approaching*ny;
      const charged = ball.main ? bumper.charges > 0 : (bumper.sharedCharges||0)>0;
      let actualEnergy=0;
      if (charged) {
        if(ball.main) bumper.charges--; else bumper.sharedCharges--;
        const before=ball.energy;
        ball.energy=Math.min(ball.initialEnergy,ball.energy+(ball.main ? m.bumperEnergy : this.data.combinations.splitSpringEnergy)); actualEnergy=Math.max(0,ball.energy-before);
        if(actualEnergy>0) { this.run.relicTriggers.mint++; if(!ball.main) this.triggerTech('springHarvest',{x:bumper.x,y:bumper.y,amount:actualEnergy}); }
        if(ball.main && this.level.starBumper && !bumper.starCharged) { bumper.starCharged=true; this.addStarPoint(bumper); this.chargeStar(this.data.constellation.bumperCharge*this.level.starBumper,{kind:'starBumper',x:bumper.x,y:bumper.y}); }
      }
      else this.consumeImpactEnergy(ball,this.data.physics.wallCost);
      this.emit('bumper', { x:bumper.x,y:bumper.y,charged:actualEnergy>0,split:!ball.main,actualEnergy,dx:ball.dx,dy:ball.dy });
      this.bounceEffects(ball);
      return;
    }
  }
  update(dt) {
    if (this.paused || this.pendingChapterSelection || (this.state === 'ended' && this.goalComplete)) return;
    this.run.time += dt;
    if(this.bossVictoryLeft>0) {
      this.bossVictoryLeft=Math.max(0,this.bossVictoryLeft-dt);
      if(!this.bossVictoryLeft) this.endRun();
      return;
    }
    if(this.boss?.phase==='waking') {
      this.boss.wakeLeft=Math.max(0,this.boss.wakeLeft-dt);
      if(!this.boss.wakeLeft) this.activateBoss();
      return;
    }
    if(this.boss?.phase==='active') this.boss.rotation=(this.boss.rotation+this.bossRules.rotationSpeed*dt)%(Math.PI*2);
    if(this.state!=='ended' && this.spawnBoss()) return;
    if (this.state !== 'flying') {
      if(this.state==='ready') this.settleOutsideBoss(this.position,dt);
      if (this.auto && this.level.idle) {
        if(this.state==='ready' && this.goalComplete && this.run.shots) { this.endRun(); return; }
        this.idleTime += dt;
        if (this.idleTime >= this.stats.idleDelay) {
          if (this.state === 'ended' && !this.goalComplete) this.newRun();
          if (this.state === 'ready') this.launch(this.autoAngle(), 1, true);
        }
      }
      return;
    }
    this.shotTime += dt;
    const physics = this.data.physics, m = this.data.mechanics, n = physics.grid, cell = physics.size / n;
    for(const bumper of this.bumpers) if(!bumper.armed && this.balls.every(b=>Math.hypot(b.x-bumper.x,b.y-bumper.y)>this.data.relicMechanics.bumperRadius+physics.radius+1)) bumper.armed=true;
    for (const ball of [...this.balls]) {
      if(this.bossVictoryLeft>0) break;
      if (this.canReturn(ball) && (ball.energy <= 0 || this.shotTime >= physics.maxShotTime)) this.beginReturn(ball);
      if (ball.returning) { this.updateReturn(ball,dt); continue; }
      if (ball.energy <= 0) continue;
      if (this.shotTime >= physics.maxShotTime) { ball.energy=0; continue; }
      this.consumeRollingEnergy(ball, dt);
      ball.portalCooldown = Math.max(0, ball.portalCooldown - dt);
      // Only movement and contacts are subdivided. Game clocks and energy drain
      // still advance once, while even the fastest ball cannot skip a brick.
      let travelTime = dt;
      while (travelTime > 1e-10 && ball.energy > 0 && !this.bossVictoryLeft) {
        const speed = this.speedForEnergy(ball.energy);
        if (speed <= 0) break;
        const stepTime = Math.min(travelTime, physics.radius * .5 / speed);
        travelTime -= stepTime;
        ball.x += ball.dx * speed * stepTime; ball.y += ball.dy * speed * stepTime;
        const r = physics.radius, max = physics.size - r;
        if (ball.x < r || ball.x > max) { ball.x = Math.max(r, Math.min(max, ball.x)); ball.dx *= -1; this.consumeImpactEnergy(ball, physics.wallCost); this.emit('wall', { x: ball.x, y: ball.y }); this.bounceEffects(ball); }
        if (ball.y < r || ball.y > max) { ball.y = Math.max(r, Math.min(max, ball.y)); ball.dy *= -1; this.consumeImpactEnergy(ball, physics.wallCost); this.emit('wall', { x: ball.x, y: ball.y }); this.bounceEffects(ball); }
        if (!ball.portalCooldown && this.portals.length) {
          const hit = this.portals.findIndex(p => Math.hypot(ball.x - p.x, ball.y - p.y) < m.portalRadius);
          if (hit >= 0) {
            const target = this.portals[1 - hit];
            ball.x = target.x + ball.dx * m.portalExit; ball.y = target.y + ball.dy * m.portalExit; ball.portalCooldown = m.portalCooldown;
            this.emit('portal', { x: ball.x, y: ball.y });
          }
        }
        this.collideBumpers(ball);
        const gx = Math.floor(ball.x / cell), gy = Math.floor(ball.y / cell);
        let collided = this.boss?.alive ? this.collideBoss(ball,this.boss) : false;
        for (let y = Math.max(0, gy - 1); y <= Math.min(n - 1, gy + 1) && !collided; y++) for (let x = Math.max(0, gx - 1); x <= Math.min(n - 1, gx + 1) && !collided; x++) {
          const b = this.grid.get(y * n + x);
          if (b) collided = this.collide(ball, b);
        }
      }
      if (ball.main) this.position = { x: ball.x, y: ball.y };
    }
    if(this.bossVictoryLeft>0) return;
    for (const ball of this.balls) if (ball.energy <= 0 && this.canReturn(ball)) this.beginReturn(ball);
    this.balls = this.balls.filter(b => b.energy > 0);
    this.updateStar(dt);
    if(this.bossVictoryLeft>0) return;
    this.updateRifts(dt);
    if(this.bossVictoryLeft>0 || this.spawnBoss()) return;
    if ((!this.balls.length && !this.star.pending && !this.star.volley.length && !this.rifts.length) || this.shotTime >= physics.maxShotTime + this.data.relicMechanics.returnMaxTime || (!this.grid.size && !this.balls.some(b=>b.returning) && !this.star.pending && !this.star.volley.length)) this.finishShot();
  }
  canReturn(ball) { return !ball.returned && this.profile.relics.includes('echo') && (ball.main || (!ball.starBorn && this.returnedSplits<(this.level.returnFormation||0)*this.data.combinations.splitParticipants)); }
  tick(seconds) {
    if (this.paused || this.pendingChapterSelection || !Number.isFinite(seconds) || seconds <= 0) return;
    const step = this.data.physics.step;
    this.accumulator = (this.accumulator || 0) + Math.min(seconds, 60);
    while (this.accumulator >= step) { this.update(step); this.accumulator -= step; }
  }
  finishShot() {
    this.balls = [];
    this.rifts = [];
    this.star.pending=0; this.star.volley=[];
    this.log('shot_end', { shot: this.run.shots, hits: this.hits, combo: this.combo, coins: this.run.coins, comboCoins:this.run.comboCoins, kills: this.run.kills, cleared: this.run.cleared, elites:this.run.elites,arcs:this.run.arcs,riftPulses:this.run.riftPulses,finales:this.run.finales,relicTriggers: { ...this.run.relicTriggers }, techTriggers:{...this.run.techTriggers}, buffs: { ...this.buffs }, seconds: +this.shotTime.toFixed(1) });
    this.emit('shotend', { combo: this.combo, timeout: this.shotTime >= this.data.physics.maxShotTime });
    this.activeBuffs = {};
    if (this.shots <= 0 || !this.grid.size || this.run.shots >= this.data.economy.maxShotsPerRun || (this.auto && this.goalComplete)) this.endRun();
    else this.state = 'ready';
    this.idleTime = 0;
  }
  endRun() {
    if (this.state === 'ended' || this.bossVictoryLeft>0) return;
    this.balls = [];
    this.rifts = [];
    this.star.pending=0; this.star.volley=[];
    this.state = 'ended';
    this.profile.runs++;
    this.profile.bestRun = Math.max(this.profile.bestRun, this.run.coins);
    this.profile.history.push({ ...this.run });
    this.profile.history = this.profile.history.slice(-30);
    this.log('run_end', { ...this.run, goal: this.goalComplete });
    this.emit('runend');
  }
  get goalComplete() {
    const p = this.profile, c = this.chapter;
    if(this.bossEnabled) return !this.pendingChapterSelection && this.isFrontier && this.run.bossDefeated;
    return !this.pendingChapterSelection && this.isFrontier && this.clearRatio >= c.clearRatio && p.stageCores >= c.cores && p.stageCombo >= c.combo;
  }
  get pendingChapterSelection() { return this.profile.pendingChapterSelection === true; }
  get isFrontier() { return this.profile.chapter === this.profile.frontierChapter; }
  get clearRatio() { return this.run.cleared / Math.max(1, this.run.totalBlocks); }
  storeChapterProgress() {
    this.profile.chapterProgress[this.profile.chapter] = Object.fromEntries(['stageKills', 'stageCores', 'stageCombo'].map(key => [key, this.profile[key]]));
  }
  selectChapter(index) {
    if(this.bossVictoryLeft>0) return false;
    if (!Number.isInteger(index) || index < 0 || index > this.profile.unlockedChapter || (index === this.profile.chapter && this.state !== 'ended' && !this.pendingChapterSelection)) return false;
    if (this.run.shots && this.state !== 'ended') this.endRun();
    if (!this.pendingChapterSelection) this.storeChapterProgress();
    this.profile.chapter = index;
    this.profile.pendingChapterSelection = false;
    this.paused = false;
    for (const key of ['stageKills', 'stageCores', 'stageCombo']) this.profile[key] = this.profile.chapterProgress[index]?.[key] || 0;
    this.log('chapter_select', { chapter: index, frontier: this.profile.frontierChapter });
    this.newRun();
    return true;
  }
  advance(relic) {
    const choices = this.data.relics.filter(r=>!this.profile.relics.includes(r.id));
    if (this.state !== 'ended' || !this.goalComplete || (choices.length ? !choices.some(r=>r.id===relic) : relic !== 'fusion')) return false;
    if (relic !== 'fusion') this.profile.relics.push(relic);
    this.profile.coins += this.chapter.bonus;
    this.profile.earned += this.chapter.bonus;
    this.storeChapterProgress();
    const next = this.profile.chapter === this.data.chapters.length - 1 ? 0 : this.profile.chapter + 1;
    if (!next) { this.profile.prestige++; this.profile.chapterProgress = {}; }
    this.profile.frontierChapter = next;
    this.profile.unlockedChapter = Math.max(this.profile.unlockedChapter, next);
    this.profile.pendingChapterSelection = true;
    this.idleTime = 0;
    this.log('chapter_unlock', { chapter: next, prestige: this.profile.prestige, relic, pendingSelection: true });
    this.emit('awaken', { id: relic, x:this.position.x,y:this.position.y });
    return true;
  }
  autoAngle() {
    // Ray samples use visible geometry and block health, never hidden drops.
    const p = this.position, size = this.data.physics.size, cell = size / this.data.physics.grid;
    let best = -Infinity, result = this.random() * Math.PI * 2;
    const offset = this.random() * 0.15;
    for (let i = 0; i < 64; i++) {
      const angle = i / 64 * Math.PI * 2 + offset, dx = Math.cos(angle), dy = Math.sin(angle);
      for (let d = 12; d < size * 1.5; d += 7) {
        const x = p.x + dx * d, y = p.y + dy * d;
        if (x < 0 || y < 0 || x >= size || y >= size) break;
        const b = this.boss?.phase==='active' && this.blockDistance(this.boss,x,y)<=this.data.physics.radius ? this.boss : this.grid.get(Math.floor(y / cell) * this.data.physics.grid + Math.floor(x / cell));
        if (!b) continue;
        const value = (b.type==='boss' ? 20 : (b.type === 'elite' ? 12 : b.type === 'core' ? 3.4 : b.type === 'gold' ? 3.8 : b.type === 'bomb' ? 2 : 1) / Math.max(0.35, b.hp / this.stats.damage)) + 30 / (d + 30) + this.random() * 0.28;
        if (value > best) { best = value; result = angle; }
        break;
      }
    }
    return result;
  }
  snapshot() {
    return JSON.parse(JSON.stringify({ seed: this.seed, tierCount:this.data.tierHP.length, bossVictoryLeft:this.bossVictoryLeft, blocks: this.blocks, portals: this.portals, pattern: this.pattern, bumpers: this.bumpers, star:this.star,rifts:this.rifts,arcSplits:this.arcSplits,mintClaimed:this.mintClaimed,burstClaimed:this.burstClaimed,finaleClaimed:this.finaleClaimed,returnedSplits:this.returnedSplits,tetherSplits:this.tetherSplits, launchOrigin: this.launchOrigin, position: this.position, state: this.state, shots: this.shots, buffs: this.buffs, activeBuffs: this.activeBuffs, run: this.run, balls: this.balls, combo: this.combo, hits: this.hits, nextBeam: this.nextBeam, beamAt:this.beamAt,beamArcAt:this.beamArcAt, shotAuto: this.shotAuto, shotTime: this.shotTime, fraction: this.fraction, accumulator: this.accumulator || 0, auto: this.auto, paused: this.paused, idleTime: this.idleTime, logs: this.logs, logSeq: this.logSeq }));
  }
  restore(saved) {
    const maxBlocks=this.data.physics.grid**2+1;
    if (!saved || !['ready', 'flying', 'ended'].includes(saved.state) || !Array.isArray(saved.blocks) || saved.blocks.length > maxBlocks || !Array.isArray(saved.balls) || saved.balls.length > this.data.physics.maxBalls) return false;
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    if (!saved.position || !finite(saved.position.x) || !finite(saved.position.y) || !saved.run || saved.run.chapter !== this.profile.chapter || !finite(saved.shots)) return false;
    if (saved.blocks.some(b => !b || ![b.id, b.x, b.y, b.hp, b.maxHP, b.loot].every(finite) || (b.percentDamageHP!==undefined && (!finite(b.percentDamageHP) || b.percentDamageHP<=0 || b.percentDamageHP>b.maxHP))) || saved.balls.some(b => !b || ![b.x, b.y, b.dx, b.dy, b.energy].every(finite))) return false;
    const savedBosses=saved.blocks.filter(b=>b.type==='boss');
    if(savedBosses.length>1 || savedBosses.some(b=>b.id!==maxBlocks-1 || ![b.size,b.rotation,b.wakeLeft,b.wakeDuration].every(finite) || b.size<=0 || b.size>this.data.physics.size/2 || b.wakeLeft<0 || b.wakeDuration<=0 || !['waking','active','defeated'].includes(b.phase))) return false;
    if(saved.bossVictoryLeft!==undefined && (!finite(saved.bossVictoryLeft)||saved.bossVictoryLeft<0)) return false;
    if (saved.balls.some(b=>b.returning && (!Array.isArray(b.returnHits) || b.returnHits.length>maxBlocks || !b.returnHits.every(finite)))) return false;
    if (saved.bumpers && (!Array.isArray(saved.bumpers) || saved.bumpers.length > this.data.relicMechanics.bumperMax || saved.bumpers.some(b=>!b || ![b.x,b.y,b.charges].every(finite)))) return false;
    if (saved.launchOrigin && ![saved.launchOrigin.x,saved.launchOrigin.y].every(finite)) return false;
    if(saved.star && (!Array.isArray(saved.star.points)||saved.star.points.length>3||!saved.star.points.every(p=>p&&finite(p.x)&&finite(p.y))||(saved.star.triangle!==null&&(!Array.isArray(saved.star.triangle)||saved.star.triangle.length!==3||!saved.star.triangle.every(p=>p&&finite(p.x)&&finite(p.y))))||![saved.star.charge,saved.star.pending,saved.star.cooldown,saved.star.casts].every(finite))) return false;
    if(saved.star?.volley && (!Array.isArray(saved.star.volley)||saved.star.volley.length>(this.data.constellation.maxProjectiles??24)||saved.star.volley.some(b=>!b||![b.x,b.y,b.tx,b.ty,b.targetId,b.left,b.duration,b.damage].every(finite)||b.left<=0||b.duration<=0||b.left>b.duration||b.damage<0||['baseDamage','hpDamage'].some(key=>b[key]!==undefined&&(!finite(b[key])||b[key]<0))))) return false;
    if(['beamAt','beamArcAt'].some(key=>saved[key]!==undefined&&(!finite(saved[key])||saved[key]<0))) return false;
    if(saved.rifts && (!Array.isArray(saved.rifts)||saved.rifts.length>this.data.elite.riftMax||saved.rifts.some(r=>!r||![r.x,r.y,r.left,r.duration,r.pulse,r.radius,r.damage,r.hpDamage].every(finite)||r.left<=0||r.duration<=0||r.left>r.duration||r.pulse<=0||r.radius<=0||r.damage<0||r.hpDamage<0))) return false;
    if(['arcSplits','mintClaimed','burstClaimed','finaleClaimed'].some(key=>saved[key]!==undefined&&(!finite(saved[key])||saved[key]<0))) return false;
    if (saved.portals && (!Array.isArray(saved.portals) || ![0, 2].includes(saved.portals.length) || saved.portals.some(p => !p || ![p.x,p.y].every(v => finite(v) && v >= 0 && v <= this.data.physics.size)))) return false;
    if (saved.pattern && ![saved.pattern.angle, saved.pattern.phase, saved.pattern.mirror].every(finite)) return false;
    if(saved.tierCount!==undefined && (!Number.isInteger(saved.tierCount)||saved.tierCount<2||saved.tierCount>64)) return false;
    const keys = ['seed', 'blocks', 'portals', 'pattern', 'bumpers','star','rifts','arcSplits','mintClaimed','burstClaimed','finaleClaimed','returnedSplits','tetherSplits', 'launchOrigin', 'position', 'state', 'shots', 'buffs', 'activeBuffs', 'run', 'balls', 'combo', 'hits', 'nextBeam', 'beamAt','beamArcAt', 'shotAuto', 'shotTime', 'fraction', 'accumulator', 'idleTime', 'logs', 'logSeq'];
    for (const key of keys) if (saved[key] !== undefined) this[key] = saved[key];
    const previousTiers=saved.tierCount||5;
    if(previousTiers!==this.data.tierHP.length) this.blocks=this.blocks.map(b=>({...b,tier:Math.max(0,Math.min(this.data.tierHP.length-1,Math.round((b.tier||0)/(previousTiers-1)*(this.data.tierHP.length-1))))}));
    this.auto = !!saved.auto && !!this.level.idle;
    this.paused = !!saved.paused;
    this.bossVictoryLeft=saved.bossVictoryLeft??0;
    this.run.totalBlocks ||= this.blocks.filter(b=>b.native!==false).length;
    this.run.cleared ??= this.blocks.filter(b=>!b.alive && b.native!==false && !b.bossCleared).length;
    this.run.bossVersion ??= 0;
    for(const key of ['bossDamage','bossChipDamage','bossDirectDamage','bossChipKills','bossDirectHits','bossShots','bossStartedShot','bossStartedTime']) this.run[key] ||= 0;
    this.run.relicTriggers ||= { echo:0,heart:0,mint:0,fusion:0 };
    this.run.starBursts ||= 0;
    this.run.techTriggers ||= {};
    for(const key of ['comboCoins','elites','arcs','riftPulses','finales']) this.run[key] ||= 0;
    this.mintClaimed=saved.mintClaimed ?? Math.floor(this.combo/this.data.combo.mintEvery)*this.data.combo.mintEvery;
    this.burstClaimed=saved.burstClaimed ?? Math.floor(this.combo/this.data.combo.burstEvery);
    this.finaleClaimed=saved.finaleClaimed ?? Math.floor(this.combo/this.data.combo.finaleEvery);
    this.star.volley ||= [];
    for(const bolt of this.star.volley) {
      bolt.hpDamage??=this.data.constellation.salvoHPDamage;
      bolt.baseDamage??=Math.max(0,bolt.damage-this.percentDamage(this.blocks.find(b=>b.id===bolt.targetId),bolt.hpDamage));
      bolt.tech??='starSalvo';
    }
    delete this.star.comboCharged;
    this.beamAt = saved.beamAt ?? 0;
    this.beamArcAt = saved.beamArcAt ?? 0;
    // Old snapshots had fixed portals; keep them aligned with their existing clearings.
    if (!saved.portals) this.portals = this.profile.chapter >= 2 ? [{ x:272, y:304 }, { x:464, y:208 }] : [];
    this.techEventTime=-1; this.techEvents={};
    this.launchOrigin = saved.launchOrigin || { ...this.position };
    for (const map of [this.buffs, this.activeBuffs]) for (const id of Object.keys(map)) map[id] = Math.max(0,Math.min(this.data.drops.find(d=>d.id===id)?.cap||this.data.mechanics.buffCap, Number(map[id]) || 0));
    this.reindex();
    this.emit('newrun');
    return true;
  }
}
