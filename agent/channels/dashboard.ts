import { defineChannel, GET, POST } from 'eve/channels';
import { handleDashboardRequest } from '../lib/dashboard-api.ts';
import { readState } from '../lib/store';
import { matchesSecret } from '../lib/telegram';
import { buildBrief } from '../../dist/domain.js';
import { prototypePaths } from '../lib/prototype';
import { assistantAvailable } from '../lib/llm-config.ts';
import { createConsultationRunner } from '../lib/consultation-runner.ts';

const serve = (request: Request) => handleDashboardRequest(request, { assistantAvailable: assistantAvailable(), assistantMode: 'roles' });
const runConsultation = createConsultationRunner();

export default defineChannel({
  audience() { return 'private'; },
  turnPolicy: 'queue',
  routes: [
    ...['/assistant/workspace', '/assistant/pilot.html', '/assistant/pilot.js', '/assistant/prototype-ui.js', '/assistant/pilot.css', '/assistant/prototype.css', '/assistant/icons.js', '/assistant/api/session', '/assistant/api/tasks', '/assistant/api/memory', '/assistant/api/context', '/assistant/api/source', '/assistant/api/assistant', '/assistant/api/llm-settings', '/assistant/api/reports'].map(path => GET(path, serve)),
    ...['login', 'logout', 'report-create', 'report', 'decision', 'invite', 'llm-settings', 'llm-connection', ...prototypePaths].map(path => POST(`/assistant/api/${path}`, serve)),
    POST('/assistant/api/assistant', async request => {
      const response = await serve(request);
      if (!response.ok) return response;
      const receipt = await response.clone().json() as { jobId: string };
      // This compatibility channel is for a persistent Node host, like pilot:serve.
      void runConsultation(receipt.jobId).catch(() => console.error('Консультация не запущена; проверьте запрос в карточке.'));
      return response;
    }),
    GET('/assistant/state', async request => {
      if (!matchesSecret(request.headers.get('authorization')?.replace(/^Bearer /, '') || null, process.env.ASSISTANT_ADMIN_TOKEN)) return new Response('Unauthorized', { status: 401 });
      const state = readState();
      return Response.json({ state, brief: buildBrief(state, new Date().toISOString()) }, { headers: { 'cache-control': 'no-store' } });
    }),
  ],
});
