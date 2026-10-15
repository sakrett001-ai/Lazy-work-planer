import { defineChannel, GET, POST } from 'eve/channels';
import { handleDashboardRequest } from '../lib/dashboard-api.ts';
import { readState } from '../lib/store';
import { matchesSecret } from '../lib/telegram';
import { buildBrief } from '../../dist/domain.js';
export default defineChannel({routes:[
  ...['/assistant/workspace','/assistant/pilot.html','/assistant/pilot.js','/assistant/pilot.css','/assistant/icons.js','/assistant/api/session','/assistant/api/tasks','/assistant/api/memory'].map(path => GET(path, handleDashboardRequest)),
  ...['/assistant/api/login','/assistant/api/logout','/assistant/api/report','/assistant/api/decision'].map(path => POST(path, handleDashboardRequest)),
  GET('/assistant/state',async req=>{
  if(!matchesSecret(req.headers.get('authorization')?.replace(/^Bearer /,'')||null,process.env.ASSISTANT_ADMIN_TOKEN))return new Response('Unauthorized',{status:401});
  const state=readState();return Response.json({state,brief:buildBrief(state,new Date().toISOString())},{headers:{'cache-control':'no-store'}});
})]});
