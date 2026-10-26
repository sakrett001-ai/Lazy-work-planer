// Socket-free contract tests. Real Unix E2E is a separate explicitly blocked test.
import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';import {createHash,createHmac} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {createBrokerFrameHandler,runBrokerWorker,createBrokerCompletion,verifyBrokerIpcResponse,IPC_RESPONSE_MAX} from '../agent/lib/broker-ipc.ts';
const key=Buffer.alloc(32,23),hash=s=>createHash('sha256').update(s).digest('hex');
const req={protocol:1,requestId:'r1',jobId:'j1',actorId:'a1',actorRole:'manager',taskId:'t1',taskVersion:'a'.repeat(64),contextVersion:'b'.repeat(64),role:'analyst',ordinal:1,issuedAtMs:Date.now(),deadlineMs:Date.now()+10000,system:'synthetic',prompt:'synthetic'};
const envelope={payload:JSON.stringify(req),mac:'0'.repeat(64)};
const receipt={requestId:'r1',state:'received',reservedMicroRub:100,chargedMicroRub:30,inputTokens:10,outputTokens:20};
const decode=b=>{const e=JSON.parse(b.toString());assert.equal(e.mac,createHmac('sha256',key).update('broker-response-v1\n'+e.payload).digest('hex'));return JSON.parse(e.payload);};
test('worker response is signed and request-bound; duplicates and errors cannot be answers',async()=>{
 const core={complete:async()=>({duplicate:false,receipt,result:{text:'fixture',inputTokens:10,outputTokens:20}})};let reply=decode(await createBrokerFrameHandler(core,key)(Buffer.from(JSON.stringify(envelope))));assert.equal(reply.requestHash,hash(envelope.payload));assert.equal(reply.ok,true);assert.equal(reply.receipt.requestId,'r1');
 reply=decode(await createBrokerFrameHandler({complete:async()=>({duplicate:true,receipt})},key)(Buffer.from(JSON.stringify(envelope))));assert.deepEqual(reply,{ok:false,requestHash:hash(envelope.payload),code:'duplicate'});
 reply=decode(await createBrokerFrameHandler({complete:async()=>{throw Error('PRIVATE HEADER');}},key)(Buffer.from(JSON.stringify(envelope))));assert.equal(reply.code,'unavailable');assert.equal(JSON.stringify(reply).includes('PRIVATE'),false);
});
test('total serialized response bound includes JSON escaping, invalid UTF8 and malformed input remain sanitized',async()=>{
 const core={complete:async()=>({duplicate:false,receipt,result:{text:'\u0000'.repeat(24000),inputTokens:10,outputTokens:20}})};const handler=createBrokerFrameHandler(core,key);const b=await handler(Buffer.from(JSON.stringify(envelope)));assert.ok(b.length<=IPC_RESPONSE_MAX);assert.equal(decode(b).ok,false);assert.equal(decode(await handler(Buffer.from([0xff]))).code,'unavailable');
});
test('stdio worker handles fragmented bounded frame; oversized/truncated header fails closed',async()=>{
 const input=new PassThrough(),output=new PassThrough();const chunks=[];output.on('data',b=>chunks.push(b));const run=runBrokerWorker(async()=>Buffer.from('{"fixture":true}'),input,output);const b=Buffer.from('{}'),header=Buffer.alloc(4);header.writeUInt32BE(b.length);input.write(header.subarray(0,2));input.write(header.subarray(2));input.end(b);await run;const got=Buffer.concat(chunks);assert.equal(got.readUInt32BE(),got.length-4);assert.deepEqual(JSON.parse(got.subarray(4)),{fixture:true});
 for(const bytes of [Buffer.from([0,0]),Buffer.from([0,2,0,1])]){const a=new PassThrough(),z=new PassThrough();const p=runBrokerWorker(async()=>Buffer.from('{}'),a,z);a.end(bytes);await assert.rejects(p,/unavailable/);}
});
test('app injection allowlists host scope and never serializes synthetic credential or connection',async()=>{
 let sent,signal;const completion=createBrokerCompletion(async(r,s)=>{sent=r;signal=s;return {text:'fixture',inputTokens:10,outputTokens:20};});const controller=new AbortController();await completion({hostScope:{requestId:'r1',jobId:'j1',actorId:'a1',actorRole:'manager',taskId:'t1',taskVersion:'a'.repeat(64),contextVersion:'b'.repeat(64),role:'analyst',ordinal:1},system:'synthetic',prompt:'synthetic',key:'PRIVATE-CREDENTIAL',connection:{label:'PRIVATE-LABEL'},model:'ignored',signal:controller.signal});assert.equal(sent.actorId,'a1');assert.equal(sent.role,'analyst');assert.equal(signal,controller.signal);assert.ok(!JSON.stringify(sent).includes('PRIVATE'));assert.deepEqual(Object.keys(sent).sort(),Object.keys(req).sort());
});
test('actual consultation runner derives scope from authenticated job rather than document content (no sockets)',()=>{
 const r=spawnSync(process.execPath,['tests/fixtures/broker-ipc-e2e.mjs','--capture-only'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/HOST_SCOPE_CAPTURE_PASS/);
});

test('pure client verifier rejects wrong MAC/request/receipt, duplicate, trailing and extra fields',()=>{
 const expected={requestId:'r1',requestHash:hash(envelope.payload),deadlineMs:Date.now()+10000};
 const encode=body=>{const payload=JSON.stringify(body),signed=Buffer.from(JSON.stringify({payload,mac:createHmac('sha256',key).update('broker-response-v1\n'+payload).digest('hex')})),h=Buffer.alloc(4);h.writeUInt32BE(signed.length);return Buffer.concat([h,signed]);};
 const body={ok:true,requestHash:expected.requestHash,receipt,result:{text:'fixture',inputTokens:10,outputTokens:20}},valid=encode(body);assert.equal(verifyBrokerIpcResponse(valid,expected,key).text,'fixture');
 for(const bad of [{...body,requestHash:'c'.repeat(64)},{...body,receipt:{...receipt,requestId:'other'}},{...body,receipt:{...receipt,inputTokens:11}},{...body,result:{...body.result,privateDebug:'x'}},{ok:false,requestHash:expected.requestHash,code:'duplicate'}])assert.throws(()=>verifyBrokerIpcResponse(encode(bad),expected,key),/unavailable/);
 assert.throws(()=>verifyBrokerIpcResponse(valid,expected,Buffer.alloc(32,24)),/unavailable/);assert.throws(()=>verifyBrokerIpcResponse(Buffer.concat([valid,valid]),expected,key),/unavailable/);assert.throws(()=>verifyBrokerIpcResponse(valid,{...expected,deadlineMs:1},key),/unavailable/);
});
