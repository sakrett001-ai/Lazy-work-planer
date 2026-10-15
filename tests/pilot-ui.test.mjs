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
  const timers = [], reports = [];
  let cookie = '', loseReportResponse = true;
  Object.assign(globalThis, {
    window:w, document:d,
    setInterval(fn, ms) { const timer=previous.setInterval(fn, ms); timer.unref(); timers.push(timer); return timer; },
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers);
      if (cookie) headers.set('cookie', cookie);
      if (options.method === 'POST') headers.set('origin', origin);
      const response = await handleDashboardRequest(new Request(url, { ...options, headers }));
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
    click('[data-decision="approve_due"]');
    await waitFor(()=>$('#detail-message').textContent.includes('Задача изменилась') && !$('[data-decision="approve_due"]').disabled);
    assert.equal(store.readState().tasks[0].due, '2026-12-10', 'Stale click must not approve either date');
    assert.ok($('#sources').textContent.includes('2026-12-16'));
    click('[data-decision="approve_due"]');
    await waitFor(()=>$('#detail-message').textContent.includes('Решение сохранено'));
    assert.equal(store.readState().tasks[0].due, '2026-12-16');
    assert.equal($('[data-decision="approve_due"]'), null);
    assert.equal(w.localStorage.length, 0); assert.deepEqual(errors, []);
  } finally {
    timers.forEach(clearInterval); Object.assign(globalThis, previous); w.close();
    store.database().close(); rmSync(dataDir, { recursive:true, force:true });
  }
});
