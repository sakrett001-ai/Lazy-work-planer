// DOM + real HTTP handlers + SQLite; this does not verify browser rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

test('Вход → отчёт с потерей ответа → память → устаревшая карточка → явное решение', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lazy-ui-'));
  const origin = 'https://assistant.test';
  process.env.ASSISTANT_DATA_DIR = dataDir;
  process.env.ASSISTANT_SERVER_ORIGIN = origin;
  const store = await import('../agent/lib/store.ts');
  const { issueInvite } = await import('../agent/lib/web-auth.ts');
  const { handleDashboardRequest } = await import('../agent/lib/dashboard-api.ts');
  store.updateState(() => ({
    employees: [{ id:'manager', name:'Руководитель', role:'manager' }, { id:'worker', name:'Сотрудник', role:'employee' }],
    tasks: [
      { id:'П-1', title:'Подготовить свод', employeeId:'worker', due:'2026-12-10', status:'active', contact:'not_requested' },
      { id:'Л-1', title:'Личная задача руководителя', employeeId:'manager', status:'active', contact:'not_requested' }
    ],
    sources:[], events:[], settings:{ timezone:'Europe/Moscow', startHour:9, endHour:18, minHoursBetween:6, excludedDates:[] }
  }));
  const errors = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(readFileSync(new URL('../dist/pilot.html', import.meta.url), 'utf8'), {
    url:origin + '/assistant/workspace', pretendToBeVisual:true, virtualConsole:console
  });
  const w = dom.window, d = w.document;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const previous = Object.fromEntries(['window', 'document', 'fetch', 'setInterval'].map(key => [key, globalThis[key]]));
  const timers = [], ticks=[], reports = [];
  let cookie = '', loseReportResponse = true, holdMemory=false, releaseMemory=null, memoryRequests=0;
  Object.assign(globalThis, {
    window:w, document:d,
    setInterval(fn, ms) { ticks.push({fn,ms});const timer=previous.setInterval(fn, ms); timer.unref(); timers.push(timer); return timer; },
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers);
      if (cookie) headers.set('cookie', cookie);
      if (options.method === 'POST') headers.set('origin', origin);
      const response = await handleDashboardRequest(new Request(url, { ...options, headers }));
      if(new URL(url).pathname.endsWith('/memory')){memoryRequests++;if(holdMemory){holdMemory=false;await new Promise(resolve=>{releaseMemory=resolve;});}}
      const nextCookie = response.headers.get('set-cookie');
      if (nextCookie) cookie = nextCookie.split(';')[0];
      if (new URL(url).pathname.endsWith('/report')) {
        reports.push(JSON.parse(options.body));
        if (loseReportResponse && response.ok) { loseReportResponse=false; throw new Error('Connection lost after commit'); }
      }
      return response;
    }
  });
  const $ = selector => d.querySelector(selector);
  const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
  const submit = selector => $(selector).dispatchEvent(new w.Event('submit', { bubbles:true, cancelable:true }));
  async function waitFor(check) {
    const until=Date.now()+3000;
    while (!check()) { assert.ok(Date.now()<until, 'UI condition timed out'); await new Promise(resolve=>setTimeout(resolve, 10)); }
  }
  async function login(id) {
    $('#login-code').value=issueInvite(id); submit('#login-form');
    await waitFor(()=>!$('#workspace').hidden && d.querySelectorAll('[data-task]').length && !$('#logout').disabled);
  }
  try {
    await import('../dist/pilot.js');
    await waitFor(()=>!$('#login-panel').hidden);
    await login('worker');
    assert.deepEqual([...d.querySelectorAll('[data-task]')].map(el=>el.dataset.task), ['П-1']);
    click('[data-task="П-1"]'); await waitFor(()=>$('#report-text'));
    assert.equal($('[data-decision]'), null);
    const text='Прошу перенести срок на 2026-12-15: ожидаем данные. <img src=x onerror=alert(1)>';
    $('#report-text').value=text; submit('#report-form');
    await waitFor(()=>$('#detail-message').textContent.includes('связь прервалась') && !$('#report-form button').disabled);
    assert.equal(store.readState().sources.length, 1, 'Server committed the report before the lost response');
    assert.equal($('#report-text').value, text, 'Failed confirmation preserves the text for retry');
    submit('#report-form');
    await waitFor(()=>$('#sources')?.textContent.includes(text) && !$('#report-form button').disabled);
    assert.equal(reports.length, 2); assert.equal(reports[0].requestId, reports[1].requestId);
    assert.equal(store.readState().sources.length, 1);
    assert.equal(store.readState().events.filter(event=>event.sourceId===store.readState().sources[0].id).length, 1);
    assert.equal($('#task-content img'), null, 'Source text is rendered as text');
    click('#close-dialog'); click('#logout');
    await waitFor(()=>!$('#login-panel').hidden && !$('#logout').disabled);
    assert.equal($('#board').textContent, ''); assert.equal($('#task-content').textContent, '');

    await login('manager');
    assert.equal(d.querySelectorAll('[data-task]').length, 2);
    click('[data-task="П-1"]'); await waitFor(()=>$('[data-decision="approve_due"]'));
    assert.equal($('#report-form'), null); assert.ok($('#sources').textContent.includes(text));
    assert.equal(store.readState().tasks[0].due, '2026-12-10');
    const tick=()=>ticks.find(t=>t.ms===15000).fn();
    const draft=$('#manager-message');draft.value='Несохранённый текст';draft.focus();draft.setSelectionRange(3,7);

    store.updateState(state=>({...state,sources:[...state.sources,{id:'plain-reply',taskId:'П-1',employeeId:'manager',authorName:'Руководитель',kind:'manager_message',text:'Обычное сообщение <img src=x>',occurredAt:'2026-12-11T12:00:00Z'}]}));
    await tick();
    assert.ok($('.conversation').textContent.includes('Обычное сообщение'));
    assert.equal($('#manager-message'),draft);assert.equal(draft.selectionStart,3);assert.equal(draft.selectionEnd,7);assert.equal(draft.value,'Несохранённый текст');
    assert.equal($('.conversation img'),null);assert.equal($('#reload-detail').hidden,true,'Plain reply is detected without a changed taskVersion');
    store.updateState(state=>({...state,events:[{key:'silence-event',kind:'no_reply',taskId:'П-1',text:'Ответ пока не получен',at:'2026-12-12T12:00:00Z'},...state.events]}));
    await tick();await tick();
    assert.equal(d.querySelectorAll('[data-conversation-source="plain-reply"]').length,1);
    assert.equal(d.querySelectorAll('[data-conversation-event="silence-event"]').length,1);
    assert.ok($('[data-conversation-event="silence-event"]').textContent.includes('не ответ сотрудника'));
    Object.defineProperty(d,'hidden',{configurable:true,value:true});
    store.updateState(state=>({...state,sources:[...state.sources,{id:'while-hidden',taskId:'П-1',employeeId:'worker',text:'После возвращения',occurredAt:'2026-12-12T13:00:00Z'}]}));
    await tick();assert.equal($('[data-conversation-source="while-hidden"]'),null);
    Object.defineProperty(d,'hidden',{configurable:true,value:false});d.dispatchEvent(new w.Event('visibilitychange'));
    await waitFor(()=>$('[data-conversation-source="while-hidden"]'));

    // A second employee session changes the task while the manager's card is open.
    const signedIn=await handleDashboardRequest(new Request(origin+'/assistant/api/login', {
      method:'POST', headers:{ origin, 'content-type':'application/json' }, body:JSON.stringify({ code:issueInvite('worker') })
    }));
    const workerCookie=signedIn.headers.get('set-cookie').split(';')[0];
    const auth=await (await handleDashboardRequest(new Request(origin+'/assistant/api/session', { headers:{ cookie:workerCookie } }))).json();
    const changed=await handleDashboardRequest(new Request(origin+'/assistant/api/report', {
      method:'POST', headers:{ origin, cookie:workerCookie, 'content-type':'application/json', 'x-csrf-token':auth.csrf },
      body:JSON.stringify({ requestId:randomUUID(), taskId:'П-1', text:'Прошу перенести срок на 2026-12-16: новых данных пока нет.' })
    }));
    assert.equal(changed.status, 200);
    await tick();assert.equal($('#manager-message'),draft);assert.equal($('#reload-detail').hidden,false);
    click('[data-decision="approve_due"]');
    await waitFor(()=>$('#detail-message').textContent.includes('Задача изменилась') && !$('[data-decision="approve_due"]').disabled);
    assert.equal(store.readState().tasks[0].due, '2026-12-10', 'Stale click must not approve either date');
    assert.equal($('#manager-message'),draft);assert.equal(draft.value,'Несохранённый текст','409 preserves draft and baseline');
    assert.equal($('#reload-detail').hidden, false);
    click('#reload-detail');
    await waitFor(()=>$('#sources').textContent.includes('2026-12-16') && !$('#reload-detail').disabled);
    click('[data-decision="approve_due"]');
    await waitFor(()=>$('#detail-message').textContent.includes('Решение сохранено'));
    assert.equal(store.readState().tasks[0].due, '2026-12-16');
    assert.equal($('[data-decision="approve_due"]'), null);
    store.updateState(state=>({...state,sources:[...state.sources,...Array.from({length:50},(_,i)=>({id:'window-'+i,taskId:'П-1',employeeId:'worker',text:'Пакет '+i,occurredAt:'2026-12-13T12:00:00Z'}))]}));
    await tick();assert.equal($('#conversation-gap').hidden,false);assert.ok($('[data-conversation-source="plain-reply"]'));
    await tick();assert.equal(d.querySelectorAll('[data-conversation-source="window-0"]').length,1);
    holdMemory=true;const waiting=tick();await waitFor(()=>releaseMemory);
    const count=memoryRequests;await tick();await tick();assert.equal(memoryRequests,count,'Repeated ticks share one in-flight memory request');
    click('#close-dialog');click('[data-task="П-1"]');await waitFor(()=>$('#manager-message'));
    const reopened=$('#manager-message');reopened.value='Новый черновик';
    releaseMemory();releaseMemory=null;await waiting;assert.equal($('#manager-message'),reopened);assert.equal(reopened.value,'Новый черновик');
    holdMemory=true;click('#reload-detail');await waitFor(()=>releaseMemory);$('#task-dialog').close();
    releaseMemory();releaseMemory=null;await waitFor(()=>!$('#logout').disabled);
    click('[data-task="П-1"]');await waitFor(()=>$('#manager-message'));assert.equal($('#manager-message').value,'Новый черновик','Closing during loading must not erase cached draft');
    click('#close-dialog');click('[data-task="Л-1"]');await waitFor(()=>$('#report-text'));
    $('#report-text').value='Личный несохранённый текст';
    store.updateState(state=>({...state,employees:state.employees.map(p=>p.id==='manager'?{...p,role:'employee'}:p)}));
    await tick();assert.equal($('#login-panel').hidden,false,'Response actor role change invalidates the old session UI');assert.equal($('#task-content').querySelector('[data-decision]'),null);assert.ok(!$('#task-content').textContent.includes('Обычное сообщение'));
    await login('worker');click('[data-task="П-1"]');await waitFor(()=>$('#report-text'));$('#report-text').value='Сохранить мой текст';
    holdMemory=true;const oldPrivateResponse=tick();await waitFor(()=>releaseMemory);
    store.updateState(state=>({...state,tasks:state.tasks.map(t=>t.id==='П-1'?{...t,employeeId:'manager'}:t)}));
    click('#reload-detail');await waitFor(()=>!$('.conversation')&&!$('#logout').disabled);
    releaseMemory();releaseMemory=null;await oldPrivateResponse;assert.equal($('.conversation'),null);assert.equal($('#report-form'),null);assert.equal($('#task-content textarea').value,'Сохранить мой текст');
    assert.equal(w.localStorage.length, 0); assert.deepEqual(errors, []);
  } finally {
    timers.forEach(clearInterval); Object.assign(globalThis, previous); w.close();
    store.database().close(); rmSync(dataDir, { recursive:true, force:true });
  }
});
