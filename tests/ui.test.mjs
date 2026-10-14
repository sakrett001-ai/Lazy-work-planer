// DOM interaction checks. These do not replace rendering or real-browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

test('Интерфейс: доска → календарь → Гант → черновик → своя задача → приёмка и архив', async () => {
 const errors=[], virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(readFileSync(new URL('../dist/index.html',import.meta.url),'utf8'),{url:'https://assistant.test/',pretendToBeVisual:true,virtualConsole});
 const w=dom.window;
 w.matchMedia=()=>({matches:true,addEventListener(){}});w.scrollTo=()=>{};w.Element.prototype.scrollIntoView=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const intervals=[], oldInterval=globalThis.setInterval;
 globalThis.setInterval=(fn,ms)=>{const timer=oldInterval(fn,ms);timer.unref();intervals.push(timer);return timer;};
 Object.assign(globalThis,{window:w,document:w.document,location:w.location,history:w.history,localStorage:w.localStorage,FormData:w.FormData,requestAnimationFrame:fn=>fn()});
 const d=w.document;
 const click=selector=>{const el=d.querySelector(selector);assert.ok(el,'Control exists: '+selector);el.click();};
 const submit=selector=>d.querySelector(selector).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 const saved=()=>JSON.parse(w.localStorage.getItem('rut-assistant-demo-v02'));
 try {
  await import('../dist/app.js');
  assert.equal(d.querySelectorAll('[data-card-id]').length,10);
  assert.match(d.querySelector('#main').textContent,/Нужно внимание/);
  click('#navigation [data-view="calendar"]');assert.equal(d.querySelectorAll('.calendar-cell').length,42);
  click('#navigation [data-view="timeline"]');assert.equal(d.querySelectorAll('.timeline-row').length,3);
  click('#navigation [data-view="board"]');
  click('[data-action="task"][data-id="П-103"]');assert.equal(d.querySelector('#modal').open,true);
  click('#modal [data-action="draft"]');assert.match(d.querySelector('#draft-body').value,/\[Адресат\]/);
  d.querySelector('#draft-body').value+='\nПроверенная правка пользователя.';
  d.querySelector('#draft-body').dispatchEvent(new w.Event('input',{bubbles:true}));
  click('[data-action="save-draft"]');assert.match(saved().drafts['П-103:extension'].body,/Проверенная правка/);
  assert.equal(saved().tasks.find(t=>t.id==='П-103').proposedDue!==null,true);
  click('#modal [data-action="close"]');click('.new-task-button');
  const f=d.querySelector('#task-form');f.querySelector('[name="title"]').value='Проверить личную идею';f.querySelector('[name="summary"]').value='<img src=x onerror=alert(1)>';
  submit('#task-form');const mine=saved().tasks.find(t=>t.title==='Проверить личную идею');assert.ok(mine);assert.equal(mine.due,null);assert.equal(mine.protocol,undefined);
  assert.equal(d.querySelector('#main img'),null,'user text is escaped');
  click('[data-action="scope"][data-scope="mine"]');assert.ok([...d.querySelectorAll('[data-card-id]')].every(el=>saved().tasks.find(t=>t.id===el.dataset.cardId).employeeId==='manager'));
  click('[data-action="scope"][data-scope="management"]');click('[data-action="task"][data-id="П-104"]');click('[data-action="task-change"][data-change="accept"]');
  assert.equal(saved().tasks.find(t=>t.id==='П-104').status,'done');assert.ok(!d.querySelector('[data-card-id="П-104"]'));
  click('#navigation [data-view="archive"]');assert.ok(d.querySelector('[data-card-id="П-104"]'));
  click('#navigation [data-view="chat"]');assert.match(d.querySelector('#main').textContent,/Письмо|Черновики/);
  d.querySelector('#chat-input').value='Что делать по П-102?';submit('#chat-form');assert.match(d.querySelector('#chat-messages').textContent,/недостающие данные/);
  click('.sidebar [data-view="settings"]');assert.ok(d.querySelector('.control-bar').hidden);assert.match(d.querySelector('#main').textContent,/Реальные права доступа ещё не подключены/);
  click('[data-action="achievements"]');assert.equal(d.querySelectorAll('.achievement').length,4);
  assert.deepEqual(errors,[]);
 } finally {intervals.forEach(clearInterval);globalThis.setInterval=oldInterval;dom.window.close();}
});
