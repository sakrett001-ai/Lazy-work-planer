// Synthetic-only worker fixture. Never imports a network/provider client.
import {readFileSync,appendFileSync} from 'node:fs';
import {createBrokerCore} from '../../agent/lib/broker-core.ts';
import {createBrokerFrameHandler,runBrokerWorker} from '../../agent/lib/broker-ipc.ts';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),key=Buffer.alloc(32,23);
const core=createBrokerCore({path:config.ledger,create:true,key,policy:config.policy,dispatch:async request=>{
 const context=JSON.parse(request.prompt).taskContext;
 const s=context.sources[0],references=s?[{kind:'source',id:s.sourceId,version:s.version,quote:s.preview}]:[];
 return {text:JSON.stringify(request.model.endsWith('/deepseek-v4.1-flash')?{protocolVersion:2,action:'review',approved:true,reasonCode:'appropriate',reason:'Synthetic contract fixture, not semantic evaluation.',references}:{protocolVersion:2,action:'answer',text:'SYNTHETIC IPC CONTRACT OUTPUT',references}),inputTokens:10,outputTokens:20};
}});
const handler=createBrokerFrameHandler(core,key);
try{await runBrokerWorker(async bytes=>{appendFileSync(config.capture,bytes.toString('utf8')+'\n',{mode:0o600});return handler(bytes);},process.stdin,process.stdout);}catch{process.exitCode=1;}finally{core.close();}
