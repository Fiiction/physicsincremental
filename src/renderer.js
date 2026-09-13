import { Application, Container, Graphics, Sprite, Text, BitmapFont, BitmapText, Texture, ParticleContainer, Particle } from 'pixi.js';
import { createComboFilter, comboEffectStrength } from './combo-filter.js';
import { GameAudio } from './audio.js';
import audioConfig from './data/audio.json' with { type: 'json' };

export class Renderer {
  constructor(game, host, onAction) {
    this.game = game;
    this.host = host;
    this.onAction = onAction;
    this.audio = new GameAudio(audioConfig);
    this.blockViews = new Map();
    this.particles = [];
    this.rings = [];
    this.floaters = [];
    this.trails = new WeakMap();
    this.time = 0;
    this.bossTime = 0;
    this.mechanismSeen = new Set();
    this.comboTexts = [];
    this.cashFlights = new Set();
    this.effectStrength = 0;
    this.dispersionStrength = 0;
    this.effectFades = {};
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.moneyFormat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
    this.aim = -Math.PI / 4;
  }
  async init() {
    this.app = new Application();
    const { width, height } = this.host.getBoundingClientRect();
    await this.app.init({ width: Math.max(1, width), height: Math.max(1, height), antialias: true, backgroundAlpha: 0, resolution: window.devicePixelRatio || 1, autoDensity: true, preference: 'webgl', powerPreference: 'high-performance' });
    this.host.append(this.app.canvas);
    this.app.canvas.setAttribute('aria-label', '弹球矿场。拖拽圆球向反方向发射，或使用方向键瞄准、空格发射。');
    this.app.canvas.setAttribute('tabindex', '0');
    this.world = new Container(); this.app.stage.addChild(this.world);
    this.comboFilter = createComboFilter(); this.world.filters = [this.comboFilter];
    this.bossBackdrop = new Graphics(); this.world.addChild(this.bossBackdrop);
    this.blockLayer = new Container(); this.world.addChild(this.blockLayer);
    this.under = new Graphics(); this.world.addChild(this.under);
    this.particleLayer = new ParticleContainer({ dynamicProperties: { position: true, color: true, rotation: true, vertex: true } });
    this.world.addChild(this.particleLayer);
    for (let i = 0; i < this.game.data.effects.particles; i++) {
      const p = new Particle({ texture: Texture.WHITE, x: 0, y: 0, alpha: 0, scaleX: 3, scaleY: 3, anchorX: 0.5, anchorY: 0.5 });
      this.particleLayer.addParticle(p); this.particles.push({ p, life: 0 });
    }
    this.over = new Graphics(); this.world.addChild(this.over);
    this.textLayer = new Container(); this.app.stage.addChild(this.textLayer);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.input(); this.rebuild();
    this.app.ticker.add(ticker => {
      // Moving between monitors can change pixel density without changing the CSS size.
      if (this.app.renderer.resolution !== (window.devicePixelRatio || 1)) this.resize();
      this.onAction('frame', Math.min(0.05, ticker.deltaMS / 1000));
    });
    return this;
  }
  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const resolution = window.devicePixelRatio || 1;
    // Resize the GPU drawing surface; only the scene coordinates stay at 608 units.
    // Pixi also needs a density transition when old and new physical sizes happen to match.
    if (this.app.renderer.resolution !== resolution) this.app.renderer.resolution = resolution;
    this.app.renderer.resize(width, height, resolution);
    this.app.stage.scale.set(width / 608, height / 608);
    this.sceneScale = width / 608;
    this.hudScale = Math.max(1, 608 / Math.max(200, width));
    const textResolution = Math.ceil(resolution * Math.max(1, width / 608, height / 608));
    if (this.textResolution !== textResolution) {
      this.textResolution = textResolution;
      const nodes = [...this.app.stage.children];
      while (nodes.length) {
        const node = nodes.pop();
        if (node instanceof Text) node.resolution = textResolution;
        if (node.children) nodes.push(...node.children);
      }
    }
    // Keep the shared digit atlas sharp too, without rebuilding it for every resize pixel.
    const fontResolution = Math.max(2, textResolution);
    if (!this.comboFontResolution || fontResolution > this.comboFontResolution) {
      if (this.comboFontResolution) BitmapFont.uninstall('ComboDigits');
      BitmapFont.install({ name: 'ComboDigits', style: { fontFamily: 'Arial', fontSize: 40, fontWeight: '800', fill: '#28344c', stroke: { color: '#ffffff', width: 5 } }, chars: '0123456789×', resolution: fontResolution, padding: 4 });
      this.comboFontResolution = fontResolution;
      for (const f of this.comboTexts) f.node.onViewUpdate();
    }
  }
  color(b) {
    const palette = this.game.chapter.palette;
    const tier = b.tier ?? this.game.patternTier(b.gx - 9, b.gy - 9);
    return b.type === 'elite' ? 0x32334d : b.type === 'gold' ? 0xf0cc68 : b.type === 'core' ? 0x23283e : b.type === 'bomb' ? 0xeb785e : palette[Math.min(palette.length - 1, tier)];
  }
  rebuild() {
    this.blockLayer.removeChildren().forEach(v => v.destroy({ children: true }));
    this.blockViews.clear();
    this.rings.length = 0;
    this.bossTime = 0; this.bossBackdrop.clear();
    this.floaters.forEach(f => f.node.destroy({ children: true })); this.floaters = [];
    this.trails = new WeakMap();
    this.mechanismSeen.clear();
    this.comboTexts.forEach(f => f.node.destroy()); this.comboTexts = [];
    this.cashFlights.forEach(node => { node.getAnimations().forEach(a => a.cancel()); node.remove(); }); this.cashFlights.clear();
    this.effectStrength = 0; this.dispersionStrength = 0; this.effectFades = {};
    this.updateComboSpectrum(0);
    for (const p of this.particles) { p.life = 0; p.p.alpha = 0; }
    for (const b of this.game.blocks) if (b.alive) this.addBlock(b);
    const boss = this.game.boss;
    if (boss?.phase === 'defeated' && this.game.bossVictoryLeft > 0) {
      const max = this.game.data.boss?.victoryDuration || 1.4;
      this.rings.push({ x: boss.x + 16, y: boss.y + 16, size: boss.size, rotation: boss.rotation,
        life: Math.min(max, this.game.bossVictoryLeft), max, palette: [...this.game.chapter.palette], bossEffect: 'defeat' });
    }
  }
  addBlock(b) {
    const container = new Container(); container.position.set(b.x + 16, b.y + 16);
    if (b.type === 'boss') {
      const body = new Graphics(); container.addChild(body); this.blockLayer.addChild(container);
      const view = { container, body, block: b, boss: true, punch: 0, damagePhase: this.bossDamagePhase(b) };
      this.blockViews.set(b.id, view); this.updateBossBody(view); return;
    }
    const side = this.game.data.physics.size / this.game.data.physics.grid * this.game.data.physics.blockSize;
    const square = new Sprite(Texture.WHITE); square.anchor.set(0.5); square.width = square.height = side; square.tint = this.color(b); container.addChild(square);
    const hole = new Sprite(Texture.WHITE); hole.anchor.set(0.5); hole.tint = 0xffffff; container.addChild(hole);
    const label = new Text({ text: this.label(b), resolution: this.textResolution, style: { fontFamily: 'Consolas, monospace', fontSize: 16, fontWeight: '600', trim: true, fill: b.type === 'elite' ? 0xffdf89 : b.type === 'gold' ? 0x775120 : 0xffffff } });
    label.anchor.set(0.5); container.addChild(label);
    this.blockLayer.addChild(container);
    const view = { container, square, hole, label, punch: 0, block: b };
    this.blockViews.set(b.id, view); this.updateHole(view);
  }
  label(b) { return ['gold','elite'].includes(b.type) ? (this.game.level.sight || 0)>=(b.type==='elite'?2:1) ? (this.game.data.drops.find(d => d.id === b.supply)?.icon || '◇') : b.type === 'elite' ? '♛' : '◇' : b.type === 'core' ? '◆' : b.type === 'bomb' ? '✹' : ''; }
  updateHole(view) {
    if (view.lastHP === view.block.hp) return;
    view.lastHP = view.block.hp;
    const ratio = Math.max(0, Math.min(1, 1 - view.block.hp / view.block.maxHP));
    // Both dimensions use cell spacing as one unit; damage grows the inner side linearly.
    const p = this.game.data.physics;
    view.hole.width = view.hole.height = p.size / p.grid * Math.min(p.holeSize, p.blockSize) * ratio;
    view.hole.visible = ratio > 0;
    view.label.style.fill = ratio > 0.15 ? this.color(view.block) : view.block.type === 'elite' ? 0xffdf89 : view.block.type === 'gold' ? 0x775120 : 0xffffff;
  }
  bossDamagePhase(b) {
    return (this.game.data.boss?.visual?.phaseThresholds || [.66, .33]).filter(hp => b.hp / b.maxHP <= hp).length;
  }
  updateBossBody(view, dt = 0) {
    const b = view.block, config = this.game.data.boss?.visual || {};
    const duration = Math.max(.05, config.punchDuration ?? .26);
    if (this.gentleEffects) view.punch = 0;
    else if (!this.game.paused) {
      // One complete recoil per impact window; late-game hits cannot restart it at zero.
      if (!view.punch && view.pendingHit && b.phase === 'active') {
        const length = Math.hypot(view.pendingHit.dx, view.pendingHit.dy);
        if (length > 0) { view.px = view.pendingHit.dx / length; view.py = view.pendingHit.dy / length; view.punch = duration; }
      }
      view.punch = Math.max(0, view.punch - dt);
    }
    view.pendingHit = null;
    const t = 1 - view.punch / duration;
    const punch = view.punch > 0 ? Math.sin(t * Math.PI * 2) * (1 - t) * (config.punchDistance ?? 9) : 0;
    // Recoil is visual only; the simulation keeps the nominal center and rotation.
    view.container.position.set(b.x + 16 + (view.px || 0) * punch, b.y + 16 + (view.py || 0) * punch);
    view.container.rotation = b.rotation || 0;
    view.container.visible = b.alive && b.phase === 'active';
    if (view.lastHP === b.hp && view.lastSize === b.size) return;
    view.lastHP = b.hp; view.lastSize = b.size;
    const palette = this.game.chapter.palette;
    const layers = (config.layers || 7) + Math.floor(this.game.profile.chapter / 2);
    const damage = Math.max(0, Math.min(1, 1 - b.hp / b.maxHP));
    const hollow = b.size * Math.max(0, Math.min(.95, config.hollowMax ?? .86)) * damage;
    const body = view.body.clear();
    // Palette bands stay fixed; the pure white square is the only growing damage mark.
    const lightest = Math.floor(palette.length / 4);
    for (let i = 0; i < layers; i++) {
      const side = b.size * (1 - i / layers);
      const color = palette[lightest + Math.round((1 - i / (layers - 1)) * (palette.length - 1 - lightest))];
      body.rect(-side / 2, -side / 2, side, side).fill(color);
    }
    if (hollow > 0) body.rect(-hollow / 2, -hollow / 2, hollow, hollow).fill(0xffffff);
    body.rect(-b.size / 2, -b.size / 2, b.size, b.size).stroke({ color: palette.at(-1), width: 1.5, alignment: 1 });
  }
  bossSquare(g, x, y, side, rotation) {
    const c = Math.cos(rotation) * side / 2, s = Math.sin(rotation) * side / 2;
    return g.moveTo(x - c + s, y - s - c).lineTo(x + c + s, y + s - c)
      .lineTo(x + c - s, y + s + c).lineTo(x - c - s, y - s + c).closePath();
  }
  drawBossField(g) {
    const b = this.game.boss, backdrop = this.bossBackdrop.clear();
    if (!b?.alive || b.phase === 'defeated') return;
    const config = this.game.data.boss?.visual || {}, chapter = this.game.profile.chapter;
    const palette = this.game.chapter.palette, color = palette.at(-1), x = b.x + 16, y = b.y + 16;
    const gentle = this.gentleEffects, waking = b.phase === 'waking' || b.phase === 'awakening';
    const phase = this.bossDamagePhase(b), time = this.bossTime;
    const progress = waking ? 1 - Math.max(0, b.wakeLeft) / (b.wakeDuration || this.game.data.boss?.wakeDuration || 1.4) : 1;
    const breath = gentle ? 0 : Math.sin(time * (1 + phase * .28)) * .5 + .5;
    // A thin frame compresses the white space; the playfield remains transparent and readable.
    const edge = (config.edgeAlpha ?? .065) * (1 + chapter * .18) * Math.min(1, progress * 2);
    for (let i = 0; i < 3; i++) {
      const inset = 2 + i * (gentle ? 5 : 5 + breath * 2);
      backdrop.rect(inset, inset, 608 - inset * 2, 608 - inset * 2).stroke({ color: palette[Math.max(0, palette.length - 1 - i * 3)], width: 2 + i * 2, alpha: edge / (i + 1) });
    }
    if (waking) {
      const count = (config.layers || 7) + Math.floor(chapter / 2);
      for (let i = 0; i < count; i++) {
        const t = Math.max(0, Math.min(1, progress * 1.5 - i / count * .5));
        const side = b.size + (gentle ? 8 : (1 - t) ** 2 * (90 + i * 13));
        this.bossSquare(g, x, y, side, (b.rotation || 0) + (gentle ? 0 : (1 - t) * (i % 2 ? -.4 : .4)))
          .stroke({ color: palette[Math.round(i / (count - 1) * (palette.length - 1))], width: i === count - 1 ? 3 : 1.5, alpha: t * .65 });
      }
      return;
    }
    const gap = config.frameGap || 13, frameAlpha = config.frameAlpha ?? .28;
    const rotation = gentle ? -(b.rotation || 0) * .12 : -time * (.065 + phase * .025);
    for (let i = 0; i < 2 + Math.floor(chapter / 2); i++) {
      const side = b.size + gap * (2 + i * 1.45) + (gentle ? 0 : breath * (2 + phase));
      this.bossSquare(g, x, y, side, rotation + i * Math.PI / 8)
        .stroke({ color: palette[Math.max(0, palette.length - 1 - i * 2)], width: i ? 1 : 1.8, alpha: frameAlpha / (1 + i * .75) });
    }
    const satellites = 4 + Math.floor(chapter / 2) * 2, radius = b.size * .77 + gap;
    for (let i = 0; i < satellites; i++) {
      const a = rotation + i * Math.PI * 2 / satellites;
      this.bossSquare(g, x + Math.cos(a) * radius, y + Math.sin(a) * radius, 4 + phase, -a)
        .fill({ color: palette[(i * 2 + 3) % palette.length], alpha: .62 });
    }
    if (!gentle) for (let i = 0; i < (config.streamCount || 12) + chapter * 2; i++) {
      const t = (time * (.16 + phase * .035) + i * .618) % 1, a = i * 2.4 + rotation;
      const near = b.size * .8, distance = near + (1 - t) * (35 + chapter * 7), length = 4 + t * 10;
      g.moveTo(x + Math.cos(a) * distance, y + Math.sin(a) * distance)
        .lineTo(x + Math.cos(a) * (distance - length), y + Math.sin(a) * (distance - length))
        .stroke({ color, width: 1, alpha: Math.sin(t * Math.PI) * .18 });
    }
  }
  bossParticles(e) {
    if (!this.game.profile.settings.particles) return;
    const config = this.game.data.boss?.visual || {}, gentle = this.gentleEffects;
    const count = Math.round((config.deathParticles || 100) * (gentle ? .3 : 1));
    for (let i = 0; i < count; i++) {
      const item = this.particles[this.cursor = ((this.cursor || 0) + 1) % this.particles.length];
      const a = i / count * Math.PI * 2, speed = gentle ? 10 + Math.random() * 15 : 45 + Math.random() * 150;
      const life = .65 + Math.random() * .5, size = 2 + Math.random() * (gentle ? 3 : 7);
      const radius = e.size * .25, color = e.palette[i % e.palette.length];
      Object.assign(item, { life, max: life, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, size, gravity: 0, spin: gentle ? 0 : -1, bossEffect: true });
      Object.assign(item.p, { x: e.x + Math.cos(a) * radius, y: e.y + Math.sin(a) * radius, tint: color, alpha: 1, rotation: e.rotation || 0, scaleX: size, scaleY: size });
    }
  }
  drawBossMoment(g, r, alpha) {
    const age = 1 - alpha, gentle = this.gentleEffects, palette = r.palette || this.game.chapter.palette;
    if (r.bossEffect === 'defeat') {
      if (!r.scattered && age >= .2) { this.bossParticles(r); r.scattered = true; }
      const collapse = age < .2 ? 1 - age * 2.5 : .5 + (age - .2) * 2.3;
      for (let i = 0; i < palette.length; i += 2) {
        const side = r.size * (1 - i / palette.length * .62) * (gentle ? 1 : collapse) + (gentle ? 0 : age * i * 3);
        this.bossSquare(g, r.x, r.y, side, (r.rotation || 0) - (gentle ? 0 : age * (.4 + i * .035)))
          .stroke({ color: palette[i], width: (3 + i * .4) * alpha, alpha: alpha * .75 });
      }
      return;
    }
    for (let i = 0; i < 3; i++) {
      const side = r.size + (gentle ? i * 5 : age * (34 + i * 16));
      this.bossSquare(g, r.x, r.y, side, r.rotation || 0)
        .stroke({ color: palette[Math.max(0, palette.length - 1 - i * 3)], width: (i ? 1.5 : 3) * alpha, alpha: alpha * .6 });
    }
  }
  events(events) {
    this.audio.update(this.game, { hidden: document.hidden, paused: this.game.paused });
    this.audio.events(events, this.game);
    for (const e of events) {
      if (e.type === 'newrun') this.rebuild();
      if (e.type === 'launch') {
        const [min, max] = this.game.data.effects.comboFX.angleRange;
        this.comboFilter.resources.spectrum.uniforms.uAngle = (min + Math.random() * (max - min)) * Math.PI / 180;
      }
      if (e.type === 'tech') {
        this.showMechanism(e.id,e.x,e.y);
        if(e.id==='fracture') this.rings.push({x:e.x,y:e.y,life:.55,max:.55,fracture:true});
      }
      if (e.type === 'upgrade') for (const v of this.blockViews.values()) if (v.label) v.label.text = this.label(v.block);
      if (e.type === 'bossphase' || e.type === 'bossdefeat') {
        const defeated = e.type === 'bossdefeat', life = defeated ? (e.duration || this.game.data.boss?.victoryDuration || 1.4) : .8;
        this.rings.push({ ...e, life, max: life, palette: [...this.game.chapter.palette], bossEffect: defeated ? 'defeat' : 'active' });
        
        if (defeated) {
          const view = this.blockViews.get(e.id); view?.container.destroy({ children: true }); this.blockViews.delete(e.id);
        }
      }
      if (e.type === 'bosschip' && this.rings.filter(r=>r.bossChip).length < 10) {
        this.rings.push({...e,life:.32,max:.32,bossChip:true});
      }
      if (e.type === 'hit') {
        const v = this.blockViews.get(e.id);
        if (v?.boss) {
          v.impact = .2;
          if (!v.pendingHit || (v.pendingHit.area && !e.area) || (v.pendingHit.area === e.area && e.damage > v.pendingHit.damage)) v.pendingHit = e;
        }
        else if (v) { v.punch = this.game.data.effects.punchDuration; v.px = e.dx; v.py = e.dy; v.label.text = this.label(v.block); }
        if (!e.area) { this.burst(e.x, e.y, this.game.chapter.color, 3, 0.25);  }
      }
      if (e.type === 'break') {
        const v = this.blockViews.get(e.id);
        const boss = v?.boss || this.game.boss?.id === e.id;
        const tint = v?.square?.tint || this.game.chapter.color;
        if (v) { v.container.destroy({ children: true }); this.blockViews.delete(e.id); }
        if (!boss) this.burst(e.x, e.y, tint, this.game.data.effects.burst, 0.6);
        if (e.comboAdded > 0 && e.combo >= 3) this.showCombo(e);
        if (!boss) { this.shake = Math.max(this.shake || 0, 1.8 + Math.min(e.combo / 10, 3)); }
      }
      if (e.type === 'dividend') this.showDividend(e);
      if (e.type === 'eliteopen') {
        this.rings.push({ ...e, life: 1.4, max: 1.4, elite: true });
        this.burst(e.x,e.y,0xe6bc56,70,1.35); 
      }
      if (e.type === 'arc') {
        this.rings.push({ ...e, life: .65, max: .65, arc: true });
        for (const p of e.points.slice(1)) this.burst(p.x,p.y,0x578bd4,5,.55);
        
      }
      if (e.type === 'riftopen' || e.type === 'riftpulse') this.rings.push({ ...e, life: .8, max: .8, rift: true });
      if (e.type === 'riftcollapse') {
        this.rings.push({ ...e, life: 1, max: 1, riftCollapse: true });
        this.burst(e.x,e.y,0x8660bb,50,.9); 
      }
      if (e.type === 'finale') {
        this.rings.push({ ...e, life: 1.2, max: 1.2, finale: true });
        
      }
      if (e.type === 'spawn') { const b = this.game.grid.get(e.id); if (b) { const old = this.blockViews.get(e.id); old?.container.destroy({ children: true }); this.addBlock(b); } this.burst(e.x, e.y, 0xf4cd6a, 12, 0.7); }
      if (e.type === 'drop') {
        const d = this.game.data.drops.find(d => d.id === e.id);
        this.showDrop(e, d);
        this.rings.push({ x: e.x, y: e.y, life: 0.8, max: 0.8, radius: 43, color: d.color });
        
      }
      if (['shock', 'core', 'portal', 'launch', 'split'].includes(e.type)) {
        const color = e.type === 'shock' ? e.tech==='comboBurst' ? 0xd6ad48 : e.tech==='splitShock' ? 0xac62cf : 0xf28463 : e.type === 'portal' || e.type === 'split' ? 0x9071e6 : 0x6d9ef5;
        const life = e.type === 'shock' ? 0.65 : e.type === 'core' ? 1.15 : 0.55;
        this.rings.push({ x: e.x, y: e.y, life, max: life, radius: e.radius || (e.type === 'core' ? 140 : 35), color, shock: e.type === 'shock', splitShock:e.tech==='splitShock', square: e.type === 'core' || e.bomb });
        if (e.type === 'core' || e.bomb) { this.burst(e.x, e.y, color, 70, 1.1); this.shake = 8;  }
      }
      if (e.type === 'beam') { this.rings.push({ ...e, life: 0.5, max: 0.5, beam: true }); this.burst(e.x, e.y, 0x72ded1, 100, 1); this.shake = 10;  }
      if (e.type === 'pierce') { this.rings.push({ ...e, life: 0.35, max: 0.35, pierce: true }); this.burst(e.x, e.y, 0x569ee3, 8, 0.4); }
      if (e.type === 'magnet') this.rings.push({ ...e, life: 0.5, max: 0.5, magnet: true });
      if (e.type === 'tether') { const life=e.split ? .7 : .4;this.rings.push({ ...e, life,max:life,tether:true });  }
      if (['bumper','bumpergrow','returnend','awaken'].includes(e.type)) {
        const color = e.type==='bumper' || e.type==='bumpergrow' ? 0xd8b747 : 0x8975ce;
        this.rings.push({ ...e, life:.65,max:.65,radius:e.type==='awaken'?160:35,color });
        this.burst(e.x,e.y,color,e.type==='awaken'?90:14,.7); 
        if(e.type==='bumper' && e.split && e.actualEnergy>0) this.rings.push({...e,life:.7,max:.7,springBoost:true});
      }
      if (e.type === 'return') { this.rings.push({...e,life:.9,max:.9,radius:32,color:0x8877d4,returnPath:e.split});  }
      if(e.type==='starpoint' || e.type==='starconduct') { this.rings.push({...e,life:.6,max:.6,radius:21,color:0x50b9ca}); this.burst(e.x,e.y,0x77cbd3,8,.55);  }
      if(e.type==='starfeed') {
        const color=e.kind==='starSplit'?0xac62cf:e.kind==='starBumper'?0xd4a424:e.kind==='starReturn'?0x7b60c3:0x328fb5;
        const recent=this.rings.find(r=>r.feed && r.kind===e.kind && r.life>.46);
        if(recent) recent.amount=Math.min(10,recent.amount+e.amount);
        else this.rings.push({...e,color,life:.62,max:.62,feed:true});
      }
      if(e.type==='starsalvohit') { const color=e.tech==='finaleSalvo'?0xd4a747:0x337ed4;this.rings.push({...e,life:.55,max:.55,radius:32,color});this.burst(e.x,e.y,color,e.killed?24:9,.65); }
      if(['starformed','starwindup','starcollapse','starrefract'].includes(e.type)) {
        const life=e.type==='starcollapse'?1.5:e.type==='starwindup'?this.game.data.constellation.windup:.85;
        this.rings.push({...e,life,max:life,starEffect:e.type});
        if(e.type==='starcollapse') { this.burst(e.x,e.y,0x75cdd3,120,1.15); this.shake=10; this.float(e.x,e.y,`星阵 · ${e.kills ? e.kills+'击破' : (e.hits||0)+'命中'}`,0x328fb5,17,1.6); }
      }
      if (e.type === 'wall') this.rings.push({ ...e, life: 0.3, max: 0.3, radius: 18, color: this.game.chapter.color });
    }
    // A screen-filling chain can exceed the cosmetic event budget. Always reconcile its final geometry.
    if (events.length) for (const [id, v] of this.blockViews) if (this.game.grid.get(id) !== v.block) { v.container.destroy({ children: true }); this.blockViews.delete(id); }
    if (events.length) for (const b of this.game.grid.values()) if (!this.blockViews.has(b.id)) this.addBlock(b);
  }
  burst(x, y, color, count, life) {
    if (!this.game.profile.settings.particles) return;
    for (let i = 0; i < count; i++) {
      const item = this.particles[this.cursor = ((this.cursor || 0) + 1) % this.particles.length];
      const a = Math.random() * Math.PI * 2, speed = 40 + Math.random() * 160;
      Object.assign(item, { life, max: life, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, size: 2 + Math.random() * 5, gravity: 120, spin: 2, bossEffect: false });
      Object.assign(item.p, { x, y, tint: color, alpha: 1, rotation: a, scaleX: item.size, scaleY: item.size });
    }
  }
  float(x, y, text, color, size, life = 0.7) {
    if (this.floaters.length >= 35) return;
    const node = new Text({ text, resolution: this.textResolution, style: { fontFamily: 'Inter, Microsoft YaHei, sans-serif', fontSize: size, fontWeight: '600', fill: color, stroke: { color: 0xffffff, width: 3 } } });
    node.anchor.set(0.5); node.position.set(Math.max(70, Math.min(538, x)), y); this.textLayer.addChild(node);
    const floater={ node, life, max: life };this.floaters.push(floater);return floater;
  }
  get gentleEffects() { return this.game.profile.settings.reducedEffects || this.reducedMotion.matches; }
  showCombo(e) {
    const config = this.game.data.effects.comboFX;
    if (this.comboTexts.length >= config.textMax) this.comboTexts.shift().node.destroy();
    const tier = e.combo < config.startCombo ? 0 : Math.min(5, 1 + Math.floor(Math.log2(e.combo / config.startCombo)));
    const size = (16 + tier * 1.4) * Math.min(1.45,this.hudScale);
    const node = new BitmapText({ text: `×${e.combo}`, style: { fontFamily: 'ComboDigits', fontSize: size } });
    node.anchor.set(.5); node.position.set(Math.max(24,Math.min(584,e.x)),Math.max(18,Math.min(590,e.y)));
    this.textLayer.addChild(node);
    this.comboTexts.push({ node, x:node.x, y:node.y, life:config.textLife, max:config.textLife, tier });
  }
  showDividend(e) {
    if (!e.coins) return;
    let notice = this.floaters.find(f => f.dividend);
    if (notice) { notice.coins += e.coins; notice.life = notice.max; notice.node.text = `连击铸币 +${this.moneyFormat.format(notice.coins)}`; }
    else {
      notice = this.float(e.x,Math.max(28,e.y-26),`连击铸币 +${this.moneyFormat.format(e.coins)}`,0xa67a22,17,1.45);
      if (notice) { notice.dividend = true; notice.coins = e.coins; }
    }
    this.burst(e.x,e.y,0xdcba60,7,.65);
    if (this.time - (this.lastCashFlight || -1) < .16) return;
    this.lastCashFlight = this.time;
    const wallet = document.getElementById('wallet'), arena = this.app.canvas.getBoundingClientRect();
    if (!wallet || !arena.width) return;
    if (this.gentleEffects) { wallet.animate([{color:'#ae8028'},{color:'inherit'}],{duration:900}); return; }
    const target = wallet.getBoundingClientRect(), tx = target.x+target.width/2, ty = target.y+target.height/2;
    const x = arena.x + e.x/608*arena.width, y = arena.y + e.y/608*arena.height;
    for (let i=0;i<4 && this.cashFlights.size<24;i++) {
      const node = document.createElement('i');
      node.setAttribute('aria-hidden','true'); node.className='combo-coin';
      Object.assign(node.style,{position:'fixed',left:'0',top:'0',width:'8px',height:'8px',border:'1.5px solid white',borderRadius:'2px',background:'#d8ad49',pointerEvents:'none',zIndex:'15',boxShadow:'0 0 8px #ddba6666'});
      document.body.appendChild(node); this.cashFlights.add(node);
      const sx=x+(i-1.5)*8,sy=y+i*3;
      const animation=node.animate([
        {transform:`translate(${sx}px,${sy}px) rotate(45deg)`,opacity:0},
        {transform:`translate(${sx+(tx-sx)*.15+28}px,${sy-45}px) rotate(135deg)`,opacity:1,offset:.24},
        {transform:`translate(${tx}px,${ty}px) rotate(225deg) scale(.4)`,opacity:.8}
      ],{duration:850+i*65,easing:'cubic-bezier(.4,0,.55,1)',fill:'forwards'});
      animation.onfinish=()=>{ node.remove(); this.cashFlights.delete(node); };
    }
  }
  updateComboSpectrum(dt) {
    const config = this.game.data.effects.comboFX;
    const active = !this.game.paused && this.game.state==='flying';
    const gentle = this.gentleEffects;
    for (const [field, target] of [
      ['effectStrength', active ? comboEffectStrength(this.game.combo, config) : 0],
      ['dispersionStrength', active && this.game.combo >= config.startCombo ? config.dispersionStrength : 0]
    ]) {
      if (gentle || this.game.paused) { this[field] = 0; delete this.effectFades[field]; }
      else if (target === this[field]) { delete this.effectFades[field]; }
      else {
        // Preserve the visible value when a burst of kills or a new shot changes the target.
        let fade = this.effectFades[field];
        if (!fade || fade.target !== target) fade = this.effectFades[field] = { strength: this[field], target, elapsed: 0, duration: target > this[field] ? config.riseDuration : config.endFadeDuration };
        fade.elapsed = Math.min(fade.duration, fade.elapsed + dt);
        this[field] = target + (fade.strength - target) * (1 - fade.elapsed / fade.duration) ** 2;
      }
    }
    const radius = this.dispersionStrength * config.shiftPerStrength * (this.sceneScale || 1);
    this.comboFilter.enabled = this.effectStrength > 0 || this.dispersionStrength > 0;
    this.comboFilter.padding = Math.ceil(radius) + 2;
    this.comboFilter.resources.spectrum.uniforms.uShift = radius;
    this.comboFilter.resources.spectrum.uniforms.uHue = this.effectStrength * config.hueDegreesPerStrength * Math.PI / 180;
    const atmosphere = this.atmosphere ||= document.getElementById('combo-atmosphere');
    if (atmosphere) {
      atmosphere.dataset.strength = String(this.effectStrength); atmosphere.dataset.reduced = String(!!gentle);
      atmosphere.style.opacity = String(this.effectStrength * config.opacityPerStrength);
      const angle=125+Math.sin(this.time*.12)*24;
      atmosphere.style.background = `linear-gradient(${angle}deg,#749de5 0%,#a882d1 32%,transparent 50%,#ebb674 70%,#5eb7af 100%)`;
    }
  }
  showMechanism(id,x,y) {
    if(this.mechanismSeen.has(id) || !Number.isFinite(x) || !Number.isFinite(y) || this.floaters.filter(f=>f.mechanism).length>=2) return;
    const tech=this.game.data.upgrades.find(u=>u.id===id);if(!tech) return;
    const notice=this.float(x,Math.max(25,y-27),tech.name,id.startsWith('star')||id==='constellation'?0x328fb5:0x9560b6,13,this.game.data.effects.mechanismLabelDuration);
    if(notice) { notice.mechanism=true;this.mechanismSeen.add(id); }
  }
  showDrop(e, d) {
    if (!d) return;
    const life = d.elite ? this.game.data.effects.eliteDropDuration : this.game.data.effects.dropDuration, existing = this.floaters.find(f => f.id === d.id && f.life > life - 1);
    if (existing) { existing.life = life; existing.count++; existing.caption.text = `${d.name} ×${existing.count}`; return; }
    const drops=this.floaters.filter(f=>f.id);
    if (drops.length >= 7) { const old=drops.find(f=>!f.elite)||drops[0]; this.floaters.splice(this.floaters.indexOf(old),1); old.node.destroy({ children: true }); }
    const node = new Container(), bg = new Graphics();
    bg.circle(0,0,28).fill({ color: 0xffffff, alpha: this.game.data.effects.dropBackgroundAlpha }).stroke({ color: d.color, width: 1.4, alpha:0.55 }); node.addChild(bg);
    if(d.elite) bg.poly([0,-37,37,0,0,37,-37,0]).stroke({color:0xc8a257,width:2,alpha:.9}).circle(0,0,32).stroke({color:d.color,width:1,alpha:.5});
    const icon = new Text({ text: d.icon, resolution: this.textResolution, style: { fontFamily: 'Arial', fontSize: d.elite ? this.game.data.effects.eliteDropSize : this.game.data.effects.dropSize, trim: true, fill: d.color } }); icon.anchor.set(0.5); node.addChild(icon);
    const caption = new Text({ text: d.name, resolution: this.textResolution, style: { fontFamily: 'Arial, Microsoft YaHei', fontSize: 12, fill: 0x29314d, stroke: { color: 0xffffff, width: 2 } } }); caption.anchor.set(0.5); caption.y = 39; node.addChild(caption);
    const scale = Math.min(1.6,this.hudScale);
    node.position.set(Math.max(43*scale,Math.min(608-43*scale,e.x)), Math.max(40*scale,Math.min(608-60*scale,e.y - 20))); this.textLayer.addChild(node);
    if (d.elite) caption.text = `${d.name} · 下一发`;
    this.floaters.push({ node, life, max: life, id: d.id, caption, count: 1, scale, elite: !!d.elite });
  }
  unlockAudio() {
    this.audio.update(this.game, { hidden: document.hidden, paused: this.game.paused });
    this.audio.unlock();
  }
  point(event) { const box = this.app.canvas.getBoundingClientRect(); return { x: (event.clientX - box.left) / box.width * 608, y: (event.clientY - box.top) / box.height * 608 }; }
  input() {
    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', e => {
      this.unlockAudio();
      if (this.game.state !== 'ready' || this.game.paused) return;
      const p = this.point(e);
      if (Math.hypot(p.x - this.game.position.x, p.y - this.game.position.y) > 75) { this.onAction('hint', '从圆球附近按住，向后拖拽再松手'); return; }
      this.drag = { start: { ...this.game.position }, end: p, power: 0 };
      canvas.setPointerCapture(e.pointerId); canvas.focus();
    });
    canvas.addEventListener('pointermove', e => {
      const p = this.point(e);
      if (this.drag) {
        this.drag.end = p;
        const dx = this.drag.start.x - p.x, dy = this.drag.start.y - p.y;
        this.drag.power = Math.min(1, Math.hypot(dx, dy) / 80);
        this.aim = Math.atan2(dy, dx);
      }
    });
    canvas.addEventListener('pointerup', () => {
      if (!this.drag) return;
      if (this.drag.power > 0.09) this.onAction('launch', { angle: this.aim, power: this.drag.power });
      this.drag = null;
    });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('lostpointercapture', () => { this.drag = null; });
  }
  render(dt) {
    this.audio.update(this.game, { hidden: document.hidden, paused: this.game.paused });
    this.time += dt;
    const game = this.game, g = this.over.clear(), under = this.under.clear();
    const bossDt = game.paused ? 0 : dt; this.bossTime += bossDt;
    this.updateComboSpectrum(dt);
    this.drawBossField(under);
    const sightKey = game.level.sight || 0;
    if (this.sightKey !== sightKey) { for (const v of this.blockViews.values()) if (v.label) v.label.text = this.label(v.block); this.sightKey = sightKey; }
    for (const v of this.blockViews.values()) {
      if (v.boss) {
        this.updateBossBody(v, bossDt);
        const phase = this.bossDamagePhase(v.block);
        if (phase > v.damagePhase && v.block.alive && v.block.phase === 'active') {
          this.rings.push({ x: v.container.x, y: v.container.y, size: v.block.size, rotation: v.block.rotation, life: .9, max: .9, bossEffect: 'damage' });
          
        }
        v.damagePhase = phase; v.impact = Math.max(0, (v.impact || 0) - bossDt);
        if (v.impact > 0 && v.container.visible) this.bossSquare(under, v.container.x, v.container.y, v.block.size + 2, v.block.rotation || 0)
          .stroke({ color: game.chapter.palette.at(-1), width: 1 + v.impact * 15, alpha: v.impact * 3 });
        continue;
      }
      v.punch = Math.max(0, v.punch - dt);
      const t = 1 - v.punch / game.data.effects.punchDuration;
      const punch = v.punch > 0 ? Math.sin(t * Math.PI * 2) * (1 - t) * game.data.effects.punchDistance : 0;
      v.container.position.set(v.block.x + 16 + (v.px || 0) * punch, v.block.y + 16 + (v.py || 0) * punch);
      v.square.tint = this.color(v.block); this.updateHole(v);
      if(v.block.type==='elite') {
        const x=v.container.x,y=v.container.y, glow=.72+(this.gentleEffects?0:Math.sin(this.time*1.3+v.block.id)*.15);
        under.rect(x-14.5,y-14.5,29,29).stroke({color:0xe2bf71,width:1.5,alpha:glow});
        for (const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) under.moveTo(x+sx*11,y+sy*17).lineTo(x+sx*17,y+sy*17).lineTo(x+sx*17,y+sy*11).stroke({color:0xc59b4e,width:1.7,alpha:glow});
      }
    }
    this.shake = Math.max(0, (this.shake || 0) - dt * 22);
    const shake = !this.gentleEffects && game.profile.settings.shake ? this.shake * game.data.effects.shake / 4 : 0;
    this.world.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (game.portals.length) {
      game.portals.forEach((p, i) => {
        const col = i ? 0x459cad : 0x9270cc;
        under.circle(p.x, p.y, 15).stroke({ color: col, width: 3, alpha: 0.9 }).circle(p.x, p.y, 8).fill({ color: col, alpha: 0.3 });
        for (let k = 0; k < 4; k++) { const a = this.time * (i ? -1 : 1) + k * Math.PI / 2; under.rect(p.x + Math.cos(a) * 21 - 2, p.y + Math.sin(a) * 21 - 2, 4, 4).fill(col); }
      });
    }
    const held = game.state === 'flying' ? game.activeBuffs : game.buffs;
    for (const field of game.rifts || []) {
      const fade=Math.min(1,field.left/.45),radius=field.radius;
      under.circle(field.x,field.y,radius).fill({color:0x8279b0,alpha:.045*fade}).stroke({color:0x8279b0,width:1,alpha:.35*fade});
      for(let arm=0;arm<2;arm++) {
        const points=[];
        for(let i=0;i<=26;i++) { const a=i/26*Math.PI*1.6+arm*Math.PI-this.time*.75,r=radius*(.12+i/26*.69);points.push(field.x+Math.cos(a)*r,field.y+Math.sin(a)*r); }
        under.moveTo(points[0],points[1]);for(let i=2;i<points.length;i+=2)under.lineTo(points[i],points[i+1]);under.stroke({color:0x6d5a99,width:2,alpha:.55*fade});
      }
      g.circle(field.x,field.y,8).fill(0x34324e).circle(field.x,field.y,11).stroke({color:0xa59bdd,width:2,alpha:fade});
      if(field.tech==='starRift') {
        const points=[];
        for(let i=0;i<3;i++) { const a=this.time*.4+i*Math.PI*2/3;points.push(field.x+Math.cos(a)*22,field.y+Math.sin(a)*22); }
        g.poly(points).stroke({color:0x3eacb8,width:2,alpha:.8*fade});
      }
    }
    if(game.level.constellation && game.state!=='ended') {
      const star=game.star,capacity=game.data.constellation.chargeRequired,charge=star.pending>0?1:Math.min(1,star.charge/capacity);
      for(const p of star.points) under.poly([p.x,p.y-7,p.x+6,p.y+4,p.x-6,p.y+4]).fill(0xffffff).stroke({color:0x328fb5,width:1.8}).circle(p.x,p.y,2).fill(0x328fb5);
      const battery=star.points[0] || game.launchOrigin;
      for(let i=0;i<capacity;i++) {
        const a=i/capacity*Math.PI*2-Math.PI/2,x=battery.x+Math.cos(a)*16,y=battery.y+Math.sin(a)*16;
        under.rect(x-1.6,y-1.6,3.2,3.2).fill({color:0x328fb5,alpha:i<charge*capacity?1:.16});
      }
      if(star.triangle) {
        under.poly(star.triangle.flatMap(p=>[p.x,p.y])).fill({color:0x328fb5,alpha:star.pending>0 ? .12 : .055}).stroke({color:0x328fb5,width:2+charge,alpha:.8});
        if(star.pending>0) for(const b of game.grid.values()) if(game.blockInStar(b)) {
          if (b.type === 'boss') {
            this.bossSquare(under, b.x + 16, b.y + 16, b.size + 3, b.rotation || 0).stroke({color:0x2477aa,width:2,alpha:.55});
            continue;
          }
          const side=game.data.physics.blockSize*32;
          under.rect(b.x+16-side/2,b.y+16-side/2,side,side).stroke({color:0x2477aa,width:2,alpha:.5+Math.sin(this.time*16)*.2});
        }
        for(let i=0;i<3;i++) {
          const a=star.triangle[i],b=star.triangle[(i+1)%3];
          const t=(this.time*.35+i/3)%1;under.circle(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,2.5).fill({color:0x7de2e0,alpha:.85});
        }
      } else if(star.points.length>1) { under.moveTo(star.points[0].x,star.points[0].y);for(const p of star.points.slice(1)) under.lineTo(p.x,p.y);under.stroke({color:0x328fb5,width:1.7,alpha:.65}); }
      for(const bolt of star.volley || []) {
        const color=bolt.tech==='finaleSalvo'?0xd4a747:0x337ed4;
        const t=Math.max(0,Math.min(1,1-bolt.left/(bolt.duration||game.data.constellation.salvoDuration))),dx=bolt.tx-bolt.x,dy=bolt.ty-bolt.y,length=Math.hypot(dx,dy)||1,nx=dx/length,ny=dy/length;
        const x=bolt.x+dx*t,y=bolt.y+dy*t,tail=Math.min(length*t,60);
        under.moveTo(bolt.x,bolt.y).lineTo(bolt.tx,bolt.ty).stroke({color,width:1,alpha:.16});
        g.moveTo(x-nx*tail,y-ny*tail).lineTo(x,y).stroke({color,width:4,alpha:.9});
        g.poly([x+nx*10,y+ny*10,x-nx*6+ny*4,y-ny*6-nx*4,x-nx*6-ny*4,y-ny*6+nx*4]).fill(color);
        g.circle(x,y,2).fill(0xffffff);
        for(const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) under.moveTo(bolt.tx+sx*10,bolt.ty+sy*16).lineTo(bolt.tx+sx*16,bolt.ty+sy*16).lineTo(bolt.tx+sx*16,bolt.ty+sy*10).stroke({color,width:1.5,alpha:.65});
      }
    }
    for (const bumper of game.bumpers) {
      const radius=game.data.relicMechanics.bumperRadius, charged=bumper.charges>0;
      under.circle(bumper.x,bumper.y,radius).fill(0xffffff).stroke({color:charged?0xd7b442:0xc5c6cf,width:2});
      under.circle(bumper.x,bumper.y,radius*.43).fill(charged?0xe9c65b:0xd8dae0);
      if(charged) under.circle(bumper.x,bumper.y,radius+3+Math.sin(this.time*3)*1.5).stroke({color:0xd7b442,width:1,alpha:.2});
    }
    const main=game.balls.find(b=>b.main);
    if (game.profile.relics.includes('heart') && main) {
      const origin=game.launchOrigin;
      under.moveTo(origin.x,origin.y).lineTo(main.x,main.y).stroke({color:0x9972cf,width:1,alpha:.2});
      under.circle(origin.x,origin.y,4).fill(0x9972cf).circle(origin.x,origin.y,8).stroke({color:0x9972cf,width:1,alpha:.4});
    }
    for (const b of game.balls) {
      let trail = this.trails.get(b); if (!trail) { trail = []; this.trails.set(b, trail); }
      trail.unshift({ x: b.x, y: b.y }); if (trail.length > game.data.effects.trail + (b.main ? (held.boost || 0) * 7 : 0)) trail.pop();
      trail.forEach((p, i) => under.circle(p.x, p.y, (b.main ? 6 : 4) * (1 - i / trail.length)).fill({ color: b.returning ? 0x8877d4 : b.main ? (held.boost ? 0xe4b640 : 0xe58d58) : 0xa786cf, alpha: (1 - i / trail.length) * (held.boost && b.main ? 0.55 : 0.35) }));
      g.circle(b.x, b.y, b.main ? 7 : 4.5).fill(b.returning ? 0x8877d4 : b.main ? 0xfb8057 : 0xa58ace);
      if(b.returning) { g.moveTo(b.x-b.dx*35,b.y-b.dy*35).lineTo(b.x+b.dx*12,b.y+b.dy*12).stroke({color:b.main?0xc5b6f5:0x9560cd,width:b.main?3:4,alpha:.9});g.circle(b.x,b.y,2.5).fill(0xffffff); }
      if(!b.main && b.tetherEligible && !b.returning) g.circle(b.x,b.y,7).stroke({color:0xac62cf,width:1,alpha:.55});
      if (b.main) g.circle(b.x - 1.5, b.y - 1.5, 2).fill({ color: 0xfff5da, alpha: 0.8 });
    }
    const actor = game.balls.find(b => b.main) || { ...game.position, dx: Math.cos(this.aim), dy: Math.sin(this.aim) };
    if (game.state === 'ready' || game.balls.some(b => b.main)) {
      // Buffs change the ball's material and motion: heat, budding satellites, pressure and phase.
      if (held.boost) {
        under.circle(actor.x,actor.y,11+held.boost*2+Math.sin(this.time*5)).fill({color:0xf1bd48,alpha:0.13});
        for(let j=0;j<held.boost+2;j++) {
          const t=(this.time*0.85+j/(held.boost+2))%1, a=j*2.4;
          const x=actor.x+(game.state==='flying' ? -actor.dx*t*32+actor.dy*Math.sin(a)*7 : Math.cos(a)*(9+t*8));
          const y=actor.y+(game.state==='flying' ? -actor.dy*t*32-actor.dx*Math.sin(a)*7 : Math.sin(a)*(9+t*8));
          under.circle(x,y,1.7*(1-t)).fill({color:0xdba52e,alpha:1-t});
        }
      }
      if (held.split) for(let j=0;j<held.split;j++) {
        const a=this.time*2.2+j*Math.PI*2/held.split, radius=12+Math.sin(this.time*3+j)*1.5;
        for(let k=3;k>=0;k--) under.circle(actor.x+Math.cos(a-k*.12)*radius,actor.y+Math.sin(a-k*.12)*radius,3.1-k*.55).fill({color:0x9972cf,alpha:1-k*.23});
      }
      if (held.shock) for(let j=0;j<2;j++) {
        const t=(this.time*(.55+held.shock*.1)+j*.5)%1;
        under.circle(actor.x,actor.y,8+t*(15+held.shock*3)).stroke({color:0xea896e,width:1.4+held.shock*.35,alpha:(1-t)*.62});
      }
      if (held.pierce) {
        const length=13+held.pierce*3+Math.sin(this.time*4)*2;
        g.moveTo(actor.x-actor.dx*length,actor.y-actor.dy*length).lineTo(actor.x+actor.dx*length,actor.y+actor.dy*length).stroke({color:0x5ca4e3,width:2,alpha:.8});
        g.circle(actor.x,actor.y,4.3).fill({color:0xd8f4ff,alpha:.9});
      }
      if (held.overdrive) {
        under.circle(actor.x,actor.y,20).fill({color:0xf0ab68,alpha:.18});
        g.circle(actor.x,actor.y,9).fill(0xed8e51).circle(actor.x,actor.y,5.3).fill(0xfff5d8);
        for(let j=0;j<6;j++) { const a=this.time*.65+j*Math.PI/3,r=14+Math.sin(this.time*1.8+j)*2;
          g.moveTo(actor.x+Math.cos(a)*r,actor.y+Math.sin(a)*r).lineTo(actor.x+Math.cos(a)*(r+5),actor.y+Math.sin(a)*(r+5)).stroke({color:0xeaa052,width:2,alpha:.75}); }
      }
      if (held.arc) {
        const points=[];
        for(let j=0;j<12;j++) { const a=j/12*Math.PI*2+this.time*.7,r=j%2?12:17;points.push(actor.x+Math.cos(a)*r,actor.y+Math.sin(a)*r); }
        g.poly(points).stroke({color:0x6288d4,width:1.5,alpha:.85});
        g.circle(actor.x,actor.y,3).fill(0xe2edff);
      }
      if (held.rift) {
        const a=this.time*.65,x=Math.cos(a)*16,y=Math.sin(a)*9;
        under.ellipse(actor.x,actor.y,18,10).stroke({color:0x8d75be,width:1.5,alpha:.5});
        g.circle(actor.x+x,actor.y+y,3.5).fill(0x51406f).circle(actor.x-x,actor.y-y,2.5).fill(0x9b82c4);
      }
    }
    if (!main) {
      const p = game.position;
      if (game.state === 'ready') {
        if (!held.shock && !held.boost) g.circle(p.x, p.y, 12 + Math.sin(this.time * 3) * 1.5).stroke({ color: 0xeb8658, width: 1, alpha: 0.35 });
        if (this.drag || this.keyboardAim) {
          const power = this.drag?.power || 1, length = 35 + power * 115, dx = Math.cos(this.aim), dy = Math.sin(this.aim);
          for (let d = 18; d < length; d += 9) g.circle(p.x + dx * d, p.y + dy * d, d > length - 20 ? 2.3 : 1.6).fill({ color: 0x394373, alpha: 0.7 });
          if (this.drag) g.moveTo(p.x, p.y).lineTo(this.drag.end.x, this.drag.end.y).stroke({ color: 0xf28a60, width: 1.5, alpha: 0.6 });
        }
      }
      g.circle(p.x, p.y, 7).fill(0xfb8057).circle(p.x - 1.5, p.y - 1.5, 2).fill({ color: 0xfff5da, alpha: 0.8 });
      if (held.pierce && game.state === 'ready') g.circle(p.x,p.y,4.3).fill(0xd8f4ff);
      if (held.overdrive && game.state === 'ready') g.circle(p.x,p.y,5.3).fill(0xfff5d8);
    }
    for (const item of this.particles) {
      if (item.life <= 0) continue;
      const particleDt = item.bossEffect ? bossDt : dt;
      item.life -= particleDt; item.p.alpha = Math.max(0, item.life / item.max);
      item.p.x += item.vx * particleDt; item.p.y += item.vy * particleDt; item.vy += item.gravity * particleDt; item.p.rotation += particleDt * item.spin;
      item.p.scaleX = item.p.scaleY = item.size * Math.max(0, item.life / item.max);
    }
    this.rings = this.rings.filter(r => {
      r.life -= r.bossEffect || r.bossChip ? bossDt : dt; if (r.life <= 0) return false;
      const alpha = r.life / r.max;
      if (r.bossEffect) this.drawBossMoment(g, r, alpha);
      else if(r.bossChip) {
        const color=game.chapter.palette.at(-1),t=this.gentleEffects?1:1-alpha,x=r.x+(r.tx-r.x)*t,y=r.y+(r.ty-r.y)*t;
        if(!this.gentleEffects) g.moveTo(r.x,r.y).lineTo(r.tx,r.ty).stroke({color,width:1,alpha:alpha*.18});
        g.rect(x-2,y-2,4,4).fill({color,alpha:alpha*.7});
      }
      else if(r.arc) {
        const points=r.points;
        if(points?.length>1) {
          g.moveTo(points[0].x,points[0].y);
          for(let i=1;i<points.length;i++) {const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1;
            for(let j=1;j<=5;j++) {const t=j/5,bend=j===5?0:Math.sin(j*2.7+i)*7;g.lineTo(a.x+dx*t-dy/l*bend,a.y+dy*t+dx/l*bend);} }
          g.stroke({color:r.tech==='beamArc'?0x36aab7:r.split?0x8d72c9:0x487bcb,width:(r.tech==='beamArc'?4.5:3.2)*alpha,alpha:.85*alpha});
          for(const p of points.slice(1)) g.circle(p.x,p.y,4+(1-alpha)*8).stroke({color:0x79a1e1,width:1.5,alpha});
        }
      }
      else if(r.riftCollapse) {
        const age=1-alpha, radius=age<.28?r.radius*(1-age/.28):r.radius*(age-.28)/.72;
        g.circle(r.x,r.y,radius).stroke({color:age<.28?0x68518c:0x9876bd,width:3*alpha,alpha:.75*alpha});
        for(let i=0;i<4;i++) { const a=i*Math.PI/2+Math.PI/4,d=radius*.7;g.moveTo(r.x+Math.cos(a)*d,r.y+Math.sin(a)*d).lineTo(r.x+Math.cos(a)*radius,r.y+Math.sin(a)*radius).stroke({color:0x69518d,width:2,alpha}); }
      }
      else if(r.rift) {
        const radius=r.radius*(1-alpha);
        g.circle(r.x,r.y,radius).stroke({color:0x756099,width:2.8*alpha,alpha:.6*alpha});
        g.circle(r.x,r.y,radius*.7).stroke({color:0xaf99cf,width:1,alpha:.5*alpha});
      }
      else if(r.elite) {
        for(let i=0;i<2;i++) { const radius=18+(1-alpha)*(44+i*25);g.poly([r.x,r.y-radius,r.x+radius,r.y,r.x,r.y+radius,r.x-radius,r.y]).stroke({color:i?0xb4a0cf:0xd6ad53,width:alpha*3,alpha:alpha*.85}); }
      }
      else if(r.finale) {
        for(const line of r.segments || []) {
          const {x,y,tx,ty}=line;
          g.moveTo(x,y).lineTo(tx,ty).stroke({color:0xd9b566,width:8*alpha,alpha:.7*alpha});
          g.moveTo(x,y).lineTo(tx,ty).stroke({color:0xfff2c5,width:2*alpha,alpha});
        }
      }
      else if(r.feed) {
        const dx=r.tx-r.x,dy=r.ty-r.y,length=Math.hypot(dx,dy)||1,bend=Math.min(36,length*.2),cx=(r.x+r.tx)/2-dy/length*bend,cy=(r.y+r.ty)/2+dx/length*bend;
        g.moveTo(r.x,r.y).quadraticCurveTo(cx,cy,r.tx,r.ty).stroke({color:r.color,width:1,alpha:alpha*.24});
        for(let i=0;i<Math.min(4,Math.ceil(r.amount));i++) {
          const t=Math.max(0,Math.min(1,(1-alpha)*1.3-i*.08)),u=1-t,x=u*u*r.x+2*u*t*cx+t*t*r.tx,y=u*u*r.y+2*u*t*cy+t*t*r.ty;
          g.circle(x,y,3.5).fill(r.color).circle(x,y,1.3).fill(0xffffff);
        }
        g.circle(r.tx,r.ty,5+(1-alpha)*8).stroke({color:r.color,width:2,alpha:1-alpha});
      }
      else if(r.fracture) {
        const side=13+(1-alpha)*5;
        for(const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) g.moveTo(r.x+sx*(side-6),r.y+sy*side).lineTo(r.x+sx*side,r.y+sy*side).lineTo(r.x+sx*side,r.y+sy*(side-6)).stroke({color:0xb74d91,width:2.8*alpha,alpha});
      }
      else if(r.springBoost) {
        const dx=r.dx || 1,dy=r.dy || 0,offset=(1-alpha)*60;
        for(let i=0;i<3;i++) { const d=offset-i*13;if(d<0) continue;const x=r.x+dx*d,y=r.y+dy*d;g.moveTo(x-dx*5+dy*5,y-dy*5-dx*5).lineTo(x+dx*4,y+dy*4).lineTo(x-dx*5-dy*5,y-dy*5+dx*5).stroke({color:0xd4a424,width:2.5,alpha}); }
        g.ellipse(r.x,r.y,9+Math.sin((1-alpha)*Math.PI)*5,9-Math.sin((1-alpha)*Math.PI)*3).stroke({color:0xd4a424,width:2,alpha});
      }
      else if(r.returnPath) {
        const dx=r.tx-r.x,dy=r.ty-r.y,length=Math.hypot(dx,dy)||1;
        for(let d=0;d<length;d+=18) g.moveTo(r.x+dx*d/length,r.y+dy*d/length).lineTo(r.x+dx*Math.min(length,d+9)/length,r.y+dy*Math.min(length,d+9)/length).stroke({color:0x9560cd,width:1.5,alpha:alpha*.5});
        g.circle(r.x,r.y,4+(1-alpha)*18).stroke({color:0x9560cd,width:2,alpha});
      }
      else if(r.starEffect) {
        const center={x:r.triangle.reduce((s,p)=>s+p.x,0)/3,y:r.triangle.reduce((s,p)=>s+p.y,0)/3};
        if(r.starEffect==='starrefract') {
          for(let i=0;i<3;i++) { const a=r.triangle[i],b=r.triangle[(i+1)%3],t=Math.max(0,Math.min(1,(1-alpha)*7-i));
            g.moveTo(a.x,a.y).lineTo(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t).stroke({color:0x328fb5,width:7*alpha,alpha}).stroke({color:0xd9fdff,width:2*alpha,alpha});
          }
        }
        else if(r.starEffect==='starformed') {
          const scale=1-alpha*.23;g.poly(r.triangle.flatMap(p=>[center.x+(p.x-center.x)*scale,center.y+(p.y-center.y)*scale])).stroke({color:0x328fb5,width:3*alpha,alpha});
        }
        else for(let layer=0;layer<3;layer++) {
          const scale=r.starEffect==='starcollapse'?Math.max(0,alpha-layer*.12):1-layer*.13+(1-alpha)*.04;
          const points=r.triangle.flatMap(p=>[center.x+(p.x-center.x)*scale,center.y+(p.y-center.y)*scale]);
          g.poly(points).fill({color:0x6ad4d3,alpha:alpha*.055}).stroke({color:layer===1?0x8e89d5:0x328fb5,width:alpha*(r.starEffect==='starcollapse'?5:2.5),alpha:alpha*(1-layer*.2)});
          if(r.starEffect==='starcollapse') for(const p of r.triangle) g.moveTo(p.x,p.y).lineTo(center.x+(p.x-center.x)*scale,center.y+(p.y-center.y)*scale).stroke({color:0x70ccd8,width:alpha*1.5,alpha:alpha*.6});
        }
      }
      else if (r.tether) {
        g.moveTo(r.x,r.y).lineTo(r.tx,r.ty).stroke({color:r.fusion?0xd7b442:r.split?0xac62cf:0xa586d8,width:alpha*(r.split?3:5),alpha});
        if(r.split) {const t=Math.min(1,(1-alpha)*2);g.circle(r.x+(r.tx-r.x)*t,r.y+(r.ty-r.y)*t,3.5*alpha).fill(0xffffff);g.circle(r.tx,r.ty,7+(1-alpha)*9).stroke({color:0xac62cf,width:2,alpha});}
      }
      else if (r.beam) g.rect(0, r.y - 3 * alpha, 608, 6 * alpha).fill({ color: 0x58ccb8, alpha }).rect(r.x - 3 * alpha, 0, 6 * alpha, 608).fill({ color: 0x58ccb8, alpha });
      else if (r.pierce) g.moveTo(r.x-r.dx*24,r.y-r.dy*24).lineTo(r.x+r.dx*36,r.y+r.dy*36).stroke({color:0x569ee3,width:5*alpha,alpha});
      else if (r.magnet) { const t = 1 - alpha; g.circle(r.x+(r.tx-r.x)*t,r.y+(r.ty-r.y)*t,3*alpha).fill(0x55baa4); }
      else if (r.square) { const size = r.radius * (1-alpha); g.rect(r.x-size,r.y-size,size*2,size*2).fill({color:r.color,alpha:alpha*0.05}).stroke({color:r.color,width:alpha*4,alpha}); }
      else if (r.shock) {
        const radius = r.radius * Math.min(1,(1-alpha)*2.2);
        g.circle(r.x,r.y,radius).fill({color:r.color,alpha:alpha*0.12}).stroke({color:r.color,width:alpha*4,alpha});
        g.circle(r.x,r.y,radius*0.7).stroke({color:r.color,width:alpha*2,alpha:alpha*0.6});
        if(r.splitShock) for(let i=0;i<8;i++) {const a=i*Math.PI/4;g.moveTo(r.x+Math.cos(a)*radius*.9,r.y+Math.sin(a)*radius*.9).lineTo(r.x+Math.cos(a)*(radius+8),r.y+Math.sin(a)*(radius+8)).stroke({color:r.color,width:alpha*3,alpha});}
      } else g.circle(r.x, r.y, r.radius * (1 - alpha) + 3).stroke({ color: r.color, width: alpha * 4, alpha });
      return true;
    });
    this.floaters = this.floaters.filter(f => { f.life -= dt; if (f.life <= 0) { f.node.destroy({ children: true }); return false; } f.node.y -= dt * (f.id ? 7 : 28); f.node.alpha = Math.min(1, f.life / 0.45); if(f.id) f.node.scale.set(f.scale*(1 + Math.max(0, 0.18-(f.max-f.life))*0.8)); return true; });
    this.comboTexts = this.comboTexts.filter(f => {
      f.life -= dt; if(f.life<=0) {f.node.destroy();return false;}
      const age=1-f.life/f.max;
      f.node.y=f.y-(this.gentleEffects?8:19)*age;
      f.node.scale.set(1+(this.gentleEffects?0:.2)*Math.exp(-age*12));
      f.node.alpha=Math.min(1,f.life/.3);
      return true;
    });
  }
}
