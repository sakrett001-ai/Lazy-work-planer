import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readState, updateState, saveSource, markDispatched } from './store.ts';
import { WebError, digest, login, logout, requireCsrf, requireOrigin, serverOrigin, session, sessionCookie, webTables } from './web-auth.ts';
import { canReadTask, scopedWorkspace } from '../../dist/access.js';
import { taskMemory } from '../../dist/task-memory.js';
import { buildBrief, decide } from '../../dist/domain.js';
import { runAssistantWorkflow } from '../../dist/langgraph-emb.js';

const reportSchema = z.object({ requestId: z.uuid(), taskId: z.string().min(1).max(100), text: z.string().trim().min(1).max(4000) }).strict();
const decisionSchema = z.object({ requestId: z.uuid(), taskId: z.string().min(1).max(100), action: z.enum(['accept', 'approve_due', 'reject_due', 'take_control']), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const assets: Record<string, [string, string]> = {
  '/assistant/workspace': ['pilot.html', 'text/html; charset=utf-8'],
  '/assistant/pilot.html': ['pilot.html', 'text/html; charset=utf-8'],
  '/assistant/pilot.js': ['pilot.js', 'text/javascript; charset=utf-8'],
  '/assistant/pilot.css': ['pilot.css', 'text/css; charset=utf-8'],
  '/assistant/icons.js': ['icons.js', 'text/javascript; charset=utf-8'],
};
export const taskVersion = (task: unknown) => digest(JSON.stringify(task));
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function readJson(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new WebError(415, 'Ожидается JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new WebError(400, 'Нет данных для сохранения.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new WebError(413, 'Сообщение слишком длинное.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WebError(400, 'Не удалось прочитать запрос.'); }
}

async function route(request: Request) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && assets[path]) {
    const [name, type] = assets[path];
    return new Response(await readFile(resolve('dist', name), 'utf8'), { headers: { 'content-type': type } });
  }
  if (!path.startsWith('/assistant/api/')) return json({ error: 'Страница не найдена.' }, 404);
  serverOrigin();
  if (request.method === 'POST') requireOrigin(request);
  if (path === '/assistant/api/login' && request.method === 'POST') {
    const input = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(await readJson(request));
    const result = login(input.code);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(result.value) } });
  }
  const auth = session(request), actor = auth.actor;
  if (request.method === 'POST') requireCsrf(request, auth.csrf);
  if (path === '/assistant/api/logout' && request.method === 'POST') {
    logout(auth.hash);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie() } });
  }
  if (path === '/assistant/api/session' && request.method === 'GET') return json({ actor: { id: actor.id, name: actor.name, role: actor.role || 'employee' }, csrf: auth.csrf });
  if (path === '/assistant/api/tasks' && request.method === 'GET') {
    const state = scopedWorkspace(readState(), actor), at = new Date().toISOString();
    return json({ tasks: state.tasks.map((task: any) => ({ ...task, version: taskVersion(task) })), employees: state.employees, brief: buildBrief(state, at), asOf: at });
  }
  if (path === '/assistant/api/memory' && request.method === 'GET') {
    const state = readState(), taskId = url.searchParams.get('taskId') || '';
    if (!canReadTask(actor, state.tasks.find(t => t.id === taskId))) throw new WebError(404, 'Задача не найдена.');
    return json({ ...taskMemory(state, actor, taskId, { before: url.searchParams.get('before'), limit: 20 }), taskVersion: taskVersion(state.tasks.find(t => t.id === taskId)) });
  }
  if (path === '/assistant/api/report' && request.method === 'POST') {
    const input = reportSchema.parse(await readJson(request));
    let receipt: unknown;
    updateState(state => {
      const task = state.tasks.find(t => t.id === input.taskId);
      if (!task || task.employeeId !== actor.id) throw new WebError(404, 'Задача не найдена или назначена другому сотруднику.');
      const at = new Date().toISOString(), id = `web:${actor.id}:${input.requestId}`;
      if (task.status === 'done' && !state.events.some(e => e.key === id)) throw new WebError(409, 'Задача принята. Для нового отчёта руководитель должен открыть её снова.');
      const source = saveSource({ id, employeeId: actor.id, taskId: input.taskId, text: input.text, receivedAt: at, occurredAt: at });
      if (source.text !== input.text || source.taskId !== input.taskId || source.employeeId !== actor.id) throw new WebError(409, 'Этот запрос уже использован для другого сообщения.');
      const result = runAssistantWorkflow(state, { eventType: 'employee_feedback', taskId: source.taskId, message: source.text, mode: 'server', actorId: actor.id, source, now: at, operationId: id });
      if (!result.state.events.some((event: any) => event.key === id)) throw new WebError(409, result.reply || 'Сообщение требует уточнения.');
      markDispatched(id);
      receipt = { ok: true, sourceId: id, duplicate: Boolean(result.duplicate), reply: result.reply, processing: 'rules' };
      return result.state;
    });
    return json(receipt);
  }
  if (path === '/assistant/api/decision' && request.method === 'POST') {
    if (actor.role !== 'manager') throw new WebError(403, 'Решения принимает руководитель.');
    const input = decisionSchema.parse(await readJson(request)), key = `web-decision:${actor.id}:${input.requestId}`, requestHash = digest(JSON.stringify(input));
    let receipt: any;
    updateState(state => {
      const currentActor = state.employees.find(p => p.id === actor.id && p.role === 'manager');
      if (!currentActor) throw new WebError(403, 'Решения принимает руководитель.');
      const db = webTables();
      const prior = db.prepare('SELECT request_hash, response FROM web_operations WHERE id = ?').get(key) as { request_hash: string; response: string } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new WebError(409, 'Этот запрос уже использован для другого решения.');
        receipt = { ...JSON.parse(prior.response), duplicate: true }; return state;
      }
      const task = state.tasks.find(t => t.id === input.taskId);
      if (!task) throw new WebError(404, 'Задача не найдена.');
      if (taskVersion(task) !== input.expectedVersion) throw new WebError(409, 'Задача изменилась. Обновите данные и проверьте решение ещё раз.');
      let next;
      try { next = decide(state, input.taskId, input.action, currentActor, new Date().toISOString()); }
      catch { throw new WebError(409, 'Это решение уже не соответствует состоянию задачи.'); }
      receipt = { ok: true, duplicate: false, taskId: input.taskId, eventId: next.events[0].key };
      db.prepare('INSERT INTO web_operations VALUES (?,?,?)').run(key, requestHash, JSON.stringify(receipt));
      return next;
    });
    return json(receipt);
  }
  return json({ error: 'Действие не найдено.' }, 404);
}

export async function handleDashboardRequest(request: Request) {
  let response: Response;
  try { response = await route(request); }
  catch (error) {
    if (error instanceof WebError) response = json({ error: error.message }, error.status);
    else if (error instanceof z.ZodError) response = json({ error: 'Проверьте заполнение полей запроса.' }, 400);
    else response = json({ error: 'Не удалось выполнить действие. Данные не подтверждены; повторите запрос.' }, 500);
  }
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return response;
}
