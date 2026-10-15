import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const dataDir=mkdtempSync(join(tmpdir(),'lazy-pilot-'));
process.env.ASSISTANT_DATA_DIR=dataDir;
process.env.ASSISTANT_SERVER_ORIGIN='https://assistant.test';
process.env.ASSISTANT_DELIVERY_ENABLED='false';
const store=await import('../agent/lib/store.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const {issueInvite,webTables,session}=await import('../agent/lib/web-auth.ts');
const {createPilotServer}=await import('../scripts/pilot-server.mjs');
const state=()=>({employees:[{id:'manager',name:'Руководитель',role:'manager'},{id:'worker',name:'Сотрудник',role:'employee'},{id:'other',name:'Другой сотрудник',role:'employee'}],tasks:[{id:'П-1',title:'Подготовить свод',employeeId:'worker',project:'Пилот',due:'2026-12-10',status:'active',summary:'Ожидаем обновление',contact:'not_requested',needsDecision:false},{id:'Л-1',title:'Личная задача',employeeId:'manager',project:'Личное',status:'active',contact:'not_requested',needsDecision:false},{id:'П-2',title:'Чужое поручение',employeeId:'other',project:'Пилот',status:'active',contact:'not_requested',needsDecision:false}],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}});
function reset(){webTables().exec('DELETE FROM web_sessions; DELETE FROM web_invites; DELETE FROM web_operations; DELETE FROM inbox; DELETE FROM outbox;');store.updateState(()=>state());}
async function request(path,body,auth,headers={}){
  const origin=process.env.ASSISTANT_SERVER_ORIGIN;
  return handleDashboardRequest(new Request(origin+'/assistant/api/'+path,{headers:{...(auth?{cookie:auth.cookie}:{}),...(body!==undefined?{'content-type':'application/json',origin,'x-csrf-token':auth?.csrf||''}:{}),...headers},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})}));
}
async function signin(id){const result=await request('login',{code:issueInvite(id)});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];const auth=await (await request('session',undefined,{cookie})).json();return {cookie,csrf:auth.csrf,actor:auth.actor};}
after(()=>{store.database().close();rmSync(dataDir,{recursive:true,force:true});});

test('Персональный код одноразовый; сеанс защищён, истекает и отзывается при выходе',async()=>{
  reset();assert.equal((await request('tasks')).status,401);
  const code=issueInvite('worker'),login=await request('login',{code});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);assert.match(login.headers.get('set-cookie'),/Secure/);
  assert.equal((await request('login',{code})).status,401);
  const cookie=login.headers.get('set-cookie').split(';')[0],auth={cookie,...await (await request('session',undefined,{cookie})).json()};
  assert.equal(auth.actor.id,'worker');assert.equal((await request('logout',{},auth)).status,200);assert.equal((await request('tasks',undefined,auth)).status,401);
  const expired=issueInvite('worker',Date.now()-31*60000);assert.equal((await request('login',{code:expired})).status,401);
  const fresh=await signin('worker');assert.throws(()=>session(new Request('https://assistant.test/',{headers:{cookie:fresh.cookie}}),Date.now()+9*3600000),/Сеанс завершён/);
  const rows=webTables().prepare('SELECT hash FROM web_sessions').all();assert.ok(rows.every(row=>!fresh.cookie.includes(row.hash)));
});

test('Сотрудник видит только свои задачи и память; роль нельзя передать в запросе',async()=>{
  reset();const worker=await signin('worker'),manager=await signin('manager');
  const data=await (await request('tasks',undefined,worker)).json();assert.deepEqual(data.tasks.map(t=>t.id),['П-1']);assert.equal(data.brief.metrics.open,1);
  assert.equal((await request('memory?taskId='+encodeURIComponent('Л-1'),undefined,worker)).status,404);
  assert.equal((await request('decision',{requestId:randomUUID(),taskId:'П-1',action:'take_control',expectedVersion:'a'.repeat(64)},worker)).status,403);
  assert.equal((await (await request('tasks',undefined,manager)).json()).tasks.length,3);
  assert.equal((await request('report',{requestId:randomUUID(),taskId:'П-1',text:'Готово',actorId:'manager'},worker)).status,400);
  assert.equal((await request('report',{requestId:randomUUID(),taskId:'П-2',text:'Готово'},worker)).status,404);
});

test('Ответ → источник → память → подтверждённое решение; повторы не меняют историю',async()=>{
  reset();const worker=await signin('worker'),manager=await signin('manager');
  const report={requestId:randomUUID(),taskId:'П-1',text:'Прошу перенести срок на 2026-12-15: ожидаем данные.'};
  const result=await request('report',report,worker);assert.equal(result.status,200,await result.clone().text());
  const first=store.readState();assert.equal(first.tasks[0].due,'2026-12-10');assert.equal(first.tasks[0].proposedDue,'2026-12-15');
  const memory=await (await request('memory?taskId='+encodeURIComponent('П-1'),undefined,manager)).json();assert.equal(memory.sources[0].text,report.text);assert.equal(memory.sources[0].employeeId,'worker');assert.equal(memory.sources[0].simulated,false);
  assert.equal((await (await request('report',report,worker)).json()).duplicate,true);assert.deepEqual(store.readState(),first);
  assert.equal((await request('report',{...report,text:'Подменённое сообщение'},worker)).status,409);
  const input={requestId:randomUUID(),taskId:'П-1',action:'approve_due',expectedVersion:memory.taskVersion};
  assert.equal((await request('decision',input,manager)).status,200);assert.equal(store.readState().tasks[0].due,'2026-12-15');
  const accepted=store.readState();assert.equal((await (await request('decision',input,manager)).json()).duplicate,true);assert.deepEqual(store.readState(),accepted);
  assert.equal((await request('decision',{...input,action:'reject_due'},manager)).status,409);
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n,0,'Внешние сообщения не отправляются');
});

test('Устаревшая карточка не отменяет новый факт; завершение требует приёмки',async()=>{
  reset();const worker=await signin('worker'),manager=await signin('manager');
  await request('report',{requestId:randomUUID(),taskId:'П-1',text:'Препятствие не устранено, нужна помощь.'},worker);
  const old=await (await request('memory?taskId='+encodeURIComponent('П-1'),undefined,manager)).json();
  await request('report',{requestId:randomUUID(),taskId:'П-1',text:'Работа выполнена, результат готов к проверке.'},worker);
  assert.equal(store.readState().tasks[0].status,'review');
  assert.equal((await request('decision',{requestId:randomUUID(),taskId:'П-1',action:'take_control',expectedVersion:old.taskVersion},manager)).status,409);
  const fresh=await (await request('memory?taskId='+encodeURIComponent('П-1'),undefined,manager)).json();
  assert.equal((await request('decision',{requestId:randomUUID(),taskId:'П-1',action:'accept',expectedVersion:fresh.taskVersion},manager)).status,200);
  assert.equal(store.readState().tasks[0].status,'done');
  const count=store.database().prepare('SELECT count(*) AS n FROM inbox').get().n;
  assert.equal((await request('report',{requestId:randomUUID(),taskId:'П-1',text:'Новое сообщение'},worker)).status,409);
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM inbox').get().n,count,'Отклонённый отчёт не оставляет половинную запись');
});

test('Чужой Origin, отсутствующий CSRF и слишком большой запрос не изменяют базу',async()=>{
  reset();const worker=await signin('worker'),input={requestId:randomUUID(),taskId:'П-1',text:'Готово'},before=store.readState();
  assert.equal((await request('report',input,worker,{origin:'https://foreign.test'})).status,403);
  assert.equal((await request('report',input,worker,{'x-csrf-token':''})).status,403);
  assert.equal((await request('report',{...input,text:'a'.repeat(17000)},worker)).status,413);
  assert.deepEqual(store.readState(),before);
  assert.equal((await request('login',{code:issueInvite('worker')},undefined,{origin:'https://foreign.test'})).status,403);
});

test('Модель данных и персональный сеанс переживают запуск нового процесса',async()=>{
  reset();const worker=await signin('worker');
  await request('report',{requestId:randomUUID(),taskId:'П-1',text:'Препятствие не устранено, нужна помощь.'},worker);
  const code=`import {handleDashboardRequest} from './agent/lib/dashboard-api.ts';
    let cookie='';for await(const chunk of process.stdin)cookie+=chunk;
    const r=await handleDashboardRequest(new Request('https://assistant.test/assistant/api/memory?taskId='+encodeURIComponent('П-1'),{headers:{cookie}}));
    const m=await r.json();console.log(JSON.stringify({status:r.status,task:m.current.status,source:m.sources[0].text}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env},input:worker.cookie,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{status:200,task:'blocked',source:'Препятствие не устранено, нужна помощь.'});
});

test('Настоящий HTTP-сервер отдаёт интерфейс и API из одного приложения',async()=>{
  reset();const previous=process.env.ASSISTANT_SERVER_ORIGIN,server=createPilotServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;process.env.ASSISTANT_SERVER_ORIGIN=origin;
  try {
    const html=await fetch(origin+'/assistant/workspace');assert.equal(html.status,200);assert.match(await html.text(),/Персональный код входа/);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal((await fetch(origin+'/assistant/pilot.js')).status,200);assert.equal((await fetch(origin+'/assistant/api/tasks')).status,401);
    const code=issueInvite('worker'),login=await fetch(origin+'/assistant/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({code})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const tasks=await (await fetch(origin+'/assistant/api/tasks',{headers:{cookie}})).json();assert.equal(tasks.tasks[0].id,'П-1');
    assert.equal((await fetch(origin+'/assistant/../../.env')).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));process.env.ASSISTANT_SERVER_ORIGIN=previous;}
});
