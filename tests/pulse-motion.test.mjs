import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCardPulseController,pulseMotionConfig,pulseUrgencyColor} from '../dist/pulse-motion.js';

test('existing deadline states only: lively blocked, bounded urgency and calm review/acceptance',()=>{
  for(const [mode,tone,period,amplitude] of [['planned','planned',2.8,.72],['active','active',1.8,1],['soon','soon',1.5,1],['overdue','overdue',1.05,1],['blocked','blocked',2.8,.72],['blocked','soon',1.5,.72],['blocked','overdue',1.05,.72]])assert.deepEqual(pulseMotionConfig(mode,tone),{static:false,period,amplitude});
  for(const [progress,period,color] of [[0,1.5,'rgb(245, 216, 105)'],[.5,1.25,'rgb(255, 171, 95)'],[1,1.05,'rgb(255, 118, 141)']]){assert.equal(pulseMotionConfig('soon','soon',progress).period,period);assert.equal(pulseUrgencyColor(progress),color);}
  assert.ok(pulseMotionConfig('soon','soon',.4).period>pulseMotionConfig('soon','soon',.6).period);
  for(const mode of ['review','done'])assert.equal(pulseMotionConfig(mode,'overdue').static,true);
});

test('one capped renderer: visible only, continuous same-ID remount, pause preferences and complete cleanup',()=>{
  const dom=new JSDOM('<body><div id="board"></div></body>',{pretendToBeVisual:true}),w=dom.window,d=w.document,root=d.querySelector('#board');
  Object.defineProperty(w,'devicePixelRatio',{value:4});
  w.HTMLElement.prototype.getBoundingClientRect=()=>({width:300,height:26,top:0,bottom:26});
  const media=new w.EventTarget();media.matches=false;w.matchMedia=()=>media;
  let observed,disconnected=0;w.IntersectionObserver=class{constructor(fn){observed=fn;}observe(){}unobserve(){}disconnect(){disconnected++;}};
  const frames=new Map();let next=0,strokes=0;
  const context={setTransform(...args){assert.deepEqual(args,[2,0,0,2,0,0]);},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++;}};
  const markup=(id='x',mode='active',tone=mode)=>`<article data-card-id="${id}" data-pulse="${mode}" data-pulse-tone="${tone}"><button>Открыть</button><div class="card-pulse"><canvas aria-hidden="true"></canvas><svg aria-hidden="true"></svg></div></article>`;
  root.innerHTML=markup();
  const control=createCardPulseController(root,{contextFor:()=>context,requestFrame:fn=>{frames.set(++next,fn);return next;},cancelFrame:id=>frames.delete(id)});
  const tick=t=>{assert.equal(frames.size,1);const [id,fn]=frames.entries().next().value;frames.delete(id);fn(t);};
  try{
    assert.equal(frames.size,0,'Offscreen cards consume no frames');
    observed([{target:root.querySelector('.card-pulse'),isIntersecting:true}]);
    assert.equal(frames.size,1);tick(0);tick(40);tick(80);
    assert.ok(strokes>0);assert.equal(root.querySelector('canvas').width,600);assert.equal(root.querySelector('canvas').height,52);
    let before=control.inspect().signals[0];assert.ok(before.time>0);
    const button=root.querySelector('button');button.focus();root.querySelector('article').dataset.pulseTone='overdue';control.refresh();assert.equal(d.activeElement,button);assert.equal(control.inspect().signals[0].time,before.time);assert.equal(control.inspect().signals[0].phase,before.phase);
    root.innerHTML=markup('x','overdue');control.refresh();assert.equal(control.inspect().signals[0].time,before.time,'Same-ID renderer replacement retains history and phase');
    observed([{target:root.querySelector('.card-pulse'),isIntersecting:true}]);tick(120);tick(160);
    before=control.inspect().signals[0];d.body.classList.add('quiet-motion');control.sync();assert.equal(frames.size,0);assert.equal(control.inspect().signals[0].time,before.time);assert.ok(root.querySelector('.pulse-live-ready'),'Stopped trace stays visible');
    d.body.classList.remove('quiet-motion');control.sync();assert.equal(frames.size,1);
    media.matches=true;media.dispatchEvent(new w.Event('change'));assert.equal(frames.size,0);
    media.matches=false;media.dispatchEvent(new w.Event('change'));assert.equal(frames.size,1);
    Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new w.Event('visibilitychange'));assert.equal(frames.size,0);assert.equal(control.inspect().signals[0].time,before.time);
    Object.defineProperty(d,'hidden',{configurable:true,value:false});d.dispatchEvent(new w.Event('visibilitychange'));tick(10000);assert.equal(control.inspect().signals[0].time,before.time,'No catch-up after hidden page');tick(10040);
    observed([{target:root.querySelector('.card-pulse'),isIntersecting:false}]);assert.equal(frames.size,0);
    root.innerHTML=markup('x','review');control.refresh();observed([{target:root.querySelector('.card-pulse'),isIntersecting:true}]);assert.equal(frames.size,0);assert.equal(root.querySelector('.pulse-live-ready'),null,'Review uses static fallback');
    root.innerHTML='';control.refresh();assert.equal(control.inspect().count,0);
  }finally{control.destroy();assert.equal(frames.size,0);assert.equal(disconnected,1);dom.window.close();}
});

test('no canvas support leaves accessible decorative static fallback and no RAF',()=>{
  const dom=new JSDOM('<article data-card-id="x" data-pulse="active" data-pulse-tone="active"><div class="card-pulse"><canvas aria-hidden="true"></canvas><svg aria-hidden="true"></svg></div></article>');
  const control=createCardPulseController(dom.window.document.body,{contextFor:()=>null,requestFrame(){assert.fail('no canvas needs no RAF');}});
  assert.equal(dom.window.document.querySelector('.pulse-live-ready'),null);control.destroy();dom.window.close();
});
