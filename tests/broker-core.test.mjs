import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createBrokerCore,signBrokerRequest,BrokerError} from '../agent/lib/broker-core.ts';
const hash=s=>createHash('sha256').update(s).digest('hex');
const key=Buffer.alloc(32,19),at=1000000;
const policy=()=>({version:1,folderId:'synthetic-folder',totalMicroRub:1000000,jobMicroRub:100000, totalCalls:100,jobCalls:8,concurrency:1,timeoutMs:1000,analyst:{inputTokenBound:1000,inputMicroRubPerToken:2,outputMicroRubPerToken:3},reviewer:{inputTokenBound:1000,inputMicroRubPerToken:4,outputMicroRubPerToken:5},systemHashes:{analyst:hash('host-author-policy'),reviewer:hash('host-critic-policy')}});
const request=(over={})=>({protocol:1,requestId:'request-1',jobId:'job-1',actorId:'manager',actorRole:'manager',taskId:'task-1',taskVersion:'a'.repeat(64),contextVersion:'b'.repeat(64),role:'analyst',ordinal:1,issuedAtMs:at,deadlineMs:at+100000,system:'host-author-policy',prompt:'SYNTHETIC-PRIVATE-PROMPT',...over});
const good={text:'synthetic reply',inputTokens:10,outputTokens:20};
function fixture(t,over={}){const dir=mkdtempSync(join(tmpdir(),'broker-core-'));chmodSync(dir,0o700);const path=join(dir,'ledger.sqlite');let broker;const options={path,create:true,key,policy:policy(),now:()=>at,dispatch:async()=>good,...over};broker=createBrokerCore(options);t.after(()=>{try{broker.close();}finally{rmSync(dir,{recursive:true,force:true});}});return {dir,path,broker,options};}
const code=expected=>e=>e?.code===expected;
const unsignedRaw=obj=>{const payload=JSON.stringify(obj);return {payload,mac:createHmac('sha256',key).update(payload).digest('hex')};};
test('broker reserves durably before injected dispatch, fixed routes, exact settlement and no plaintext ledger',async t=>{
 let f;const seen=[];f=fixture(t,{dispatch:async input=>{seen.push(input);const db=new DatabaseSync(f.path);try{const r=db.prepare('SELECT * FROM attempts ORDER BY rowid DESC').get();assert.equal(r.state,'reserved');assert.ok(r.charged>=8144);}finally{db.close();}return good;}});
 const a=await f.broker.complete(signBrokerRequest(request(),key));assert.equal(a.result.text,good.text);assert.equal(a.receipt.chargedMicroRub,80);
 await f.broker.complete(signBrokerRequest(request({requestId:'request-2',role:'reviewer',system:'host-critic-policy'}),key));assert.equal(seen[0].model,'gpt://synthetic-folder/aliceai-llm-flash');assert.equal(seen[1].model,'gpt://synthetic-folder/deepseek-v4.1-flash');assert.equal(seen[1].maxOutputTokens,2048);assert.equal(seen[1].expectedResponseModel,'gpt://deepseek-v4.1-flash/latest');
 f.broker.close();const bytes=readFileSync(f.path);for(const text of ['SYNTHETIC-PRIVATE-PROMPT','host-author-policy','synthetic reply'])assert.equal(bytes.includes(Buffer.from(text)),false);
});
test('auth, unknown keys, altered system policy, invalid JSON and Unicode byte overflow dispatch zero',async t=>{
 let calls=0;const f=fixture(t,{dispatch:async()=>{calls++;return good;}});
 const signed=signBrokerRequest(request(),key);await assert.rejects(f.broker.complete({...signed,mac:'0'.repeat(64)}),code('auth'));
 await assert.rejects(f.broker.complete(unsignedRaw({...request(),url:'https://forbidden.invalid'})),code('schema'));
 await assert.rejects(f.broker.complete(signBrokerRequest(request({system:'forged policy'}),key)),code('system_policy'));
 await assert.rejects(f.broker.complete(unsignedRaw({...request(),prompt:'界'.repeat(17000)})),code('request_size'));
 const payload='{';await assert.rejects(f.broker.complete({payload,mac:createHmac('sha256',key).update(payload).digest('hex')}),code('schema'));
 assert.equal(calls,0);assert.equal(f.broker.snapshot().attempts.length,0);
});
test('expired/new requests fail before reserve; exact authenticated completed replay remains metadata-only after expiry',async t=>{
 let clock=at,calls=0;const f=fixture(t,{now:()=>clock,dispatch:async()=>{calls++;return good;}});const signed=signBrokerRequest(request(),key);await f.broker.complete(signed);clock=at+200000;const duplicate=await f.broker.complete(signed);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.result,undefined);assert.equal(calls,1);
 await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'new',jobId:'new'}),key)),code('expired'));assert.equal(f.broker.snapshot().attempts.length,1);
});
test('duplicate simultaneous request dispatches once; ordinal and immutable actor/context binding cannot be bypassed',async t=>{
 let release,calls=0;const f=fixture(t,{dispatch:()=>{calls++;return new Promise(r=>release=r);}});const signed=signBrokerRequest(request(),key);const running=f.broker.complete(signed);await new Promise(r=>setImmediate(r));const dupe=await f.broker.complete(signed);assert.equal(dupe.receipt.state,'reserved');
 await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'new'}),key)),code('ordinal_conflict'));
 await assert.rejects(f.broker.complete(signBrokerRequest(request({actorId:'other'}),key)),code('request_conflict'));
 await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'new2',ordinal:2,contextVersion:'c'.repeat(64)}),key)),code('scope_conflict'));
 assert.equal(calls,1);release(good);await running;
});
test('concurrent separate jobs cannot exceed durable concurrency cap',async t=>{
 let release,calls=0;const f=fixture(t,{dispatch:()=>{calls++;return new Promise(r=>release=r);}});const first=f.broker.complete(signBrokerRequest(request(),key));await new Promise(r=>setImmediate(r));await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'other',jobId:'other'}),key)),code('concurrency'));assert.equal(calls,1);release(good);await first;
});
test('exact monetary boundary admitted once and subsequent reservation must fit including settled cost',async t=>{
 const p=policy();p.totalMicroRub=p.jobMicroRub=8144;const f=fixture(t,{policy:p});await f.broker.complete(signBrokerRequest(request(),key));await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'next',ordinal:2}),key)),code('budget'));assert.equal(f.broker.snapshot().attempts.length,1);
});
test('global and job call limits count durable attempts rather than successful text only',async t=>{
 const p=policy();p.totalCalls=p.jobCalls=1;const f=fixture(t,{policy:p});await f.broker.complete(signBrokerRequest(request(),key));await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'next',jobId:'other'}),key)),code('budget'));
});
test('timeout ignoring AbortSignal holds reserve, halts, and late success cannot settle or release it',async t=>{
 let release;const p=policy();p.timeoutMs=15;const f=fixture(t,{policy:p,dispatch:()=>new Promise(r=>release=r)});const signed=signBrokerRequest(request(),key);await assert.rejects(f.broker.complete(signed),code('unknown'));const before=f.broker.snapshot();assert.equal(before.halted,true);assert.equal(before.attempts[0].state,'unknown');assert.equal(before.attempts[0].chargedMicroRub,8144);release(good);await new Promise(r=>setImmediate(r));assert.deepEqual(f.broker.snapshot(),before);assert.equal((await f.broker.complete(signed)).duplicate,true);await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'next',jobId:'next'}),key)),code('halted'));
});
test('missing/invalid usage and raw dispatcher error are unknown, retained, and sanitized',async t=>{
 for(const dispatch of [async()=>({text:'x',inputTokens:10}),async()=>{throw new Error('PRIVATE CREDENTIAL PAYLOAD');}]){
  const dir=mkdtempSync(join(tmpdir(),'broker-bad-'));chmodSync(dir,0o700);const b=createBrokerCore({path:join(dir,'ledger.sqlite'),create:true,key,policy:policy(),now:()=>at,dispatch});try{await assert.rejects(b.complete(signBrokerRequest(request(),key)),e=>!e.message.includes('PRIVATE')&&['unknown','unverified_reply'].includes(e.code));assert.equal(b.snapshot().attempts[0].chargedMicroRub,8144);}finally{b.close();rmSync(dir,{recursive:true,force:true});}
 }
});
test('usage overrun records known greater charge and latches halt without refund',async t=>{
 const f=fixture(t,{dispatch:async()=>({text:'x',inputTokens:10000,outputTokens:20})});await assert.rejects(f.broker.complete(signBrokerRequest(request(),key)),code('usage_overrun'));const s=f.broker.snapshot();assert.equal(s.halted,true);assert.equal(s.attempts[0].chargedMicroRub,20060);assert.equal(s.attempts[0].state,'unknown');
});
test('reopen preserves completed tombstone and refuses policy cap amendment, missing or existing ledger create',async t=>{
 const f=fixture(t);const signed=signBrokerRequest(request(),key);await f.broker.complete(signed);f.broker.close();let calls=0;const reopened=createBrokerCore({...f.options,create:false,dispatch:async()=>{calls++;return good;}});try{assert.equal((await reopened.complete(signed)).duplicate,true);assert.equal(calls,0);}finally{reopened.close();}
 assert.throws(()=>createBrokerCore({...f.options,create:false,policy:{...f.options.policy,totalCalls:101}}),code('policy_mismatch'));
 assert.throws(()=>createBrokerCore(f.options));const missing=join(f.dir,'missing.sqlite');assert.throws(()=>createBrokerCore({...f.options,path:missing,create:false}));assert.equal(existsSync(missing),false);
 const partial=join(f.dir,'partial.sqlite');writeFileSync(partial,'',{mode:0o600});assert.throws(()=>createBrokerCore({...f.options,path:partial,create:false}));const db=new DatabaseSync(partial);try{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);}finally{db.close();}
});
test('restart with interrupted reservation cannot replay or admit another job; hold retained',async t=>{
 const f=fixture(t);const signed=signBrokerRequest(request(),key);await f.broker.complete(signed);f.broker.close();const db=new DatabaseSync(f.path);db.exec("UPDATE attempts SET state='reserved',charged=reserved,input_tokens=NULL,output_tokens=NULL");db.close();let calls=0;const b=createBrokerCore({...f.options,create:false,dispatch:async()=>{calls++;return good;}});try{assert.equal((await b.complete(signed)).receipt.state,'reserved');await assert.rejects(b.complete(signBrokerRequest(request({requestId:'next',jobId:'next'}),key)),code('restart_unresolved'));assert.equal(calls,0);assert.equal(b.snapshot().attempts[0].chargedMicroRub,8144);}finally{b.close();}
});
test('unsafe pricing arithmetic and nonprivate ledger directory are rejected before ledger creation',t=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-config-'));const path=join(dir,'ledger.sqlite');const p=policy();p.analyst.inputMicroRubPerToken=Number.MAX_SAFE_INTEGER;try{assert.throws(()=>createBrokerCore({path,create:true,key,policy:p,dispatch:async()=>good}),code('money_overflow'));assert.equal(existsSync(path),false);chmodSync(dir,0o755);assert.throws(()=>createBrokerCore({path,create:true,key,policy:policy(),dispatch:async()=>good}),code('private_directory_required'));assert.equal(existsSync(path),false);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('unusable text cannot hide known greater charge or observed usage',async t=>{
 const f=fixture(t,{dispatch:async()=>({text:'',inputTokens:10000,outputTokens:20})});await assert.rejects(f.broker.complete(signBrokerRequest(request(),key)),code('usage_overrun'));const r=f.broker.snapshot().attempts[0];assert.equal(r.chargedMicroRub,20060);assert.equal(r.inputTokens,10000);assert.equal(r.outputTokens,20);
});
test('absolute deadline crossed inside dispatch never publishes or refunds even before timer callback',async t=>{
 let clock=at;const f=fixture(t,{now:()=>clock,dispatch:async()=>{clock=at+100001;return good;}});await assert.rejects(f.broker.complete(signBrokerRequest(request(),key)),code('late_reply'));assert.equal(f.broker.snapshot().attempts[0].state,'unknown');assert.equal(f.broker.snapshot().attempts[0].chargedMicroRub,8144);
});
test('blocked event loop cannot defeat monotonic wall timeout through Promise microtask order',async t=>{
 const p=policy();p.timeoutMs=10;const f=fixture(t,{policy:p,dispatch:async()=>{const end=performance.now()+25;while(performance.now()<end){}return good;}});await assert.rejects(f.broker.complete(signBrokerRequest(request(),key)),code('late_reply'));assert.equal(f.broker.snapshot().attempts[0].chargedMicroRub,8144);
});
test('rejected empty or wrong-policy reopen preserves ledger bytes',async t=>{
 const f=fixture(t);await f.broker.complete(signBrokerRequest(request(),key));f.broker.close();const before=readFileSync(f.path);assert.throws(()=>createBrokerCore({...f.options,create:false,policy:{...f.options.policy,totalCalls:101}}),code('policy_mismatch'));assert.deepEqual(readFileSync(f.path),before);
 const empty=join(f.dir,'empty.sqlite');writeFileSync(empty,'',{mode:0o600});assert.throws(()=>createBrokerCore({...f.options,path:empty,create:false}));assert.equal(readFileSync(empty).length,0);
});

test('only exact reply fields cross boundary and injected BrokerError codes are sanitized',async t=>{
 const f=fixture(t,{dispatch:async()=>({...good,privateDebug:'PRIVATE HEADER'})});const r=await f.broker.complete(signBrokerRequest(request(),key));assert.deepEqual(r.result,good);assert.equal(r.result.privateDebug,undefined);
 const dir=mkdtempSync(join(tmpdir(),'broker-code-'));chmodSync(dir,0o700);const b=createBrokerCore({path:join(dir,'ledger.sqlite'),create:true,key,policy:policy(),now:()=>at,dispatch:async()=>{throw new BrokerError('PRIVATE-CREDENTIAL');}});try{await assert.rejects(b.complete(signBrokerRequest(request(),key)),e=>e.code==='unknown'&&!e.message.includes('PRIVATE'));}finally{b.close();rmSync(dir,{recursive:true,force:true});}
});
test('broker host identities retain Cyrillic exactly and exclude control/path characters',async t=>{
 const f=fixture(t);await f.broker.complete(signBrokerRequest(request({actorId:'руководитель-1',taskId:'П-001'}),key));
 for(const taskId of ['../П-001','П-001\n','П/001'])assert.throws(()=>signBrokerRequest(request({taskId}),key));
 await assert.rejects(f.broker.complete(signBrokerRequest(request({requestId:'next',ordinal:2,actorId:'руководитель-2',taskId:'П-001'}),key)),code('scope_conflict'));
});
test('broker can reserve full DeepSeek context bound without token estimates',async t=>{
 const p=policy();p.totalMicroRub=p.jobMicroRub=10000000;p.reviewer.inputTokenBound=1048576;
 const f=fixture(t,{policy:p,dispatch:async()=>({text:'answer',inputTokens:1046528,outputTokens:2048})});
 const out=await f.broker.complete(signBrokerRequest(request({role:'reviewer',system:'host-critic-policy'}),key));assert.equal(out.receipt.reservedMicroRub,1048576*4+2048*5);assert.equal(out.receipt.state,'received');
});
test('production policy agreement rejects absent or stale signed hash before any reservation',async t=>{
 const {brokerPolicyFingerprint}=await import('../agent/lib/broker-core.ts');let calls=0;const f=fixture(t,{requirePolicyHash:true,dispatch:async()=>{calls++;return good;}});
 for(const policyHash of [undefined,'0'.repeat(64)])await assert.rejects(f.broker.complete(signBrokerRequest(request(policyHash?{policyHash}:{}),key)),code('policy_mismatch'));
 assert.equal(calls,0);assert.equal(f.broker.snapshot().attempts.length,0);
 const out=await f.broker.complete(signBrokerRequest(request({policyHash:brokerPolicyFingerprint(f.options.policy)}),key));assert.equal(out.receipt.state,'received');assert.equal(calls,1);
});
