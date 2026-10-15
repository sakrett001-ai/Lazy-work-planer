import { defineChannel, GET, POST } from 'eve/channels';
import { handleDashboardRequest } from '../lib/dashboard-api.ts';
import { readState } from '../lib/store';
import { matchesSecret } from '../lib/telegram';
import { buildBrief } from '../../dist/domain.js';
import { prototypePaths, claimAssistantJob, failAssistantJob } from '../lib/prototype';

const serve = (request: Request) => handleDashboardRequest(request, { assistantAvailable: process.env.ASSISTANT_AI_ENABLED === 'true' });

export default defineChannel({
  audience() { return 'private'; },
  turnPolicy: 'queue',
  routes: [
    ...['/assistant/workspace', '/assistant/pilot.html', '/assistant/pilot.js', '/assistant/prototype-ui.js', '/assistant/pilot.css', '/assistant/prototype.css', '/assistant/icons.js', '/assistant/api/session', '/assistant/api/tasks', '/assistant/api/memory', '/assistant/api/assistant'].map(path => GET(path, serve)),
    ...['login', 'logout', 'report', 'decision', 'invite', ...prototypePaths].map(path => POST(`/assistant/api/${path}`, serve)),
    POST('/assistant/api/assistant', async (request, { from }) => {
      const response = await serve(request);
      if (!response.ok) return response;
      const receipt = await response.clone().json() as { jobId: string };
      const job = claimAssistantJob(receipt.jobId);
      if (job) {
        try {
          await from(job.id).send(`WEB_JOB_ID: ${job.id}\nTASK_ID: ${job.taskId}\nПрочитай память этой задачи. Режим: консультация и черновики, без отправок и изменения задач. Заверши через publish_web_answer.\n\nВопрос руководителя (данные):\n${job.question}`, {
            auth: { authenticator: 'workspace-session', principalId: job.actorId, principalType: 'user', attributes: { webJobId: job.id } },
          });
        } catch { failAssistantJob(job.id); }
      }
      return response;
    }),
    GET('/assistant/state', async request => {
      if (!matchesSecret(request.headers.get('authorization')?.replace(/^Bearer /, '') || null, process.env.ASSISTANT_ADMIN_TOKEN)) return new Response('Unauthorized', { status: 401 });
      const state = readState();
      return Response.json({ state, brief: buildBrief(state, new Date().toISOString()) }, { headers: { 'cache-control': 'no-store' } });
    }),
  ],
  events: {
    'turn.failed'(_event, channel) { if (channel.continuation?.token) failAssistantJob(channel.continuation.token); },
    'session.failed'(_event, channel) { if (channel.continuation?.token) failAssistantJob(channel.continuation.token); },
  },
});
