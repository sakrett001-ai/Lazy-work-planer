import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createBrokerAllocationBook,bootstrapBrokerLedger} from '../agent/lib/broker-allocation.ts';
import {signBrokerRequest,brokerPolicyFingerprint} from '../agent/lib/broker-core.ts';
import {verifyBrokerIpcResponse} from '../agent/lib/broker-ipc.ts';
import {createBrokerWorker,loadBrokerWorker,readBrokerWorkerConfig,BrokerWorkerStartupError} from '../agent/lib/broker-worker.ts';
import {consultationInstructions,consultationSystemHash} from '../agent/lib/consultation-runner.ts';
const key=Buffer.alloc(32,41),credential={type:'api_key',value:'synthetic-provider-secret'};
const startup=e=>e instanceof BrokerWorkerStartupError&&!String(e).includes(credential.value);
const policy=()=>({version:1,folderId:'synthetic-worker-folder',totalMicroRub:20000000,jobMicroRub:20000000,totalCalls:20,jobCalls:8,concurrency:1,timeoutMs:45000,analyst:{inputTokenBound:65536,inputMicroRubPerToken:2,outputMicroRubPerToken:3},reviewer:{inputTokenBound:1048576,inputMicroRubPerToken:4,outputMicroRubPerToken:5},systemHashes:{analyst:consultationSystemHash('analyst'),reviewer:consultationSystemHash('reviewer')}});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'broker-worker-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));const config={schemaVersion:1,enabled:true,ledgerPath:join(dir,'ledger.sqlite'),allocationPath:join(dir,'allocation.sqlite'),allocationId:'synthetic-allocation',ipcKeyFile:join(dir,'ipc-key'),providerCredentialFile:join(dir,'provider-credential'),policy:policy()};createBrokerAllocationBook(config.allocationPath,{version:1,aggregateMicroRub:50000000,carryMicroRub:10000000,carryEvidenceSha256:'a'.repeat(64)});bootstrapBrokerLedger({path:config.allocationPath,allocationId:config.allocationId,ledgerPath:config.ledgerPath,policy:config.policy,key});const configPath=join(dir,'worker.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});writeFileSync(config.ipcKeyFile,key.toString('hex'),{mode:0o600});writeFileSync(config.providerCredentialFile,JSON.stringify(credential),{mode:0o600});return {dir,configPath,config};}
function request(role='analyst',extra={}){const now=Date.now();return {protocol:1,policyHash:brokerPolicyFingerprint(policy()),requestId:'request-'+role,jobId:'job',actorId:'manager',actorRole:'manager',taskId:'task',taskVersion:'b'.repeat(64),contextVersion:'c'.repeat(64),role,ordinal:1,issuedAtMs:now,deadlineMs:now+60000,system:consultationInstructions(role),prompt:'Synthetic context',...extra};}
function response(body,over={}){const name=body.model.split('/').at(-1);return new Response(JSON.stringify({model:`gpt://${name}/latest`,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'SYNTHETIC RESPONSE'}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},...over}));}
function framed(bytes){const head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);return Buffer.concat([head,bytes]);}
async function call(worker,r,k=key){const envelope=signBrokerRequest(r,k);const bytes=await worker.handler(Buffer.from(JSON.stringify(envelope)));return {envelope,bytes,reply:JSON.parse(JSON.parse(bytes).payload)};}
test('real worker composition: allocation→existing ledger→fixed Yandex fake fetch→authenticated response',async t=>{
 const f=setup(t),seen=[];const worker=loadBrokerWorker(f.configPath,{fetchImpl:async(url,init)=>{seen.push({url,init});return response(JSON.parse(init.body));}});t.after(()=>worker.close());
 for(const role of ['analyst','reviewer']){const r=request(role),out=await call(worker,r);assert.equal(out.reply.ok,true);assert.equal(out.reply.receipt.state,'received');assert.equal(out.reply.result.text,'SYNTHETIC RESPONSE');assert.equal(verifyBrokerIpcResponse(framed(out.bytes),{requestId:r.requestId,requestHash:createHash('sha256').update(out.envelope.payload).digest('hex'),deadlineMs:r.deadlineMs},key).text,'SYNTHETIC RESPONSE');assert.equal(out.bytes.includes(Buffer.from(credential.value)),false);}
 assert.equal(seen.length,2);for(const {url,init} of seen){assert.equal(url,'https://ai.api.cloud.yandex.net/v1/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Api-Key '+credential.value);const b=JSON.parse(init.body);assert.equal(b.max_completion_tokens,2048);assert.deepEqual(b.response_format,{type:'json_object'});assert.equal(b.store,false);assert.equal(b.tools,undefined);}
 assert.deepEqual(seen.map(x=>JSON.parse(x.init.body).model),['gpt://synthetic-worker-folder/aliceai-llm-flash','gpt://synthetic-worker-folder/deepseek-v4.1-flash']);assert.equal(worker.snapshot().attempts.length,2);
});
test('worker rejects allocation, system/model bound, timeout and key mismatch without fetch',async t=>{
 const f=setup(t);let calls=0;const fetchImpl=async()=>{calls++;throw Error('should not fetch');};
 for(const config of [{...f.config,allocationId:'wrong'},{...f.config,policy:{...f.config.policy,timeoutMs:40000}},{...f.config,policy:{...f.config.policy,analyst:{...f.config.policy.analyst,inputTokenBound:10}}},{...f.config,policy:{...f.config.policy,systemHashes:{...f.config.policy.systemHashes,analyst:'d'.repeat(64)}}}])assert.throws(()=>createBrokerWorker({config,ipcKey:key,providerCredential:credential,fetchImpl}),startup);
 assert.throws(()=>createBrokerWorker({config:f.config,ipcKey:Buffer.alloc(31),providerCredential:credential,fetchImpl}),startup);
 const worker=createBrokerWorker({config:f.config,ipcKey:key,providerCredential:credential,fetchImpl});t.after(()=>worker.close());const wrong=await call(worker,request(),Buffer.alloc(32,42));assert.equal(wrong.reply.ok,false);assert.equal(worker.snapshot().attempts.length,0);assert.equal(calls,0);
});
test('disabled startup does not read secret/ledger files or construct default network transport',t=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-disabled-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'disabled.json');writeFileSync(path,JSON.stringify({schemaVersion:1,enabled:false}),{mode:0o600});assert.deepEqual(loadBrokerWorker(path),{enabled:false});const worker=spawnSync(process.execPath,['scripts/broker-worker.mjs','--config',path],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000});assert.equal(worker.status,0,worker.stderr);assert.equal(worker.stdout,'');assert.equal(worker.stderr,'BROKER_DISABLED\n');assert.deepEqual(readBrokerWorkerConfig(path),{schemaVersion:1,enabled:false});
 const launcher=spawnSync('python3',['-I','-B','scripts/broker-launcher.py','--config',path],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000});assert.equal(launcher.status,0,launcher.stderr);assert.equal(launcher.stdout,'BROKER_DISABLED\n');
});
test('bounded owner-private config/credential reads accept0400/0500 but reject symlink and group access',t=>{
 const f=setup(t);let calls=0;const fetchImpl=async()=>{calls++;throw Error('unused');};const privateDir=join(f.dir,'readonly');mkdirSync(privateDir,{mode:0o700});const readOnlyConfig=join(privateDir,'disabled.json');writeFileSync(readOnlyConfig,JSON.stringify({schemaVersion:1,enabled:false}),{mode:0o400});chmodSync(privateDir,0o500);try{assert.equal(readBrokerWorkerConfig(readOnlyConfig).enabled,false);}finally{chmodSync(privateDir,0o700);}
 chmodSync(f.configPath,0o400);assert.equal(readBrokerWorkerConfig(f.configPath).enabled,true);chmodSync(f.configPath,0o640);assert.throws(()=>readBrokerWorkerConfig(f.configPath),startup);chmodSync(f.configPath,0o600);
 const link=join(f.dir,'link.json');symlinkSync(f.configPath,link);assert.throws(()=>readBrokerWorkerConfig(link),startup);
 chmodSync(f.config.providerCredentialFile,0o644);assert.throws(()=>loadBrokerWorker(f.configPath,{fetchImpl}),startup);chmodSync(f.config.providerCredentialFile,0o400);chmodSync(f.config.ipcKeyFile,0o400);const w=loadBrokerWorker(f.configPath,{fetchImpl});w.close();assert.equal(calls,0);
});
test('known usage on unusable provider output is projected to held accounting, never answer or retry',async t=>{
 const f=setup(t);let calls=0;const worker=loadBrokerWorker(f.configPath,{fetchImpl:async(_url,init)=>{calls++;const body=JSON.parse(init.body);return response(body,{choices:[{index:0,finish_reason:'length',message:{role:'assistant',content:'partial'}}]});}});t.after(()=>worker.close());const r=request(),first=await call(worker,r);assert.equal(first.reply.ok,false);const a=worker.snapshot().attempts[0];assert.equal(a.state,'unknown');assert.equal(a.inputTokens,10);assert.equal(a.outputTokens,20);assert.equal(a.chargedMicroRub,a.reservedMicroRub);await call(worker,r);assert.equal(calls,1);
});
test('missing ledger never auto-bootstraps and provider credential shape has no ambient fallback',t=>{
 const f=setup(t);let calls=0;const fetchImpl=async()=>{calls++;throw Error('unused');};const missing=join(f.dir,'missing.sqlite');assert.throws(()=>createBrokerWorker({config:{...f.config,ledgerPath:missing},ipcKey:key,providerCredential:credential,fetchImpl}),startup);assert.equal(existsSync(missing),false);
 assert.throws(()=>createBrokerWorker({config:f.config,ipcKey:key,providerCredential:{type:'iam',value:'synthetic-token'},fetchImpl}),startup);assert.throws(()=>createBrokerWorker({config:f.config,ipcKey:key,providerCredential:credential}),startup);assert.equal(calls,0);
});

test('production worker requires exact signed policy hash before reservation or fetch',async t=>{
 const f=setup(t);let calls=0;const worker=loadBrokerWorker(f.configPath,{fetchImpl:async()=>{calls++;throw Error('must not fetch');}});t.after(()=>worker.close());
 for(const r of [request('analyst',{policyHash:undefined}),request('analyst',{policyHash:'f'.repeat(64)})]){const out=await call(worker,r);assert.equal(out.reply.ok,false);}
 assert.equal(calls,0);assert.equal(worker.snapshot().attempts.length,0);
});

test('operator FIFO config is rejected without blocking by both explicit CLIs',t=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-fifo-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'not-a-regular-config');
 const make=spawnSync('python3',['-I','-c','import os,sys; os.mkfifo(sys.argv[1],0o600)',path],{encoding:'utf8',timeout:2000});assert.equal(make.status,0,make.stderr);
 for(const [command,args] of [[process.execPath,['scripts/broker-worker.mjs','--config',path]],['python3',['-I','-B','scripts/broker-launcher.py','--config',path]]]){
  const r=spawnSync(command,args,{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:2000});assert.equal(r.signal,null);assert.equal(r.status,1,r.stderr);assert.equal(r.stdout,'');assert.equal(r.stderr,'BROKER_UNAVAILABLE\n');
 }
});
