import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { handleDashboardRequest } from '../agent/lib/dashboard-api.ts';
import { serverOrigin } from '../agent/lib/web-auth.ts';
import { updateState } from '../agent/lib/store.ts';
import { monitorWorkspace } from '../agent/lib/workspace-monitor.ts';

// Same handlers as eve. Only in-app monitoring runs here; no model or external transport.
export function createPilotServer() {
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
      const response = await handleDashboardRequest(new Request(new URL(req.url, origin), options));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503, { 'cache-control': 'no-store' }); res.end('Workspace unavailable'); }
  });
  let timer;
  server.on('listening', () => {
    timer = setInterval(() => {
      try { updateState(state => monitorWorkspace(state)); }
      catch { console.error('Проверка ожидания ответа отложена: хранилище недоступно.'); }
    }, 60000);
    timer.unref();
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ASSISTANT_PORT || 8787), host = process.env.ASSISTANT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный ASSISTANT_PORT.');
  if (!process.env.ASSISTANT_SERVER_ORIGIN && host === '127.0.0.1') process.env.ASSISTANT_SERVER_ORIGIN = `http://127.0.0.1:${port}`;
  const origin = serverOrigin();
  createPilotServer().listen(port, host, () => console.log(`Рабочее пространство: ${origin}/assistant/workspace\nМодель и внешние отправки этим процессом не запускаются.`));
}
