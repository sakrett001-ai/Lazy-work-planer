__modules["pulse-motion.js"]=(()=>{
const {createPulseSignal,advancePulseSignal,generatePulsePoints}=__modules["pulse-signal.js"];
// Presentation cadence only. No extra urgency threshold or invented start date.
const boundedProgress=value=>Math.max(0,Math.min(1,Number(value)||0));
function pulseUrgencyColor(progress) {
  const p=boundedProgress(progress),from=p<.5?[245,216,105]:[255,171,95],to=p<.5?[255,171,95]:[255,118,141],mix=p<.5?p*2:(p-.5)*2;
  return `rgb(${from.map((v,i)=>Math.round(v+(to[i]-v)*mix)).join(', ')})`;
}
function pulseMotionConfig(mode,tone,progress=0) {
  if(mode==='done')return {static:true,period:2.8,amplitude:.72};
  // Awaiting approval is still alive, but never borrows overdue urgency.
  if(mode==='review')return {static:false,period:2.4,amplitude:.85};
  const p=boundedProgress(progress),soonPeriod=p<.5?1.5-p*.5:1.25-(p-.5)*.4;
  const period=tone==='overdue'?1.05:tone==='soon'?soonPeriod:mode==='active'?1.8:2.8;
  return {static:false,period,amplitude:(mode==='planned'||mode==='blocked') ? .72 : 1};
}

// One frame loop/observer set for the board, not one timer per card.
function createCardPulseController(root, options={}) {
  const win=root.ownerDocument.defaultView, doc=root.ownerDocument;
  const raf=options.requestFrame||win.requestAnimationFrame?.bind(win);
  const cancel=options.cancelFrame||win.cancelAnimationFrame?.bind(win);
  const contextFor=options.contextFor||(canvas=>win.CanvasRenderingContext2D?canvas.getContext('2d'):null);
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const records=new Map();let frame=null,last=null,destroyed=false;
  const stopped=()=>doc.hidden||doc.body.classList.contains('quiet-motion')||reduced?.matches;
  const config=node=>{const card=node.closest('[data-card-id]');return pulseMotionConfig(card.dataset.pulse,card.dataset.pulseTone,card.dataset.pulseProgress);};
  function measure(record){const rect=record.node.getBoundingClientRect();record.width=Math.min(1000,rect.width);record.height=rect.height;record.color=win.getComputedStyle(record.node).color;}
  function draw(record) {
    if(doc.hidden||!record.context||!record.visible||record.config.static)return;
    if(record.width<=0||record.height<=0)return;
    const width=record.width,height=record.height,dpr=Math.min(2,win.devicePixelRatio||1);
    const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr),cv=record.canvas,ctx=record.context;
    if(cv.width!==pixelWidth||cv.height!==pixelHeight){cv.width=pixelWidth;cv.height=pixelHeight;}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    ctx.strokeStyle=record.color;ctx.lineWidth=record.mode==='blocked'?1:1.25;ctx.lineCap='round';ctx.lineJoin='round';
    let previous=null;
    for(const point of generatePulsePoints(record.signal,width)) {
      if(!point){previous=null;continue;}
      if(previous){ctx.globalAlpha=(previous[2]+point[2])/2;ctx.beginPath();ctx.moveTo(previous[0],previous[1]*height);ctx.lineTo(point[0],point[1]*height);ctx.stroke();}
      previous=point;
    }
    ctx.globalAlpha=1;if(!record.ready){record.node.classList.add('pulse-live-ready');record.ready=true;}
  }
  const running=()=>!stopped()&&[...records.values()].some(r=>r.visible&&r.context&&!r.config.static);
  function schedule(){if(!destroyed&&raf&&frame===null&&running())frame=raf(tick);}
  function tick(timestamp){
    frame=null;if(destroyed||!running()){last=null;return;}
    if(last===null)last=timestamp;
    if(timestamp-last>=40){const dt=Math.min(.2,(timestamp-last)/1000);last=timestamp;
      for(const record of records.values())if(record.visible&&record.context&&!record.config.static){advancePulseSignal(record.signal,dt,record.config);draw(record);}
    }
    schedule();
  }
  function sync(){
    if(!running()){if(frame!==null)cancel?.(frame);frame=null;last=null;}
    for(const record of records.values())draw(record);
    schedule();
  }
  const intersection=win.IntersectionObserver?new win.IntersectionObserver(entries=>{for(const entry of entries){const record=[...records.values()].find(r=>r.node===entry.target);if(record){record.visible=entry.isIntersecting;measure(record);draw(record);}}sync();}):null;
  const resize=win.ResizeObserver?new win.ResizeObserver(()=>{for(const record of records.values()){measure(record);draw(record);}}):null;
  function refresh(){
    if(destroyed)return;
    const found=new Set();
    for(const node of root.querySelectorAll('.card-pulse')){
      const card=node.closest('[data-card-id]'),id=card?.dataset.cardId;if(!id)continue;found.add(id);
      const next=config(node);let record=records.get(id);
      if(!next.static&&['soon','overdue'].includes(card.dataset.pulseTone))node.style.setProperty('--pulse-color',pulseUrgencyColor(card.dataset.pulseTone==='overdue'?1:card.dataset.pulseProgress));
      else node.style.removeProperty('--pulse-color');
      if(!record||record.node!==node){
        if(record){intersection?.unobserve(record.node);resize?.unobserve(record.node);}
        const canvas=node.querySelector('canvas'),signal=record?.signal||createPulseSignal(next);
        record={node,canvas,signal,context:canvas?contextFor(canvas):null,visible:!intersection,config:next,mode:card.dataset.pulse};records.set(id,record);
        intersection?.observe(node);resize?.observe(node);
      }else{record.config=next;record.mode=card.dataset.pulse;}
      if(next.static){node.classList.remove('pulse-live-ready');record.ready=false;}
      measure(record);draw(record);
    }
    for(const [id,record] of records)if(!found.has(id)){intersection?.unobserve(record.node);resize?.unobserve(record.node);records.delete(id);}
    sync();
  }
  const mutation=new win.MutationObserver(refresh);mutation.observe(root,{childList:true,subtree:true});
  const visibility=()=>{last=null;sync();};
  doc.addEventListener('visibilitychange',visibility);reduced?.addEventListener?.('change',visibility);
  win.addEventListener('resize',refresh);
  refresh();
  return {refresh,sync,destroy(){destroyed=true;if(frame!==null)cancel?.(frame);frame=null;mutation.disconnect();intersection?.disconnect();resize?.disconnect();records.clear();doc.removeEventListener('visibilitychange',visibility);reduced?.removeEventListener?.('change',visibility);win.removeEventListener('resize',refresh);},
    // Read-only diagnostics for bounded lifecycle verification; no application data.
    inspect(){return {count:records.size,scheduled:frame!==null,signals:[...records].map(([id,r])=>({id,time:r.signal.time,phase:r.signal.phase,visible:r.visible}))};}};
}

return {pulseUrgencyColor,pulseMotionConfig,createCardPulseController};})();
