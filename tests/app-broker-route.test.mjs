import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'pulse-app-broker-'));
process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN='https://broker-app.test';process.env.ASSISTANT_AI_ENABLED='true';
// Poison direct configuration: touching it fails. Broker tests never create provider keys.
process.env.ASSISTANT_LLM_CONFIG=join(dir,'DO-NOT-READ-direct-provider.json');
const store=await import('../agent/lib/store.ts'),proto=await import('../agent/lib/prototype.ts'),auth=await import('../agent/lib/web-auth.ts');
const {brokerExecutionPlan}=await import('../agent/lib/llm-config.ts');
const {createConsultationRunner,consultationInstructions,consultationSystemHash}=await import('../agent/lib/consultation-runner.ts');
const {loadAppBroker}=await import('../agent/lib/app-broker-config.ts');
const {readAttempts}=await import('../agent/lib/provider-attempts.ts');
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const policyHash='a'.repeat(64),options={enabled:true,policyHash};
const manager=()=>store.readState().employees[0];
function reset(){process.env.ASSISTANT_AI_ENABLED='true';store.updateState(()=>({employees:[{id:'boss',name:'Тест',role:'manager'},{id:'employee',role:'employee',name:'Тест'}],tasks:[{id:'T1',employeeId:'employee',status:'active',title:'Synthetic task',due:'2030-01-01'}],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));proto.preferences('boss');store.database().exec('DELETE FROM web_assistant_jobs; DELETE FROM web_operations; DELETE FROM web_sessions; DELETE FROM web_invites; DELETE FROM provider_attempts;');}
function job(plan=brokerExecutionPlan(options)){return proto.createAssistantJob({requestId:randomUUID(),taskId:store.readState().tasks[0].id,expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Что делать?'},manager(),true,plan).jobId;}
const reply=role=>({text:JSON.stringify(role==='analyst'?{protocolVersion:2,action:'answer',text:'Предлагаю уточнить ожидаемый результат.',references:[]}:{protocolVersion:2,action:'review',approved:true,reasonCode:'appropriate',reason:'Соответствует фактам карточки.',references:[]}),inputTokens:20,outputTokens:10});
// Initialise journal once before reset.
const {beginAttempt}=await import('../agent/lib/provider-attempts.ts');beginAttempt('fixture-init','analyst',1,'yandex-broker');
after(()=>{store.database().close();rmSync(dir,{recursive:true,force:true});});
test('Broker plan is explicit, fixed and fails closed when disabled',()=>{
 reset();assert.throws(()=>brokerExecutionPlan());assert.throws(()=>brokerExecutionPlan({...options,enabled:false}));
 const plan=brokerExecutionPlan(options);assert.equal(plan.transport,'broker');assert.deepEqual(plan.routes.map(r=>[r.roleId,r.model]),[['analyst','aliceai-llm-flash'],['reviewer','deepseek-v4.1-flash']]);
 process.env.ASSISTANT_AI_ENABLED='false';assert.throws(()=>brokerExecutionPlan(options));
});
test('Real runner keyless broker inputs, stable host identity, two-role evidence pipeline, no direct config or fallback',async()=>{
 reset();const id=job(),before=structuredClone(store.readState()),calls=[];let direct=0;
 const run=createConsultationRunner({complete:async()=>{direct++;throw Error('Direct forbidden');},broker:{...options,complete:async input=>{
   calls.push(input);assert.deepEqual(Object.keys(input).sort(),['hostScope','prompt','signal','system']);assert.equal(input.hostScope.actorId,'boss');assert.equal(input.hostScope.actorRole,'manager');assert.equal(input.hostScope.taskId,'T1');assert.equal(input.hostScope.jobId,id);assert.equal(input.hostScope.ordinal,1);
   assert.equal(input.system,consultationInstructions(input.hostScope.role));assert.match(consultationSystemHash(input.hostScope.role),/^[a-f0-9]{64}$/);assert.equal(JSON.parse(input.prompt).taskContext.contextVersion,input.hostScope.contextVersion);
   return reply(input.hostScope.role);
 }}});await run(id);await run(id);
 assert.equal(direct,0);assert.equal(calls.length,2);assert.notEqual(calls[0].hostScope.requestId,calls[1].hostScope.requestId);
 assert.equal(proto.getJob(id).status,'completed');assert.equal(proto.getJob(id).execution.reviewStatus,'passed');assert.deepEqual(store.readState(),before);
 assert.deepEqual(readAttempts(id).map(a=>a.provider),['yandex-broker','yandex-broker']);
});
test('Broker failure is unknown once; missing opt-in/tampered routes never reach broker or direct keys',async()=>{
 for(const mode of ['unknown','disabled','model','hash']){
  reset();const plan=brokerExecutionPlan(options);if(mode==='model')plan.routes[0].model='attacker';if(mode==='hash')plan.configurationVersion='b'.repeat(64);const id=job(plan);let direct=0,calls=0;
  const run=createConsultationRunner({complete:async()=>{direct++;throw Error('Forbidden');},broker:{...options,enabled:mode!=='disabled',complete:async()=>{calls++;throw Error('private IPC failure');}}});
  await run(id);await run(id);assert.equal(direct,0);assert.equal(calls,mode==='unknown'?1:0);assert.equal(proto.getJob(id).status,'failed');assert.equal(proto.getJob(id).text,undefined);assert.ok(!JSON.stringify(proto.getJob(id)).includes('private IPC'));
  if(mode==='unknown')assert.equal(readAttempts(id)[0].state,'unknown');
 }
});
test('ACL/context revocation after broker response prevents next role/publication but keeps usage',async()=>{
 for(const mode of ['role','context']){
  reset();const id=job();let calls=0;await createConsultationRunner({broker:{...options,complete:async input=>{calls++;store.updateState(s=>{if(mode==='role')s.employees[0].role='employee';else s.tasks[0].summary='New fact';return s;});return reply(input.hostScope.role);}}})(id);
  assert.equal(calls,1);assert.equal(proto.getJob(id).status,'failed');assert.equal(proto.getJob(id).text,undefined);assert.equal(readAttempts(id)[0].inputTokens,20);
 }
});
test('Authenticated HTTP handler uses server-injected plan; body cannot pick broker routes',async()=>{
 reset();const root=process.env.ASSISTANT_SERVER_ORIGIN;const api=(path,body,headers={})=>handleDashboardRequest(new Request(root+'/assistant/api/'+path,{method:body?'POST':'GET',headers:{...headers,...(body?{origin:root,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),{assistantAvailable:true,assistantMode:'roles',brokerMode:true,executionPlan:()=>brokerExecutionPlan(options)});
 const login=await api('login',{code:auth.issueInvite('boss')}),cookie=login.headers.get('set-cookie').split(';')[0];const session=await(await api('session',null,{cookie})).json();const headers={cookie,'x-csrf-token':session.csrf};
 assert.equal((await api('llm-settings',null,headers)).status,403);assert.equal((await api('llm-connection',{provider:'openai'},headers)).status,403);
 const input={requestId:randomUUID(),taskId:'T1',expectedVersion:proto.versionOf(store.readState().tasks[0]),question:'Что делать?'};
 assert.equal((await api('assistant',{...input,transport:'broker',model:'evil'},headers)).status,400);
 const r=await api('assistant',input,headers);assert.equal(r.status,200);const {jobId}=await r.json();assert.equal(proto.getJob(jobId).execution.transport,'broker');
});
test('App config: off reads nothing; on uses only strict private IPC files and no socket in fake factory',()=>{
 let calls=0;assert.equal(loadAppBroker({env:{ASSISTANT_BROKER_CONFIG:'/never/read'},makeCompletion:()=>{calls++;}}),undefined);
 const keyFile=join(dir,'ipc.key'),file=join(dir,'app-broker.json');writeFileSync(keyFile,'01'.repeat(32),{mode:0o600});
 const cfg={version:1,policyHash,socketPath:'/run/pulse-broker/control.sock',expectedOwnerUid:1234,ipcKeyFile:keyFile};writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
 const env={ASSISTANT_AI_ENABLED:'true',ASSISTANT_BROKER_ENABLED:'true',ASSISTANT_BROKER_CONFIG:file};
 const broker=loadAppBroker({env,makeCompletion:o=>{calls++;assert.equal(o.policyHash,policyHash);assert.equal(o.key.length,32);assert.equal(o.timeoutMs,55000);assert.equal(o.socketPath,cfg.socketPath);return async()=>reply('analyst');}});
 assert.equal(calls,1);assert.equal(broker.enabled,true);
 chmodSync(file,0o400);chmodSync(keyFile,0o400);chmodSync(dir,0o500);assert.ok(loadAppBroker({env,makeCompletion:()=>async()=>reply('analyst')}));chmodSync(dir,0o700);chmodSync(file,0o600);chmodSync(keyFile,0o600);env.ASSISTANT_BROKER_ENABLED='false';assert.equal(broker.enabled,false);
 env.ASSISTANT_BROKER_ENABLED='true';chmodSync(keyFile,0o644);assert.throws(()=>loadAppBroker({env}));chmodSync(keyFile,0o600);
 writeFileSync(file,JSON.stringify({...cfg,providerKey:'forbidden'}));assert.throws(()=>loadAppBroker({env}));writeFileSync(file,JSON.stringify(cfg));
 const link=join(dir,'config-link');symlinkSync(file,link);assert.throws(()=>loadAppBroker({env:{...env,ASSISTANT_BROKER_CONFIG:link}}));
});

test('Canonical Cyrillic task ID reaches broker scope unchanged',async()=>{
 reset();store.updateState(s=>{s.tasks[0].id='П-001';return s;});const id=job();let calls=0;await createConsultationRunner({broker:{...options,complete:async input=>{calls++;assert.equal(input.hostScope.taskId,'П-001');return reply(input.hostScope.role);}}})(id);assert.equal(calls,2);assert.equal(proto.getJob(id).status,'completed');
});

test('Broker-only runtime rejects old direct jobs and unknown transport before poisoned credential config',async()=>{
 for(const transport of [undefined,'direct','malicious']){
  reset();const plan={transport,configurationVersion:'c'.repeat(64),routes:[{roleId:'analyst',provider:'openai',model:'old',connectionId:'old-key',connectionLabel:'Old',connectionVersion:'d'.repeat(64),maxOutputTokens:2048}],steps:[]};
  const id=job(plan);let calls=0;await createConsultationRunner({complete:async()=>{calls++;throw Error('direct forbidden');},broker:{...options,complete:async()=>{calls++;throw Error('broker forbidden');}}})(id);
  assert.equal(calls,0);assert.equal(proto.getJob(id).execution.errorCode,'configuration');assert.deepEqual(readAttempts(id),[]);
 }
 reset();const id=job({configurationVersion:'e'.repeat(64),routes:[{roleId:'analyst'}],steps:[]});await createConsultationRunner({brokerOnly:true})(id);assert.equal(proto.getJob(id).execution.errorCode,'configuration');
});
test('Bounded compromised-model regression: foreign source and arbitrary write action fail without disclosure or mutation',async()=>{
 for(const attack of ['foreign-source','write']){
  reset();store.updateState(s=>{s.tasks.push({id:'T2',title:'Other task',employeeId:'boss',status:'active'});s.sources.push({id:'PRIVATE-S2',taskId:'T2',employeeId:'boss',text:'Other task private content',receivedAt:'2026-10-26T00:00:00Z'});return s;});
  const before=structuredClone(store.readState()),id=job();let calls=0;
  const sourceVersion=(await import('../agent/lib/assistant-memory.ts')).sourceVersion(store.readState().sources[0]);
  const run=createConsultationRunner({broker:{...options,complete:async input=>{
   calls++;assert.ok(!input.prompt.includes('PRIVATE-S2'));assert.ok(!input.prompt.includes('Other task private content'));assert.equal(input.hostScope.taskId,'T1');
   const action=attack==='foreign-source'?{protocolVersion:2,action:'read_source',sourceId:'PRIVATE-S2',version:sourceVersion,offset:0,limit:1600}:{protocolVersion:2,action:'task-action',taskId:'T2',operation:'accept'};
   return {text:JSON.stringify(action),inputTokens:20,outputTokens:10};
  }}});
  await run(id);await run(id);assert.equal(calls,1,'No source page, reviewer continuation or repair call after rejection');assert.equal(proto.getJob(id).status,'failed');assert.equal(proto.getJob(id).text,undefined);assert.deepEqual(store.readState(),before);
 }
});
test('In-memory composition (not Unix E2E): real runner → signed IPC → allocated worker → fake Yandex → verified citations',async()=>{
 const {createHash}=await import('node:crypto');
 const {createBrokerAllocationBook,bootstrapBrokerLedger}=await import('../agent/lib/broker-allocation.ts');
 const {signBrokerRequest,brokerPolicyFingerprint}=await import('../agent/lib/broker-core.ts');
 const {createBrokerCompletion,verifyBrokerIpcResponse}=await import('../agent/lib/broker-ipc.ts');
 const {createBrokerWorker}=await import('../agent/lib/broker-worker.ts');
 reset();store.updateState(s=>{s.sources.push({id:'S1',taskId:'T1',employeeId:'employee',text:'Нужны исходные данные.',receivedAt:'2026-10-26T00:00:00Z'});return s;});const before=structuredClone(store.readState());
 const privateDir=mkdtempSync(join(tmpdir(),'app-worker-inmemory-')),key=Buffer.alloc(32,47);
 const policy={version:1,folderId:'synthetic-app-worker',totalMicroRub:20000000,jobMicroRub:20000000,totalCalls:20,jobCalls:8,concurrency:1,timeoutMs:45000,analyst:{inputTokenBound:65536,inputMicroRubPerToken:2,outputMicroRubPerToken:3},reviewer:{inputTokenBound:1048576,inputMicroRubPerToken:4,outputMicroRubPerToken:5},systemHashes:{analyst:consultationSystemHash('analyst'),reviewer:consultationSystemHash('reviewer')}};
 const config={schemaVersion:1,enabled:true,ledgerPath:join(privateDir,'ledger.sqlite'),allocationPath:join(privateDir,'allocation.sqlite'),allocationId:'synthetic-app-allocation',ipcKeyFile:join(privateDir,'unused-ipc-key'),providerCredentialFile:join(privateDir,'unused-provider-key'),policy};
 createBrokerAllocationBook(config.allocationPath,{version:1,aggregateMicroRub:50000000,carryMicroRub:10000000,carryEvidenceSha256:'a'.repeat(64)});bootstrapBrokerLedger({path:config.allocationPath,allocationId:config.allocationId,ledgerPath:config.ledgerPath,policy,key});
 let worker,calls=0;try{
  worker=createBrokerWorker({config,ipcKey:key,providerCredential:{type:'api_key',value:'synthetic-worker-only-key'},fetchImpl:async(_url,init)=>{
   calls++;const body=JSON.parse(init.body),payload=JSON.parse(body.messages[1].content),source=payload.taskContext.sources[0],reviewer=body.model.endsWith('/deepseek-v4.1-flash');
   assert.equal(payload.taskContext.taskId,'T1');assert.equal(source.sourceId,'S1');const references=[{kind:'source',id:source.sourceId,version:source.version,quote:source.preview}];
   const action=reviewer?{protocolVersion:2,action:'review',approved:true,reasonCode:'appropriate',reason:'Основание подтверждено.',references}:{protocolVersion:2,action:'answer',text:'Предлагаю запросить исходные данные.',references};
   return new Response(JSON.stringify({model:`gpt://${body.model.split('/').at(-1)}/latest`,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(action)}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));
  }});
  const complete=createBrokerCompletion(async request=>{
   assert.equal(request.policyHash,brokerPolicyFingerprint(policy));
   const envelope=signBrokerRequest(request,key),response=await worker.handler(Buffer.from(JSON.stringify(envelope))),head=Buffer.alloc(4);head.writeUInt32BE(response.length);
   return verifyBrokerIpcResponse(Buffer.concat([head,response]),{requestId:request.requestId,requestHash:createHash('sha256').update(envelope.payload).digest('hex'),deadlineMs:request.deadlineMs},key);
  },brokerPolicyFingerprint(policy));
  const broker={enabled:true,policyHash:brokerPolicyFingerprint(policy),complete},id=job(brokerExecutionPlan(broker));await createConsultationRunner({broker})(id);
  assert.equal(calls,2);assert.equal(proto.getJob(id).status,'completed');assert.equal(proto.getJob(id).execution.reviewStatus,'passed');assert.equal(proto.getJob(id).references[0].sourceId,'S1');assert.equal(proto.getJob(id).references[0].quote,'Нужны исходные данные.');assert.equal(worker.snapshot().attempts.length,2);assert.deepEqual(store.readState(),before);
  assert.ok(!JSON.stringify(proto.getJob(id)).includes('synthetic-worker-only-key'));
 }finally{worker?.close();rmSync(privateDir,{recursive:true,force:true});}
});

test('Broker disable or policy drift after either role withholds output and prevents further dispatch',async()=>{
 for(const changed of ['disabled','policy'])for(const afterRole of ['analyst','reviewer']){
  reset();const id=job();let enabled=true,currentHash=policyHash,calls=0;
  const broker={get enabled(){return enabled;},get policyHash(){return currentHash;},complete:async input=>{
   calls++;if(input.hostScope.role===afterRole){if(changed==='disabled')enabled=false;else currentHash='f'.repeat(64);}return reply(input.hostScope.role);
  }};
  await createConsultationRunner({broker})(id);
  assert.equal(calls,afterRole==='analyst'?1:2);assert.equal(proto.getJob(id).status,'failed');assert.equal(proto.getJob(id).text,undefined);
  assert.equal(readAttempts(id).length,calls);assert.ok(readAttempts(id).every(row=>row.state==='response_received'&&row.inputTokens===20));
 }
});
