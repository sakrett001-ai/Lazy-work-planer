import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { context, invoke } from './helpers/server-runtime.mjs';

const dir=mkdtempSync(join(tmpdir(),'lazy-prototype-'));
process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN='https://prototype.test';process.env.ASSISTANT_DELIVERY_ENABLED='false';
const store=await import('../agent/lib/store.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const {issueInvite,webTables}=await import('../agent/lib/web-auth.ts');
const proto=await import('../agent/lib/prototype.ts');
const {initializePrototype}=await import('../scripts/prototype.mjs');
const state=()=>({employees:[{id:'boss',name:'Начальник',role:'manager'},{id:'a',name:'Сотрудник А',role:'employee'},{id:'b',name:'Сотрудник Б',role:'employee'}],tasks:[{id:'Т-1',title:'Подготовить материал',employeeId:'a',project:'Пилот',status:'active',summary:'Первое описание',due:'2026-12-01',contact:'not_requested',needsDecision:false},{id:'Т-2',title:'Другой материал',employeeId:'b',project:'Пилот',status:'active',contact:'not_requested'}],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}});
function reset(){proto.preferences('boss');webTables().exec('DELETE FROM web_sessions; DELETE FROM web_invites; DELETE FROM web_operations; DELETE FROM web_preferences; DELETE FROM web_assistant_jobs; DELETE FROM inbox; DELETE FROM outbox;');store.updateState(()=>state());}
async function request(path,body,auth,{ai=false}={}){
  return handleDashboardRequest(new Request(process.env.ASSISTANT_SERVER_ORIGIN+'/assistant/api/'+path,{headers:{...(auth?{cookie:auth.cookie}:{}),...(body!==undefined?{'content-type':'application/json',origin:process.env.ASSISTANT_SERVER_ORIGIN,'x-csrf-token':auth?.csrf||''}:{})},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})}),{assistantAvailable:ai});
}
async function signin(id){const r=await request('login',{code:issueInvite(id)});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];return {cookie,...await(await request('session',undefined,{cookie})).json()};}
async function ok(path,body,auth,options){const r=await request(path,body,auth,options);const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
const command=extra=>({requestId:randomUUID(),...extra});
async function target(taskId,auth){const m=await ok('memory?taskId='+encodeURIComponent(taskId),undefined,auth);return {taskId,expectedVersion:m.taskVersion};}
after(()=>{store.database().close();rmSync(dir,{recursive:true,force:true});});

test('Постановка без срока/протокола, повтор, персональная видимость и автор истории',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a'),b=await signin('b');
  const input=command({fields:{title:'Личное поручение',employeeId:'a',description:'Ожидаемый результат'}});
  const first=await ok('task-create',input,boss);assert.equal((await ok('task-create',input,boss)).duplicate,true);
  assert.equal(store.readState().tasks.filter(t=>t.id===first.taskId).length,1);
  const m=await ok('memory?taskId='+encodeURIComponent(first.taskId),undefined,a);assert.equal(m.task.due,null);assert.equal(m.task.protocol,undefined);assert.equal(m.task.description,'Ожидаемый результат');
  assert.equal(m.timeline[0].actorId,'boss');
  assert.equal((await request('memory?taskId='+encodeURIComponent(first.taskId),undefined,b)).status,404);
  assert.equal((await request('task-create',input,a)).status,403);
  assert.equal((await request('task-create',{...input,fields:{...input.fields,title:'Подмена'}},boss)).status,409);
});

test('Редактирование не затирает новое сообщение; просроченная версия и неверная дата отклоняются',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a'),old=await target('Т-1',boss);
  await ok('report',command({taskId:'Т-1',text:'Препятствие не устранено, нужна помощь.'}),a);
  const fields={title:'Новое название',employeeId:'a',description:'Другой результат',due:'2026-12-03'};
  assert.equal((await request('task-edit',command({...old,fields}),boss)).status,409);
  const summary=store.readState().tasks[0].summary;
  await ok('task-edit',command({...await target('Т-1',boss),fields}),boss);
  assert.equal(store.readState().tasks[0].summary,summary);assert.equal(store.readState().tasks[0].status,'blocked');
  assert.equal((await request('task-edit',command({...await target('Т-1',boss),fields:{...fields,due:'2026-02-30'}}),boss)).status,400);
  const m=await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,boss);assert.ok(m.sources.some(s=>s.text===summary));assert.ok(m.timeline.some(e=>e.actorId==='boss'));
});

test('Этапы: зависимости, запрет цикла и чужого доступа, повтор завершения, возврат зависимых этапов',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a'),b=await signin('b');
  await ok('phase-save',command({...await target('Т-1',boss),phaseId:null,phase:{title:'Сбор',start:'2026-11-01',end:'2026-11-03',dependsOn:null}}),boss);
  const first=store.readState().tasks[0].phases[0].id;
  await ok('phase-save',command({...await target('Т-1',boss),phaseId:null,phase:{title:'Свод',start:'2026-11-03',end:'2026-11-05',dependsOn:first}}),boss);
  const second=store.readState().tasks[0].phases[1].id;
  assert.equal((await request('phase-toggle',command({...await target('Т-1',boss),phaseId:second,done:true}),a)).status,400);
  assert.equal((await request('phase-save',command({...await target('Т-1',boss),phaseId:first,phase:{title:'Сбор',start:'2026-11-05',end:'2026-11-06',dependsOn:second}}),boss)).status,400);
  const finish=command({...await target('Т-1',boss),phaseId:first,done:true});await ok('phase-toggle',finish,a);assert.equal((await ok('phase-toggle',finish,a)).duplicate,true);
  await ok('phase-toggle',command({...await target('Т-1',boss),phaseId:second,done:true}),a);
  await ok('phase-toggle',command({...await target('Т-1',boss),phaseId:first,done:false}),a);
  assert.ok(store.readState().tasks[0].phases.every(p=>!p.done));
  assert.equal((await request('phase-toggle',command({...await target('Т-1',boss),phaseId:first,done:true}),b)).status,404);
  assert.equal(store.readState().tasks[0].due,'2026-12-01');
});

test('Обсуждение → ответ → редактируемый документ; согласование текста не меняет срок и не отправляет письмо',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a');
  const msg=command({taskId:'Т-1',text:'Что мешает? Предложи реальный срок.',requestUpdate:true});await ok('message',msg,boss);await ok('message',msg,boss);
  assert.equal(store.readState().sources.length,1);assert.equal(store.readState().tasks[0].contact,'awaiting');
  assert.ok((await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,a)).conversation[0].text.includes('Что мешает'));
  await ok('report',command({taskId:'Т-1',text:'Прошу перенести срок на 2026-12-10: ожидаем данные.'}),a);
  const created=await ok('draft-create',command({...await target('Т-1',boss),kind:'extension'}),boss);
  let m=await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,boss),draft=m.drafts.find(d=>d.id===created.draftId);
  assert.equal(draft.generator,'template');assert.ok(draft.body.includes('2026'));assert.ok(draft.references.length);
  const saved=command({draftId:draft.id,expectedVersion:draft.version,expectedTaskVersion:m.taskVersion,title:'Запрос продления',body:'Проверенный текст руководителя.',status:'approved'});
  await ok('draft-save',saved,boss);await ok('draft-save',saved,boss);
  m=await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,boss);assert.equal(m.drafts[0].status,'approved');assert.equal(m.drafts[0].body,saved.body);
  const employeeMemory=await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,a);assert.deepEqual(employeeMemory.drafts,[]);assert.ok(!JSON.stringify(employeeMemory).includes('Проверенный текст руководителя'));
  assert.equal(store.readState().tasks[0].due,'2026-12-01');assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal((await request('draft-save',{...saved,requestId:randomUUID()},boss)).status,409);
});

test('Закрепления и «замечено» персональны и не меняют рабочие факты',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a'),b=await signin('b'),before=structuredClone(store.readState());
  await ok('pin',command({taskId:'Т-1',pinned:true}),boss);
  await ok('notice',command({...await target('Т-1',boss)}),boss);
  assert.deepEqual(store.readState(),before);
  assert.deepEqual((await ok('tasks',undefined,boss)).preferences.pins,['Т-1']);assert.deepEqual((await ok('tasks',undefined,a)).preferences.pins,[]);
  const bossSecond=await signin('boss'),aSecond=await signin('a');
  const managerPrefs=(await ok('tasks',undefined,boss)).preferences;
  const employeePrefs=(await ok('tasks',undefined,a)).preferences;
  for(const session of [boss,bossSecond,a,aSecond]){
    const read=await ok('memory?taskId='+encodeURIComponent('Т-1'),undefined,session);
    assert.deepEqual(read.currentActor,{id:session.actor.id,role:session.actor.role});
    const prefs=(await ok('tasks',undefined,session)).preferences;
    assert.deepEqual(prefs,session.actor.id==='boss'?managerPrefs:employeePrefs,'Two views share only their own actor preferences; memory polling is not a read receipt');
  }
  assert.deepEqual(employeePrefs.seen,{});assert.notDeepEqual(managerPrefs.seen,employeePrefs.seen);
  assert.equal((await request('pin',command({taskId:'Т-1',pinned:true}),b)).status,404);
});

test('Участник создаётся один раз; приглашения доступны руководителю и не сохраняются открытым текстом',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a'),body=command({name:'Новый сотрудник'});
  const first=await ok('person-create',body,boss);assert.equal((await ok('person-create',body,boss)).duplicate,true);
  assert.equal(store.readState().employees.length,4);assert.equal(first.employee.role,'employee');
  assert.equal((await request('person-create',{...body,role:'manager'},boss)).status,400);
  assert.equal((await request('invite',{employeeId:first.employee.id},a)).status,403);
  const invite=await ok('invite',{employeeId:first.employee.id},boss);
  const records=webTables().prepare('SELECT * FROM web_invites').all();assert.ok(!JSON.stringify(records).includes(invite.code));
  const receipts=webTables().prepare('SELECT * FROM web_operations').all();assert.ok(!JSON.stringify(receipts).includes(invite.code));
  assert.equal((await request('login',{code:invite.code})).status,200);assert.equal((await request('login',{code:invite.code})).status,401);
});

test('Веб-консультация: явное подключение, проверенный владелец, запрет изменения/отправки и проверка цитат',async()=>{
  reset();const boss=await signin('boss'),a=await signin('a');
  await ok('report',command({taskId:'Т-1',text:'Нужна помощь: исходные данные не получены.'}),a);
  const input=command({...await target('Т-1',boss),question:'Как устранить препятствие?'});
  assert.equal((await request('assistant',input,boss)).status,503);
  assert.equal((await request('assistant',input,a,{ai:true})).status,403);
  const created=await ok('assistant',input,boss,{ai:true});assert.equal((await ok('assistant',input,boss,{ai:true})).duplicate,true);
  assert.equal(proto.claimAssistantJob(created.jobId).status,'running');assert.equal(proto.claimAssistantJob(created.jobId),undefined);
  const ctx=context('boss','web-call');ctx.session.auth.current.attributes={webJobId:created.jobId};
  const before=structuredClone(store.readState());
  const notify=(await import('../agent/tools/notify_employee.ts')).default;
  await assert.rejects(()=>notify.execute({taskId:'Т-1',kind:'check_in'},ctx),/Веб-консультация/);
  const workflow=(await import('../agent/tools/run_monitoring_graph.ts')).default;
  assert.throws(()=>workflow.execute({eventType:'check_in_request',taskId:'Т-1'},ctx),/Веб-консультация/);
  assert.deepEqual(store.readState(),before);
  proto.readAssistantContext(ctx,'Т-1');
  assert.throws(()=>proto.finishAssistantJob(ctx,{text:'Ответ',references:[{sourceId:store.readState().sources[0].id,quote:'Выдуманная цитата'}]}),/Цитата/);
  await ok('message',command({taskId:'Т-1',text:'Уточнён контекст.'}),boss);
  await ok('task-action',command({...await target('Т-1',boss),action:'unblock'}),boss);
  const source=store.readState().sources[0];
  proto.finishAssistantJob(ctx,{text:'Запросить исходные данные, затем уточнить дату.',references:[{sourceId:source.id,quote:source.text}]});
  const jobs=await ok('assistant?taskId='+encodeURIComponent('Т-1'),undefined,boss);assert.equal(jobs.jobs[0].status,'completed');assert.equal(jobs.jobs[0].stale,true);
  assert.deepEqual((await ok('assistant?taskId='+encodeURIComponent('Т-1'),undefined,a)).jobs,[]);
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n,0);
});

test('Начальная настройка создаёт относительные даты и не перезаписывает существующую память',()=>{
  reset();assert.equal(initializePrototype(),false);
  store.updateState(()=>({...state(),employees:[],tasks:[]}));
  assert.equal(initializePrototype({now:new Date('2026-10-15T23:00:00Z')}),true);
  const initial=store.readState();assert.equal(initial.employees.length,3);assert.equal(initial.tasks.length,6);assert.equal(initial.tasks[0].due,'2026-10-19');assert.equal(initial.settings.prototypeExamples,true);
  assert.ok(initial.tasks.some(t=>t.status==='blocked'));assert.ok(initial.tasks.some(t=>t.status==='review'));
  assert.equal(initializePrototype({now:new Date('2030-01-01')}),false);assert.deepEqual(store.readState(),initial);
});

test('Ассистент спрашивает статус внутри приложения по рабочему графику; повтор и молчание не выдумывают прогресс',async()=>{
  const {monitorWorkspace}=await import('../agent/lib/workspace-monitor.ts');
  const s=state();s.settings.prototypeAutoCheckins=true;
  assert.equal(monitorWorkspace(s,'2026-10-16T03:00:00Z').sources.length,0,'До начала рабочего дня запросов нет');
  assert.equal(monitorWorkspace(s,'2026-10-17T07:00:00Z').sources.length,0,'В субботу запросов нет');
  let checked=monitorWorkspace(s,'2026-10-16T07:00:00Z');assert.equal(checked.sources.length,2);assert.equal(checked.sources[0].authorName,'Ассистент · запрос статуса');
  assert.equal(checked.tasks[0].contact,'awaiting');assert.equal(checked.tasks[0].status,'active');
  assert.deepEqual(monitorWorkspace(checked,'2026-10-16T07:00:00Z'),checked);
  checked=monitorWorkspace(checked,'2026-10-16T11:00:00Z');assert.equal(checked.tasks[0].contact,'no_reply');assert.equal(checked.tasks[0].status,'active');assert.equal(checked.sources.length,2);
  assert.equal(monitorWorkspace(s,'2026-10-16T07:00:00Z',false).sources.length,0,'При другом канале не дублируем запрос');
  s.tasks[0].lastReply='2026-10-16T06:50:00Z';assert.equal(monitorWorkspace(s,'2026-10-16T07:00:00Z').sources.length,1,'Свежий ответ откладывает запрос');
});
