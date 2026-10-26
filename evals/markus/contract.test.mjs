import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {validateSuite,requestHash} from './harness.mjs';
const load=p=>JSON.parse(readFileSync(new URL('./scenarios/'+p+'.json',import.meta.url),'utf8'));
function run(args,input){const dir=mkdtempSync(join(tmpdir(),'markus-eval-test-'));try{const child=spawnSync(process.execPath,['evals/markus/run.mjs',...args,'--output='+join(dir,'log.jsonl')],{cwd:new URL('../..',import.meta.url),encoding:'utf8',input,timeout:20000});return {status:child.status,stderr:child.stderr,manifest: (()=>{try{return JSON.parse(readFileSync(join(dir,'log.jsonl'),'utf8').split('\n')[0]);}catch{return null;}})(),lines:child.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))};}finally{rmSync(dir,{recursive:true,force:true});}}
test('12 frozen synthetic scenarios, 36 turns, disjoint split IDs and explicit capability gaps',()=>{
 const ids=new Set();let turns=0,gaps=0;
 for(const p of ['baseline','calibration','holdout'])for(const s of validateSuite(load(p),p)){assert.ok(!ids.has(s.id));ids.add(s.id);turns+=s.turns.length;if(s.capabilityStatus==='gap')gaps++;}
 assert.equal(ids.size,12);assert.equal(turns,36);assert.ok(gaps>0);assert.ok(gaps<12);
});
test('actual runner offline protocol run is explicitly not model quality or deployed chat memory',()=>{
 const r=run(['--partition=baseline']);assert.equal(r.status,0,r.stderr);const s=r.lines.at(-1);
 assert.equal(s.backend,'contract_stub');assert.equal(s.qualityVerdict,'not_scored');assert.ok(s.calls>0);
 for(const t of s.records){if(t.status==='capability_gap')continue;assert.equal(t.status,'completed');assert.equal(t.domainUnchanged,true);assert.equal(t.historyMode,'task_sources_only_no_prior_assistant_turns');assert.match(t.text,/CONTRACT STUB/);assert.equal(t.reviewStatus,'passed');}
});
test('global per-run call cap stops before another completion and cannot publish half-reviewed answer',()=>{
 const r=run(['--partition=baseline','--max-calls=1']);assert.equal(r.status,0,r.stderr);const s=r.lines.at(-1);
 assert.equal(s.calls,1);assert.equal(s.stopped,'total_call_cap');assert.equal(s.records.at(-1).status,'failed');assert.equal(s.records.at(-1).text,null);
});
test('stdio seam emits actual prompts but missing admission/mismatched reply stops as unknown without replay',()=>{
 const r=run(['--partition=baseline','--mode=stdio','--model=gpt://fictional/test','--response-model=gpt://test/latest'],JSON.stringify({sequence:1,requestHash:'wrong',result:{text:'bad'}})+'\n');assert.equal(r.status,0,r.stderr);
 assert.equal(r.lines.filter(x=>x.kind==='provider_request').length,1);const s=r.lines.at(-1);assert.equal(s.calls,1);assert.equal(s.stopped,'transport_unknown_or_blocked');assert.equal(s.records.at(-1).text,null);
});
test('holdout external evaluation requires an explicit frozen candidate marker',()=>{
 const r=run(['--partition=holdout','--mode=stdio'],'');assert.notEqual(r.status,0);assert.match(r.stderr,/frozen candidate/);
});
test('request hash binds actual policy, payload and configured target marker',()=>{
 const a={system:'fixed host policy',prompt:'synthetic data',model:'eval-target'};
 assert.notEqual(requestHash(a),requestHash({...a,prompt:'changed'}));assert.notEqual(requestHash(a),requestHash({...a,system:'changed'}));
});

test('manifest records actual immutable policy/runner/fixture hashes and run caps',()=>{
 const r=run(['--partition=baseline']);assert.equal(r.status,0,r.stderr);
 for(const key of ['policyHash','runnerHash','scenarioHash','harnessHash','driverHash'])assert.match(r.manifest[key],/^[a-f0-9]{64}$/);
 assert.match(r.manifest.runtimeCommit,/^[a-f0-9]{40}$/);assert.equal(r.manifest.maxCalls,24);assert.equal(r.manifest.targetModel,'eval-target');
});
test('an open stdin without receipt times out as unknown and exits without replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'markus-eval-open-'));let child;
 try{
  child=spawn(process.execPath,['evals/markus/run.mjs','--partition=baseline','--mode=stdio','--model=gpt://fictional/test','--response-model=gpt://test/latest','--receipt-timeout-ms=20','--output='+join(dir,'log.jsonl')],{cwd:new URL('../..',import.meta.url),stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill(),3000);let result;try{result=await once(child,'exit');}finally{clearTimeout(timer);}
  assert.equal(result[0],0,stderr);const lines=stdout.trim().split('\n').map(x=>JSON.parse(x));assert.equal(lines.filter(x=>x.kind==='provider_request').length,1);
  assert.equal(lines.at(-1).stopped,'transport_unknown_or_blocked');assert.equal(lines.at(-1).calls,1);
 }finally{child?.stdin.destroy();rmSync(dir,{recursive:true,force:true});}
});

test('small baseline selector runs only the recorded scenario; unknown selection is refused',()=>{
 const r=run(['--partition=baseline','--scenario=B02']);assert.equal(r.status,0,r.stderr);const s=r.lines.at(-1);
 assert.equal(s.calls,6);assert.deepEqual(r.manifest.selectedScenarioIds,['B02']);assert.ok(s.records.every(x=>x.id==='B02'));
 const bad=run(['--partition=baseline','--scenario=missing']);assert.notEqual(bad.status,0);assert.match(bad.stderr,/Unknown scenario/);
});
test('hybrid routes actual analyst/reviewer models independently and binds max2048',()=>{
 const script=`import fs from 'node:fs';import assert from 'node:assert/strict';import {runTaskScenarios,contractStub} from './evals/markus/harness.mjs';const scenarios=JSON.parse(fs.readFileSync('evals/markus/scenarios/baseline.json')).filter(s=>s.id==='B02');const seen=[];const result=await runTaskScenarios(scenarios,{backend:'contract_stub',targetModel:'eval-author',reviewerModel:'eval-critic',maxOutputTokens:2048,maxCalls:34,complete:request=>{assert.equal(request.model,request.role==='reviewer'?'eval-critic':'eval-author');assert.equal(request.maxOutputTokens,2048);seen.push(request.role);return contractStub(request);}});assert.equal(result.calls,6);assert.equal(seen.filter(r=>r==='reviewer').length,3);console.log('hybrid pass');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../..',import.meta.url),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/hybrid pass/);
});
test('hybrid stdio refuses missing critic response identity before any call',()=>{
 const r=run(['--partition=baseline','--mode=stdio','--model=author','--response-model=author-alias','--reviewer-model=critic'],'');assert.notEqual(r.status,0);assert.match(r.stderr,/Reviewer response alias required/);
});
test('receipt deadline accepts bounded300s only; runtime job deadline remains unchanged',()=>{const r=run(['--partition=baseline','--receipt-timeout-ms=300000']);assert.equal(r.status,0,r.stderr);assert.equal(r.manifest.receiptTimeoutMs,300000);assert.notEqual(run(['--receipt-timeout-ms=300001']).status,0);});
for(const check of [{name:'length with complete-looking JSON',finishReason:'length',usable:false,outputTokens:2048,text:'complete',expected:'transport_known_unusable'},{name:'content-filter empty zero output',finishReason:'content_filter',usable:false,outputTokens:0,text:'',expected:'transport_known_unusable'},{name:'explicit refusal empty zero output',finishReason:'stop',refused:true,usable:false,outputTokens:0,text:'',expected:'transport_known_unusable'},{name:'conflicting refused positive response is blocked',finishReason:'stop',refused:true,usable:true,outputTokens:100,text:'complete',expected:'transport_known_unusable'},{name:'usable zero output is invalid',finishReason:'stop',usable:true,outputTokens:0,text:'',expected:'transport_unknown_or_blocked'}])test('receipt gate: '+check.name,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'markus-eval-length-'));let child;
 try{child=spawn(process.execPath,['evals/markus/run.mjs','--partition=baseline','--scenario=B02','--mode=stdio','--model=eval-author','--response-model=author-alias','--max-output-tokens=2048','--output='+join(dir,'log.jsonl')],{cwd:new URL('../..',import.meta.url),stdio:['pipe','pipe','pipe']});let stdout='',stderr='',sent=false;child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{stdout+=b;if(sent||!stdout.includes('\n'))return;const q=JSON.parse(stdout.split('\n')[0]);if(q.kind!=='provider_request')return;sent=true;child.stdin.write(JSON.stringify({sequence:q.sequence,requestHash:q.requestHash,reservationId:'synthetic-known-length',provider:'yandex',model:'author-alias',finishReason:check.finishReason,refused:check.refused,usable:check.usable,result:{text:check.text?JSON.stringify({protocolVersion:2,action:'answer',text:'Should never publish',references:[]}):'',inputTokens:100,outputTokens:check.outputTokens}})+'\n');});const timer=setTimeout(()=>child.kill(),5000);let result;try{result=await once(child,'exit');}finally{clearTimeout(timer);}assert.equal(result[0],0,stderr);const summary=JSON.parse(stdout.trim().split('\n').at(-1));assert.equal(summary.calls,1);assert.equal(summary.stopped,check.expected);assert.equal(summary.records.at(-1).text,null);
 }finally{child?.stdin.destroy();rmSync(dir,{recursive:true,force:true});}
});
test('fresh validation has four bounded one-turn cases and a genuine pre-job manager decision',()=>{
 const s=validateSuite(load('validation'),'validation');assert.equal(s.length,4);assert.ok(s.every(x=>x.turns.length===1));assert.equal(s.filter(x=>x.setupManagerAcceptanceAt).length,1);
 const r=run(['--partition=validation','--max-calls=17']);assert.equal(r.status,0,r.stderr);const summary=r.lines.at(-1);assert.equal(summary.calls,8);assert.equal(summary.records.length,4);assert.ok(summary.records.every(x=>x.status==='completed'&&x.domainUnchanged&&!x.publicReviewExposed));assert.equal(summary.qualityVerdict,'not_scored');
 const bad=structuredClone(s);bad[0].setupManagerAcceptanceAt='2026-11-24T01:00:00.000Z';assert.throws(()=>validateSuite(bad,'validation'));
});
test('validation analyst sees real structured acceptance only after fixture manager action',()=>{
 const script=`import fs from 'node:fs';import assert from 'node:assert/strict';import {runTaskScenarios,contractStub} from './evals/markus/harness.mjs';const scenarios=JSON.parse(fs.readFileSync('evals/markus/scenarios/validation.json'));let accepted=false;await runTaskScenarios(scenarios,{backend:'contract_stub',maxCalls:17,complete:r=>{const c=JSON.parse(r.prompt).taskContext;if(r.scenarioId==='V04'){assert.equal(c.current.status,'done');assert.equal(c.evidenceState.recordedAcceptance.actorId,'eval-manager');accepted=true;}else assert.equal(c.evidenceState.recordedAcceptance,null);return contractStub(r);}});assert.equal(accepted,true);`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../..',import.meta.url),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);
});
test('two fresh confirmation cases freeze role inference and explicit decision setup within cap10',()=>{
 const cases=validateSuite(load('confirmation'),'confirmation');assert.equal(cases.length,2);assert.ok(cases.every(s=>s.turns.length===1));assert.ok(!cases[0].turns[0].question.includes('Я руководитель'));
 const r=run(['--partition=confirmation','--max-calls=10','--max-output-tokens=2048','--receipt-timeout-ms=300000']);assert.equal(r.status,0,r.stderr);const summary=r.lines.at(-1);assert.equal(summary.calls,4);assert.equal(summary.records.length,2);assert.equal(r.manifest.maxCalls,10);assert.ok(summary.records.every(x=>x.domainUnchanged&&!x.publicReviewExposed));assert.equal(summary.qualityVerdict,'not_scored');
 const absent=run(['--partition=confirmation','--mode=stdio'],'');assert.notEqual(absent.status,0);assert.match(absent.stderr,/frozen candidate/);
});
test('paired comparison freezes three fresh cases, real acceptance and both declared routes',()=>{
 const cases=validateSuite(load('paired'),'paired');assert.equal(cases.length,3);assert.ok(cases.every(s=>s.turns.length===1));assert.equal(cases.filter(s=>s.setupManagerAcceptanceAt).length,1);
 for(const route of ['flash-deepseek','deepseek-deepseek']){const r=run(['--partition=paired','--eval-route='+route,'--max-calls=24','--max-output-tokens=2048']);assert.equal(r.status,0,r.stderr);assert.equal(r.manifest.evalRoute,route);const s=r.lines.at(-1);assert.equal(s.calls,6);assert.ok(s.records.every(x=>x.domainUnchanged&&!x.publicReviewExposed));assert.equal(s.qualityVerdict,'not_scored');}
});
