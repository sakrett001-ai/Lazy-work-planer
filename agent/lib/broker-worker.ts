/** Explicit operator-started worker composition. No import-time reads or default fetch.
 * API credentials never enter app configuration, IPC, logging, or stored job data. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {z} from 'zod';
import {brokerPolicyFingerprint,createBrokerCore,type BrokerPolicy} from './broker-core.ts';
import {verifyBrokerAllocation} from './broker-allocation.ts';
import {createBrokerFrameHandler} from './broker-ipc.ts';
import {createYandexContract,YandexContractError} from './yandex-contract.ts';
import {consultationSystemHash} from './consultation-runner.ts';

export const BROKER_WORKER_LIMITS=Object.freeze({adapterMs:40000,coreMs:45000,peerMs:50000,clientMs:55000,requestMs:60000,outputTokens:2048});
export const BROKER_MODEL_CONTEXT=Object.freeze({analyst:65536 as const,reviewer:1048576 as const});
export class BrokerWorkerStartupError extends Error {constructor(){super('Broker worker configuration unavailable.');}}
const absolute=z.string().min(1).max(4096).refine(p=>resolve(p)===p&&!p.includes('\0'));
const policy=z.custom<BrokerPolicy>(value=>{try{brokerPolicyFingerprint(value);return true;}catch{return false;}});
const enabledSchema=z.object({schemaVersion:z.literal(1),enabled:z.literal(true),ledgerPath:absolute,
 allocationPath:absolute,allocationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),ipcKeyFile:absolute,
 providerCredentialFile:absolute,policy}).strict();
const configSchema=z.discriminatedUnion('enabled',[
 z.object({schemaVersion:z.literal(1),enabled:z.literal(false)}).strict(),enabledSchema,
]);
export type BrokerWorkerConfig=z.infer<typeof configSchema>;
export type EnabledBrokerWorkerConfig=z.infer<typeof enabledSchema>;
const credentialSchema=z.object({type:z.literal('api_key'),value:z.string().regex(/^[A-Za-z0-9_.-]{8,256}$/)}).strict();
export type BrokerProviderCredential=z.infer<typeof credentialSchema>;

/** Only dedicated broker-owned0500/0700 parent and0400/0600 regular files. No ambient lookup.
 * Same-UID control of trusted paths/processes is outside this filesystem boundary. */
function privateBytes(path:string,max:number){
 let fd:number|undefined;
 try{
  if(resolve(path)!==path)throw new BrokerWorkerStartupError();const parent=dirname(path),dir=lstatSync(parent);
  if(realpathSync(parent)!==parent||!dir.isDirectory()||![0o500,0o700].includes(dir.mode&0o777)||dir.uid!==process.getuid?.())throw new BrokerWorkerStartupError();
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const st=fstatSync(fd);
  if(!st.isFile()||![0o400,0o600].includes(st.mode&0o777)||st.uid!==process.getuid?.()||st.size<1||st.size>max)throw new BrokerWorkerStartupError();
  const value=readFileSync(fd);if(value.length!==st.size||value.length>max)throw new BrokerWorkerStartupError();return value;
 }catch{throw new BrokerWorkerStartupError();}finally{if(fd!==undefined)closeSync(fd);}
}
function checkedConfig(value:unknown):BrokerWorkerConfig{
 try{
  const config=configSchema.parse(value);if(!config.enabled)return config;
  if(config.policy.timeoutMs!==BROKER_WORKER_LIMITS.coreMs||config.policy.concurrency!==1)throw new BrokerWorkerStartupError();
  for(const role of ['analyst','reviewer'] as const){
   if(config.policy[role].inputTokenBound!==BROKER_MODEL_CONTEXT[role]||config.policy.systemHashes[role]!==consultationSystemHash(role))throw new BrokerWorkerStartupError();
  }
  if(new Set([config.ledgerPath,config.allocationPath,config.ipcKeyFile,config.providerCredentialFile]).size!==4)throw new BrokerWorkerStartupError();
  return config;
 }catch{throw new BrokerWorkerStartupError();}
}
function allocation(config:EnabledBrokerWorkerConfig){
 try{return verifyBrokerAllocation({path:config.allocationPath,allocationId:config.allocationId,ledgerPath:config.ledgerPath,policy:config.policy});}
 catch{throw new BrokerWorkerStartupError();}
}
export function readBrokerWorkerConfig(path:string):BrokerWorkerConfig{
 try{return checkedConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(privateBytes(path,32768))));}
 catch{throw new BrokerWorkerStartupError();}
}
/** Injected composition used by tests and explicit CLI loader. Opens existing ledger only. */
export function createBrokerWorker(options:{config:EnabledBrokerWorkerConfig;ipcKey:Uint8Array;providerCredential:BrokerProviderCredential;fetchImpl:typeof fetch}){
 let core:ReturnType<typeof createBrokerCore>|undefined;
 let key:Buffer=Buffer.alloc(0);
 try{
  key=Buffer.from(options.ipcKey);
  const config=checkedConfig(options.config);if(!config.enabled||typeof options.fetchImpl!=='function'||key.byteLength!==32)throw new BrokerWorkerStartupError();
  allocation(config);const credential=credentialSchema.parse(options.providerCredential);
  const names={analyst:'aliceai-llm-flash',reviewer:'deepseek-v4.1-flash'} as const;
  const adapters=new Map<string,{expected:string;complete:ReturnType<typeof createYandexContract>}>();
  for(const role of ['analyst','reviewer'] as const){
   const model=`gpt://${config.policy.folderId}/${names[role]}`,expected=`gpt://${names[role]}/latest`;
   adapters.set(model,{expected,complete:createYandexContract({fetchImpl:options.fetchImpl,apiKey:credential.value,model,expectedResponseModel:expected,maxCompletionTokens:2048,maxContextTokens:BROKER_MODEL_CONTEXT[role],timeoutMs:40000})});
  }
  core=createBrokerCore({path:config.ledgerPath,create:false,requirePolicyHash:true,key,policy:config.policy,dispatch:async request=>{
   const adapter=adapters.get(request.model);
   if(!adapter||adapter.expected!==request.expectedResponseModel||request.maxOutputTokens!==2048)throw new BrokerWorkerStartupError();
   try{return await adapter.complete({system:request.system,prompt:request.prompt,signal:request.signal});}
   catch(error){
    // Only this trusted adapter class may contribute observed usage; never forward raw errors.
    const usage=error instanceof YandexContractError?error.observedUsage:undefined;
    if(usage&&Number.isSafeInteger(usage.inputTokens)&&usage.inputTokens>0&&Number.isSafeInteger(usage.outputTokens)&&usage.outputTokens>0)
     return {text:'',inputTokens:usage.inputTokens,outputTokens:usage.outputTokens};
    throw new BrokerWorkerStartupError();
   }
  }});
  const handler=createBrokerFrameHandler(core,key),owned=core;
  return {enabled:true as const,handler,snapshot:()=>owned.snapshot(),close(){owned.close();key.fill(0);adapters.clear();}};
 }catch{if(core)core.close();key.fill(0);throw new BrokerWorkerStartupError();}
}
/** The only file-loading entrypoint; disabled config returns before allocation/secrets/ledger. */
export function loadBrokerWorker(path:string,options:{fetchImpl?:typeof fetch}={}){
 const config=readBrokerWorkerConfig(path);if(!config.enabled)return {enabled:false as const};
 allocation(config);let key:Buffer|undefined;
 try{
  const text=new TextDecoder('utf-8',{fatal:true}).decode(privateBytes(config.ipcKeyFile,128)).trim();if(!/^[a-f0-9]{64}$/.test(text))throw new BrokerWorkerStartupError();key=Buffer.from(text,'hex');
  const providerCredential=credentialSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(privateBytes(config.providerCredentialFile,1024))));
  if(typeof options.fetchImpl!=='function')throw new BrokerWorkerStartupError();
  return createBrokerWorker({config,ipcKey:key,providerCredential,fetchImpl:options.fetchImpl});
 }catch{throw new BrokerWorkerStartupError();}finally{key?.fill(0);}
}
