/** Finite synthetic smoke. Importable test seam; CLI always uses the real IPC client. */
import {mkdirSync,lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const LIMITS=Object.freeze({jobs:2,totalCalls:20,jobCalls:8,roleCalls:4,deadlineMs:600000});
const employee={id:'smoke-employee',role:'employee',name:'Вымышленный исполнитель'};
const manager={id:'smoke-manager',role:'manager',name:'Вымышленный руководитель'};
export const SCENARIOS=Object.freeze([
 {id:'synthetic-status',title:'Вымышленная проверка макета',status:'active',text:'Макет подготовлен исполнителем. Проверка руководителем ещё не проводилась.',question:'Каков текущий статус? Отдели сообщение исполнителя о готовности от приёмки руководителем.',accept:false},
 {id:'synthetic-acceptance',title:'Вымышленная проверка памятки',status:'review',text:'Исполнитель подготовил памятку и передал её на проверку.',question:'Принят ли результат руководителем? Укажи основание: сообщение исполнителя или записанное решение.',accept:true}
].map(s=>Object.freeze(s)));
export const fixtureHash=createHash('sha256').update(JSON.stringify(SCENARIOS)).digest('hex');
let used=false;
function newRoot(root){
 if(!isAbsolute(root)||resolve(root)!==root)throw Error('Invalid smoke root');
 const parent=dirname(root),stat=lstatSync(parent),uid=process.getuid?.();
 if(uid===undefined||realpathSync(parent)!==parent||!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o777)!==0o700)throw Error('Private owned smoke parent required');
 mkdirSync(root,{mode:0o700}); // exclusive: any existing file/directory is refused, never resumed/deleted
}
function deadlineCall(complete,input,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('Smoke interrupted; outcome may be unknown'));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return complete({...input,signal});}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
/** One call per fresh process. brokerFactory is test injection, never a CLI option. */
export async function runSyntheticSmoke({root,brokerConfig,policyHash,signal,brokerFactory,deadlineMs=LIMITS.deadlineMs}={}){
 if(used)throw Error('Smoke cannot restart in this process');used=true;
 if(!/^[a-f0-9]{64}$/.test(policyHash||''))throw Error('Explicit frozen broker policy hash required');
 if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>LIMITS.deadlineMs)throw Error('Invalid bounded deadline');
 signal?.throwIfAborted();newRoot(root);process.umask(0o077);
 const env={ASSISTANT_DATA_DIR:join(root,'app'),ASSISTANT_SERVER_ORIGIN:'https://synthetic-smoke.invalid',ASSISTANT_AI_ENABLED:'true',ASSISTANT_BROKER_ENABLED:'true',ASSISTANT_DELIVERY_ENABLED:'false',ASSISTANT_BROKER_CONFIG:brokerConfig,ASSISTANT_LLM_CONFIG:join(root,'DIRECT-PROVIDER-FORBIDDEN.json')};
 Object.assign(process.env,env);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);
 const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 let store,owned=false;const receipt={version:1,fixtureHash,scope:'synthetic_only',qualityVerdict:'not_scored',limits:LIMITS,appDispatchAttempts:0,counterScope:'bounded_client_attempts_not_provider_admissions_or_charges',roles:{analyst:0,reviewer:0},records:[],stopped:'not_started',accounting:'broker_ledger_authoritative_no_refunds_or_replay'};
 const persist=()=>writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 try{
  const {loadAppBroker}=await import('../../agent/lib/app-broker-config.ts');
  const actual=brokerFactory?await brokerFactory(env):loadAppBroker({env});
  if(!actual?.enabled||actual.policyHash!==policyHash||typeof actual.complete!=='function')throw Error('Frozen broker configuration mismatch');
  store=await import('../../agent/lib/store.ts');
  const file=store.database().prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
  if(file!==join(root,'app','assistant.sqlite'))throw Error('Pre-existing store singleton refused');owned=true;
  const proto=await import('../../agent/lib/prototype.ts');const {brokerExecutionPlan}=await import('../../agent/lib/llm-config.ts');
  const {createConsultationRunner}=await import('../../agent/lib/consultation-runner.ts');const {readAttempts}=await import('../../agent/lib/provider-attempts.ts');const {decide}=await import('../../dist/domain.js');
  const jobs=new Map();
  const broker={get enabled(){return actual.enabled&&!combined.aborted;},get policyHash(){return actual.policyHash;},complete:async input=>{
   combined.throwIfAborted();const {jobId,role,ordinal}=input.hostScope,entry=jobs.get(jobId);
   if(!entry||!['analyst','reviewer'].includes(role)||ordinal!==entry[role]+1||ordinal>LIMITS.roleCalls||entry.calls>=LIMITS.jobCalls||receipt.appDispatchAttempts>=LIMITS.totalCalls)throw Error('Finite smoke admission stop');
   entry.calls++;entry[role]++;receipt.appDispatchAttempts++;receipt.roles[role]++;persist();
   return deadlineCall(actual.complete,input,AbortSignal.any([combined,input.signal]));
  }};
  for(const scenario of SCENARIOS){
   if(combined.aborted){receipt.stopped='interrupted';break;}
   store.updateState(()=>({employees:[manager,employee],tasks:[{id:scenario.id,employeeId:employee.id,title:scenario.title,status:scenario.status,due:'2031-01-02'}],sources:[{id:scenario.id+'-source',taskId:scenario.id,employeeId:employee.id,text:scenario.text,receivedAt:'2031-01-01T12:00:00.000Z'}],events:[],settings:{timezone:'UTC',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
   if(scenario.accept)store.updateState(s=>decide(s,scenario.id,'accept',manager,'2031-01-01T13:00:00.000Z'));
   const before=structuredClone(store.readState());
   const id=proto.createAssistantJob({requestId:randomUUID(),taskId:scenario.id,expectedVersion:proto.versionOf(before.tasks[0]),question:scenario.question},manager,true,brokerExecutionPlan(broker)).jobId;
   jobs.set(id,{calls:0,analyst:0,reviewer:0});await createConsultationRunner({broker,brokerOnly:true})(id);
   const job=proto.getJob(id),attempts=readAttempts(id),domainUnchanged=JSON.stringify(before)===JSON.stringify(store.readState());
   const publicJob=proto.assistantJobs(manager,scenario.id).find(j=>j.id===id);
   const evidenceSatisfied=scenario.accept?Boolean(job.decisionReferences?.length):Boolean(job.references?.length)&&!job.decisionReferences?.length;
   const contractPassed=job.status==='completed'&&job.execution?.reviewStatus==='passed'&&evidenceSatisfied&&domainUnchanged&&!combined.aborted;
   receipt.records.push({scenario:scenario.id,status:job.status,reviewStatus:job.execution?.reviewStatus||'not_run',domainUnchanged,evidenceSatisfied,contractPassed,attempts:attempts.map(a=>({role:a.roleId,state:a.state,inputTokens:a.inputTokens??null,outputTokens:a.outputTokens??null}))});
   assert.equal(publicJob?.execution?.review,undefined);persist();
   if(!contractPassed){receipt.stopped=combined.aborted?'interrupted':attempts.some(a=>a.state!=='response_received')?'unknown_or_blocked':'failed_validation';break;}
  }
  if(receipt.records.length===2&&receipt.records.every(r=>r.contractPassed))receipt.stopped='completed';
 }catch{
  receipt.stopped=combined.aborted?'interrupted':'setup_or_execution_failed';
 }finally{
  clearTimeout(timer);env.ASSISTANT_AI_ENABLED='false';env.ASSISTANT_BROKER_ENABLED='false';process.env.ASSISTANT_AI_ENABLED='false';process.env.ASSISTANT_BROKER_ENABLED='false';
  if(owned)store.database().close();persist();
 }
 return receipt;
}
