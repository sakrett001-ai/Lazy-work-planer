import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {cardPulseState,cardPulseProgress,cardPulsePath,deadlineState,installPrototype} from '../dist/prototype-ui.js';
const now=Date.parse('2026-10-25T15:00:00Z');
const task={id:'p1',title:'Проверка срока',employeeId:'a',version:1,status:'active',due:'2026-10-25',dueTime:'18:00'};
test('deadline and pulse priority table, exact boundaries and no invented urgency',()=>{
  for(const [fields,time,mode,tone] of [
    [{},now,'overdue','overdue'],[{},now-1,'soon','soon'],[{},now-86400000,'active','active'],[{},now-86400000+1,'soon','soon'],
    [{due:null},now,'active','active'],[{status:'planned',due:null,start:'2000-01-01'},now,'planned','planned'],
    [{status:'planned'},now,'overdue','overdue'],[{status:'blocked'},now,'blocked','overdue'],[{status:'blocked'},now-1,'blocked','soon'],
    [{status:'blocked',due:null},now,'blocked','blocked'],[{blocker:'Ждём данные'},now,'blocked','overdue'],
    [{status:'review',blocker:'старое препятствие'},now,'review','review'],[{status:'done',blocker:'старое препятствие'},now,'done','accepted'],
    [{status:'done',due:null},now,'done','accepted'],[{proposedDue:'2026-11-01'},now,'overdue','overdue'],
    [{dueTime:null},now,'overdue','overdue'],[{dueTime:'19:00'},now,'soon','soon'],[{due:'invalid'},now,'active','active']
  ]) assert.deepEqual(cardPulseState({...task,...fields},time),{mode,tone});
  assert.equal(cardPulseProgress(task,now-86400000),0);assert.equal(cardPulseProgress(task,now-43200000),.5);assert.equal(cardPulseProgress(task,now),1);assert.equal(cardPulseProgress(task,now+86400000),1);assert.equal(cardPulseProgress({...task,due:null},now),0);
  assert.equal(deadlineState(task,now).text,'Срок наступил');
  assert.equal(deadlineState(task,now+1).kind,'overdue');
  assert.equal(deadlineState({...task,status:'done',due:null},now).text,'Завершено');
});
test('actual prototype DOM: independent acknowledgement, lifecycle, timer preserves focus and input',()=>{
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{pretendToBeVisual:true});
  const old={window:globalThis.window,document:globalThis.document,setInterval:globalThis.setInterval},oldNow=Date.now;
  const timers=[];let clock=now-1;
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,setInterval(fn,ms){timers.push({fn,ms});return 0;}});Date.now=()=>clock;
  const d=dom.window.document,$=s=>d.querySelector(s);
  const current={identity:{id:'boss',role:'manager'},filter:'open',snapshot:{tasks:[{...task}],preferences:{pins:[],seen:{}},employees:[{id:'a',name:'Участник'}],assistant:{available:false},brief:{text:''}}};
  const ctx={get:()=>current,busy:()=>false,note(){},date:x=>x,renderBoard(){ $('#board').innerHTML=ui.renderBoard(current.snapshot.tasks); }};
  let ui;
  try{
    $('#workspace').hidden=false;ui=installPrototype(ctx);ctx.renderBoard();
    assert.equal($('[data-card-id]').dataset.pulse,'soon');assert.ok($('.notice-button'));
    assert.equal($('.card-pulse').getAttribute('aria-hidden'),'true');assert.equal($('.card-pulse svg').getAttribute('focusable'),'false');assert.equal($('.card-pulse').closest('button'),null);assert.equal($('.card-pulse').previousElementSibling.className,'notice-button');assert.equal($('.card-pulse svg').getAttribute('viewBox'),'0 0 300 52');assert.equal($('.card-open-arrow').getAttribute('aria-hidden'),'true');assert.equal($('.card-open-arrow').getAttribute('focusable'),'false');assert.equal($('.card-open-arrow').tagName,'svg');
    current.snapshot.preferences.seen.p1=1;ctx.renderBoard();assert.equal($('.notice-button'),null);assert.equal($('[data-card-id]').dataset.pulse,'soon');
    current.snapshot.tasks[0].version=2;ctx.renderBoard();assert.ok($('.notice-button'));
    const trace=$('.pulse-wave'),track=$('.pulse-track');assert.equal(trace.getAttribute('pathLength'),'740');assert.equal(track.getAttribute('pathLength'),'740');assert.equal(trace.getAttribute('d'),cardPulsePath('soon'));
    const node=$('[data-card-id]'),button=$('.card-open');button.focus();$('#search').value='Не терять текст';
    clock=now;timers.find(t=>t.ms===15000).fn();assert.equal($('[data-card-id]'),node);assert.equal(d.activeElement,button);assert.equal($('#search').value,'Не терять текст');assert.equal(node.dataset.pulse,'overdue');assert.equal($('.pulse-wave'),trace);assert.equal($('.pulse-track'),track);assert.equal(trace.getAttribute('d'),cardPulsePath('overdue'));assert.equal(track.getAttribute('d'),cardPulsePath('overdue'));assert.equal($('[data-deadline-state]').textContent,'Срок наступил');
    for(const [status,mode] of [['blocked','blocked'],['active','overdue'],['review','review'],['active','overdue'],['review','review'],['done','done'],['active','overdue']]){
      current.snapshot.tasks[0].status=status;current.filter=status==='done'?'done':'open';ctx.renderBoard();assert.equal($('[data-card-id]').dataset.pulse,mode);assert.equal($('.pulse-wave').getAttribute('d'),cardPulsePath(mode));if(status==='review')assert.equal($('[data-deadline-state]').className,'overdue');
    }
    current.snapshot.tasks[0].proposedDue='2026-11-01';ctx.renderBoard();assert.equal($('[data-card-id]').dataset.pulse,'overdue');
    current.snapshot.tasks[0].due='2026-11-01';ctx.renderBoard();assert.equal($('[data-card-id]').dataset.pulse,'active');
    $('#pulse').checked=false;$('#pulse').dispatchEvent(new dom.window.Event('change'));assert.ok(d.body.classList.contains('quiet-motion'));
    current.snapshot.tasks[0].due='2026-10-25';ctx.renderBoard();const deadlineLabel=$('[data-deadline-state]');const beforeHidden=deadlineLabel.textContent;
    Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new dom.window.Event('visibilitychange'));assert.ok(d.body.classList.contains('page-hidden'));clock=now+7200000;timers.find(t=>t.ms===15000).fn();assert.equal(deadlineLabel.textContent,beforeHidden);
    Object.defineProperty(d,'hidden',{configurable:true,value:false});d.dispatchEvent(new dom.window.Event('visibilitychange'));assert.ok(!d.body.classList.contains('page-hidden'));assert.match(deadlineLabel.textContent,/Просрочено на 2 ч/);
  }finally{Object.assign(globalThis,old);Date.now=oldNow;dom.window.close();}
});
test('bounded CSS motion and non-color deadline remain accessible',()=>{
  const css=readFileSync(new URL('../dist/prototype.css',import.meta.url),'utf8');
  assert.doesNotMatch(css,/animation:card-bottom-pulse|animation:signal-breathe|stroke-dashoffset/);
  assert.match(css,/\.card-pulse\.pulse-live-ready svg\{display:none\}/);
  const l=hex=>{const c=hex.match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
  for(const text of ['ffb3bf','ffe0a3','acbad3'])for(const bg of ['1b2941','141f34','2b2949'])assert.ok((l(text)+.05)/(l(bg)+.05)>4.5,`${text} on ${bg}`);
});

test('approved distinct heartbeat geometries and calm static states',()=>{
  const modes=['planned','active','soon','overdue','blocked'];
  assert.equal(new Set(modes.map(cardPulsePath)).size,5);
  for(const mode of modes){assert.match(cardPulsePath(mode),/^M0 26H/);assert.match(cardPulsePath(mode),/H300$/);}
  assert.equal((cardPulsePath('active').match(/S\d+ 8 /g)||[]).length,3);
  assert.equal((cardPulsePath('soon').match(/S\d+ 8 /g)||[]).length,4);
  assert.equal((cardPulsePath('overdue').match(/S\d+ 6 /g)||[]).length,5);
  assert.equal(cardPulsePath('review'),'M0 26H300');assert.equal(cardPulsePath('done'),'M0 26H300');
  const css=readFileSync(new URL('../dist/prototype.css',import.meta.url),'utf8');
  assert.match(css,/height:26px;margin-top:12px;flex:none;overflow:hidden/);
  assert.doesNotMatch(css,/@keyframes card-bottom-pulse[^}]*opacity/);
});
