/** Explicit local IPC seam. No provider credentials/configuration or auto-enable. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createConnection} from 'node:net';
import {z} from 'zod';
import {signBrokerRequest,type BrokerRequest,type createBrokerCore} from './broker-core.ts';
import type {Readable,Writable} from 'node:stream';
export const IPC_REQUEST_MAX=131072,IPC_RESPONSE_MAX=65536;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receipt=z.object({requestId:z.string().min(1).max(200),state:z.enum(['reserved','received','unknown']),reservedMicroRub:integer,chargedMicroRub:integer,inputTokens:integer.nullable(),outputTokens:integer.nullable()}).strict();
const result=z.object({text:z.string().min(1).max(24000),inputTokens:integer.min(1),outputTokens:integer.min(1).max(2048)}).strict();
const responseSchema=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),requestHash:hex,receipt,result}).strict(),
 z.object({ok:z.literal(false),requestHash:hex,code:z.enum(['unavailable','duplicate'])}).strict(),
]);
const signedSchema=z.object({payload:z.string().max(IPC_RESPONSE_MAX),mac:hex}).strict();
export class BrokerIpcError extends Error{constructor(){super('Broker IPC outcome unavailable; do not retry automatically.');}}
function keyCheck(key:Uint8Array){if(!(key instanceof Uint8Array)||key.byteLength<32||key.byteLength>128)throw new BrokerIpcError();}
function frame(body:Buffer,max:number){if(body.length<1||body.length>max)throw new BrokerIpcError();const head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);}
function signResponse(body:unknown,key:Uint8Array){const payload=JSON.stringify(body);return Buffer.from(JSON.stringify({payload,mac:createHmac('sha256',key).update('broker-response-v1\n'+payload).digest('hex')}));}
/** Server-side pipe handler. Key/core come only from a trusted launcher, never IPC. */
export function createBrokerFrameHandler(core:ReturnType<typeof createBrokerCore>,key:Uint8Array){
 keyCheck(key);
 return async(bytes:Buffer)=>{
  let requestHash='0'.repeat(64);let answer:unknown;
  try{if(bytes.length>IPC_REQUEST_MAX)throw new BrokerIpcError();const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(typeof envelope?.payload==='string')requestHash=hash(envelope.payload);
   const r=await core.complete(envelope);answer=r.duplicate?{ok:false,requestHash,code:'duplicate'}:{ok:true,requestHash,receipt:r.receipt,result:r.result};
  }catch{answer={ok:false,requestHash,code:'unavailable'};}
  let signed=signResponse(answer,key);
  if(signed.length>IPC_RESPONSE_MAX)signed=signResponse({ok:false,requestHash,code:'unavailable'},key);
  return signed;
 };
}
/** Persistent serial pipe protocol; only a trusted peer-gate process owns these pipes. */
export async function runBrokerWorker(handler:(b:Buffer)=>Promise<Buffer>,input:Readable,output:Writable){
 let buffer=Buffer.alloc(0);
 try{for await(const part of input){const chunk=Buffer.from(part);if(buffer.length+chunk.length>IPC_REQUEST_MAX+4)throw new BrokerIpcError();buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=4){const size=buffer.readUInt32BE();if(size<1||size>IPC_REQUEST_MAX)throw new BrokerIpcError();if(buffer.length<size+4)break;const body=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);
    const answer=frame(await handler(body),IPC_RESPONSE_MAX);await new Promise<void>((ok,no)=>output.write(answer,e=>e?no(e):ok()));}
  }if(buffer.length)throw new BrokerIpcError();
 }catch{input.destroy();output.destroy();throw new BrokerIpcError();}
}
/** Pure response verifier; used by the socket client and socket-free adversarial tests. */
export function verifyBrokerIpcResponse(bytes:Buffer,expected:{requestId:string;requestHash:string;deadlineMs:number},key:Uint8Array){
 try{keyCheck(key);
   if(bytes.length<4||bytes.readUInt32BE()!==bytes.length-4||bytes.length-4>IPC_RESPONSE_MAX)throw new BrokerIpcError();
   const signed=signedSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(4))));
   const mac=createHmac('sha256',key).update('broker-response-v1\n'+signed.payload).digest();if(!timingSafeEqual(mac,Buffer.from(signed.mac,'hex')))throw new BrokerIpcError();
   const reply=responseSchema.parse(JSON.parse(signed.payload));if(reply.requestHash!==expected.requestHash||!reply.ok||reply.receipt.requestId!==expected.requestId||reply.receipt.state!=='received'||reply.receipt.inputTokens!==reply.result.inputTokens||reply.receipt.outputTokens!==reply.result.outputTokens||!reply.result.text.trim()||Buffer.byteLength(reply.result.text)>24000||Date.now()>=expected.deadlineMs)throw new BrokerIpcError();
   return {text:reply.result.text,inputTokens:reply.result.inputTokens,outputTokens:reply.result.outputTokens};
 }catch{throw new BrokerIpcError();}
}
export function createBrokerIpcClient(options:{socketPath:string;expectedOwnerUid:number;key:Uint8Array;timeoutMs:number}){
 keyCheck(options.key);if(!Number.isSafeInteger(options.expectedOwnerUid)||options.expectedOwnerUid<0||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>125000)throw new BrokerIpcError();
 const key=Buffer.from(options.key),path=resolve(options.socketPath);
 return async(request:BrokerRequest,signal?:AbortSignal)=>{
  try{
   if(signal?.aborted||Date.now()>=request.deadlineMs)throw new BrokerIpcError();const parent=dirname(path),d=lstatSync(parent),s=lstatSync(path);
   if(realpathSync(parent)!==parent||!d.isDirectory()||d.uid!==options.expectedOwnerUid||![0o700,0o750].includes(d.mode&0o777)||!s.isSocket()||s.isSymbolicLink()||s.uid!==options.expectedOwnerUid||![0o600,0o660].includes(s.mode&0o777))throw new BrokerIpcError();
   const envelope=signBrokerRequest(request,key),body=frame(Buffer.from(JSON.stringify(envelope)),IPC_REQUEST_MAX),requestHash=hash(envelope.payload);
   const bytes=await new Promise<Buffer>((ok,no)=>{
    const socket=createConnection({path,allowHalfOpen:true});let chunks:Buffer[]=[],length=0,done=false;
    const finish=(error?:boolean)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();if(error)no(new BrokerIpcError());else ok(Buffer.concat(chunks));};
    const abort=()=>finish(true),timer=setTimeout(abort,Math.min(options.timeoutMs,Math.max(1,request.deadlineMs-Date.now())));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    socket.on('connect',()=>{if(!done)socket.end(body);});socket.on('error',abort);socket.on('data',chunk=>{length+=chunk.length;if(length>IPC_RESPONSE_MAX+4)return abort();chunks.push(chunk);});socket.on('end',()=>finish());socket.on('close',()=>{if(!done)abort();});
   });
   return verifyBrokerIpcResponse(bytes,{requestId:request.requestId,requestHash,deadlineMs:request.deadlineMs},key);
  }catch{throw new BrokerIpcError();}
 };
}

/** Optional server-owned injection only; never serialize ModelRequest.key/connection. */
export function createBrokerCompletion(client:ReturnType<typeof createBrokerIpcClient>,policyHash?:string):import('./consultation-runner.ts').BrokerCompletion {
 if(policyHash!==undefined&&!/^[a-f0-9]{64}$/.test(policyHash))throw new BrokerIpcError();
 return async input=>{
  const scope=input.hostScope;if(scope.role!=='analyst'&&scope.role!=='reviewer')throw new BrokerIpcError();
  const issuedAtMs=Date.now();
  return client({protocol:1,...(policyHash===undefined?{}:{policyHash}),requestId:scope.requestId,jobId:scope.jobId,actorId:scope.actorId,actorRole:scope.actorRole,taskId:scope.taskId,taskVersion:scope.taskVersion,contextVersion:scope.contextVersion,role:scope.role,ordinal:scope.ordinal,issuedAtMs,deadlineMs:issuedAtMs+60000,system:input.system,prompt:input.prompt},input.signal);
 };
}
