/** Explicit operator-only bootstrap, never invoked by server/worker startup.
 * Input contains no credentials. Key file contents are loaded only for explicit ledger creation. */
import {readFileSync,lstatSync,realpathSync,openSync,closeSync,constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {z} from 'zod';
import {createBrokerAllocationBook,bootstrapBrokerLedger} from '../agent/lib/broker-allocation.ts';
function readPrivate(path){
 const absolute=resolve(path),parent=dirname(absolute),d=lstatSync(parent),s=lstatSync(absolute);
 if(realpathSync(parent)!==parent||!d.isDirectory()||d.uid!==process.getuid()||![0o500,0o700].includes(d.mode&0o777)||!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||![0o400,0o600].includes(s.mode&0o777)||s.size>32768)throw Error();
 const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{return readFileSync(fd,'utf8');}finally{closeSync(fd);}
}
try{
 const [command,configPath,...extra]=process.argv.slice(2);if(extra.length||!configPath)throw Error();
 const config=JSON.parse(readPrivate(configPath));
 if(command==='create-book'){
  const c=z.object({path:z.string().min(1),book:z.unknown()}).strict().parse(config);createBrokerAllocationBook(c.path,c.book);
 }else if(command==='allocate-ledger'){
  const c=z.object({path:z.string().min(1),allocationId:z.string().min(1),ledgerPath:z.string().min(1),policy:z.unknown(),ipcKeyFile:z.string().min(1)}).strict().parse(config);
  const text=readPrivate(c.ipcKeyFile).trim();if(!/^[a-f0-9]{64}$/.test(text))throw Error();const key=Buffer.from(text,'hex');
  try{bootstrapBrokerLedger({path:c.path,allocationId:c.allocationId,ledgerPath:c.ledgerPath,policy:c.policy,key});}finally{key.fill(0);}
 }else throw Error();
 process.stdout.write('Broker bootstrap completed.\n');
}catch{process.stderr.write('Broker bootstrap refused; inspect local allocation state before any further operator action.\n');process.exitCode=1;}
