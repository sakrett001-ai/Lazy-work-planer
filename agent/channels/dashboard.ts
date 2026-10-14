import { defineChannel, GET } from 'eve/channels';
import { readState } from '../lib/store';
import { matchesSecret } from '../lib/telegram';
import { buildBrief } from '../../dist/domain.js';
export default defineChannel({routes:[GET('/assistant/state',async req=>{
  if(!matchesSecret(req.headers.get('authorization')?.replace(/^Bearer /,'')||null,process.env.ASSISTANT_ADMIN_TOKEN))return new Response('Unauthorized',{status:401});
  const state=readState();return Response.json({state,brief:buildBrief(state,new Date().toISOString())},{headers:{'cache-control':'no-store'}});
})]});
