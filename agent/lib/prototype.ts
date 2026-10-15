import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readState, updateState, type Employee, type State } from './store.ts';
import { digest, issueInvite, webTables, WebError } from './web-auth.ts';
import { canReadTask } from '../../dist/access.js';
import { validDate } from '../../dist/domain.js';
import { addTask, editTask, changeTask, savePhase, setPhase, makeDraft, proposal } from '../../dist/workspace-model.js';
import { saveDecisionDraft } from './decisions.ts';

const id = z.string().trim().min(1).max(150);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const day = z.string().refine(value => !value || validDate(value), 'Проверь дату');
const operation = { requestId: z.uuid() };
const target = { ...operation, taskId: id, expectedVersion: version };
const fields = z.object({
  title: z.string().trim().min(1).max(160), employeeId: id,
  project: z.string().trim().max(120).default(''), description: z.string().trim().max(2000).default(''),
  due: day.default(''), dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
  protocolNumber: z.string().trim().max(100).default(''), protocolPoint: z.string().trim().max(100).default(''), protocolDate: day.default(''),
}).strict();
const schemas = {
  'task-create': z.object({ ...operation, fields }).strict(),
  'task-edit': z.object({ ...target, fields }).strict(),
  'task-action': z.object({ ...target, action: z.enum(['start', 'reopen', 'rework', 'unblock']) }).strict(),
  'phase-save': z.object({ ...target, phaseId: id.nullable(), phase: z.object({ title: z.string().trim().min(1).max(120), start: day.refine(Boolean), end: day.refine(Boolean), dependsOn: id.nullable() }).strict() }).strict(),
  'phase-toggle': z.object({ ...target, phaseId: id, done: z.boolean() }).strict(),
  'message': z.object({ ...operation, taskId: id, text: z.string().trim().min(1).max(4000), requestUpdate: z.boolean().default(false) }).strict(),
  'draft-create': z.object({ ...target, kind: z.enum(['extension', 'request', 'clarify', 'plan', 'review']) }).strict(),
  'draft-save': z.object({ ...operation, draftId: id, expectedVersion: version, expectedTaskVersion: version, title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(6000), status: z.enum(['draft', 'approved']) }).strict(),
  'pin': z.object({ ...operation, taskId: id, pinned: z.boolean() }).strict(),
  'notice': z.object({ ...operation, taskId: id, expectedVersion: version }).strict(),
  'person-create': z.object({ ...operation, name: z.string().trim().min(1).max(120) }).strict(),
  'automation': z.object({ ...operation, enabled: z.boolean() }).strict(),
};

export const versionOf = (value: unknown) => digest(JSON.stringify(value));
function manager(actor: Employee) { if (actor.role !== 'manager') throw new WebError(403, 'Это действие доступно руководителю.'); }
function allowedTask(state: State, actor: Employee, taskId: string) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!canReadTask(actor, task)) throw new WebError(404, 'Задача не найдена.');
  return task;
}
function fresh(task: unknown, expected: string) {
  if (versionOf(task) !== expected) throw new WebError(409, 'Задача изменилась. Обновите данные и проверьте действие ещё раз.');
}
function tables() {
  const db = webTables();
  db.exec('CREATE TABLE IF NOT EXISTS web_preferences (employee_id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS web_assistant_jobs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, data TEXT NOT NULL);');
  return db;
}
export function preferences(actorId: string): { pins: string[]; seen: Record<string, string> } {
  const row = tables().prepare('SELECT data FROM web_preferences WHERE employee_id=?').get(actorId) as {data:string}|undefined;
  return row ? JSON.parse(row.data) : { pins: [], seen: {} };
}

// All writes and their receipts share the same SQLite transaction. A lost response
// can be retried with the same request ID; stale task edits are rejected.
export function prototypeWrite(path: string, raw: unknown, actor: Employee): unknown {
  const schema = schemas[path as keyof typeof schemas];
  if (!schema) throw new WebError(404, 'Действие не найдено.');
  const input: any = schema.parse(raw), key = `prototype:${actor.id}:${input.requestId}`, requestHash = digest(JSON.stringify({ path, input }));
  let receipt: any;
  tables();
  updateState(state => {
    const current = state.employees.find(p => p.id === actor.id);
    if (!current) throw new WebError(401, 'Участник не найден.');
    if (!['pin', 'notice', 'phase-toggle'].includes(path)) manager(current);
    const db = tables();
    const prior = db.prepare('SELECT request_hash,response FROM web_operations WHERE id=?').get(key) as {request_hash:string;response:string}|undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new WebError(409, 'Этот запрос уже использован для другого действия.');
      receipt = { ...JSON.parse(prior.response), duplicate: true }; return state;
    }
    const at = new Date().toISOString();
    let next = state, task = input.taskId ? allowedTask(state, current, input.taskId) : null;
    if (input.expectedVersion && task) fresh(task, input.expectedVersion);
    receipt = { ok: true, duplicate: false, taskId: input.taskId };
    try {
      if (path === 'task-create') {
        const result = addTask(state, { ...input.fields, summary: 'Ожидаем первое обновление.' }, new Date(at));
        next = result.state;
        (result.task as any).description = input.fields.description;
        result.task.contact = 'not_requested';
        receipt.taskId = result.task.id;
      } else if (path === 'task-edit') {
        next = editTask(state, task.id, { ...input.fields, summary: task.summary || '' }, new Date(at));
        const updated = next.tasks.find(t => t.id === task.id);
        updated.description = input.fields.description;
        if (task.description !== updated.description) next.events.unshift({ key: `${key}:description`, taskId: task.id, kind: 'edited', at, text: 'Руководитель изменил описание поручения.' });
      } else if (path === 'task-action') {
        next = changeTask(state, task.id, input.action, new Date(at));
      } else if (path === 'phase-save') {
        if (!input.phaseId && (task.phases || []).length >= 30) throw new WebError(400, 'В прототипе доступно до 30 этапов задачи.');
        next = savePhase(state, task.id, input.phaseId, input.phase, new Date(at));
      } else if (path === 'phase-toggle') {
        next = setPhase(state, task.id, input.phaseId, input.done, new Date(at));
      } else if (path === 'message') {
        if (task.status === 'done') throw new WebError(409, 'Сначала верните задачу в работу.');
        const source = { id: key, taskId: task.id, employeeId: current.id, text: input.text, occurredAt: at, receivedAt: at, channel: 'workspace', kind: 'manager_message' };
        state.sources.push(source);
        state.events.unshift({ key, sourceId: key, taskId: task.id, actorId: current.id, kind: 'manager_message', at, text: input.requestUpdate ? 'Руководитель запросил обновление в обсуждении задачи.' : 'Сообщение руководителя в обсуждении задачи.' });
        if (input.requestUpdate && !['done', 'review'].includes(task.status)) { task.lastRequestedAt = at; task.contact = 'awaiting'; }
        receipt.sourceId = source.id;
      } else if (path === 'draft-create') {
        const prepared = makeDraft(state, task, input.kind), suggestion = proposal(task);
        const source = state.sources.find(s => s.id === task.latestSourceId && s.taskId === task.id);
        const result = saveDecisionDraft(state, current, {
          taskId: task.id, kind: input.kind, title: prepared.title, body: prepared.body,
          reason: suggestion.detail, options: [{ label: suggestion.title, consequence: 'Проверить текст и основания; следующее действие подтверждает руководитель.' }],
          references: source?.text ? [{ sourceId: source.id, quote: source.text.slice(0, 800) }] : [],
        }, key, at);
        result.draft.generator = 'template'; next = result.state; receipt.draftId = result.draft.id;
      } else if (path === 'draft-save') {
        const draft = state.decisionDrafts?.find(d => d.id === input.draftId);
        if (!draft) throw new WebError(404, 'Черновик не найден.');
        const draftTask = allowedTask(state, current, draft.taskId);
        if (versionOf(draft) !== input.expectedVersion) throw new WebError(409, 'Черновик изменился. Откройте актуальную версию.');
        if (input.status === 'approved') fresh(draftTask, input.expectedTaskVersion);
        Object.assign(draft, { title: input.title, body: input.body, status: input.status, needsReview: input.status !== 'approved', editedAt: at, editorId: current.id });
        state.events.unshift({ key, taskId: draft.taskId, kind: 'decision_draft', actorId: current.id, at, text: input.status === 'approved' ? `Текст согласован: ${input.title}. Отправка не выполнялась.` : `Черновик отредактирован: ${input.title}` });
        receipt.draftId = draft.id; receipt.taskId = draft.taskId;
      } else if (path === 'pin' || path === 'notice') {
        const prefs = preferences(current.id);
        if (path === 'pin') prefs.pins = input.pinned ? [...new Set([...prefs.pins, task.id])].slice(-100) : prefs.pins.filter(t => t !== task.id);
        else prefs.seen[task.id] = versionOf(task);
        db.prepare('INSERT INTO web_preferences VALUES (?,?) ON CONFLICT(employee_id) DO UPDATE SET data=excluded.data').run(current.id, JSON.stringify(prefs));
      } else if (path === 'person-create') {
        const person = { id: `employee-${randomUUID()}`, name: input.name, role: 'employee' as const };
        state.employees.push(person); receipt.employee = person;
      } else if (path === 'automation') {
        (state.settings as any).prototypeAutoCheckins = input.enabled;
      }
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError(400, error instanceof Error ? error.message : 'Проверьте данные.');
    }
    const previous = new Set(state.events.map(e => e.key));
    for (const event of next.events) if (!previous.has(event.key)) event.actorId = current.id;
    db.prepare('INSERT INTO web_operations VALUES (?,?,?)').run(key, requestHash, JSON.stringify(receipt));
    return next;
  });
  return receipt;
}

export function inviteParticipant(raw: unknown, actor: Employee) {
  manager(actor);
  const { employeeId } = z.object({ employeeId: id }).strict().parse(raw);
  const person = readState().employees.find(p => p.id === employeeId);
  if (!person || (person.role === 'manager' && person.id !== actor.id)) throw new WebError(404, 'Участник не найден.');
  // Only the hash goes into SQLite; never retain the login code in an operation receipt.
  return { code: issueInvite(employeeId), expiresInMinutes: 30, employeeId };
}

export type AssistantJob = { id: string; actorId: string; taskId: string; question: string; taskVersion: string; status: 'pending'|'running'|'completed'|'failed'; createdAt: string; updatedAt: string; text?: string; error?: string; stale?: boolean; references?: {sourceId:string;quote:string}[] };
export function getJob(jobId: string): AssistantJob|undefined {
  const row = tables().prepare('SELECT data FROM web_assistant_jobs WHERE id=?').get(jobId) as {data:string}|undefined;
  return row && JSON.parse(row.data);
}
function putJob(job: AssistantJob) { tables().prepare('INSERT INTO web_assistant_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, job.actorId, JSON.stringify(job)); }
export function assistantJobs(actor: Employee, taskId: string) {
  allowedTask(readState(), actor, taskId);
  const jobs = (tables().prepare("SELECT data FROM web_assistant_jobs WHERE actor_id=? AND json_extract(data,'$.taskId')=? ORDER BY rowid DESC LIMIT 20").all(actor.id, taskId) as {data:string}[]).map(row => JSON.parse(row.data) as AssistantJob);
  for (const job of jobs) if (['pending', 'running'].includes(job.status) && Date.now() - Date.parse(job.updatedAt) > 10 * 60000) { failAssistantJob(job.id); Object.assign(job, getJob(job.id)); }
  return jobs;
}
export function createAssistantJob(raw: unknown, actor: Employee, available: boolean) {
  manager(actor);
  if (!available) throw new WebError(503, 'ИИ подключается при запуске сервера eve. Сейчас доступны сводка и редактируемые шаблоны.');
  const input = z.object({ ...target, question: z.string().trim().min(1).max(2000) }).strict().parse(raw);
  const task = allowedTask(readState(), actor, input.taskId), jobId = `web-job:${actor.id}:${input.requestId}`;
  const previous = getJob(jobId);
  if (previous) {
    if (previous.taskId !== input.taskId || previous.question !== input.question || previous.taskVersion !== input.expectedVersion) throw new WebError(409, 'Этот запрос уже использован.');
    return { ok: true, jobId, duplicate: true };
  }
  fresh(task, input.expectedVersion);
  if (assistantJobs(actor, input.taskId).some(job => job.status === 'pending' || job.status === 'running')) throw new WebError(409, 'По этой задаче уже готовится ответ. Дождитесь его завершения.');
  const at = new Date().toISOString();
  putJob({ id: jobId, actorId: actor.id, taskId: task.id, question: input.question, taskVersion: versionOf(task), status: 'pending', createdAt: at, updatedAt: at });
  return { ok: true, jobId, duplicate: false };
}
export function claimAssistantJob(jobId: string): AssistantJob|undefined {
  let claimed: AssistantJob|undefined;
  updateState(state => { const job = getJob(jobId); if (job?.status === 'pending') { job.status = 'running'; job.updatedAt = new Date().toISOString(); putJob(job); claimed = job; } return state; });
  return claimed;
}
export function failAssistantJob(jobId: string) {
  updateState(state => { const job = getJob(jobId); if (job && job.status !== 'completed') { job.status = 'failed'; job.error = 'Ответ ИИ не подтверждён. Память задачи сохранена; можно задать новый вопрос.'; job.updatedAt = new Date().toISOString(); putJob(job); } return state; });
}
export function webJobFor(ctx: any) {
  const jobId = ctx.session.auth.current?.attributes?.webJobId;
  const job = typeof jobId === 'string' ? getJob(jobId) : undefined;
  if (!job || job.actorId !== ctx.session.auth.current?.principalId) throw new Error('Нет проверенного запроса из рабочего пространства.');
  return job;
}
export function assertWebReadOnly(ctx: any) {
  if (ctx.session.auth.current?.attributes?.webJobId) throw new Error('Веб-консультация может читать память и готовить черновики. Изменения и отправки выполняет человек в интерфейсе.');
}
export function finishAssistantJob(ctx: any, input: {text:string;references:{sourceId:string;quote:string}[]}) {
  let result: AssistantJob|undefined;
  updateState(state => {
    const job = webJobFor(ctx), actor = state.employees.find(p => p.id === job.actorId);
    if (!actor || actor.role !== 'manager') throw new Error('Нет доступа к консультации.');
    const task = allowedTask(state, actor, job.taskId);
    for (const ref of input.references) if (!state.sources.some(s => s.id === ref.sourceId && s.taskId === task.id && s.text.includes(ref.quote) && ref.quote.trim())) throw new Error('Цитата не подтверждена источником этой задачи.');
    if (job.status !== 'completed') { Object.assign(job, input, { status: 'completed', stale: versionOf(task) !== job.taskVersion, updatedAt: new Date().toISOString() }); putJob(job); }
    result = job; return state;
  });
  return { saved: true, jobId: result!.id };
}

export const prototypePaths = Object.keys(schemas);
