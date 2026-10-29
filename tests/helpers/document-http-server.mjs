// Synthetic test subprocess only. No provider, worker, or external delivery.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readState, updateState } from '../../agent/lib/store.ts';
import { issueInvite } from '../../agent/lib/web-auth.ts';
import { handleDashboardRequest } from '../../agent/lib/dashboard-api.ts';
if(!readState().employees.length) updateState(s=>({...s,employees:['manager','owner','curator','coexecutor','outsider'].map(id=>({id,name:id,role:id==='manager'?'manager':'employee'})),tasks:[{id:'synthetic-task',employeeId:'owner',title:'Synthetic request',status:'active'}]}));
const server=createServer(async(req,res)=>{const origin=process.env.ASSISTANT_SERVER_ORIGIN;const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const response=await handleDashboardRequest(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));});
server.listen(0,'127.0.0.1',()=>{process.env.ASSISTANT_SERVER_ORIGIN=`http://127.0.0.1:${server.address().port}`;console.log(JSON.stringify({origin:process.env.ASSISTANT_SERVER_ORIGIN,codes:Object.fromEntries(readState().employees.map(p=>[p.id,issueInvite(p.id)]))}));});
