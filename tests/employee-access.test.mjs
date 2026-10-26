import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir=mkdtempSync(join(tmpdir(),'lazy-pilot-'));
process.env.ASSISTANT_DATA_DIR=dataDir;
process.env.ASSISTANT_SERVER_ORIGIN='https://assistant.test';
process.env.ASSISTANT_DELIVERY_ENABLED='false';
const store=await import('../agent/lib/store.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const {issueInvite,webTables}=await import('../agent/lib/web-auth.ts');

const state=()=>({employees:[{id:'manager',name:'Руководитель',role:'manager'},{id:'worker',name:'Сотрудник',role:'employee'},{id:'other',name:'Другой сотрудник',role:'employee'}],tasks:[{id:'П-1',title:'Подготовить свод',employeeId:'worker',project:'Пилот',due:'2026-12-10',status:'active',summary:'Ожидаем обновление',contact:'not_requested',needsDecision:false},{id:'Л-1',title:'Личная задача',employeeId:'manager',project:'Личное',status:'active',contact:'not_requested',needsDecision:false},{id:'П-2',title:'Чужое поручение',employeeId:'other',project:'Пилот',status:'active',contact:'not_requested',needsDecision:false}],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}});
function reset(){webTables().exec('DELETE FROM web_sessions; DELETE FROM web_invites; DELETE FROM web_operations; DELETE FROM inbox; DELETE FROM outbox;');store.updateState(()=>state());}
async function request(path,body,auth,headers={}){
  const origin=process.env.ASSISTANT_SERVER_ORIGIN;
  return handleDashboardRequest(new Request(origin+'/assistant/api/'+path,{headers:{...(auth?{cookie:auth.cookie}:{}),...(body!==undefined?{'content-type':'application/json',origin,'x-csrf-token':auth?.csrf||''}:{}),...headers},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})}));
}
async function signin(id){const result=await request('login',{code:issueInvite(id)});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];const auth=await (await request('session',undefined,{cookie})).json();return {cookie,csrf:auth.csrf,actor:auth.actor};}
after(()=>{store.database().close();rmSync(dataDir,{recursive:true,force:true});});

test('M/A/B: disable atomically revokes every A session and invite, keeps M/B and history', async()=>{
  reset(); const manager=await signin('manager'), a1=await signin('worker'), a2=await signin('worker'), b=await signin('other');
  const report={requestId:randomUUID(),taskId:'П-1',text:'Исходные данные ещё не получены.'};
  assert.equal((await request('report',report,a1)).status,200);
  assert.equal((await (await request('report',report,a1)).json()).duplicate,true);
  const code=issueInvite('worker'), before=store.readState();
  const input={requestId:randomUUID(),employeeId:'worker'};
  for(const actor of [a1,b]) assert.equal((await request('person-disable',input,actor)).status,403);
  assert.equal((await request('person-disable',input,manager,{'x-csrf-token':''})).status,403);
  assert.equal((await request('person-disable',input,manager,{origin:'https://evil.test'})).status,403);
  assert.equal((await request('person-disable',{...input,employeeId:'manager'},manager)).status,403);
  assert.equal((await request('person-disable',{...input,employeeId:'missing'},manager)).status,404);
  assert.equal((await request('person-disable',input,manager)).status,200);
  const after=store.readState();
  assert.equal(after.employees.find(p=>p.id==='worker').enabled,false);
  assert.deepEqual(after.tasks,before.tasks); assert.deepEqual(after.sources,before.sources);
  assert.deepEqual(after.events.slice(1),before.events);
  assert.equal(after.events[0].actorId,'manager');
  assert.equal(webTables().prepare("SELECT count(*) AS n FROM web_sessions WHERE employee_id='worker'").get().n,0);
  assert.equal(webTables().prepare("SELECT count(*) AS n FROM web_invites WHERE employee_id='worker'").get().n,0);
  for(const auth of [a1,a2]) {
    for(const path of ['session','tasks','memory?taskId='+encodeURIComponent('П-1')]) assert.equal((await request(path,undefined,auth)).status,401);
    assert.equal((await request('report',report,auth)).status,401);
  }
  assert.equal((await request('login',{code})).status,401);
  assert.equal((await request('invite',{employeeId:'worker'},manager)).status,403);
  assert.throws(()=>issueInvite('worker'),/отключён/);
  for(const auth of [manager,b]) assert.equal((await request('tasks',undefined,auth)).status,200);
  assert.equal((await request('report',{requestId:randomUUID(),taskId:'П-2',text:'Продолжаю работу.'},b)).status,200);
  assert.equal((await (await request('person-disable',input,manager)).json()).duplicate,true);
  assert.equal((await request('person-disable',{...input,employeeId:'other'},manager)).status,409);
  const repeated=await (await request('person-disable',{...input,requestId:randomUUID()},manager)).json();
  assert.equal(repeated.alreadyDisabled,true);
  assert.equal(store.readState().events.filter(e=>e.kind==='employee_disabled').length,1);
  const memory=await (await request('memory?taskId='+encodeURIComponent('П-1'),undefined,manager)).json();
  assert.equal(memory.sources[0].employeeId,'worker'); assert.equal(memory.sources[0].text,report.text);
});

test('enabled is checked even for retained/stale credentials; failed revocation rolls back state and credentials',async()=>{
  reset();const manager=await signin('manager'),a=await signin('worker'),code=issueInvite('worker');
  // Simulate a database write failure after session deletion, before invite deletion.
  webTables().exec("CREATE TRIGGER fail_revocation BEFORE DELETE ON web_invites BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  try { assert.equal((await request('person-disable',{requestId:randomUUID(),employeeId:'worker'},manager)).status,400); }
  finally { webTables().exec('DROP TRIGGER fail_revocation'); }
  assert.notEqual(store.readState().employees.find(p=>p.id==='worker').enabled,false);
  assert.equal((await request('tasks',undefined,a)).status,200);
  assert.equal(webTables().prepare("SELECT count(*) AS n FROM web_invites WHERE employee_id='worker'").get().n,1);
  store.updateState(s=>{s.employees.find(p=>p.id==='worker').enabled=false;return s;});
  assert.equal((await request('session',undefined,a)).status,401);
  assert.equal((await request('login',{code})).status,401);
  assert.throws(()=>issueInvite('worker'),/отключён/);
});

test('A cannot read or mutate B card through direct endpoints',async()=>{
  reset(); const a=await signin('worker');
  const version=(await import('../agent/lib/prototype.ts')).versionOf(store.readState().tasks[2]);
  const before=store.readState();
  for(const path of ['memory','context','source']) {
    const r=await request(path+'?taskId='+encodeURIComponent('П-2')+'&sourceId=missing',undefined,a);
    assert.equal(r.status,404,path);
  }
  for(const [path,body,status] of [
    ['report',{text:'Чужой отчёт'},404],['pin',{pinned:true},404],['notice',{expectedVersion:version},404],
    ['phase-toggle',{expectedVersion:version,phaseId:'none',done:true},404],
    ['message',{text:'Чужое сообщение'},403],['task-action',{expectedVersion:version,action:'start'},403],
  ]) assert.equal((await request(path,{requestId:randomUUID(),taskId:'П-2',...body},a)).status,status,path);
  assert.deepEqual(store.readState(),before);
});

test('an employee write awaiting its body cannot commit after disable',async()=>{
  reset();const manager=await signin('manager'),a=await signin('worker');
  for(const path of ['report','pin']) {
    if(path==='pin') {reset();}
    const currentA=path==='pin'?await signin('worker'):a;
    const currentM=path==='pin'?await signin('manager'):manager;
    let controller;
    const body=new ReadableStream({start(c){controller=c;}});
    const pending=handleDashboardRequest(new Request(process.env.ASSISTANT_SERVER_ORIGIN+'/assistant/api/'+path,{
      method:'POST',duplex:'half',body,headers:{cookie:currentA.cookie,origin:process.env.ASSISTANT_SERVER_ORIGIN,'content-type':'application/json','x-csrf-token':currentA.csrf},
    }));
    assert.equal((await request('person-disable',{requestId:randomUUID(),employeeId:'worker'},currentM)).status,200);
    const after=store.readState();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({requestId:randomUUID(),taskId:'П-1',...(path==='report'?{text:'Слишком поздно'}:{pinned:true})})));
    controller.close();
    assert.equal((await pending).status,401);
    assert.deepEqual(store.readState(),after);
  }
});

test('disabled principal cannot enter via linked Telegram, call agent tools or receive new assignments',async()=>{
  reset(); const manager=await signin('manager');
  store.updateState(s=>{s.employees.find(p=>p.id==='worker').telegramId='123456';return s;});
  assert.equal((await request('person-disable',{requestId:randomUUID(),employeeId:'worker'},manager)).status,200);
  const before=store.readState();
  const fields={title:'Нельзя назначить',employeeId:'worker'};
  assert.equal((await request('task-create',{requestId:randomUUID(),fields},manager)).status,400);
  const {versionOf}=await import('../agent/lib/prototype.ts');
  assert.equal((await request('task-edit',{requestId:randomUUID(),taskId:'П-2',expectedVersion:versionOf(before.tasks[2]),fields},manager)).status,400);
  assert.throws(()=>store.currentEmployee({session:{auth:{current:{principalId:'worker'}}}}),/отключён/);
  const {invoke}=await import('./helpers/server-runtime.mjs');
  const tool=(await import('../agent/tools/list_tasks.ts')).default;
  await assert.rejects(invoke(tool,{},'worker'),/отключён/);
  const telegram=(await import('../agent/channels/telegram.ts')).default;
  const previous=process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_WEBHOOK_SECRET='synthetic-test-secret-not-real';
  let dispatches=0;
  try {
    const response=await telegram.routes[0].handler(new Request('https://assistant.test/assistant/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':process.env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify({message:{message_id:22,from:{id:123456},chat:{id:123456,type:'private'},text:'П-1 Работа завершена.'}})}),{from(){dispatches++;throw Error('must not dispatch');}});
    assert.equal(response.status,200);assert.equal(dispatches,0);
    assert.equal(webTables().prepare('SELECT count(*) AS n FROM inbox').get().n,0);
  } finally {if(previous===undefined)delete process.env.TELEGRAM_WEBHOOK_SECRET;else process.env.TELEGRAM_WEBHOOK_SECRET=previous;}
  assert.deepEqual(store.readState(),before);
});

test('disabled employee is skipped without starving enabled scheduled recipients; reports keep disabled authors',async()=>{
  reset();const manager=await signin('manager');
  store.updateState(s=>{s.employees.find(p=>p.id==='worker').telegramId='111';s.employees.find(p=>p.id==='other').telegramId='222';s.settings.prototypeAutoCheckins=true;return s;});
  await request('person-disable',{requestId:randomUUID(),employeeId:'worker'},manager);
  const {monitorWorkspace}=await import('../agent/lib/workspace-monitor.ts');
  const monitored=monitorWorkspace(store.readState(),'2026-10-26T07:00:00Z');
  assert.ok(!monitored.sources.some(s=>s.taskId==='П-1'));
  assert.ok(monitored.sources.some(s=>s.taskId==='П-2'));
  const {versionOf}=await import('../agent/lib/prototype.ts');
  const response=await request('report-create',{requestId:randomUUID(),selection:[{taskId:'П-1',expectedVersion:versionOf(store.readState().tasks[0])}]},manager);
  assert.equal(response.status,200,await response.clone().text());
  assert.match(JSON.stringify(await response.json()),/Сотрудник/);
  const edit=await request('task-edit',{requestId:randomUUID(),taskId:'П-1',expectedVersion:versionOf(store.readState().tasks[0]),fields:{title:'Уточнили прежнюю задачу',employeeId:'worker',description:'Новый текст',due:'2026-12-20'}},manager);
  assert.equal(edit.status,200,await edit.clone().text());assert.equal(store.readState().tasks[0].employeeId,'worker');assert.equal(store.readState().tasks[0].description,'Новый текст');
  await import('./helpers/server-runtime.mjs');
  const schedule=(await import('../agent/schedules/check_in.ts')).default;
  const OriginalDate=globalThis.Date,originalFetch=globalThis.fetch,env={delivery:process.env.ASSISTANT_DELIVERY_ENABLED,token:process.env.TELEGRAM_BOT_TOKEN};
  const sent=[];
  globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:['2026-10-26T07:00:00Z']));}};
  globalThis.fetch=async(_url,options)=>{sent.push(JSON.parse(options.body).chat_id);return {ok:true,json:async()=>({ok:true,result:{message_id:1}})};};
  process.env.ASSISTANT_DELIVERY_ENABLED='true';process.env.TELEGRAM_BOT_TOKEN='synthetic-test-token';
  try {await schedule.run();assert.deepEqual(sent,['222']);}
  finally {globalThis.Date=OriginalDate;globalThis.fetch=originalFetch;process.env.ASSISTANT_DELIVERY_ENABLED=env.delivery;if(env.token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=env.token;}
});
