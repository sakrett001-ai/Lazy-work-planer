/** Server-only opt-in. App reads IPC authentication, NEVER provider credentials. */
import {openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync,constants} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {createBrokerIpcClient,createBrokerCompletion} from './broker-ipc.ts';
import type {RunnerBroker,BrokerCompletion} from './consultation-runner.ts';
const schema=z.object({version:z.literal(1),policyHash:z.string().regex(/^[a-f0-9]{64}$/),socketPath:z.string().min(1).max(400),expectedOwnerUid:z.number().int().min(0).max(2147483647),ipcKeyFile:z.string().min(1).max(400)}).strict();
function privateFile(path:string,max:number){
 if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)throw Error('Unsafe file');
 const uid=process.getuid?.();if(uid===undefined)throw Error('POSIX required');
 const parent=dirname(path),dir=lstatSync(parent);
 if(realpathSync(parent)!==parent||!dir.isDirectory()||dir.uid!==uid||![0o500,0o700].includes(dir.mode&0o777))throw Error('Unsafe directory');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==uid||![0o400,0o600].includes(s.mode&0o777)||s.size<1||s.size>max)throw Error('Unsafe file');const data=readFileSync(fd);if(data.length>max)throw Error('File grew');return new TextDecoder('utf-8',{fatal:true}).decode(data);}finally{closeSync(fd);}
}
export type AppBrokerClientOptions = {policyHash:string;socketPath:string;expectedOwnerUid:number;key:Uint8Array;timeoutMs:number};
export function loadAppBroker({env=process.env,makeCompletion=(options:AppBrokerClientOptions)=>createBrokerCompletion(createBrokerIpcClient(options),options.policyHash)}:{env?:NodeJS.ProcessEnv;makeCompletion?:(options:AppBrokerClientOptions)=>BrokerCompletion}={}):RunnerBroker|undefined {
 // Neither config nor IPC key is read until both explicit server gates are on.
 if(env.ASSISTANT_BROKER_ENABLED!=='true'||env.ASSISTANT_AI_ENABLED!=='true')return undefined;
 try{
  const config=schema.parse(JSON.parse(privateFile(env.ASSISTANT_BROKER_CONFIG||'',8192)));
  if(!isAbsolute(config.socketPath)||resolve(config.socketPath)!==config.socketPath)throw Error('Invalid socket path');
  const hex=privateFile(config.ipcKeyFile,128).trim();if(!/^[a-f0-9]{64}$/i.test(hex))throw Error('Invalid IPC key');
  const complete=makeCompletion({policyHash:config.policyHash,socketPath:config.socketPath,expectedOwnerUid:config.expectedOwnerUid,key:Buffer.from(hex,'hex'),timeoutMs:55000});
  if(typeof complete!=='function')throw Error('Invalid completion');
  return {get enabled(){return env.ASSISTANT_BROKER_ENABLED==='true'&&env.ASSISTANT_AI_ENABLED==='true';},policyHash:config.policyHash,complete};
 }catch{throw Error('Broker configuration unavailable; direct-provider fallback is forbidden.');}
}
