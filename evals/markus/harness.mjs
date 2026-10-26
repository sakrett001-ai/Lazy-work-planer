// Synthetic evaluation harness. Never imports a provider transport or reads keys.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const requestHash = input => createHash('sha256').update(JSON.stringify([input.system,input.prompt,input.model])).digest('hex');
export function validateSuite(scenarios,partition) {
  assert.equal(scenarios.length,partition==='confirmation'?2:partition==='paired'?3:4);const ids=new Set();
  for(const s of scenarios){assert.equal(s.partition,partition);assert.ok(!ids.has(s.id));ids.add(s.id);
    assert.ok(['task_consultation','free_chat_memory'].includes(s.flow));assert.equal(s.capabilityStatus,s.flow==='task_consultation'?'supported':'gap');
    assert.equal(s.turns.length,['validation','confirmation','paired'].includes(partition)?1:3);
    if(s.setupManagerAcceptanceAt!==undefined){assert.ok(['validation','confirmation','paired'].includes(partition));assert.equal(s.task.status,'review');assert.match(s.setupManagerAcceptanceAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);assert.ok(Number.isFinite(Date.parse(s.setupManagerAcceptanceAt)));}assert.ok(s.turns.every(t=>t.question&&t.expected.humanChecks.length));
    assert.ok(s.sources.every(x=>x.taskId===s.task.id));
  }return scenarios;
}
export async function runTaskScenarios(scenarios,{complete,backend,maxCalls=100,targetModel='eval-target',reviewerModel=targetModel,maxOutputTokens=800,onObservation=()=>{}}) {
  if(typeof complete!=='function'||!['contract_stub','external_eval_transport'].includes(backend))throw Error('Explicit injected evaluation transport required');
  if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>100)throw Error('Invalid total call cap');
  if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<256||maxOutputTokens>2048)throw Error('Invalid evaluation output cap');
  const dir=mkdtempSync(join(tmpdir(),'markus-eval-')),file=join(dir,'connections.json');
  // Isolated process only. Never run against a server's imported store singleton.
  process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN='https://markus-eval.invalid';
  process.env.ASSISTANT_AI_ENABLED='true';process.env.ASSISTANT_DELIVERY_ENABLED='false';
  process.env.ASSISTANT_LLM_CONFIG=file;process.env.ASSISTANT_LLM_KEY_EVAL='synthetic-not-a-provider-key';
  writeFileSync(file,JSON.stringify({connections:[{id:'eval',label:'Injected synthetic evaluation',provider:'vsegpt',credentialEnv:'ASSISTANT_LLM_KEY_EVAL',models:[...new Set([targetModel,reviewerModel])],maxOutputTokens}]}));
  const store=await import('../../agent/lib/store.ts'),proto=await import('../../agent/lib/prototype.ts'),cfg=await import('../../agent/lib/llm-config.ts');
  const {createConsultationRunner}=await import('../../agent/lib/consultation-runner.ts');
  const boundFile=store.database().prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
  if(boundFile!==join(dir,'assistant.sqlite'))throw Error('Refusing a pre-existing/non-evaluation store singleton');
  const records=[];let calls=0;
  try {
    for(const scenario of scenarios){
      if(scenario.flow!=='task_consultation'){records.push({id:scenario.id,status:'capability_gap',reason:'Free-chat history is not implemented in the deployed task runner; no model calls made.'});continue;}
      const actor={id:'eval-manager',name:'Синтетический руководитель',role:'manager'};
      store.updateState(()=>({employees:[actor,{id:scenario.task.employeeId,name:'Синтетический исполнитель',role:'employee'}],tasks:[structuredClone(scenario.task)],sources:structuredClone(scenario.sources),events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
      if(scenario.setupManagerAcceptanceAt){
        assert.ok(['validation','confirmation','paired'].includes(scenario.partition),'Manager fixture setup is bounded validation-only');
        const {decide}=await import('../../dist/domain.js');
        store.updateState(s=>decide(s,scenario.task.id,'accept',actor,scenario.setupManagerAcceptanceAt));
        onObservation({kind:'synthetic_fixture_setup',scenarioId:scenario.id,action:'accept',actorId:actor.id,at:scenario.setupManagerAcceptanceAt,scope:'explicit synthetic manager setup before consultation, not model action'});
      }
      const off={enabled:false,connectionId:null,model:null},on={enabled:true,connectionId:'eval',model:targetModel};
      cfg.saveRoleSettings({requestId:randomUUID(),expectedVersion:cfg.roleSettings(actor).version,roles:{coordinator:off,analyst:on,reviewer:{...on,model:reviewerModel}}},actor);
      for(const turn of scenario.turns){
        if(turn.addSources)store.updateState(s=>{s.sources.push(...structuredClone(turn.addSources));return s;});
        const before=structuredClone(store.readState()),id=proto.createAssistantJob({requestId:randomUUID(),taskId:scenario.task.id,expectedVersion:proto.versionOf(before.tasks[0]),question:turn.question},actor,true,cfg.executionPlan()).jobId;
        const trace=[];let externalFailure;
        await createConsultationRunner({complete:async input=>{
          if(calls>=maxCalls){externalFailure='total_call_cap';throw Error('Evaluation total call cap');}
          const payload=JSON.parse(input.prompt);assert.equal(payload.taskContext.taskId,scenario.task.id);
          assert.equal(Object.hasOwn(payload,'history'),false,'Current task runner must not silently acquire conversational memory');
          const request={sequence:++calls,scenarioId:scenario.id,turnId:turn.id,role:input.system.includes('Ты проверяющий.')?'reviewer':'analyst',system:input.system,prompt:input.prompt,model:input.model,maxOutputTokens,backend};
          assert.equal(request.model,request.role==='reviewer'?reviewerModel:targetModel,'Actual runner role routing mismatch');
          request.requestHash=requestHash(request);trace.push({sequence:request.sequence,role:request.role,requestHash:request.requestHash});
          onObservation({kind:'request',...request});
          try {const result=await complete(request,{signal:input.signal});onObservation({kind:'response',sequence:request.sequence,requestHash:request.requestHash,result});return result;}
          catch(error){externalFailure=error?.knownUnusable===true?'transport_known_unusable':'transport_unknown_or_blocked';onObservation({kind:error?.knownUnusable===true?'known_unusable':'unknown',sequence:request.sequence,requestHash:request.requestHash});throw error;}
        }})(id);
        const job=proto.getJob(id);assert.deepEqual(store.readState(),before,'Consultation must not mutate task/source/decision state');
        const publicJob=proto.assistantJobs(actor,scenario.task.id).find(j=>j.id===id);
        assert.equal(publicJob?.execution?.review,undefined,'Raw reviewer prose must not escape public projection');
        const record={id:scenario.id,turnId:turn.id,backend,status:job.status,text:job.text||null,errorCode:job.execution?.errorCode||null,reviewStatus:job.execution?.reviewStatus||null,references:job.references||[],decisionReferences:job.decisionReferences||[],trace,domainUnchanged:true,qualityVerdict:'not_scored',publicError:publicJob?.error||null,publicReviewExposed:Boolean(publicJob?.execution?.review),historyMode:'task_sources_only_no_prior_assistant_turns'};
        records.push(record);onObservation({kind:'turn',...record});
        if(externalFailure)return {backend,calls,records,stopped:externalFailure,qualityVerdict:'not_scored'};
      }
    }
    return {backend,calls,records,qualityVerdict:'not_scored'};
  } finally {store.database().close();rmSync(dir,{recursive:true,force:true});}
}
export function contractStub(request){
 const context=JSON.parse(request.prompt).taskContext;
 const references=context.sources.length?[{kind:'source',id:context.sources[0].sourceId,version:context.sources[0].version,quote:context.sources[0].preview}]:[];
 return {text:JSON.stringify(request.role==='reviewer'?{protocolVersion:2,action:'review',approved:true,reasonCode:'appropriate',reason:'CONTRACT STUB: no semantic judgment was performed.',references}:{protocolVersion:2,action:'answer',text:'CONTRACT STUB — not a Markus/model response; only protocol plumbing is tested.',references}),inputTokens:0,outputTokens:0};
}
