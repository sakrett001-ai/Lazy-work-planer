import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { handleDashboardRequest } from '../agent/lib/dashboard-api.ts';
import { serverOrigin } from '../agent/lib/web-auth.ts';
import { updateState } from '../agent/lib/store.ts';
import { monitorWorkspace } from '../agent/lib/workspace-monitor.ts';
import { executionPlan, brokerExecutionPlan } from '../agent/lib/llm-config.ts';
import { createConsultationRunner } from '../agent/lib/consultation-runner.ts';
import { loadAppBroker } from '../agent/lib/app-broker-config.ts';
import { createConsultationWorker } from '../agent/lib/consultation-worker.ts';

// Model execution stays outside the shared, side-effect-free dashboard handlers.
export function createPilotServer({ runConsultation, broker, brokerSelected = process.env.ASSISTANT_BROKER_ENABLED === 'true' } = {}) {
  // Both entrypoints (prototype and pilot:serve) use this same server-owned path.
  // Invalid enabled configuration aborts startup; there is no direct fallback.
  if (broker === undefined && brokerSelected) broker = loadAppBroker();
  const plan = brokerSelected ? () => brokerExecutionPlan(broker) : executionPlan;
  const available = () => { try { plan(); return true; } catch { return false; } };
  runConsultation ||= createConsultationRunner({broker,brokerOnly:brokerSelected});
  let worker;
  const server = createServer(async (req, res) => {
    try {
      const origin = serverOrigin();
      if (req.headers.host?.toLowerCase() !== new URL(origin).host.toLowerCase()) {
        res.writeHead(421); res.end('Unexpected host'); return;
      }
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(302, { location: '/assistant/workspace', 'cache-control': 'no-store' }); res.end(); return;
      }
      const options = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) { options.body = Readable.toWeb(req); options.duplex = 'half'; }
      const url = new URL(req.url, origin);
      const response = await handleDashboardRequest(new Request(url, options), { assistantAvailable: available(), executionPlan: plan, brokerMode: brokerSelected, assistantMode: 'roles' });
      const job = req.method === 'POST' && url.pathname === '/assistant/api/assistant' && response.ok ? await response.clone().json() : null;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      if (job?.jobId) void worker?.wake().catch(() => console.error('Консультация не запущена; запрос можно проверить в карточке задачи.'));
    } catch { res.writeHead(503, { 'cache-control': 'no-store' }); res.end('Workspace unavailable'); }
  });
  let timer;
  server.on('listening', () => {
    worker = createConsultationWorker({ runConsultation });
    void worker.wake().catch(() => console.error('Восстановление очереди консультаций отложено.'));
    timer = setInterval(() => {
      try { updateState(state => monitorWorkspace(state)); }
      catch { console.error('Проверка ожидания ответа отложена: хранилище недоступно.'); }
    }, 60000);
    timer.unref();
  });
  server.on('close', () => { clearInterval(timer); worker?.stop(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ASSISTANT_PORT || 8787), host = process.env.ASSISTANT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный ASSISTANT_PORT.');
  if (!process.env.ASSISTANT_SERVER_ORIGIN && host === '127.0.0.1') process.env.ASSISTANT_SERVER_ORIGIN = `http://127.0.0.1:${port}`;
  const origin = serverOrigin();
  createPilotServer().listen(port, host, () => console.log(`Рабочее пространство: ${origin}/assistant/workspace\nПодключения ИИ: раздел «Модели и роли». Внешняя доставка сообщений подключается отдельно.`));
}
