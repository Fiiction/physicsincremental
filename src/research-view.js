// One continuous map; related systems form visible limbs.
export const researchBranches = [
  {id:'core',name:'核心',color:'#5f85be'}, {id:'links',name:'联动',color:'#cd8d71'},
  {id:'treasure',name:'宝库',color:'#bd9b4d'}, {id:'stars',name:'星阵',color:'#56a6ab'},
  {id:'finale',name:'终局',color:'#9975b3'}
];
export const researchSize = {width:1480,height:860};
export const researchPositions = {
  power:[75,335], kinetic:[75,175], salvage:[75,540], fortune:[75,735],
  battery:[235,65], idle:[235,190], idleYield:[395,65], idleSpeed:[395,185], magnet:[235,470],
  combo:[235,335], split:[395,295], splitCombo:[555,205], chain:[715,145],
  springHarvest:[555,65], splitTether:[880,65], splitShock:[880,190], returnFormation:[715,280],
  shock:[395,425], reactor:[555,345], fracture:[715,420], prism:[880,420],
  comboMint:[555,480], comboBurst:[715,535], arcSplit:[880,600], riftEcho:[1045,725],
  sight:[235,650], comboLuck:[235,790], idleLuck:[395,650], goldCombo:[395,790],
  eliteUnlock:[395,540], eliteChance:[555,605], eliteAccess:[555,755],
  elitePower:[715,655], eliteSeeds:[715,790], treasureCombo:[880,790],
  constellation:[1045,270], starCombo:[1205,65], starSplit:[1205,195],
  starBumper:[1045,65], starReturn:[1205,330], starPrism:[1045,415], mintStar:[1045,560],
  starSalvo:[1375,205], beamArc:[1205,540], riftCollapse:[1205,735], starRift:[1375,660], finaleSalvo:[1375,415]
};
export const researchGroup = u => u.viewGroup;

export function researchScene(upgrades,profile,state,status) {
  const ancestors=new Set(), byId=new Map(upgrades.map(u=>[u.id,u]));
  const visit=id=>{if(ancestors.has(id))return;ancestors.add(id);byId.get(id)?.requires.forEach(visit);};
  if(state.selected)visit(state.selected);
  const color=u=>researchBranches.find(b=>b.id===researchGroup(u)).color;
  const paths=upgrades.flatMap(u=>u.requires.map(id=>{
    const [ax,ay]=researchPositions[id], [bx,by]=researchPositions[u.id], bend=Math.max(60,Math.abs(bx-ax)*.45);
    const selected=ancestors.has(id)&&ancestors.has(u.id), powered=profile.upgrades[id]&&profile.upgrades[u.id];
    return `<path data-from="${id}" data-to="${u.id}" class="${powered?'powered':''} ${selected?'selected':''} ${state.recent===u.id?'activated':''}" style="--branch:${color(u)}" d="M${ax} ${ay} C${ax+bend} ${ay} ${bx-bend} ${by} ${bx} ${by}"/>`;
  })).join('');
  const buttons=upgrades.map(u=>{
    const [x,y]=researchPositions[u.id], level=profile.upgrades[u.id]||0, kind=status(u.id);
    return `<button class="research-node ${kind} ${level?'owned':''} ${ancestors.has(u.id)?'in-route':''} ${state.selected===u.id?'selected':''} ${state.recent===u.id?'just-upgraded':''} ${u.viewGroup==='finale'||u.id==='constellation'?'keystone':''}" style="left:${x}px;top:${y}px;--branch:${color(u)};--chapter:${color(u)}" data-tech="${u.id}" aria-label="${u.name}，${level}/${u.max}" aria-pressed="${state.selected===u.id}"><svg class="research-rank" viewBox="0 0 64 64" aria-hidden="true"><circle class="rank-track" cx="32" cy="32" r="30"/><circle class="rank-fill" cx="32" cy="32" r="30" pathLength="100" stroke-dasharray="${level/u.max*100} 100"/></svg><span class="research-glyph">${u.icon}</span><small>${level}/${u.max}</small><b>${u.name}</b>${kind==='chapter'?`<i>${['I','II','III','IV','V'][u.chapter]}</i>`:''}</button>`;
  }).join('');
  return `<div class="research-viewport" tabindex="0" aria-label="完整科技树，拖拽移动，滚轮或双指缩放"><div class="research-world"><svg class="research-connections" viewBox="0 0 ${researchSize.width} ${researchSize.height}" aria-hidden="true">${paths}</svg>${buttons}</div></div>`;
}

function mapSize(viewport) {
  const portrait=viewport.clientWidth<650&&viewport.clientHeight>viewport.clientWidth;
  return portrait?{width:researchSize.height,height:researchSize.width,portrait}:researchSize;
}
function fitScale(viewport) {const size=mapSize(viewport);return Math.min(viewport.clientWidth/size.width,viewport.clientHeight/size.height);}
export function applyResearchCamera(viewport,state) {
  if(!viewport?.clientWidth||!viewport.clientHeight)return;
  const size=mapSize(viewport),base=fitScale(viewport),scale=base*state.zoom;
  const xLimit=Math.max(0,(size.width*scale-viewport.clientWidth)/2+20), yLimit=Math.max(0,(size.height*scale-viewport.clientHeight)/2+20);
  state.x=Math.max(-xLimit,Math.min(xLimit,state.x));state.y=Math.max(-yLimit,Math.min(yLimit,state.y));
  const world=viewport.querySelector('.research-world');
  const orientation=size.portrait?'portrait':'landscape';
  if(viewport.dataset.orientation!==orientation){
    viewport.dataset.orientation=orientation;
    Object.assign(world.style,{width:`${size.width}px`,height:`${size.height}px`,marginLeft:`${-size.width/2}px`,marginTop:`${-size.height/2}px`});
    for(const button of world.querySelectorAll('.research-node')){const p=researchPositions[button.dataset.tech];button.style.left=`${p[size.portrait?1:0]}px`;button.style.top=`${p[size.portrait?0:1]}px`;}
    world.querySelector('.research-connections').style.transform=size.portrait?'matrix(0,1,1,0,0,0)':'';
  }
  world.style.transform=`translate(${state.x}px,${state.y}px) scale(${scale})`;
  const uiScale = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 : 1;
  world.style.setProperty('--label-size',`${Math.max(13,10*uiScale/scale)}px`);
  viewport.classList.toggle('micro',scale<.32);viewport.dataset.zoom=state.zoom.toFixed(2);
  const dialog=viewport.closest('dialog');
  if(dialog){
    dialog.querySelector('[data-research-zoom="out"]').disabled=state.zoom<=1;dialog.querySelector('[data-research-zoom="in"]').disabled=state.zoom>=8;
    const selected=world.querySelector('.research-node.selected'),detail=dialog.querySelector('.research-detail');
    if(selected&&detail)detail.classList.toggle('on-left',selected.getBoundingClientRect().left>viewport.getBoundingClientRect().left+viewport.clientWidth/2);
  }
}
export function zoomResearch(viewport,state,zoom,anchor) {
  if(!viewport)return;
  const next=Math.max(1,Math.min(8,zoom)), ratio=next/state.zoom,x=anchor?.x||0,y=anchor?.y||0;
  state.x=x-(x-state.x)*ratio;state.y=y-(y-state.y)*ratio;state.zoom=next;
  if(next===1)state.x=state.y=0;applyResearchCamera(viewport,state);
}
export function focusResearchNode(viewport,state,id) {
  if(!viewport?.clientWidth||!researchPositions[id])return;
  state.zoom=Math.max(state.zoom,Math.min(8,.9/fitScale(viewport)));
  const size=mapSize(viewport),p=researchPositions[id],x=p[size.portrait?1:0],y=p[size.portrait?0:1],scale=fitScale(viewport)*state.zoom;
  state.x=(size.width/2-x)*scale;state.y=(size.height/2-y)*scale;
  applyResearchCamera(viewport,state);
}
export function attachResearchCamera(viewport,state) {
  if(!viewport)return;
  const resize=new ResizeObserver(()=>applyResearchCamera(viewport,state));resize.observe(viewport);applyResearchCamera(viewport,state);
  const pointers=new Map();let drag,pinch,suppressClick=false;
  const local=event=>{const r=viewport.getBoundingClientRect();return {x:event.clientX-r.left-r.width/2,y:event.clientY-r.top-r.height/2};};
  const pair=()=>{const [a,b]=[...pointers.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y)};};
  viewport.addEventListener('wheel',event=>{event.preventDefault();zoomResearch(viewport,state,state.zoom*Math.exp(-event.deltaY*.0015),local(event));},{passive:false});
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;pointers.set(event.pointerId,local(event));suppressClick=false;
    drag={pointer:event.pointerId,...local(event),px:state.x,py:state.y,moved:false};
    if(pointers.size===2){const p=pair();pinch={...p,zoom:state.zoom,x:state.x,y:state.y,anchor:p};suppressClick=true;}
  });
  viewport.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId))return;pointers.set(event.pointerId,local(event));
    if(pinch&&pointers.size===2){
      const p=pair(),zoom=Math.max(1,Math.min(8,pinch.zoom*p.distance/Math.max(1,pinch.distance))),ratio=zoom/pinch.zoom;
      state.x=p.x-(pinch.anchor.x-pinch.x)*ratio;state.y=p.y-(pinch.anchor.y-pinch.y)*ratio;state.zoom=zoom;
      suppressClick=true;applyResearchCamera(viewport,state);return;
    }
    if(!drag||drag.pointer!==event.pointerId)return;
    const point=local(event),dx=point.x-drag.x,dy=point.y-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<5)return;
    drag.moved=true;suppressClick=true;viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');
    state.x=drag.px+dx;state.y=drag.py+dy;applyResearchCamera(viewport,state);
  });
  const stop=event=>{
    pointers.delete(event.pointerId);drag=null;pinch=null;viewport.classList.remove('dragging');
    if(pointers.size===1){const [pointer,point]=[...pointers][0];drag={pointer,...point,px:state.x,py:state.y,moved:true};suppressClick=true;}
  };
  viewport.addEventListener('pointerup',stop);viewport.addEventListener('pointercancel',stop);
  // Ignore capture moving from a touched node to the canvas during a drag.
  viewport.addEventListener('lostpointercapture',event=>{if(event.target===viewport)stop(event);});
  viewport.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
  viewport.addEventListener('keydown',event=>{
    if(event.target!==viewport)return;
    const move={ArrowLeft:[80,0],ArrowRight:[-80,0],ArrowUp:[0,80],ArrowDown:[0,-80]}[event.key];
    if(move){event.preventDefault();state.x+=move[0];state.y+=move[1];applyResearchCamera(viewport,state);}
    else if(event.key==='+'||event.key==='=')zoomResearch(viewport,state,state.zoom*1.3);
    else if(event.key==='-')zoomResearch(viewport,state,state.zoom/1.3);
    else if(event.key==='Home')zoomResearch(viewport,state,1);
  });
  return ()=>resize.disconnect();
}
