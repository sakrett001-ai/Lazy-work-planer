import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

test('Рабочий прототип в DOM: постановка с потерей ответа, закрепление, календарь, этап, обсуждение, документ и архив',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lazy-prototype-ui-')),origin='https://prototype.test';
  process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN=origin;
  const store=await import('../agent/lib/store.ts'),{issueInvite}=await import('../agent/lib/web-auth.ts'),{handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
  store.updateState(()=>({employees:[{id:'boss',name:'Руководитель',role:'manager'},{id:'a',name:'Сотрудник',role:'employee'}],tasks:[],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{url:origin+'/assistant/workspace',pretendToBeVisual:true,virtualConsole:console}),w=dom.window,d=w.document;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const previous=Object.fromEntries(['window','document','fetch','setInterval'].map(k=>[k,globalThis[k]])),timers=[],requests=[],intervals=[];
  let cookie='',lose=true;
  Object.assign(globalThis,{window:w,document:d,setInterval(fn,ms){const t=previous.setInterval(fn,ms);t.unref();timers.push(t);intervals.push({fn,ms});return t;},async fetch(url,options={}){
    const h=new Headers(options.headers);if(cookie)h.set('cookie',cookie);if(options.method==='POST')h.set('origin',origin);
    const r=await handleDashboardRequest(new Request(url,{...options,headers:h}));if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    if(new URL(url).pathname.endsWith('/task-create')){requests.push(JSON.parse(options.body));if(lose&&r.ok){lose=false;throw new Error('Lost response');}}
    return r;
  }});
  const $=s=>d.querySelector(s),click=s=>{assert.ok($(s),s);$(s).click();},submit=s=>$(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  async function wait(check){const until=Date.now()+4000;while(!check()){assert.ok(Date.now()<until,'UI timed out');await new Promise(r=>setTimeout(r,10));}}
  async function login(id){$('#login-code').value=issueInvite(id);submit('#login-form');await wait(()=>!$('#workspace').hidden&&!$('#logout').disabled&&$('#freshness').textContent.includes('Обновлено'));}
  async function logout(){if($('#task-dialog').open)click('#close-dialog');click('#logout');await wait(()=>!$('#login-panel').hidden&&!$('#logout').disabled);}
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()),later=new Date(Date.parse(day+'T12:00:00Z')+3*86400000).toISOString().slice(0,10);
  try{
    await import('../dist/pilot.js');await wait(()=>!$('#login-panel').hidden);await login('boss');
    assert.ok($('#board .empty'));click('#new-task');
    let form=$('#task-editor');form.elements.title.value='Подготовить тестовую сводку';form.elements.employeeId.value='a';form.elements.description.value='Ожидаемый результат <img src=x onerror=alert(1)>';form.elements.due.value=day;
    submit('#task-editor');await wait(()=>$('#editor-message').textContent.includes('связь прервалась')&&!$('#task-editor button').disabled);
    assert.equal(store.readState().tasks.length,1);assert.equal(form.elements.title.value,'Подготовить тестовую сводку');
    submit('#task-editor');await wait(()=>$('#task-title')?.textContent==='Подготовить тестовую сводку'&&!$('#logout').disabled);
    assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(store.readState().tasks.length,1);assert.equal($('#task-content img'),null);
    const taskId=store.readState().tasks[0].id;
    click('#close-dialog');click('[data-pin]');await wait(()=>$('.pin-button.is-pinned')&&!$('#logout').disabled);assert.equal($('#task-dialog').open,false);
    click('[data-view="calendar"]');assert.ok($('.calendar-grid'));assert.ok($('.calendar-task')?.textContent.includes('тестовую сводку'));
    click('[data-view="board"]');click('[data-task]');await wait(()=>$('[data-new-phase]'));
    click('[data-new-phase]');form=$('#phase-editor');form.elements.title.value='Подготовить исходные данные';form.elements.start.value=day;form.elements.end.value=later;submit('#phase-editor');
    await wait(()=>$('.phase-item')?.textContent.includes('исходные данные')&&!$('#logout').disabled);
    assert.equal($('#task-content progress').max,1);click('#close-dialog');click('[data-view="gantt"]');assert.ok($('.gantt-row')?.textContent.includes('исходные данные'));
    click('[data-view="board"]');click('[data-task]');await wait(()=>$('#message-form'));
    const longMessage='Уточни готовый результат и необходимые данные. '+'Дополнительное пояснение. '.repeat(90)+'В конце: <img src=x onerror=alert(1)> Исходные данные НЕ получены.';
    $('#manager-message').value=longMessage;$('#message-form').elements.requestUpdate.checked=true;submit('#message-form');
    await wait(()=>$('.bubble')?.textContent.includes('Уточни готовый результат')&&!$('#logout').disabled);
    click('#preview-context');await wait(()=>$('#context-preview-content .context-source'));
    click('#context-preview-content [data-source-open]');await wait(()=>$('#context-preview-content .source-page'));
    click('#context-preview-content [data-source-open]');await wait(()=>!$('#context-preview-content [data-source-open]'));
    assert.ok($('#context-preview-content').textContent.includes('Исходные данные НЕ получены.'));assert.equal($('#context-preview-content img'),null);
    const proto=await import('../agent/lib/prototype.ts'),actor=store.readState().employees[0];
    const job=proto.createAssistantJob({requestId:crypto.randomUUID(),taskId,expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Что известно?'},actor,true);
    proto.claimAssistantJob(job.jobId);const jobContext={session:{auth:{current:{principalId:actor.id,attributes:{webJobId:job.jobId}}}}};
    proto.readAssistantHistory(jobContext,taskId,{});
    proto.finishAssistantJob(jobContext,{text:'Нужно уточнить получение данных.',references:[{sourceId:store.readState().sources[0].id,quote:'Исходные данные НЕ получены.'}]});
    click('#close-dialog');click('[data-task]');await wait(()=>$('#assistant-jobs [data-source-open]'));
    click('#assistant-jobs [data-source-open]');await wait(()=>$('#assistant-jobs .source-page'));
    const pageBefore=$('#assistant-jobs .source-page');intervals.find(t=>t.ms===6000).fn();await new Promise(r=>setTimeout(r,20));
    assert.equal($('#assistant-jobs .source-page'),pageBefore,'Опрос не сбрасывает открытый источник');
    click('#assistant-jobs [data-source-open]');await wait(()=>!$('#assistant-jobs [data-source-open]'));
    assert.ok($('#assistant-jobs .source-pages').textContent.includes('Исходные данные НЕ получены.'));assert.equal($('#task-content img'),null);
    click('[data-template="request"]');await wait(()=>$('[data-edit-draft]')&&!$('#logout').disabled);click('[data-edit-draft]');
    form=$('#draft-editor');form.elements.body.value='Готовый текст запроса. <script>bad()</script>';form.elements.status.value='approved';submit('#draft-editor');
    await wait(()=>$('.draft')?.textContent.includes('Текст согласован')&&!$('#logout').disabled);assert.equal(store.readState().decisionDrafts[0].body,'Готовый текст запроса. <script>bad()</script>');
    await logout();await login('a');assert.equal($('#new-task').hidden,true);assert.equal($('#team').hidden,true);
    click('[data-task]');await wait(()=>$('#report-form'));assert.ok($('.bubble').textContent.includes('Уточни готовый результат'));assert.equal($('[data-edit-draft]'),null);assert.equal($('#preview-context'),null);
    click('[data-phase-toggle]');await wait(()=>$('#task-content progress')?.value===1&&!$('#logout').disabled);
    $('#report-text').value='Работа выполнена, результат готов к проверке.';submit('#report-form');await wait(()=>store.readState().tasks[0].status==='review'&&!$('#logout').disabled);
    await logout();await login('boss');click('[data-task]');await wait(()=>$('[data-decision="accept"]'));
    click('[data-decision="accept"]');await wait(()=>store.readState().tasks[0].status==='done'&&!$('#logout').disabled);
    click('#close-dialog');assert.equal($('[data-task]'),null);click('[data-filter="done"]');assert.equal($('[data-task]').dataset.task,taskId);
    click('[data-task]');await wait(()=>$('[data-task-action="reopen"]'));click('[data-task-action="reopen"]');await wait(()=>store.readState().tasks[0].status==='active'&&!$('#logout').disabled);
    assert.equal(w.localStorage.length,0);assert.deepEqual(errors,[]);
  }finally{timers.forEach(clearInterval);Object.assign(globalThis,previous);w.close();store.database().close();rmSync(dir,{recursive:true,force:true});}
});
