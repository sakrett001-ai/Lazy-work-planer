import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

test('Форма поручения: пробелы, исправление, ожидание, ошибка и повтор',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lazy-prototype-ui-')),origin='https://prototype.test';
  process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN=origin;
  const store=await import('../agent/lib/store.ts'),{issueInvite}=await import('../agent/lib/web-auth.ts'),{handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
  store.updateState(()=>({employees:[{id:'boss',name:'Руководитель',role:'manager'},{id:'a',name:'Сотрудник',role:'employee'}],tasks:[],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{url:origin+'/assistant/workspace',pretendToBeVisual:true,virtualConsole:console}),w=dom.window,d=w.document;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const previous=Object.fromEntries(['window','document','fetch','setInterval'].map(k=>[k,globalThis[k]])),timers=[],requests=[];
  let cookie='',release,delay=null;
  function deferWrite(){delay=new Promise(resolve=>{release=resolve;});}
  Object.assign(globalThis,{window:w,document:d,setInterval(fn,ms){const t=previous.setInterval(fn,ms);t.unref();timers.push(t);return t;},async fetch(url,options={}){
    const h=new Headers(options.headers);if(cookie)h.set('cookie',cookie);if(options.method==='POST')h.set('origin',origin);
    if(/\/task-(create|edit)$/.test(new URL(url).pathname)){requests.push(JSON.parse(options.body));const gate=delay;delay=null;if(gate&&await gate==='fail')throw new Error('Delayed failure');}
    const r=await handleDashboardRequest(new Request(url,{...options,headers:h}));if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    return r;
  }});
  const $=s=>d.querySelector(s),click=s=>{assert.ok($(s),s);$(s).click();},submit=s=>$(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  async function wait(check){const until=Date.now()+4000;while(!check()){assert.ok(Date.now()<until,'UI timed out');await new Promise(r=>setTimeout(r,10));}}
  async function login(id){$('#login-code').value=issueInvite(id);submit('#login-form');await wait(()=>!$('#workspace').hidden&&!$('#logout').disabled&&$('#freshness').textContent.includes('Обновлено'));}
  function enterTitle(value){const title=$('#task-editor').elements.title;title.value=value;title.dispatchEvent(new w.Event('input',{bubbles:true}));return title;}
  function assertSaving(form){
    assert.equal(form.getAttribute('aria-busy'),'true');
    const status=$('#editor-message');assert.equal(status.textContent,'Сохраняем…');
    assert.equal(status.classList.contains('pending'),true);assert.equal(status.classList.contains('success'),false);
    assert.match(readFileSync(new URL('../dist/pilot.css',import.meta.url),'utf8'),/#editor-message\.pending\{color:var\(--muted\)\}/,'Ожидание использует существующий нейтральный цвет');
    assert.equal(status.getAttribute('role'),'status');assert.equal(status.getAttribute('aria-live'),'polite');
    assert.equal(status.closest('[aria-busy="true"]'),null,'Статус находится вне занятой области');
    assert.ok([...d.querySelectorAll('#editor-dialog button')].every(button=>button.disabled));
    click('#close-editor');assert.equal($('#editor-dialog').open,true);
    const cancel=new w.Event('cancel',{cancelable:true});$('#editor-dialog').dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);
    const count=requests.length;submit('#task-editor');assert.equal(requests.length,count,'Нет повторного запроса во время ожидания');
  }
  function assertSpacesBlocked(){
    const count=requests.length,title=enterTitle(' \t\u00a0 ');
    assert.equal(title.validity.valid,true,'required сам по себе допускает пробелы');submit('#task-editor');
    assert.equal(requests.length,count);assert.equal(title.validity.customError,true);
    assert.match(title.validationMessage,/не только пробелы/);assert.equal(d.activeElement,title);
    assert.equal($('#task-editor').hasAttribute('aria-busy'),false);assert.equal($('#task-editor button').disabled,false);
    enterTitle('Исправленное поручение');assert.equal(title.validity.valid,true,'Ввод снимает устаревшую ошибку');
  }
  try{
    await import('../dist/pilot.js');await wait(()=>!$('#login-panel').hidden);await login('boss');
    click('#new-task');assertSpacesBlocked();
    let form=$('#task-editor');deferWrite();submit('#task-editor');assertSaving(form);
    assert.equal(store.readState().tasks.length,0);
    release('success');await wait(()=>$('#task-title')?.textContent==='Исправленное поручение'&&!$('#logout').disabled);
    assert.equal(form.hasAttribute('aria-busy'),false);assert.equal($('#editor-message').textContent,'');assert.equal($('#editor-message').classList.contains('pending'),false);
    assert.equal($('#editor-dialog').open,false);assert.equal(store.readState().tasks.length,1);
    click('[data-edit-task]');assertSpacesBlocked();enterTitle('Изменённое поручение');
    form=$('#task-editor');deferWrite();submit('#task-editor');assertSaving(form);
    release('fail');await wait(()=>$('#editor-message').textContent.includes('связь прервалась')&&!$('#logout').disabled);
    assert.equal(form.hasAttribute('aria-busy'),false);assert.equal($('#editor-dialog').open,true);
    assert.equal($('#editor-message').classList.contains('pending'),false);assert.equal($('#editor-message').classList.contains('success'),false,'Ошибка возвращается к исходному состоянию сообщения');
    assert.equal(form.elements.title.value,'Изменённое поручение');
    assert.ok([...d.querySelectorAll('#editor-dialog button')].every(button=>!button.disabled));
    assert.equal(store.readState().tasks[0].title,'Исправленное поручение');
    deferWrite();submit('#task-editor');assertSaving(form);
    assert.equal(requests[1].requestId,requests[2].requestId,'Повтор сохраняет ключ идемпотентности');
    release('success');await wait(()=>$('#task-title')?.textContent==='Изменённое поручение'&&!$('#logout').disabled);
    assert.equal(form.hasAttribute('aria-busy'),false);assert.equal($('#editor-message').textContent,'');assert.equal($('#editor-message').classList.contains('pending'),false);
    assert.equal(store.readState().tasks.length,1);assert.equal(store.readState().tasks[0].title,'Изменённое поручение');
    click('[data-edit-task]');const cancel=new w.Event('cancel',{cancelable:true});$('#editor-dialog').dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,false);
    click('#close-editor');assert.equal($('#editor-dialog').open,false);assert.deepEqual(errors,[]);
  }finally{timers.forEach(clearInterval);Object.assign(globalThis,previous);w.close();store.database().close();rmSync(dir,{recursive:true,force:true});}
});
