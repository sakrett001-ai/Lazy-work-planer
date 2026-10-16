import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';

const dir=mkdtempSync(join(tmpdir(),'lazy-llm-')),file=join(dir,'connections.json');
process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN='https://roles.test';process.env.ASSISTANT_AI_ENABLED='true';process.env.ASSISTANT_LLM_CONFIG=file;
process.env.ASSISTANT_LLM_KEY_TEST_ONE='dummy-key-one';process.env.ASSISTANT_LLM_KEY_TEST_TWO='dummy-key-two';process.env.ASSISTANT_LLM_KEY_TEST_THREE='dummy-key-three';
const store=await import('../agent/lib/store.ts'),auth=await import('../agent/lib/web-auth.ts'),proto=await import('../agent/lib/prototype.ts'),config=await import('../agent/lib/llm-config.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts'),{createConsultationRunner}=await import('../agent/lib/consultation-runner.ts');
const connections=[
  {id:'vse-one',label:'Vse · общий',provider:'vsegpt',credentialEnv:'ASSISTANT_LLM_KEY_TEST_ONE',models:['a-small','a-large']},
  {id:'vse-two',label:'Vse · отдельный ключ',provider:'vsegpt',credentialEnv:'ASSISTANT_LLM_KEY_TEST_TWO',models:['b-model']},
  {id:'claude',label:'Claude',provider:'anthropic',credentialEnv:'ASSISTANT_LLM_KEY_TEST_THREE',models:['c-model']},
];
const boss=()=>store.readState().employees[0];
const off={enabled:false,connectionId:null,model:null};
const roles={coordinator:{enabled:true,connectionId:'vse-one',model:'a-small'},analyst:{enabled:true,connectionId:'vse-two',model:'b-model'},reviewer:{enabled:true,connectionId:'claude',model:'c-model'}};
function reset(){
  writeFileSync(file,JSON.stringify({connections}));process.env.ASSISTANT_AI_ENABLED='true';process.env.ASSISTANT_SERVER_ORIGIN='https://roles.test';
  store.updateState(()=>({employees:[{id:'boss',name:'Руководитель',role:'manager'},{id:'a',name:'Исполнитель',role:'employee'}],tasks:[{id:'T1',title:'Свод',employeeId:'a',status:'active',summary:'Не хватает данных',due:'2026-12-01'},{id:'T2',title:'Другая задача',employeeId:'a',status:'active'}],sources:[{id:'S1',taskId:'T1',employeeId:'a',text:'Нужны исходные данные.',receivedAt:'2026-10-16T08:00:00Z'},{id:'S2',taskId:'T2',employeeId:'a',text:'Другая информация.',receivedAt:'2026-10-16T08:00:00Z'}],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
  config.roleSettings(boss());proto.preferences('boss');
  auth.webTables().exec('DELETE FROM llm_settings; DELETE FROM web_assistant_jobs; DELETE FROM web_operations; DELETE FROM web_sessions; DELETE FROM web_invites;');
}
function save(selected=roles){return config.saveRoleSettings({requestId:randomUUID(),expectedVersion:config.roleSettings(boss()).version,roles:selected},boss());}
const refs=[{sourceId:'S1',quote:'Нужны исходные данные.'}];
const answer=(text='Запросить недостающие данные.',references=refs)=>({text:JSON.stringify({action:'answer',text,references}),inputTokens:20,outputTokens:10});
const review=(approved=true,references=refs)=>({text:JSON.stringify({action:'review',approved,reason:approved?'Вывод подтверждён.':'Есть неподтверждённый вывод.',references})});
function job(){return proto.createAssistantJob({requestId:randomUUID(),taskId:'T1',expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Что делать?'},boss(),true,config.executionPlan()).jobId;}
async function api(path,body,session){return handleDashboardRequest(new Request(process.env.ASSISTANT_SERVER_ORIGIN+'/assistant/api/'+path,{headers:{...(session?{cookie:session.cookie}:{}),...(body===undefined?{}:{origin:process.env.ASSISTANT_SERVER_ORIGIN,'content-type':'application/json','x-csrf-token':session?.csrf||''})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}),{assistantAvailable:config.assistantAvailable(),assistantMode:'roles'});}
async function signin(id){const response=await api('login',{code:auth.issueInvite(id)}),cookie=response.headers.get('set-cookie').split(';')[0];return{cookie,...await(await api('session',undefined,{cookie})).json()};}
after(()=>{store.database().close();rmSync(dir,{recursive:true,force:true});});

test('Настройки: несколько ключей одного провайдера, независимые модели, права/CSRF, idempotency и stale version',async()=>{
  reset();assert.equal(config.assistantAvailable(),false);const manager=await signin('boss'),employee=await signin('a');
  assert.equal((await api('llm-settings',undefined,employee)).status,403);
  const settings=await(await api('llm-settings',undefined,manager)).json(),serialized=JSON.stringify(settings);
  assert.ok(!serialized.includes('dummy-key'));assert.ok(!serialized.includes('credentialEnv'));assert.ok(!serialized.includes('ASSISTANT_LLM_KEY'));
  const command={requestId:randomUUID(),expectedVersion:settings.version,roles};
  assert.equal((await api('llm-settings',command,{...manager,csrf:'bad'})).status,403);
  assert.equal((await api('llm-settings',command,employee)).status,403);
  assert.equal((await api('llm-settings',command,manager)).status,200);
  assert.equal((await(await api('llm-settings',command,manager)).json()).duplicate,true);
  assert.equal((await api('llm-settings',{...command,requestId:randomUUID()},manager)).status,409);
  assert.equal(config.assistantAvailable(),true);assert.deepEqual(config.executionPlan().routes.map(r=>[r.connectionId,r.model]),[['vse-one','a-small'],['vse-two','b-model'],['claude','c-model']]);
  const invalid={...roles,analyst:{...roles.analyst,model:'c-model'}};
  assert.equal((await api('llm-settings',{...command,requestId:randomUUID(),expectedVersion:config.roleSettings(boss()).version,roles:invalid},manager)).status,400);
  assert.equal((await api('llm-settings',{...command,requestId:randomUUID(),expectedVersion:config.roleSettings(boss()).version,roles,apiKey:'browser-secret'},manager)).status,400);
  save({coordinator:off,analyst:roles.analyst,reviewer:off});assert.equal(config.executionPlan().routes.length,1);
  save({coordinator:off,analyst:off,reviewer:off});assert.equal(config.assistantAvailable(),false);
});

test('Файл подключений не позволяет браузеру выбирать URL/чужие секреты; отсутствующий ключ отключает запуск',()=>{
  reset();save();
  for(const extra of [{baseUrl:'http://127.0.0.1'},{credentialEnv:'TELEGRAM_BOT_TOKEN'},{provider:'unknown'}]){
    writeFileSync(file,JSON.stringify({connections:[{...connections[0],...extra}]}));
    assert.throws(()=>config.loadConnections());assert.equal(config.assistantAvailable(),false);
  }
  writeFileSync(file,JSON.stringify({connections}));delete process.env.ASSISTANT_LLM_KEY_TEST_TWO;
  assert.equal(config.assistantAvailable(),false);assert.equal(config.roleSettings(boss()).connections[1].ready,false);
  process.env.ASSISTANT_LLM_KEY_TEST_TWO='dummy-key-two';
});

test('Реальный исполнитель: три роли с разными ключами, снимок маршрута, проверка источников, без повторного вызова',async()=>{
  reset();save();const id=job(),calls=[];
  save({coordinator:off,analyst:{enabled:true,connectionId:'vse-one',model:'a-large'},reviewer:off});
  const run=createConsultationRunner({complete:async input=>{
    calls.push(input);const payload=JSON.parse(input.prompt);
    if(calls.length===2)assert.equal(payload.untrustedProposals[0].trust,'untrusted_model_proposal');
    return input.connection.provider==='anthropic'?review():answer();
  }});
  await Promise.all([run(id),run(id)]);await run(id);
  assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>[c.connection.id,c.key,c.model]),[['vse-one','dummy-key-one','a-small'],['vse-two','dummy-key-two','b-model'],['claude','dummy-key-three','c-model']]);
  const done=proto.getJob(id);assert.equal(done.status,'completed');assert.equal(done.execution.steps.length,3);assert.equal(done.execution.review,'Вывод подтверждён.');assert.ok(done.references[0].version);
  assert.ok(!JSON.stringify(done).includes('dummy-key'));assert.ok(!JSON.stringify(done).includes('credentialEnv'));assert.equal(store.readState().tasks[0].status,'active');
});

test('Дочитывание источника ограничено задачей и ролью; неподтверждённые и чужие цитаты не публикуются',async()=>{
  reset();save({coordinator:off,analyst:roles.analyst,reviewer:off});
  store.updateState(s=>{s.sources[0].text='Начало. '+'Подробности. '.repeat(100)+'Нужны исходные данные.';return s;});
  let id=job(),calls=0;
  const run=createConsultationRunner({complete:async input=>{
    calls++;const p=JSON.parse(input.prompt);
    if(calls===1)return{text:JSON.stringify({action:'read_source',sourceId:'S1',version:p.taskContext.sources[0].version,offset:1000,limit:1000})};
    assert.ok(p.sourcePages[0].text.includes(refs[0].quote));return answer();
  }});
  await run(id);assert.equal(proto.getJob(id).status,'completed');assert.equal(calls,2);
  id=job();await createConsultationRunner({complete:async()=>answer()})(id);assert.equal(proto.getJob(id).status,'failed');
  id=job();await createConsultationRunner({complete:async()=>answer('Чужие данные.',[{sourceId:'S2',quote:'Другая информация.'}])})(id);assert.equal(proto.getJob(id).status,'failed');
  id=job();await createConsultationRunner({complete:async()=>({text:JSON.stringify({action:'read_source',sourceId:'S2',version:'a'.repeat(64)})})})(id);assert.equal(proto.getJob(id).status,'failed');
  id=job();await createConsultationRunner({complete:async()=>({text:JSON.stringify({action:'send_email',to:'attacker.invalid',body:'data'})})})(id);assert.equal(proto.getJob(id).status,'failed');
});

test('Проверяющий не наследует полномочия и прочитанные фрагменты аналитика',async()=>{
  reset();save({coordinator:off,analyst:roles.analyst,reviewer:roles.reviewer});
  store.updateState(s=>{s.sources[0].text='Описание. '.repeat(70)+'Нужны исходные данные.';return s;});
  const id=job();let calls=0;
  await createConsultationRunner({complete:async input=>{
    calls++;const p=JSON.parse(input.prompt);
    if(calls===1)return{text:JSON.stringify({action:'read_source',sourceId:'S1',version:p.taskContext.sources[0].version,offset:600,limit:500})};
    if(calls===2)return answer();
    assert.equal(p.sourcePages.length,0);return review();
  }})(id);
  assert.equal(proto.getJob(id).status,'failed');assert.equal(calls,3);
});

test('Изменение данных/прав во время вызова, отказ проверяющего и смена каталога останавливают консультацию',async()=>{
  for(const mutation of [s=>{s.tasks[0].due='2026-12-02';},s=>{s.employees[0].role='employee';}]){
    reset();save();const id=job();let calls=0;
    await createConsultationRunner({complete:async()=>{calls++;store.updateState(s=>{mutation(s);return s;});return answer();}})(id);
    assert.equal(proto.getJob(id).status,'failed');assert.equal(calls,1);assert.equal(proto.getJob(id).text,undefined);
  }
  reset();save();let id=job();
  await createConsultationRunner({complete:async input=>input.connection.provider==='anthropic'?review(false):answer()})(id);
  assert.equal(proto.getJob(id).status,'failed');assert.equal(proto.getJob(id).execution.errorCode,'review_rejected');
  id=job();writeFileSync(file,JSON.stringify({connections:connections.map(c=>({...c,label:c.label+' изменён'}))}));let calls=0;
  await createConsultationRunner({complete:async()=>{calls++;return answer();}})(id);assert.equal(calls,0);assert.equal(proto.getJob(id).status,'failed');
});

test('Обычный HTTP-сервер принимает вопрос, запускает выбранную модель и возвращает ответ после повторного запроса',async()=>{
  reset();save({coordinator:off,analyst:roles.analyst,reviewer:off});let calls=0;
  const {createPilotServer}=await import('../scripts/pilot-server.mjs');
  const server=createPilotServer({runConsultation:createConsultationRunner({complete:async input=>{calls++;assert.equal(input.model,'b-model');return answer();}})});
  server.listen(0,'127.0.0.1');await once(server,'listening');process.env.ASSISTANT_SERVER_ORIGIN='http://127.0.0.1:'+server.address().port;
  const url=process.env.ASSISTANT_SERVER_ORIGIN+'/assistant/api/';
  try{
    const login=await fetch(url+'login',{method:'POST',headers:{origin:process.env.ASSISTANT_SERVER_ORIGIN,'content-type':'application/json'},body:JSON.stringify({code:auth.issueInvite('boss')})});
    const cookie=login.headers.get('set-cookie').split(';')[0],session=await(await fetch(url+'session',{headers:{cookie}})).json();
    const body={requestId:randomUUID(),taskId:'T1',expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Что делать?'};
    const post=()=>fetch(url+'assistant',{method:'POST',headers:{cookie,origin:process.env.ASSISTANT_SERVER_ORIGIN,'content-type':'application/json','x-csrf-token':session.csrf},body:JSON.stringify(body)});
    const response=await post();assert.equal(response.status,200);const {jobId}=await response.json();
    const deadline=Date.now()+2000;while(proto.getJob(jobId).status==='pending'||proto.getJob(jobId).status==='running'){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}
    assert.equal((await(await post()).json()).duplicate,true);
    const result=await(await fetch(url+'assistant?taskId=T1',{headers:{cookie}})).json();assert.equal(result.jobs[0].status,'completed');assert.equal(calls,1);
    const tasks=await(await fetch(url+'tasks',{headers:{cookie}})).json();assert.equal(tasks.assistant.mode,'roles');
  }finally{server.close();server.closeAllConnections();await once(server,'close');}
});

test('Цикл чтения ограничен четырьмя вызовами, ошибка модели не передаёт вопрос следующей роли',async()=>{
  reset();save();let id=job(),calls=0;
  await createConsultationRunner({complete:async input=>{
    calls++;const p=JSON.parse(input.prompt);return{text:JSON.stringify({action:'read_source',sourceId:'S1',version:p.taskContext.sources[0].version,offset:0,limit:10})};
  }})(id);
  assert.equal(calls,4);assert.equal(proto.getJob(id).execution.errorCode,'step_limit');assert.equal(proto.getJob(id).status,'failed');
  id=job();calls=0;
  await createConsultationRunner({complete:async()=>{calls++;throw new Error('private provider error dummy-key-one');}})(id);
  assert.equal(calls,1);assert.equal(proto.getJob(id).status,'failed');assert.ok(!JSON.stringify(proto.getJob(id)).includes('dummy-key-one'));
});
