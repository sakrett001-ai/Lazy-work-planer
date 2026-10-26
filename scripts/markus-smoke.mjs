#!/usr/bin/env node
// Does not start a worker, provision secrets, reset a ledger or contact a provider directly.
import {runSyntheticSmoke} from './lib/markus-smoke.mjs';
const values=new Map();let enabled=false,valid=true;
for(const arg of process.argv.slice(2)){
 if(arg==='--run-synthetic-smoke'&&!enabled){enabled=true;continue;}
 const match=/^--(root|broker-config|policy-sha256)=(.+)$/.exec(arg);
 if(!match||values.has(match[1])){valid=false;break;}values.set(match[1],match[2]);
}
if(!enabled||!valid||values.size!==3){console.error('Requires --run-synthetic-smoke --root=NEW_ABSOLUTE_PATH --broker-config=PRIVATE_APP_CONFIG --policy-sha256=APPROVED_HASH');process.exitCode=2;}
else{
 const stop=new AbortController();const interrupt=()=>stop.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
 try{
  const receipt=await runSyntheticSmoke({root:values.get('root'),brokerConfig:values.get('broker-config'),policyHash:values.get('policy-sha256'),signal:stop.signal});
  console.log(JSON.stringify(receipt));process.exitCode=receipt.stopped==='completed'?0:1;
 }catch{console.error('Smoke stopped; dispatch or charge outcome may be unknown. Reconcile ledger before any further run.');process.exitCode=1;}
 finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
