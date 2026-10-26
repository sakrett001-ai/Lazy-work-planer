import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {runSyntheticSmoke,LIMITS,fixtureHash} from '../../scripts/lib/markus-smoke.mjs';
import {loadAppBroker} from '../../agent/lib/app-broker-config.ts';
const mode=process.argv[2],parent=mkdtempSync(join(tmpdir(),'smoke-test-')),root=join(parent,'run');chmodSync(parent,0o700);
let calls=0;const controller=new AbortController();
try{
 const config=join(parent,'app.json'),key=join(parent,'ipc.key'),policyHash='a'.repeat(64);writeFileSync(key,'ab'.repeat(32),{mode:0o600});writeFileSync(config,JSON.stringify({version:1,policyHash,ipcKeyFile:key,socketPath:join(parent,'unused.sock'),expectedOwnerUid:process.getuid()}),{mode:0o600});
 if(mode==='existing')mkdirSync(root,{mode:0o700});
 if(mode==='unsafe-parent')chmodSync(parent,0o755);
 if(mode==='singleton'){
  process.env.ASSISTANT_DATA_DIR=join(parent,'prior');const store=await import('../../agent/lib/store.ts');store.updateState(s=>({...s,marker:'untouched'}));
 }
 const options={root,brokerConfig:mode==='missing-config'?join(parent,'missing'):config,policyHash:mode==='wrong-policy'?'b'.repeat(64):policyHash,signal:controller.signal,deadlineMs:mode==='deadline'?25:5000,brokerFactory:env=>loadAppBroker({env,makeCompletion:()=>async input=>{
  calls++;assert.deepEqual(Object.keys(input).sort(),['hostScope','prompt','signal','system']);
  if(mode==='unknown')throw Error('SECRET-PROVIDER-ERROR');
  if(mode==='abort-late'){controller.abort();await new Promise(r=>setTimeout(r,20));}
  if(mode==='deadline')await new Promise(r=>setTimeout(r,80));
  const c=JSON.parse(input.prompt).taskContext,s=c.sources[0],references=[{kind:'source',id:s.sourceId,version:s.version,quote:s.preview}];
  if(c.evidenceState.recordedAcceptance){const d=c.evidenceState.recordedAcceptance;references.push({kind:'decision',id:d.decisionId,version:d.version});}
  if(mode==='pages')return {text:JSON.stringify({protocolVersion:2,action:'read_source',sourceId:s.sourceId,version:s.version,offset:0,limit:100}),inputTokens:20,outputTokens:10};
  const result=input.hostScope.role==='analyst'?{protocolVersion:2,action:'answer',text:'SYNTHETIC RAW RESPONSE MUST NOT ENTER RECEIPT',references}:{protocolVersion:2,action:'review',approved:mode!=='reject',reasonCode:mode==='reject'?'unsupported_claim':'appropriate',reason:'SYNTHETIC REVIEW MUST NOT ENTER RECEIPT',references};
  return {text:mode==='malformed'?'private malformed response':JSON.stringify(result),inputTokens:20,outputTokens:10};
 }})};
 if(['existing','unsafe-parent'].includes(mode)){await assert.rejects(runSyntheticSmoke(options));assert.equal(calls,0);}
 else{
  const result=await runSyntheticSmoke(options);assert.equal(result.appDispatchAttempts,calls);assert.equal(result.fixtureHash,fixtureHash);assert.deepEqual(result.limits,LIMITS);
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('RAW RESPONSE'));assert.ok(!JSON.stringify(result).includes('SYNTHETIC REVIEW'));assert.ok(!JSON.stringify(result).includes(parent));
  assert.deepEqual(JSON.parse(readFileSync(join(root,'receipt.json'),'utf8')),result);
  if(mode==='success'){assert.equal(result.stopped,'completed');assert.equal(calls,4);assert.equal(result.records.length,2);assert.ok(result.records.every(r=>r.contractPassed&&r.domainUnchanged));assert.equal(result.records[1].evidenceSatisfied,true);}
  else if(['wrong-policy','missing-config','singleton'].includes(mode)){assert.equal(calls,0);assert.equal(result.records.length,0);assert.equal(result.stopped,'setup_or_execution_failed');if(mode==='singleton'){const store=await import('../../agent/lib/store.ts');assert.equal(store.readState().marker,'untouched');store.database().close();}}
  else{assert.notEqual(result.stopped,'completed');assert.equal(result.records.length,1);assert.equal(result.records[0].contractPassed,false);assert.equal(calls,mode==='pages'?4:mode==='reject'?2:1);}
  if(['unknown','abort-late','deadline'].includes(mode))assert.equal(result.records[0].attempts[0].state,'unknown');
  await assert.rejects(runSyntheticSmoke(options),/restart/);assert.equal(process.env.ASSISTANT_AI_ENABLED,'false');
 }
 console.log('PASS '+mode);
}finally{chmodSync(parent,0o700);rmSync(parent,{recursive:true,force:true});}
