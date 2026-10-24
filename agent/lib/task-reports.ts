import { z } from 'zod';
import { readState, updateState, type Employee } from './store.ts';
import { digest, webTables, WebError } from './web-auth.ts';
import { sourceVersion } from './assistant-memory.ts';

const schema = z.object({ requestId: z.uuid(), selection: z.array(z.object({ taskId: z.string().min(1).max(150), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(50) }).strict();
function table() {
  const db = webTables();
  db.exec('CREATE TABLE IF NOT EXISTS task_reports (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);');
  return db;
}
function manager(actor: Employee) {
  const current = readState().employees.find(p => p.id === actor.id);
  if (!current || current.role !== 'manager') throw new WebError(403, 'Отчёты доступны руководителю.');
  return current;
}
const quote = (value: unknown) => JSON.stringify(String(value ?? ''));
const statuses: Record<string,string> = { planned:'Запланировано',active:'В работе',blocked:'Есть препятствие',review:'На проверке',done:'Принято' };
const date = (value: string|null, time?: string|null) => value ? `${value}${time ? ' '+time+' мск' : ''}` : 'не задан';
export function createReport(raw: unknown, actor: Employee) {
  manager(actor); const input = schema.parse(raw);
  if (new Set(input.selection.map(s => s.taskId)).size !== input.selection.length) throw new WebError(400, 'Поручение выбрано повторно.');
  const id = `task-report:${actor.id}:${input.requestId}`, hash = digest(JSON.stringify(input));
  let receipt: any; table();
  updateState(state => {
    manager(actor);
    const prior = table().prepare('SELECT request_hash,response FROM web_operations WHERE id=?').get(id) as {request_hash:string;response:string}|undefined;
    if (prior) {
      if (prior.request_hash !== hash) throw new WebError(409, 'Этот запрос уже использован для другого отчёта.');
      const saved = table().prepare('SELECT payload FROM task_reports WHERE id=? AND actor_id=?').get(id, actor.id) as {payload:string}|undefined;
      if (!saved) throw new WebError(409, 'Сохранённый отчёт недоступен.');
      receipt = { report: JSON.parse(saved.payload), duplicate: true }; return state;
    }
    const createdAt = new Date().toISOString();
    const selected = new Set(input.selection.map(s => s.taskId));
    function descendants(root: string) {
      const visited = new Set([root]), result: string[] = [], queue = [{id:root,depth:0}];
      while (queue.length) {
        const node = queue.shift()!;
        const children = state.tasks.filter(t => t.parentId === node.id);
        if (children.length && node.depth >= 20) throw new WebError(400, 'Слишком глубокая цепочка поручений.');
        for (const child of children) {
          if (visited.has(child.id) || result.length >= 500) throw new WebError(400, 'Цикл или слишком большая цепочка поручений.');
          visited.add(child.id); result.push(child.id); queue.push({id:child.id,depth:node.depth+1});
        }
      }
      return result;
    }
    const copySource = (source: any) => ({id:source.id,text:String(source.text || ''),occurredAt:source.occurredAt || source.receivedAt,receivedAt:source.receivedAt,version:sourceVersion(source)});
    const items = input.selection.map(({taskId,expectedVersion}) => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) throw new WebError(404, 'Поручение не найдено.');
      const version = digest(JSON.stringify(task));
      if (version !== expectedVersion) throw new WebError(409, 'Поручение изменилось. Обновите список перед созданием отчёта.');
      const source = state.sources.find(s => s.id === task.latestSourceId && s.taskId === taskId);
      const originalDueKnown = Object.hasOwn(task, 'originalDue');
      const descendantsIds = descendants(taskId);
      const sourceIds = new Set([task.latestSourceId, ...Object.values(task.factOrigins || {}).map((o: any) => o?.sourceId)].filter(Boolean));
      const evidence = state.sources.filter(s => s.taskId === taskId && sourceIds.has(s.id)).map(copySource);
      return {
        id: task.id, title: String(task.title), employeeId: task.employeeId,
        employeeName: state.employees.find(p => p.id === task.employeeId)?.name || 'Участник',
        parentId: task.parentId || null, taskVersion: version,
        coverage: {descendantsTotal:descendantsIds.length,descendantsIncluded:descendantsIds.filter(id => selected.has(id)).length}, evidence,
        status: task.status, summary: task.summary || '', blocker: task.blocker || '', nextAction: task.nextAction || '',
        due: task.due || null, dueTime: task.dueTime || '18:00', originalDueKnown,
        originalDue: originalDueKnown ? task.originalDue : null, originalDueTime: originalDueKnown ? task.originalDueTime : null,
        overdue: task.status !== 'done' && Boolean(task.due) && Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) < Date.parse(createdAt),
        contact: task.contact || null, lastRequestedAt: task.lastRequestedAt || null, lastReply: task.lastReply || null,
        phases: { total: (task.phases || []).length, done: (task.phases || []).filter((p: any) => p.done).length },
        source: source ? copySource(source) : null,
        factOrigins: task.factOrigins || {},
      };
    });
    const text = [`ОТЧЁТ ПО ВЫБРАННЫМ ПОРУЧЕНИЯМ`, `Снимок на ${createdAt} (UTC). Выбрано: ${items.length}.`, 'Включены только явно выбранные поручения; сроки и статусы не изменялись.', ...items.map(item => [
      `\n${quote(item.id)} · ${quote(item.title)}`, `Ответственный: ${quote(item.employeeName)}`, item.parentId ? `Дочернее поручение: ${quote(item.parentId)}` : 'Основное/самостоятельное поручение',
      `Дочерние в этом отчёте: ${item.coverage.descendantsIncluded}/${item.coverage.descendantsTotal}${item.coverage.descendantsIncluded < item.coverage.descendantsTotal ? ' · часть НЕ ВКЛЮЧЕНА' : ''}.`,
      `Состояние: ${statuses[item.status] || item.status}${item.overdue ? ' · ПРОСРОЧЕНО' : ''}`,
      `Текущий срок: ${date(item.due,item.dueTime)}. Исходный: ${item.originalDueKnown ? date(item.originalDue,item.originalDueTime) : 'неизвестен (старая запись)'}.`,
      `Что известно: ${quote(item.summary || 'Нет обновления')}`, `Препятствие: ${quote(item.blocker || 'Не зафиксировано')}`,
      `Этапы: ${item.phases.done}/${item.phases.total}. Последний ответ: ${item.lastReply || 'не получен'}.`,
      item.source ? `Последний ответ (не основание всех полей карточки), источник ${item.source.id} от ${item.source.occurredAt}, получен ${item.source.receivedAt}: ${JSON.stringify(item.source.text)}` : 'Сообщение-основание не зафиксировано; данные из карточки.',
    ].join('\n'))].join('\n');
    const report = { id, createdAt, schemaVersion: 1, snapshotPolicy: 'current_facts_at_creation', selectionPolicy: 'explicit_only', items, text };
    table().prepare('INSERT INTO task_reports VALUES (?,?,?,?)').run(id, actor.id, createdAt, JSON.stringify(report));
    table().prepare('INSERT INTO web_operations VALUES (?,?,?)').run(id, hash, JSON.stringify({reportId:id}));
    receipt = { report, duplicate: false }; return state;
  });
  return receipt;
}
export function readReports(actor: Employee, id: string|null = null) {
  manager(actor);
  if (id) {
    const row = table().prepare('SELECT payload FROM task_reports WHERE id=? AND actor_id=?').get(id, actor.id) as {payload:string}|undefined;
    if (!row) throw new WebError(404, 'Отчёт не найден.');
    return {report: JSON.parse(row.payload)};
  }
  const rows = table().prepare('SELECT id,created_at,payload FROM task_reports WHERE actor_id=? ORDER BY rowid DESC LIMIT 50').all(actor.id) as {id:string;created_at:string;payload:string}[];
  return {reports: rows.map(row => ({id:row.id,createdAt:row.created_at,taskCount:JSON.parse(row.payload).items.length}))};
}
