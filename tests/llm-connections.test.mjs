import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,renameSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const dir=mkdtempSync(join(tmpdir(),'lazy-connections-')),origin='https://connections.test';
process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN=origin;delete process.env.ASSISTANT_LLM_CONFIG;delete process.env.ASSISTANT_AI_ENABLED;
const store=await import('../agent/lib/store.ts'),auth=await import('../agent/lib/web-auth.ts'),cfg=await import('../agent/lib/llm-config.ts'),proto=await import('../agent/lib/prototype.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts'),{createConsultationRunner}=await import('../agent/lib/consultation-runner.ts');
const manager={id:'boss',name:'Руководитель',role:'manager'},employee={id:'a',name:'Сотрудник',role:'employee'},secret='test-only-private-api-key-001';
function reset(){
  process.env.ASSISTANT_AI_ENABLED='true';
  store.updateState(()=>({employees:[manager,employee],tasks:[{id:'T1',title:'Проверить план',employeeId:'a',status:'active'}],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
  cfg.roleSettings(manager);proto.preferences('boss');auth.webTables().exec('DELETE FROM llm_connections; DELETE FROM llm_settings; DELETE FROM web_operations; DELETE FROM web_sessions; DELETE FROM web_invites; DELETE FROM web_assistant_jobs;');
  rmSync(join(dir,'llm-master.key'),{force:true});
}
function command(extra={}){return{requestId:randomUUID(),expectedVersion:cfg.roleSettings(manager).version,connectionId:null,label:'Мой шлюз',provider:'vsegpt',apiKey:secret,models:['model-small','model-large'],...extra};}
async function api(path,body,session){return handleDashboardRequest(new Request(origin+'/assistant/api/'+path,{headers:{...(session?{cookie:session.cookie}:{}),...(body===undefined?{}:{'content-type':'application/json',origin,'x-csrf-token':session?.csrf||''})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}));}
async function signin(id){const r=await api('login',{code:auth.issueInvite(id)}),cookie=r.headers.get('set-cookie').split(';')[0];return{cookie,...await(await api('session',undefined,{cookie})).json()};}
function enable(id){const off={enabled:false,connectionId:null,model:null};cfg.saveRoleSettings({requestId:randomUUID(),expectedVersion:cfg.roleSettings(manager).version,roles:{coordinator:off,analyst:{enabled:true,connectionId:id,model:'model-small'},reviewer:off}},manager);}
after(()=>{store.database().close();rmSync(dir,{recursive:true,force:true});});

test('Ключ вводится через API, шифруется, не выдаётся браузеру/SQLite/WAL; права, CSRF и повторы',async()=>{
  reset();const boss=await signin('boss'),user=await signin('a'),body=command();
  assert.equal((await api('llm-connection',body,user)).status,403);assert.equal((await api('llm-connection',body,{...boss,csrf:'invalid'})).status,403);
  assert.equal((await api('llm-connection',{...body,baseUrl:'https://attacker.invalid'},boss)).status,400);
  const response=await api('llm-connection',body,boss);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const receipt=await response.json(),repeat=await(await api('llm-connection',body,boss)).json();assert.equal(repeat.duplicate,true);assert.equal(repeat.connectionId,receipt.connectionId);
  assert.equal((await api('llm-connection',{...body,apiKey:'changed-key'},boss)).status,409);
  const publicSettings=await(await api('llm-settings',undefined,boss)).json();assert.equal(publicSettings.connections[0].editable,true);assert.equal(publicSettings.connections[0].ready,true);
  for(const data of [receipt,publicSettings,store.readState()])assert.ok(!JSON.stringify(data).includes(secret));
  const row=auth.webTables().prepare('SELECT * FROM llm_connections').get();assert.ok(!JSON.stringify(row).includes(secret));assert.ok(!JSON.stringify(auth.webTables().prepare('SELECT * FROM web_operations').all()).includes(secret));
  for(const file of ['assistant.sqlite','assistant.sqlite-wal'])if(existsSync(join(dir,file)))assert.ok(!readFileSync(join(dir,file)).includes(Buffer.from(secret)));
  const keyfile=join(dir,'llm-master.key');assert.equal(statSync(keyfile).size,32);if(process.platform!=='win32')assert.equal(statSync(keyfile).mode&0o777,0o600);
  assert.equal(cfg.credential(cfg.loadConnections()[0]),secret);
});

test('Сохранённый ключ не включает ИИ без явного server opt-in',async()=>{
  reset();delete process.env.ASSISTANT_AI_ENABLED;assert.equal(cfg.assistantAvailable(),false);
  const saved=cfg.saveConnection(command(),manager);enable(saved.connectionId);assert.equal(cfg.assistantAvailable(),false);
  assert.throws(()=>cfg.executionPlan());process.env.ASSISTANT_AI_ENABLED='';assert.equal(cfg.assistantAvailable(),false);
  process.env.ASSISTANT_AI_ENABLED='true';assert.equal(cfg.assistantAvailable(),true);
  const receipt=proto.createAssistantJob({requestId:randomUUID(),taskId:'T1',expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Как начать?'},manager,true,cfg.executionPlan());let calls=0;
  await createConsultationRunner({complete:async input=>{calls++;assert.equal(input.key,secret);assert.equal(input.model,'model-small');return{text:JSON.stringify({protocolVersion:2,action:'answer',text:'Уточнить ожидаемый результат.',references:[]})};}})(receipt.jobId);
  assert.equal(calls,1);assert.equal(proto.getJob(receipt.jobId).status,'completed');assert.ok(!JSON.stringify(proto.getJob(receipt.jobId)).includes(secret));
  process.env.ASSISTANT_AI_ENABLED='false';assert.equal(cfg.assistantAvailable(),false);assert.equal(cfg.roleSettings(manager).enabledOnServer,false);
});

test('Редактирование оставляет ключ при пустом поле, ротация меняет версию; провайдера нельзя подменить',()=>{
  reset();const created=cfg.saveConnection(command(),manager),id=created.connectionId;enable(id);const route=cfg.executionPlan().routes[0];
  const edit=command({connectionId:id,label:'Другой заголовок',apiKey:''});cfg.saveConnection(edit,manager);assert.equal(cfg.credential(cfg.loadConnections()[0]),secret);
  assert.throws(()=>cfg.saveConnection(command({connectionId:id,provider:'openai',apiKey:''}),manager));
  cfg.saveConnection(command({connectionId:id,apiKey:'test-only-rotated-key'}),manager);
  assert.equal(cfg.credential(cfg.loadConnections()[0]),'test-only-rotated-key');assert.throws(()=>cfg.resolveRoute(route));
  assert.throws(()=>cfg.saveConnection({...edit,requestId:randomUUID()},manager));
});

test('Подмена шифротекста и потеря мастер-ключа закрывают доступ и не создают новый ключ поверх старого',()=>{
  reset();cfg.saveConnection(command(),manager);const connection=cfg.loadConnections()[0],row=auth.webTables().prepare('SELECT secret FROM llm_connections').get();
  const envelope=JSON.parse(row.secret);envelope.tag=Buffer.alloc(16).toString('base64');auth.webTables().prepare('UPDATE llm_connections SET secret=?').run(JSON.stringify(envelope));
  assert.throws(()=>cfg.credential(connection));assert.equal(cfg.roleSettings(manager).connections[0].ready,false);
  auth.webTables().prepare('UPDATE llm_connections SET secret=?').run(row.secret);
  assert.throws(()=>cfg.credential({...connection,provider:'openai'}));
  const keypath=join(dir,'llm-master.key');renameSync(keypath,keypath+'.held');
  try{assert.throws(()=>cfg.credential(connection));assert.throws(()=>cfg.saveConnection(command(),manager));assert.equal(existsSync(keypath),false);}
  finally{renameSync(keypath+'.held',keypath);}
  assert.equal(cfg.credential(connection),secret);
});

test('Ключ переживает новый процесс и восстанавливается вместе с резервной копией',()=>{
  reset();cfg.saveConnection(command(),manager);
  const verify="const c=await import('./agent/lib/llm-config.ts');process.stdout.write(String(c.credential(c.loadConnections()[0])===process.env.TEST_EXPECTED_KEY));";
  const child=env=>spawnSync(process.execPath,['--input-type=module','-e',verify],{env:{...process.env,TEST_EXPECTED_KEY:secret,...env},encoding:'utf8'});
  assert.equal(child({}).stdout,'true');
  const target=join(dir,'key-backup.sqlite'),backup=spawnSync(process.execPath,['scripts/backup-state.mjs',target],{env:process.env,encoding:'utf8'});
  assert.equal(backup.status,0,backup.stderr);assert.ok(!backup.stdout.includes(secret));assert.ok(existsSync(target+'.llm-key'));
  const restored=join(dir,'restored');mkdirSync(restored);copyFileSync(target,join(restored,'assistant.sqlite'));copyFileSync(target+'.llm-key',join(restored,'llm-master.key'));
  const result=child({ASSISTANT_DATA_DIR:restored});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'true');
});
