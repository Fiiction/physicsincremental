import data from './data/balance.json';
import { Game, createProfile, sanitizeProfile, upgradeCost, upgradeStatus } from './game.js';
import { Renderer } from './renderer.js';
import { idleSnapshot } from './idle.js';
import { FrameLoop } from './frame-loop.js';
import presentation from './data/presentation.json' with { type: 'json' };
import { researchBranches, researchGroup, researchScene, attachResearchCamera, applyResearchCamera, zoomResearch, focusResearchNode } from './research-view.js';
import './style.css';

const $ = id => document.getElementById(id);
const htmlCache = new Map();
function setHTML(id, html) { if (htmlCache.get(id) !== html) { $(id).innerHTML = html; htmlCache.set(id, html); } }
const format = n => Math.floor(n).toLocaleString('en-US');
const SAVE_KEY = 'corebound.save.v1';
let saved;
try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { /* A damaged local save starts safely with a new profile. */ }
let profile;
try { profile = saved ? sanitizeProfile(saved.profile, data) : createProfile(); } catch { profile = createProfile(); }
let game = new Game(data, profile);
if (saved?.run) game.restore(saved.run);
let view, modal = '', uiClock = 0, saveClock = 0, practiceBackup = null, practicePaused = false, practiceKind = '', practiceDrop = 'arc', pausedBeforeModal = false, selectedTech = 'power';
let loop, simulatedThrough = Date.now(), renderClock = 0, researchedRun = null;
// Old versions stored a background-replay marker. Live play never replays saved time.
try { sessionStorage.removeItem(SAVE_KEY + '.background'); } catch { /* Optional legacy cleanup. */ }
const researchView = {zoom:1,x:0,y:0,recent:null};
let cleanupResearchCamera;

document.getElementById('app').innerHTML = `
  <div class="game-screen">
    <header class="game-header">
      <button class="chapter-select" data-action="chapters" title="选关" aria-label="选关"><span id="chapter-index">01</span><strong id="chapter-name"></strong><small class="chapter-label">选关</small><span class="chevron">⌄</span></button>
      <div class="wallet" title="矿晶"><span>✦</span><strong id="wallet">0</strong></div>
      <nav class="game-menu" aria-label="游戏菜单">
        <button class="menu-button research-entry" data-action="tech" title="科技树" aria-label="科技"><span>⌘</span><small>科技</small><i id="research-dot" hidden></i></button>
        <button class="menu-button" data-action="atlas" title="图鉴" aria-label="图鉴"><span>◇</span><small>图鉴</small></button>
        <button class="menu-button" data-action="stats" title="记录" aria-label="记录"><span>◷</span><small>记录</small></button>
        <button class="menu-button" data-action="settings" title="设置" aria-label="设置"><span>⚙</span><small>设置</small></button>
      </nav>
      <button class="icon-button" id="pause-button" data-action="pause" aria-label="暂停游戏" title="暂停 · P">Ⅱ</button>
    </header>
    <main class="playfield">
      <div class="match-hud"><aside class="goal-rail" id="mission-goals" aria-label="区域目标"></aside><span id="combo" class="sr-only">连击 0</span></div>
      <section class="arena-column" aria-label="游戏区域">
        <div class="arena-shell"><div id="canvas-host"></div><div class="first-hint" id="first-hint">拖拽发射</div><div class="boss-banner" id="boss-banner" aria-live="polite" hidden></div><div id="arena-overlay"></div><div class="practice-tools" id="practice-tools" aria-label="宝库试玩" hidden></div><button class="practice-exit" id="practice-exit" data-action="leave-practice" hidden>退出试玩 ×</button></div>
        <div class="arena-bottom">
          <div class="energy-box" title="剩余动能"><span aria-hidden="true">ϟ</span><div class="energy-track" id="energy-meter" role="meter" aria-label="动能" aria-valuemin="0" aria-valuemax="100"><i id="energy-fill"></i></div></div>
          <div class="shots-box" title="剩余弹射"><div class="battery-dots" id="battery-dots"></div><strong id="shots-label">5</strong></div>
          <button class="auto-button" id="auto-toggle" data-action="auto" role="switch" aria-label="自动引航" aria-checked="false"><span>⌁</span><small id="auto-label">自动</small><i id="auto-progress"></i></button>
          <button class="cashout-button" data-action="cashout" id="cashout" title="结算本局" aria-label="结算本局">⏏</button>
        </div>
      </section>
    </main>
  </div>
  <div id="combo-atmosphere" class="combo-atmosphere" aria-hidden="true"></div><span class="sr-only" id="save-status">已保存</span><div id="toast" role="status" aria-live="polite"></div><dialog id="dialog"><div id="dialog-content"></div></dialog><input id="import-file" type="file" accept="application/json,.json" hidden />
`;

function save() {
  if (practiceBackup) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ profile: game.profile, run: idleSnapshot(game, manualPause()), savedAt: simulatedThrough })); setHTML('save-status', '进度已自动保存'); }
  catch { setHTML('save-status', '浏览器存储不可用，请导出存档'); }
}
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('visible'), 3000); }
function techDemo(id) {
  const ore = (x,y,kind='') => `<g class="td-ore ${kind}" transform="translate(${x} ${y})"><rect width="19" height="19"/><rect class="td-hole" x="6" y="6" width="7" height="7"/></g>`;
  const ball = '<circle class="td-ball" r="5"/>';
  const frame = '<path class="td-frame" d="M132 88 182 22 228 88Z"/>';
  const charge = '<path class="td-charge" pathLength="1" d="M132 88 182 22 228 88"/>';
  const spark = '<circle class="td-spark" r="3"/>';
  const vault = (x,y,kind='') => `<g class="td-vault ${kind}" transform="translate(${x} ${y})"><rect x="-13" y="-13" width="26" height="26"/><path d="M-8 -5 -4 1 0 -4 4 1 8 -5 6 6H-6Z"/></g>`;
  const coins = '<g class="td-coins"><circle cx="0" cy="0" r="5"/><circle cx="-12" cy="8" r="3"/><circle cx="-17" cy="-6" r="3"/></g>';
  const mint = `<text class="td-mint-combo" x="38" y="73">×10</text><path class="td-guide" d="M102 64H214"/><circle class="td-wallet" cx="216" cy="63" r="15"/>${coins}`;
  const rift = '<g class="td-rift"><ellipse cx="39" cy="78" rx="12" ry="25"/><ellipse class="td-rift-pulse" cx="39" cy="78" rx="30" ry="25"/></g>';
  const demos = {
    beamArc: `${ore(64,46,'td-hit')}${ore(121,20,'td-hit')}${ore(170,57,'td-hit')}${ore(211,25,'td-hit')}<path class="td-beam" d="M20 56H233"/><path class="td-lightning" pathLength="1" d="M73 56 103 45 129 30 151 58 180 67 202 43 220 34"/>`,
    riftCollapse: `${ore(58,49,'td-hit')}${ore(176,31,'td-hit')}${ore(176,81,'td-hit')}<ellipse class="td-well" cx="124" cy="60" rx="22" ry="34"/><circle class="td-collapse-wave" cx="124" cy="60" r="64"/>`,
    starRift: `${ore(101,55,'td-hit')}${ore(146,70,'td-hit')}<path class="td-collapse" d="M50 88 120 20 199 88Z"/><ellipse class="td-afterwell" cx="124" cy="66" rx="20" ry="30"/><ellipse class="td-afterwell-ring" cx="124" cy="66" rx="39" ry="28"/>`,
    finaleSalvo: `${ore(15,19,'td-hit')}${ore(205,19,'td-hit')}${ore(215,86,'td-hit')}<path class="td-final-cut" d="M38 104 217 8 M30 10 218 103"/>${[-24,95,106].map((angle,i)=>`<g class="td-salvo td-salvo-${['a','b','c'][i]}"><g transform="rotate(${angle})"><path class="td-spear-tail" d="M0 6V23"/><path class="td-spear-head" d="M0 -11 5 5 0 2 -5 5Z"/></g></g>`).join('')}`,
    comboMint: mint,
    comboBurst: `${mint}${ore(160,16,'td-hit')}${ore(163,87,'td-hit')}<circle class="td-mint-wave" cx="115" cy="63" r="52"/>`,
    mintStar: `${frame}${charge}<text class="td-mint-combo" x="23" y="72">×10</text>${coins}`,
    eliteUnlock: `${ore(30,70)}${ore(58,70)}${ore(86,70)}${vault(158,56,'td-reveal')}<path class="td-crown-rays" d="M157 14V5 M189 28 197 20 M197 58H210"/>`,
    eliteChance: `${vault(56,63)}${vault(125,63,'td-reveal')}${vault(194,63,'td-reveal td-delay')}<path class="td-guide" d="M37 96H212"/>`,
    eliteAccess: `<path class="td-guide" d="M38 85H218 M38 58H218 M38 31H218"/><circle class="td-anchor" cx="38" cy="85" r="5"/>${vault(186,31,'td-inward')}`,
    elitePower: `${vault(63,63)}<path class="td-guide" d="M82 63H162"/><circle class="td-supernova" cx="183" cy="63" r="17"/><circle class="td-supernova-ring" cx="183" cy="63" r="32"/>`,
    eliteSeeds: `${vault(122,57,'td-open-vault')}<g class="td-seeds"><rect x="42" y="82" width="15" height="15"/><rect x="187" y="82" width="15" height="15"/></g><path class="td-seed-trail" d="M122 57 50 90 M122 57 194 90"/>`,
    treasureCombo: `${vault(61,62,'td-open-vault')}<path class="td-guide" d="M82 63H141"/><text class="td-treasure-combo" x="152" y="74">×20</text>`,
    arcSplit: `${ore(96,31,'td-hit')}${ore(160,54,'td-hit')}${ore(207,20,'td-hit')}<path class="td-lightning" pathLength="1" d="M40 85 108 40 132 65 169 64 188 31 216 29"/>${ball}`,
    riftEcho: `<circle class="td-anchor" cx="30" cy="84" r="5"/><path class="td-return-trail" d="M218 36 30 84"/>${ore(59,52,'td-hit')}${ore(64,83,'td-hit')}${rift}${ball}`,
    splitShock: `<path class="td-guide" d="M34 83 97 29 149 70"/><path class="td-wall" d="M83 20H112 M157 55V85"/>${ore(167,38,'td-hit')}${ore(165,91,'td-hit')}<circle class="td-wave" cx="149" cy="70" r="34"/>${ball}`,
    fracture: `<path class="td-sweep" d="M48 29V90"/>${ore(103,49,'td-intact')}${ore(166,49,'td-damaged')}<path class="td-extra" d="M166 45H185 M189 49V68"/>`,
    splitTether: `<circle class="td-anchor" cx="34" cy="89" r="5"/><path class="td-guide" d="M34 89 203 28 205 89"/><path class="td-wall" d="M190 18H218"/>${ore(117,47,'td-hit')}<path class="td-cut" d="M34 89 203 28"/>${ball}`,
    returnFormation: `<circle class="td-anchor" cx="34" cy="86" r="5"/><path class="td-guide" d="M207 35 34 86"/>${ore(116,51,'td-hit')}<path class="td-return-trail" d="M207 35 34 86"/>${ball}`,
    springHarvest: `<path class="td-guide" d="M36 89 128 70 199 23"/><g class="td-spring" transform="translate(139 73)"><circle r="12"/><circle class="td-spring-core" r="4"/></g><path class="td-boost" d="M145 52 189 23"/>${ball}`,
    constellation: `${ore(103,59,'td-hit')}${ore(137,66,'td-hit')}<path class="td-array td-form" d="M50 88 120 20 199 88Z"/><circle class="td-point td-point-a" cx="50" cy="88" r="4"/><circle class="td-point td-point-b" cx="120" cy="20" r="4"/><circle class="td-point td-point-c" cx="199" cy="88" r="4"/><path class="td-collapse" d="M50 88 120 20 199 88Z"/>${ball}`,
    starCombo: `<text class="td-combo" x="41" y="69">×</text><path class="td-guide" d="M65 61 154 61"/>${frame}${charge}${spark}`,
    starSplit: `${ore(54,53,'td-hit')}<path class="td-guide" d="M29 87 62 64"/>${frame}${charge}${ball}${spark}`,
    starBumper: `<path class="td-array" d="M65 83 162 24 224 87Z"/><circle class="td-point" cx="162" cy="24" r="3"/><circle class="td-point" cx="224" cy="87" r="3"/><g class="td-spring" transform="translate(65 83)"><circle r="12"/><circle class="td-spring-core" r="4"/></g><circle class="td-new-point" cx="65" cy="83" r="5"/><path class="td-charge" pathLength="1" d="M65 83 162 24 224 87"/>${ball}`,
    starReturn: `<circle class="td-anchor" cx="32" cy="83" r="5"/><path class="td-frame" d="M132 88 182 22 225 57Z"/><path class="td-guide" d="M225 57 32 83"/><path class="td-return-trail" d="M225 57 32 83"/><circle class="td-new-point" cx="225" cy="57" r="5"/><path class="td-charge" pathLength="1" d="M225 57 132 88 182 22"/>${ball}`,
    starPrism: `${ore(149,45,'td-hit')}${ore(190,46,'td-hit')}${ore(173,79,'td-hit')}${frame}<path class="td-beam" d="M22 64H237 M51 17V100"/><path class="td-refract" pathLength="1" d="M149 64 182 22 228 88 132 88 149 64"/>`,
    starSalvo: `${ore(15,19,'td-hit')}${ore(205,19,'td-hit')}${ore(215,86,'td-hit')}<path class="td-collapse" d="M50 88 120 20 199 88Z"/>${[-24,95,106].map((angle,i)=>`<g class="td-salvo td-salvo-${['a','b','c'][i]}"><g transform="rotate(${angle})"><path class="td-spear-tail" d="M0 6V23"/><path class="td-spear-head" d="M0 -11 5 5 0 2 -5 5Z"/></g></g>`).join('')}`
  };
  return demos[id] ? `<svg class="tech-demo td-${id}" viewBox="0 0 250 112" aria-hidden="true">${demos[id]}</svg>` : '';
}
function techTree() {
  const previews='<div class="research-previewbar"><span class="research-gesture">拖拽 · 滚轮 / 双指缩放</span><button data-system-preview>▷ 试玩星阵</button><button data-treasure-preview>▷ 试玩宝库</button><button data-endgame-preview>▷ 试玩终局</button></div>';
  const navigation=`<nav class="research-nav" aria-label="科技星图导航"><div class="research-legend">${researchBranches.map(b=>`<span style="--branch:${b.color}">${b.name}</span>`).join('')}</div><span class="research-total">${data.upgrades.filter(u=>game.level[u.id]).length}<small> / ${data.upgrades.length}</small></span><div class="research-zoom" aria-label="星图缩放"><button data-research-zoom="out" aria-label="缩小科技图" ${researchView.zoom<=1?'disabled':''}>−</button><button data-research-zoom="fit" aria-label="全览完整科技树">全览</button><button data-research-zoom="in" aria-label="放大科技图" ${researchView.zoom>=8?'disabled':''}>＋</button></div></nav>`;
  const scene=researchScene(data.upgrades,game.profile,{...researchView,selected:selectedTech},id=>upgradeStatus(data,game.profile,id));
  if(!selectedTech)return navigation+scene+previews;
  const current = data.upgrades.find(u => u.id === selectedTech), status = upgradeStatus(data, game.profile, current.id), level = game.level[current.id] || 0;
  const reason = status==='chapter' ? `第${current.chapter+1}区解锁` : status==='relic' ? '需要突破核心：'+data.relics.find(r=>r.id===current.requiresRelic).name : '';
  const demo = techDemo(current.id), description = current.levelDescriptions?.[Math.max(0,level-1)] || current.description;
  const reinforcementNote = /基础生命|最大生命|百分比/.test(description) ? `<small>生命削蚀按矿石基础生命计算，不含加固增量；清场每块削弱首领当前生命${Math.round(game.bossRules.clearDamageFraction*100)}%，需球体撞击击破</small>` : '';
  const prerequisites=current.requires.length?`<div class="research-prerequisites"><span>前置</span>${current.requires.map(id=>{const u=data.upgrades.find(u=>u.id===id),group=researchBranches.find(b=>b.id===researchGroup(u));return `<button data-tech="${id}" data-research-locate class="${game.level[id]?'complete':''}" title="${group.name} · ${u.name}">${game.level[id]?'✓':'↗'} ${u.name}</button>`;}).join('')}</div>`:'';
  return navigation+scene+`<div class="research-detail ${demo ? 'has-demo' : ''}"><button class="research-dismiss" data-research-dismiss aria-label="收起科技详情">×</button>${demo}<div class="research-copy"><h3>${current.icon} ${current.name} <small>${level}/${current.max}</small></h3>${current.previewCue ? `<p class="research-cue">${current.previewCue}</p>` : ''}<p class="research-effect">${description}</p>${reinforcementNote}${prerequisites}${reason ? `<small>${reason}</small>` : ''}</div><button class="primary-button" data-buy="${current.id}" ${status!=='available'?'disabled':''}>${status==='max'?'已满级':'✦ '+format(upgradeCost(data,game.profile,current.id))+'　研究'}</button></div>`+previews;
}
function updateUI() {
  const p = game.profile, c = game.chapter, stats = game.stats;
  if (modal === 'tech') {
    const wallet = document.querySelector('.modal-wallet');
    if (wallet && wallet.dataset.coins !== String(p.coins)) {
      wallet.dataset.coins = String(p.coins); wallet.textContent = `✦ ${format(p.coins)}`;
      for (const node of document.querySelectorAll('.research-node.poor, .research-node.available')) {
        const affordable = upgradeStatus(data, p, node.dataset.tech) === 'available';
        node.classList.toggle('available', affordable); node.classList.toggle('poor', !affordable);
      }
      const buy = document.querySelector('[data-buy]');
      if (buy) buy.disabled = upgradeStatus(data, p, buy.dataset.buy) !== 'available';
    }
  }
  const frontier = p.frontierChapter ?? p.chapter, isFrontier = game.isFrontier ?? p.chapter === frontier;
  $('wallet').textContent = format(p.coins); $('chapter-index').textContent = `0${p.chapter + 1}`; $('chapter-name').textContent = c.name;
  const goals = [['◩', '本局清场', Math.floor(game.clearRatio*100), Math.round(c.clearRatio*100), '%'], ['◆', '累计核心', p.stageCores, c.cores, ''], ['×', '最高连击', p.stageCombo, c.combo, '']];
  const clearPercent = Math.floor(game.clearRatio*100);
  $('mission-goals').classList.toggle('boss-rail', !!game.bossEnabled);
  if (game.bossEnabled) {
    const boss=game.boss, target=Math.round(c.boss.threshold*100), health=boss ? Math.max(0,boss.hp/boss.maxHP) : Math.min(1,game.clearRatio/c.boss.threshold);
    const status=boss ? boss.phase==='waking'?'正在苏醒':boss.alive?`剩余 ${game.shots} 发`:'已击破' : `唤醒 · ${clearPercent}/${target}%`;
    setHTML('mission-goals', `<div title="击碎一块矿石，削弱首领当前生命的${Math.round(game.bossRules.clearDamageFraction*100)}%；球体直接撞击才能击破首领" class="boss-gauge ${boss?'':'dormant'}"><strong>${boss?'◆':'◇'} ${c.boss.name}</strong><span>${status}</span><div class="boss-health" role="meter" aria-label="${boss?'首领剩余生命':'首领唤醒进度'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(health*100)}"><i style="width:${health*100}%"></i></div></div>`);
    $('mission-goals').setAttribute('aria-label',boss?'首领挑战':'清场唤醒首领');
  } else {
    setHTML('mission-goals', isFrontier ? goals.map(([icon, name, value, target, unit]) => `<button class="goal ${value >= target ? 'complete' : ''}" data-goal="${name} · ${value}/${target}${unit}" aria-label="${name} · ${value}/${target}${unit}" title="${name} · ${value}/${target}${unit}"><span>${value >= target ? '✓' : icon}</span><b>${unit ? value : Math.min(value,target)}<small>/${target}${unit}</small></b></button>`).join('') : `<button class="goal" data-goal="本局清场 · ${clearPercent}%" aria-label="本局清场 ${clearPercent}%"><span>◩</span><b>${clearPercent}<small>%</small></b></button><button class="frontier-return" data-action="chapters" title="返回主线：${data.chapters[frontier].name}" aria-label="返回主线：${data.chapters[frontier].name}">返回主线 ↗</button>`);
    $('mission-goals').setAttribute('aria-label',isFrontier ? '主线目标' : '本局开采');
  }
  const waking=game.boss?.phase==='waking', victorious=game.bossVictoryLeft>0;
  $('boss-banner').hidden=!(waking||victorious)||game.paused;
  $('boss-banner').classList.toggle('victory',victorious);
  if(waking||victorious) setHTML('boss-banner',`<small>${victorious?'区域解放':'清场削弱 · 撞击击破'}</small><strong>${victorious?'核芯击破':c.boss.name}</strong>`);
  $('research-dot').hidden = !data.upgrades.some(u => upgradeStatus(data, p, u.id) === 'available');
  $('shots-label').textContent = game.shots;
  $('shots-label').setAttribute('aria-label', `剩余 ${game.shots} 次弹射`);
  setHTML('battery-dots', Array.from({ length: Math.max(stats.shots, game.shots) }, (_, i) => `<i class="${i < game.shots ? 'charged' : ''}"></i>`).join(''));
  const energy = game.state === 'flying' ? Math.max(0, game.balls.find(b => b.main)?.energy || 0) : game.state === 'ready' ? stats.energy : 0;
  const full = game.state === 'flying' ? game.balls.find(b => b.main)?.initialEnergy || stats.energy : stats.energy;
  const ratio = Math.max(0, Math.min(100, energy / full * 100));
  $('energy-fill').style.width = ratio + '%'; $('energy-meter').setAttribute('aria-valuenow', Math.round(ratio));
  $('combo').textContent = `连击 ${game.combo}`;
  $('first-hint').hidden = game.run.shots > 0 || p.runs > 0 || !!view?.drag || !!game.boss;
  $('pause-button').textContent = game.paused ? '▶' : 'Ⅱ';
  $('pause-button').setAttribute('aria-label', game.paused ? '继续游戏' : '暂停游戏');
  $('pause-button').title = (game.paused ? '继续' : '暂停') + ' · P';
  $('cashout').disabled = game.state !== 'ready' || !game.run.shots;
  $('cashout').textContent = game.goalComplete ? '突破 →' : '⏏';
  $('cashout').classList.toggle('breakthrough-ready',game.goalComplete);
  $('cashout').setAttribute('aria-label',game.goalComplete ? '领取突破奖励，也可继续弹射' : '结算本局');
  $('cashout').title = game.goalComplete ? '领取突破奖励，也可继续弹射' : '结算本局';
  $('auto-toggle').classList.toggle('on', game.auto); $('auto-toggle').setAttribute('aria-checked', String(game.auto));
  $('auto-toggle').classList.toggle('locked', !game.level.idle);
  $('auto-toggle').classList.toggle('unlocked', !!game.level.idle);
  $('auto-toggle').title = game.level.idle ? `自动引航 · 收益${Math.round(stats.idleYield * 100)}% · 等待${stats.idleDelay}s` : '研究自动引航后解锁';
  $('auto-label').textContent = !game.auto ? '自动' : manualPause() ? '已暂停' : game.pendingChapterSelection || (game.state === 'ended' && game.goalComplete) ? '待突破' : '自动中';
  $('auto-progress').style.width = (game.auto && game.state !== 'flying' ? Math.min(100, game.idleTime / stats.idleDelay * 100) : 0) + '%';
  document.documentElement.style.setProperty('--chapter', c.color);
  $('practice-exit').hidden = !practiceBackup;
  $('practice-tools').hidden = !practiceBackup || practiceKind !== 'treasure';
  $('practice-tools').setAttribute('aria-label','宝库试玩');
  if (practiceBackup && practiceKind === 'treasure') setHTML('practice-tools', data.drops.filter(d=>d.elite).map(d=>`<button data-preview-drop="${d.id}" aria-label="试玩${d.name}，下一发生效" aria-pressed="${practiceDrop===d.id}" title="${d.name} · 下一发生效" style="--buff:${d.color}">${d.icon}<small>${d.name}</small></button>`).join('')+'<button data-preview-restart aria-label="重新试玩宝库" title="重新试玩">↻</button>');
  const held = game.state === 'flying' ? game.activeBuffs : game.buffs;
  view?.app.canvas.setAttribute('aria-label','弹球矿场。拖拽反向发射，方向键瞄准，空格发射。强化：'+(data.drops.filter(d=>held[d.id]).map(d=>`${d.name}${held[d.id]}层`).join('、')||'无'));
  renderOverlay();
}
function renderOverlay() {
  if (game.bossVictoryLeft>0 && !game.paused) { setHTML('arena-overlay',''); return; }
  if (game.pendingChapterSelection) {
    setHTML('arena-overlay', '<div class="settlement"><h2>突破完成</h2><button class="primary-button" data-action="chapters">选择下一站 →</button></div>');
    if (!modal && view && !document.hidden) openModal('chapters');
    return;
  }
  if (game.paused && !modal) { setHTML('arena-overlay', '<div class="pause-card"><button class="resume-button" data-action="pause" aria-label="继续游戏" title="继续">▶</button></div>'); return; }
  if (game.state !== 'ended') { setHTML('arena-overlay', ''); return; }
  const failed=game.boss?.alive, remaining=failed?Math.ceil(game.boss.hp/game.boss.maxHP*100):0;
  const upgradeFirst = researchedRun !== game.run;
  setHTML('arena-overlay', `<div class="settlement ${failed?'boss-failed':''}"><h2>${game.run.bossDefeated ? '首领已击破' : failed ? '守卫未破' : game.goalComplete ? '区域完成' : '开采完成'}</h2>${failed?`<div class="boss-remnant" style="--damage:${1-game.boss.hp/game.boss.maxHP}" aria-hidden="true"></div><p class="boss-result">${game.chapter.boss.name} · 剩余 ${remaining}%</p>`:''}<div class="result-income"><span>✦</span>+${format(game.run.coins)}</div><div class="result-stats"><span title="击碎方块">□ <b>${game.run.kills}</b></span><span title="最高连击">× <b>${game.run.combo}</b></span></div><div class="result-actions"><button class="${upgradeFirst ? 'primary-button' : 'secondary-button'}" data-action="tech">升级</button><button class="secondary-button" data-action="chapters">选关</button><button class="${upgradeFirst ? 'secondary-button' : 'primary-button'}" data-action="${practiceBackup ? 'leave-practice' : game.goalComplete ? 'advance' : 'restart'}">${practiceBackup ? '退出试玩' : game.goalComplete ? '突破 →' : failed ? '再挑战 →' : '继续 →'}</button></div>${practiceBackup?'<small>独立试玩 · 不影响存档</small>':failed?'<small>矿晶已保留 · 下局重新挑战</small>':game.auto ? `<small>${game.goalComplete ? '突破后选择下一站' : '自动续局'}</small>` : ''}</div>`);
}
function onAction(type, payload) {
  if (type === 'frame') {
    simulatedThrough = Date.now();
    if (view.drag && game.state === 'ready') game.idleTime = 0;
    game.tick(payload);
    const events = game.events.splice(0);
    let persist = false;
    for (const e of events) {
      if (e.type === 'shotend' && e.timeout) toast('弹射结束');
      if (e.type === 'drop' && ['cache','charge'].includes(e.id)) document.querySelector(e.id==='charge'?'.shots-box':'.wallet').animate([{transform:'scale(1)'},{transform:'scale(1.22)'},{transform:'scale(1)'}],{duration:420});
      if (['runend', 'core', 'upgrade'].includes(e.type)) persist = true;
    }
    view.events(events); renderClock += payload;
    // The menu covers most of the arena. Keep simulation and audio live, reserve UI time for input.
    if (!modal || renderClock + 1e-6 >= 1 / presentation.menuFPS) {
      view.render(renderClock); view.app.render(); renderClock = 0;
    }
    uiClock += payload; saveClock += payload;
    if (uiClock > 0.12) { updateUI(); uiClock = 0; }
    if (persist || saveClock >= 1) {
      if (persist) console.info('[Physics Incremental]', game.logs.at(-1));
      save(); saveClock = 0; updateTitle();
    }
  } else if (type === 'launch') { if (settleClock() && game.launch(payload.angle, payload.power)) { updateUI(); save(); } }
  else if (type === 'hint') toast(payload);
}
function action(name) {
  if (!settleClock()) return;
  view?.unlockAudio();
  view?.audio.ui('tap');
  if (name === 'play') closeModal();
  else if (name === 'pause') { game.paused = !game.paused; updateUI(); save(); }
  else if (name === 'sound') { game.profile.settings.sound = !game.profile.settings.sound; updateUI(); save(); }
  else if (name === 'auto') { if (game.level.idle) { game.auto = !game.auto; if (game.auto) game.paused = false; game.idleTime = 0; updateUI(); save(); } else openModal('tech'); }
  else if (name === 'restart') { game.newRun(); updateUI(); save(); }
  else if (name === 'cashout') { if (game.state === 'ready' && game.run.shots) { game.endRun(); updateUI(); save(); if(game.goalComplete && !practiceBackup) openModal('advance'); } }
  else if (name === 'chapters') openModal(!practiceBackup && game.state === 'ended' && game.goalComplete ? 'advance' : 'chapters');
  else if (name === 'advance') { if (practiceBackup) leavePractice(); else openModal('advance'); }
  else if (name === 'leave-practice') leavePractice();
  else if (name === 'export') download('physics-incremental-save.json', { profile: (practiceBackup || game).profile, run: idleSnapshot(practiceBackup || game, practiceBackup ? practicePaused : manualPause()), savedAt: simulatedThrough });
  else if (name === 'export-logs') download('physics-incremental-run-log.json', { date: new Date().toISOString(), chapter: game.chapter.name, events: game.logs, history: game.profile.history });
  else if (name === 'import') $('import-file').click();
  else if (name === 'reset-confirm') {
    if ($('reset-word')?.value !== '重新开始') { toast('请输入「重新开始」以确认'); return; }
    try { localStorage.setItem(SAVE_KEY + '.backup', JSON.stringify({ profile: game.profile, run: game.snapshot() })); } catch { toast('无法备份，请先导出存档'); return; }
    game = new Game(data); practiceBackup = null; view.game = game; view.rebuild(); closeModal(); save(); toast('新的旅程开始了；旧存档已在本机备份');
  }
  else if (name === 'recover') {
    try { const old = JSON.parse(localStorage.getItem(SAVE_KEY + '.backup')); const restored = new Game(data, sanitizeProfile(old.profile, data)); restored.restore(old.run); game = restored; practiceBackup = null; view.game = game; view.rebuild(); closeModal(); save(); toast('已恢复上次重置前的进度'); } catch { toast('没有可恢复的备份'); }
  }
  else openModal(name);
}
document.addEventListener('click', event => {
  if (!settleClock()) return;
  const buy = event.target.closest('[data-buy]');
  if (buy && game.buy(buy.dataset.buy)) { researchView.recent=buy.dataset.buy; view?.unlockAudio(); view?.audio.ui('buy'); toast('已研究：' + data.upgrades.find(u => u.id === buy.dataset.buy).name); updateUI(); if (modal === 'tech') {renderModal();document.querySelector('[data-buy]')?.focus({preventScroll:true});} save(); }
  const button = event.target.closest('[data-action]'); if (button) action(button.dataset.action);
  const tech = event.target.closest('[data-tech]'); if (tech) {
    const locate=tech.hasAttribute('data-research-locate')||document.querySelector('.research-viewport')?.clientWidth<650;
    selectedTech=tech.dataset.tech;researchView.recent=null;renderModal();
    const viewport=document.querySelector('.research-viewport');
    if(locate)focusResearchNode(viewport,researchView,selectedTech);
    viewport.querySelector(`[data-tech="${selectedTech}"]`)?.focus({preventScroll:true});
  }
  if(event.target.closest('[data-research-dismiss]')) {selectedTech=null;researchView.recent=null;renderModal();document.querySelector('.research-viewport')?.focus({preventScroll:true});}
  const zoom=event.target.closest('[data-research-zoom]'); if(zoom) {
    if(zoom.dataset.researchZoom==='fit'){selectedTech=null;researchView.recent=null;renderModal();}
    zoomResearch(document.querySelector('.research-viewport'),researchView,zoom.dataset.researchZoom==='fit'?1:researchView.zoom*(zoom.dataset.researchZoom==='in'?1.4:1/1.4));
  }
  const chapter = event.target.closest('[data-enter-chapter]'); if(chapter) enterChapter(Number(chapter.dataset.enterChapter));
  if(event.target.closest('[data-system-preview]')) startPractice(2,'constellation');
  if(event.target.closest('[data-treasure-preview]')) startPractice(data.previews.treasure?.chapter ?? 2,'treasure');
  if(event.target.closest('[data-endgame-preview]')) startPractice(data.previews.endgame?.chapter ?? 4,'endgame');
  const previewDrop=event.target.closest('[data-preview-drop]'); if(previewDrop && practiceBackup && practiceKind==='treasure') {
    const item=data.drops.find(d=>d.elite && d.id===previewDrop.dataset.previewDrop);
    if(item) { practiceDrop=item.id; for(const d of data.drops.filter(d=>d.elite)) delete game.buffs[d.id]; game.buffs[item.id]=1; updateUI(); toast(`${item.name} · 下一发生效`); }
  }
  if(event.target.closest('[data-preview-restart]') && practiceBackup) startPractice(game.profile.chapter,practiceKind);
  const relic = event.target.closest('[data-relic]'); if (relic && game.advance(relic.dataset.relic)) { openModal('chapters'); updateUI(); save(); toast(relic.dataset.relic==='fusion' ? '三核合相 · 返航唤醒整片弹簧网络' : '已唤醒：'+data.relics.find(r=>r.id===relic.dataset.relic).name); }
  const preview = event.target.closest('[data-relic-preview]'); if(preview) startPractice(1,preview.dataset.relicPreview);
  const practice = event.target.closest('[data-practice]'); if (practice) startPractice(Number(practice.dataset.practice));
  const buff = event.target.closest('[data-buff]'); if (buff) { const d = data.drops.find(d => d.id === buff.dataset.buff); toast(d.name + ' · ' + d.description); }
  const goal = event.target.closest('[data-goal]'); if (goal) toast(goal.dataset.goal);
});
function openModal(name) {
  if (!settleClock()) return;
  if (name === 'tech' && game.state === 'ended') researchedRun = game.run;
  if (!modal) pausedBeforeModal = game.paused;
  if(name==='tech'&&!modal) {Object.assign(researchView,{zoom:1,x:0,y:0,recent:null});selectedTech=null;}
  modal = name; game.paused = pausedBeforeModal || !game.auto; view.menuOpen = true; view.drag = null; renderModal();
  if (!$('dialog').open) $('dialog').showModal();
  if(name==='tech')applyResearchCamera(document.querySelector('.research-viewport'),researchView);
}
function closeModal() {
  simulatedThrough = Date.now();
  cleanupResearchCamera?.();cleanupResearchCamera=null;$('dialog').close(); modal = ''; view.menuOpen = false; game.paused = pausedBeforeModal; updateUI();
}
function relicDemo(id) {
  const geometry = id==='heart' ? '<path class="demo-flash" d="M32 94 L194 30 M32 94 L200 98"/><circle cx="32" cy="94" r="5"/><rect class="demo-ore" x="111" y="56" width="15" height="15"/>' : id==='mint' ? '<circle class="demo-spring" cx="130" cy="70" r="12"/><circle cx="130" cy="70" r="4"/><rect class="demo-ore" x="121" y="61" width="18" height="18"/>' : id==='fusion' ? '<path class="demo-flash" d="M120 75 L45 40 M120 75 L198 42 M120 75 L174 111"/><circle class="demo-spring" cx="45" cy="40" r="8"/><circle class="demo-spring" cx="198" cy="42" r="8"/><circle class="demo-spring" cx="174" cy="111" r="8"/><circle cx="120" cy="75" r="4"/>' : '<path class="demo-path" d="M32 94 L146 30 L204 84"/><path class="demo-flash" d="M204 84 L32 94"/><rect class="demo-ore" x="112" y="81" width="16" height="16"/>';
  return `<svg class="relic-demo demo-${id}" viewBox="0 0 240 130" aria-hidden="true">${geometry}<circle class="demo-ball" r="6"/></svg>`;
}
function relicCard(r, choose=false) {
  return `<article class="relic-card">${relicDemo(r.id)}<div class="relic-copy"><small>${r.verb}</small><h3>${r.name}</h3><p>${r.description}</p><div class="relic-actions"><button class="text-button" data-relic-preview="${r.id}">▷ 试玩</button>${choose?`<button class="primary-button" data-relic="${r.id}">唤醒 →</button>`:''}</div></div></article>`;
}
function itemCollection(elite=false) {
  const p=game.profile, items=data.drops.filter(d=>!!d.elite===elite), locked=elite&&!game.level.eliteUnlock;
  return `<h3 class="subheading collection-heading">${elite?'♛ 高级宝库':'◇ 普通宝箱'} <span>${items.filter(d=>p.seenDrops.includes(d.id)).length}/${items.length}</span>${elite?'<button class="text-button" data-treasure-preview>▷ 试玩宝库</button>':''}</h3><p class="fine-print">${elite ? locked?'研究「'+data.upgrades.find(u=>u.id==='eliteUnlock').name+'」后生成。':'稀有强化 · 本局持续 · 二级透视可见内容' : '金色◇必出道具；透视可见内容。普通方块只产矿晶。'}</p><div class="item-grid ${elite?'elite-items':''}">${items.map(d=>{
    const seen=p.seenDrops.includes(d.id);
    return `<details class="item-card ${seen?'discovered':'undiscovered'}"><summary><span class="item-icon" style="--buff:${d.color}">${seen?d.icon:elite?'♛':'◇'}</span><b>${seen?d.name:locked?'未解锁':'未发现'}</b>${seen?'<small>✓</small>':''}</summary><p>${seen?d.description+(d.stackable&&!elite?'；每层另加25%伤害。':''):elite?'击碎王冠宝箱，发现一种稀有强化。':'开启普通宝箱，记录新的道具。'}</p></details>`;
  }).join('')}</div>`;
}
function chapterArt(chapter, index) {
  const cells = [];
  for (let y=0;y<11;y++) for (let x=0;x<11;x++) {
    const dx=x-5,dy=y-5,ring=Math.max(Math.abs(dx),Math.abs(dy));
    if (ring<2) continue;
    const motif=[dx+dy,Math.abs(dx)-Math.abs(dy),Math.sin(dx)*2+dy,dx-dy,Math.abs(dx+dy)-Math.abs(dx-dy)][index];
    const shade=Math.max(0,Math.min(chapter.palette.length-1,Math.round((ring-2)/3*(chapter.palette.length-1)+motif*.28)));
    cells.push(`<rect x="${x*10+.5}" y="${y*10+.5}" width="9" height="9" fill="${chapter.palette[shade]}"/>`);
  }
  return `<svg class="region-art" viewBox="0 0 110 110" aria-hidden="true">${cells.join('')}<circle cx="55" cy="55" r="3" fill="${chapter.color}"/></svg>`;
}
function chapterSelection() {
  const mining = practiceBackup || game, p = mining.profile, pending = mining.pendingChapterSelection;
  const frontier = p.frontierChapter ?? p.chapter, unlocked = p.unlockedChapter ?? p.chapter;
  return `<p class="region-caption">${pending ? p.chapter===data.chapters.length-1 ? '新周目 · 选择下一站' : '区域已解锁 · 选择下一站' : practiceBackup ? '进入正式区域将结束试玩' : '已解锁区域可重复开采'}</p><nav class="region-route" aria-label="选择开采区域">${data.chapters.map((c,i)=>{
    const current=i===p.chapter,locked=i>unlocked,active=current&&!pending&&mining.state!=='ended';
    const status=locked?'未解锁':active?'开采中':pending&&i===frontier?'下一站 →':i===frontier?'主线 →':current?'重新开采 →':'进入 →';
    return `<button class="region-node ${current&&!pending?'current':''} ${i===frontier?'frontier':''} ${locked?'locked':''} ${pending&&i===frontier?'newly-open':''}" data-enter-chapter="${i}" style="--region:${c.color}" ${locked||active?'disabled':''} aria-label="${status.replace(' →','')}：${c.name}"><span class="region-number">0${i+1}<small>${i<frontier?'✓':locked?'◇':''}</small></span>${chapterArt(c,i)}<strong>${c.name}</strong><span class="region-mechanic">${c.mechanic}</span><span class="region-status">${status}</span></button>`;
  }).join('')}</nav>${pending?'<div class="region-footer"><button class="text-button" data-action="tech">⌘ 科技</button><span>突破奖励已收取</span></div>':''}`;
}
function renderModal() {
  const p = game.profile;
  const title = (cn, extra = '') => `<div class="modal-heading"><h2 id="modal-title">${cn}</h2>${extra}</div>`;
  let content = '';
  if (modal === 'tech') {
    content = title('科技星图', `<span class="modal-wallet">✦ ${format(p.coins)}</span>`) + techTree();
  } else if (modal === 'chapters') {
    content = title('选择区域') + chapterSelection();
  } else if (modal === 'atlas') {
    content = title('图鉴');
    content += `<div class="atlas-previews" aria-label="区域机制试玩">${data.chapters.map((c,i)=>`<button class="text-button" data-practice="${i}" style="--region:${c.color}" title="独立试玩，不影响存档">▷ ${c.name}</button>`).join('')}</div>`;
    content += itemCollection() + itemCollection(true);
    content += '<h3 class="subheading">突破核心</h3><div class="relic-grid">'+data.relics.map(r=>relicCard({...r,verb:p.relics.includes(r.id)?'已唤醒':r.verb})).join('')+'</div>';
  } else if (modal === 'advance') {
    const choices=data.relics.filter(r=>!p.relics.includes(r.id));
    content = title(choices.length ? '唤醒核心' : '三核合相');
    if(choices.length) content += `<div class="relic-grid" style="--choices:${choices.length}">${choices.map(r=>relicCard(r,true)).join('')}</div>`;
    else content += `<div class="fusion-reward">${relicDemo('fusion')}<p>弹簧预置于起点。每次返航，锚核向所有弹簧释放切割光弦。</p><button class="primary-button" data-relic="fusion">${p.chapter===data.chapters.length-1?'合相 · 开启新周目':'继续 →'}</button></div>`;
    content += `<p class="breakthrough-footer">永久保留 · ✦ +${format(game.chapter.bonus)}<span>${p.chapter===data.chapters.length-1?'新周目 · 科技保留':game.chapter.unlock}</span></p>`;
  } else if (modal === 'stats') {
    content = title('记录');
    content += `<div class="record-totals"><div><b>${format(p.earned)}</b><span>累计矿晶</span></div><div><b>${format(p.totalKills)}</b><span>击碎方块</span></div><div><b>${p.bestCombo}×</b><span>最高连击</span></div><div><b>${p.prestige}</b><span>奇点跃迁</span></div></div>`;
    const max = Math.max(1, ...p.history.map(h => h.coins));
    content += p.history.length ? `<div class="history-chart">${p.history.map((h, i) => `<div title="第 ${Math.max(1, p.runs - p.history.length + i + 1)} 局：${h.coins} 矿晶，${h.combo} 连击"><span>${format(h.coins)}</span><i style="height:${(10 + h.coins / max * 100)/16}rem;background:${data.chapters[h.chapter].color}"></i><small>${Math.max(1, p.runs - p.history.length + i + 1)}</small></div>`).join('')}</div><div class="history-table"><div class="table-head"><span>区域</span><span>矿晶</span><span>连击</span><span>弹射</span></div>${p.history.slice().reverse().map(h => `<div><span>${data.chapters[h.chapter].name} <small>${h.auto ? '自动' : ''}</small></span><b>${format(h.coins)}</b><span>${h.combo}×</span><span>${h.shots}</span></div>`).join('')}</div>` : '<p class="empty-record">暂无记录</p>';
  } else if (modal === 'help') {
    content = title('操作');
    content += `<div class="help-list"><p><b>拖拽圆球</b><span>反向发射，拉远蓄力</span></p><p><b>↑ ↓ ← → / 空格</b><span>瞄准 / 满力发射</span></p><p><b>A / P</b><span>自动 / 暂停</span></p><p><b>方形空洞</b><span>边长随损伤增加</span></p><p><b>◇ / ♛</b><span>普通宝箱 / 稀有宝库；透视可见内容</span></p><p><b>× 连击</b><span>十连色散 · 连击推动色相</span></p><p><b>中心首领</b><span>清场唤醒 · 用剩余弹射击破后过关</span></p><p><b>挑战失败</b><span>保留矿晶；升级后下局重新唤醒满血首领</span></p><p><b>折跃门</b><span>第三关起双向传送</span></p><p><b>终光裁切</b><span>第五关每 40 连击斜交切割</span></p><p><b>热尾 / 卫星 / 波纹 / 蓝芯</b><span>动能 / 分裂 / 冲击 / 穿透</span></p></div><p class="fine-print">选关可重返已解锁区域。强化每局重置，下一发生效，满层转矿晶。自动引航后台可继续开采。</p>`;
  } else if (modal === 'settings') {
    content = title('设置');
    content += '<details class="background-help"><summary>后台挂机</summary><p>前后台使用同一局游戏，切换窗口无需加载交接。自动开启后持续开采，画面和已开启的声音照常运行；主线击破后等待你选择突破奖励。</p><p>长时间挂机，可在 Chrome 或 Edge 的「性能」设置中，将本站加入「始终保持这些网站活跃」。浏览器强制休眠或电脑睡眠时会暂停；恢复后继续，不补算停顿时间。</p><p><a href="https://support.google.com/chrome/answer/12929150?hl=zh-Hans" target="_blank" rel="noopener noreferrer">Chrome 设置说明 ↗</a> · <a href="https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge" target="_blank" rel="noopener noreferrer">Edge 设置说明 ↗</a></p></details>';
    content += `<div class="audio-settings">${[['sound','音效','soundVolume'],['music','背景音乐','musicVolume']].map(([key,name,volume])=>`<div class="audio-setting"><label><b>${name}</b><input type="checkbox" data-setting="${key}" ${p.settings[key]?'checked':''}></label><input type="range" min="0" max="100" step="1" value="${Math.round(p.settings[volume]*100)}" data-volume="${volume}" aria-label="${name}音量" /></div>`).join('')}</div><div class="settings-list">${[['shake', '震动'], ['particles', '碎片'], ['reducedEffects', '柔和特效']].map(([id, name]) => `<label><b>${name}${id==='reducedEffects'?'<small>关闭全屏染色，减少动效</small>':''}</b><input type="checkbox" data-setting="${id}" ${p.settings[id] ? 'checked' : ''}></label>`).join('')}</div><h3 class="subheading">存档</h3><div class="settings-actions"><button class="secondary-button" data-action="export">导出</button><button class="secondary-button" data-action="import">导入</button><button class="secondary-button" data-action="recover">恢复备份</button></div><div class="settings-links"><button class="text-button" data-action="help">操作</button><button class="text-button" data-action="logs">日志</button><button class="text-button danger" data-action="reset">重置</button></div>`;
  } else if (modal === 'reset') {
    content = title('重置进度') + '<p class="fine-print">当前进度将备份到本机，可在设置中恢复。</p>';
    content += '<label class="reset-label">输入「重新开始」<input id="reset-word" placeholder="重新开始" autocomplete="off"></label><div class="settings-actions"><button class="primary-button" data-action="reset-confirm">备份并重新开始</button><button class="secondary-button" data-action="export">先导出存档</button></div>';
  } else if (modal === 'logs') {
    content = title('日志');
    content += '<button class="secondary-button" data-action="export-logs">导出日志 ↗</button><pre class="log-view"></pre>';
  }
  cleanupResearchCamera?.();cleanupResearchCamera=null;
  $('dialog-content').innerHTML = `${modal==='chapters' && game.pendingChapterSelection ? '' : '<button class="modal-close" data-action="play" aria-label="关闭">×</button>'}${content}`;
  $('dialog').dataset.mode = modal;
  $('dialog').setAttribute('aria-labelledby', 'modal-title');
  if(modal==='tech') cleanupResearchCamera=attachResearchCamera(document.querySelector('.research-viewport'),researchView);
  if (modal === 'logs') $('dialog-content').querySelector('pre').textContent = game.logs.slice().reverse().map(e => `${e.seq} | ${e.time}s | ${e.event} | ${JSON.stringify(e)}`).join('\n');
}
function download(name, content) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function enterChapter(chapter) {
  if (document.hidden || !settleClock()) return false;
  const mining = practiceBackup || game;
  if (!mining.selectChapter(chapter)) return false;
  game = mining; practiceBackup = null; view.game = game; view.drag = null; view.rebuild();
  pausedBeforeModal = false; closeModal(); save(); updateUI();
  return true;
}
function startPractice(chapter, relic) {
  if (document.hidden || !settleClock()) return false;
  if (!Number.isInteger(chapter) || chapter < 0 || chapter >= data.chapters.length) return false;
  if (!practiceBackup) { save(); practicePaused = modal ? pausedBeforeModal : game.paused; practiceBackup = game; }
  practiceKind = relic || '';
  const p = createProfile(); p.chapter = chapter; p.unlockedChapter = Math.max(p.unlockedChapter || 0,chapter); p.frontierChapter = chapter;
  p.settings = {...practiceBackup.profile.settings};
  p.upgrades = { power: data.previews.power[chapter], kinetic: data.previews.kinetic[chapter], combo: chapter ? 2 : 0, idle: 1, split: chapter ? 1 : 0, splitCombo: chapter ? 1 : 0, shock: chapter >= 1 ? 1 : 0, reactor: chapter >= 1 ? 1 : 0, chain: chapter >= 2 ? 1 : 0 };
  if(relic==='constellation') { p.relics=data.relics.map(r=>r.id); Object.assign(p.upgrades,{power:data.previews.constellationPower,constellation:1,splitShock:2,fracture:1,splitTether:2,returnFormation:2,springHarvest:2,starCombo:2,starSplit:2,starBumper:2,starReturn:2,starPrism:2,starSalvo:2,prism:1,magnet:1}); }
  if(relic==='treasure') {
    const preview=data.previews.treasure;
    p.relics=data.relics.map(r=>r.id);
    Object.assign(p.upgrades,preview.upgrades,{power:preview.power,kinetic:preview.kinetic});
  }
  if(relic==='endgame' && data.previews.endgame) {
    const preview=data.previews.endgame;
    p.relics=data.relics.map(r=>r.id);
    Object.assign(p.upgrades,preview.upgrades,{power:preview.power,kinetic:preview.kinetic});
  }
  if(relic==='fusion') { p.relics=data.relics.map(r=>r.id); p.prestige=1; }
  else if(data.relics.some(r=>r.id===relic)) p.relics=[relic];
  game = new Game(data, p, 42000 + chapter); if(chapter) game.buffs = { split: 1, shock: 1, boost: 1 };
  if(relic==='endgame') Object.assign(game.buffs,data.previews.endgame?.buffs || {overdrive:1,arc:1,rift:1});
  if(relic==='treasure') {
    game.buffs[practiceDrop]=1;
    // Keep the genuine map and reward rules; bring two preview prizes within reach.
    const near=game.blocks.filter(b=>b.ring===3&&b.type==='normal').sort((a,b)=>Math.abs(a.gx-9)+Math.abs(a.gy-9)-Math.abs(b.gx-9)-Math.abs(b.gy-9));
    const outward=game.blocks.filter(b=>b.type==='elite'&&b.ring>3);
    const needed=Math.max(0,2-game.blocks.filter(b=>b.type==='elite'&&b.ring===3).length);
    for(let i=0;i<Math.min(needed,near.length,outward.length);i++) {
      const target=near[i], source=outward[i];
      target.type='elite';target.supply=source.supply;target.hp=target.maxHP=Math.round(target.maxHP*data.elite.hpMultiplier*100)/100;
      source.type='normal';source.supply=null;source.hp=source.maxHP=Math.round(source.maxHP/data.elite.hpMultiplier*100)/100;
    }
  }
  view.game = game; view.rebuild(); pausedBeforeModal = false; closeModal();
  toast(relic==='treasure' ? '宝库试玩 · 拖拽发射，切换下发强化' : relic==='endgame' ? '终局试玩 · 拖拽发射' : '试玩 · 不影响存档'); return true;
}
function leavePractice() {
  if (document.hidden || !settleClock()) return false;
  if (!practiceBackup) return false;
  game = practiceBackup; practiceBackup = null; practiceKind = ''; view.game = game; view.rebuild(); pausedBeforeModal = practicePaused; closeModal(); save(); return true;
}
document.addEventListener('change', event => {
  if (event.target.dataset.setting) { view?.unlockAudio(); game.profile.settings[event.target.dataset.setting] = event.target.checked; view?.audio.update(game, { hidden: document.hidden, paused: game.paused || !!modal }); save(); updateUI(); }
  if (event.target.dataset.volume) save();
});
document.addEventListener('input', event => {
  const key=event.target.dataset.volume;
  if (['soundVolume','musicVolume'].includes(key)) { view?.unlockAudio(); game.profile.settings[key]=Math.max(0,Math.min(1,Number(event.target.value)/100)); view?.audio.update(game, { hidden: document.hidden, paused: game.paused || !!modal }); }
});
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('存档文件过大');
    const input = JSON.parse(await file.text()), p = sanitizeProfile(input.profile, data), imported = new Game(data, p);
    if (document.hidden) throw new Error('请回到游戏界面后重新导入');
    if (input.run && !imported.restore(input.run)) throw new Error('本局数据损坏，未覆盖现有进度');
    localStorage.setItem(SAVE_KEY + '.backup', JSON.stringify({ profile: (practiceBackup || game).profile, run: (practiceBackup || game).snapshot() }));
    game = imported; practiceBackup = null; view.game = game; view.rebuild(); pausedBeforeModal = false; closeModal(); save(); toast('存档导入成功');
  } catch (error) { toast('导入失败：' + error.message); }
  event.target.value = '';
});
$('dialog').addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
window.addEventListener('keydown', e => {
  if (modal || ['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); view?.unlockAudio(); if (game.state === 'ready') onAction('launch', { angle: view.aim, power: 1 }); else if (game.state === 'ended') action(game.goalComplete ? 'advance' : 'restart'); }
  const directions = { ArrowUp: -Math.PI / 2, ArrowDown: Math.PI / 2, ArrowLeft: Math.PI, ArrowRight: 0 };
  if (e.code in directions) { e.preventDefault(); view.aim = directions[e.code]; view.keyboardAim = true; }
  if (e.code === 'KeyP') action('pause');
  if (e.code === 'KeyA') action('auto');
});
function manualPause() { return modal ? pausedBeforeModal : game.paused; }
// Embedded browsers may keep visibilityState='visible' after the player switches away.
function isBackgroundPage() { return document.hidden || document.hasFocus?.() === false; }

// Changes start now, never at an old save or suspended-frame timestamp.
function settleClock() {
  loop?.reset();
  simulatedThrough = Date.now();
  return true;
}
function updateTitle() {
  document.title = 'Physics Incremental by Fiiction';
}
function syncPresence() {
  if (!view) return;
  if (isBackgroundPage()) view.drag = null;
  view.audio.update(game, { hidden: document.hidden, paused: game.paused || !!modal });
  updateTitle(); save();
}
document.addEventListener('visibilitychange', syncPresence);
window.addEventListener('blur', syncPresence);
window.addEventListener('focus', syncPresence);
window.addEventListener('pagehide', () => { save(); loop?.stop(); });
window.addEventListener('pageshow', () => { loop?.start(); syncPresence(); });
document.addEventListener('freeze', save);
document.addEventListener('resume', syncPresence);
updateUI();
// Pixi's lazy renderer chunks import shared exports from the built entry.
// Let that entry finish evaluating before waiting for renderer initialization.
async function start() {
try { view = await new Renderer(game, $('canvas-host'), onAction).init(); updateUI(); }
catch (error) { console.error(error); $('canvas-host').innerHTML = '<div class="graphics-error"><h2>画面初始化未完成</h2><p>请使用支持 WebGL 的浏览器，并开启硬件加速后刷新。</p></div>'; }
if (view) {
  loop = new FrameLoop(dt => onAction('frame', dt), data.idleRuntime, seconds => {
    game.log('runtime_interrupted', { seconds: Math.round(seconds), replayed: false });
  });
  loop.start(); syncPresence();
}
window.corebound = { get game() { return game; }, get renderer() { return view; }, data, save, getState: () => {
  const p=game.profile,g=game,b=g.blocks?.find(block=>block.type==='boss');
  return { state:g.state, auto:!!g.auto, paused:manualPause(), pendingChapterSelection:!!p.pendingChapterSelection, chapter:p.chapter, unlockedChapter:p.unlockedChapter, frontierChapter:p.frontierChapter, isFrontier:p.chapter===p.frontierChapter, coins:p.coins, shots:g.shots, combo:g.combo, run:{...g.run}, buffs:{...g.buffs}, boss:b?{name:data.chapters[p.chapter].boss.name,phase:b.phase,hp:b.hp,maxHP:b.maxHP,size:b.size,rotation:b.rotation}:null, position:{...g.position}, background:isBackgroundPage(), execution:'continuous', backgroundRuntime:null };
} };
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const register = tool => { try { Promise.resolve(modelContext.registerTool(tool)).catch(error => console.warn('WebMCP registration', error)); } catch (error) { console.warn('WebMCP registration', error); } };
  register({ name: 'read_game_state', description: '读取Physics Incremental的当前可见游戏状态、主线与资源。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => { const state=window.corebound.getState(); return { ...state, goalComplete:state.run.bossVersion===1 ? !state.pendingChapterSelection&&state.isFrontier&&state.run.bossDefeated : game.goalComplete, practice:!!practiceBackup, stats:game.stats }; } });
  register({ name: 'launch_ball', description: '按指定角度与力度发射弹球；消耗本局一次弹射。', inputSchema: { type: 'object', properties: { angle: { type: 'number' }, power: { type: 'number', minimum: 0.3, maximum: 1 } }, required: ['angle', 'power'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: input => { if (!input || !Number.isFinite(input.angle) || !Number.isFinite(input.power) || input.power < 0.3 || input.power > 1) throw new Error('角度须为弧度，力度须在 0.3 至 1 之间'); const launched = !modal && !document.hidden && game.launch(input.angle, input.power); updateUI(); save(); return { launched, ...window.corebound.getState() }; } });
  register({ name: 'start_mechanic_preview', description: '进入独立的章节机制试玩。保留正式进度，暂停正式开采。', inputSchema: { type: 'object', properties: { chapter: { type: 'integer', minimum: 0, maximum: data.chapters.length-1 } }, required: ['chapter'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: input => { if (!Number.isInteger(input?.chapter) || input.chapter < 0 || input.chapter >= data.chapters.length) throw new Error(`章节须为 0 到 ${data.chapters.length-1}`); return { started: startPractice(input.chapter), ...window.corebound.getState() }; } });
  register({ name: 'leave_mechanic_preview', description: '结束机制试玩，恢复正式开采进度。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => ({ restored: leavePractice(), ...window.corebound.getState() }) });
  register({ name: 'start_treasure_preview', description: '进入独立宝库试玩，选择一种真实稀有强化；保留正式进度。', inputSchema: { type: 'object', properties: { effect: { type: 'string', enum: ['overdrive','arc','rift'] } }, required: ['effect'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: input => { if (!data.drops.some(d=>d.elite && d.id===input?.effect)) throw new Error('请选择一种高级宝库强化'); practiceDrop=input.effect; return { started: startPractice(data.previews.treasure.chapter,'treasure'), ...window.corebound.getState() }; } });
}
}
void start();
