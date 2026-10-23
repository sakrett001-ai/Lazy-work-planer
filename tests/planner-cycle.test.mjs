import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Only fictional records and a private disposable SQLite directory. No live model,
// external transport, public server, or authentication shortcut is used here.
const directory = mkdtempSync(join(tmpdir(), 'planner-cycle-'));
const origin = 'https://planner-cycle.test';
process.env.ASSISTANT_DATA_DIR = directory;
process.env.ASSISTANT_SERVER_ORIGIN = origin;
process.env.ASSISTANT_DELIVERY_ENABLED = 'false';
const store = await import('../agent/lib/store.ts');
const { issueInvite } = await import('../agent/lib/web-auth.ts');
const { handleDashboardRequest } = await import('../agent/lib/dashboard-api.ts');
const referenceTime = Date.now();
const day = offset => new Date(referenceTime + offset * 86400000).toISOString().slice(0, 10);
const command = fields => ({ requestId: randomUUID(), ...fields });

async function request(path, body, auth) {
  return handleDashboardRequest(new Request(`${origin}/assistant/api/${path}`, {
    headers: {
      ...(auth ? { cookie: auth.cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json', origin, 'x-csrf-token': auth?.csrf || '' } : {}),
    },
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  }), { assistantAvailable: false });
}
async function ok(path, body, auth) {
  const response = await request(path, body, auth), data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function signin(employeeId) {
  const response = await request('login', { code: issueInvite(employeeId) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, ...await ok('session', undefined, { cookie }) };
}
async function target(taskId, auth) {
  const memory = await ok(`memory?taskId=${encodeURIComponent(taskId)}`, undefined, auth);
  return { taskId, expectedVersion: memory.taskVersion };
}
after(() => { store.database().close(); rmSync(directory, { recursive: true, force: true }); });

test('Пилот: постановка со сроком и реквизитами → работа → препятствие → проверка → приёмка; память переживает новый процесс', async () => {
  store.updateState(() => ({
    employees: [
      { id: 'manager', name: 'Руководитель · тест', role: 'manager' },
      { id: 'employee', name: 'Исполнитель · тест', role: 'employee' },
      { id: 'other', name: 'Другой участник · тест', role: 'employee' },
    ],
    tasks: [], sources: [], events: [],
    settings: { timezone: 'Europe/Moscow', startHour: 9, endHour: 18, minHoursBetween: 6, excludedDates: [] },
  }));
  const manager = await signin('manager'), employee = await signin('employee'), other = await signin('other');
  const input = command({ fields: {
    title: 'Подготовить материалы пилота', employeeId: 'employee', project: 'Показ программы',
    description: 'Вымышленное поручение: собрать один демонстрационный отчёт.',
    due: day(7), dueTime: '16:30', protocolNumber: 'ПИЛОТ-01', protocolPoint: '2.1', protocolDate: day(0),
  } });
  assert.equal((await request('task-create', input)).status, 401, 'Нет анонимной записи');
  assert.equal((await request('task-create', input, employee)).status, 403, 'Постановка доступна руководителю');
  const created = await ok('task-create', input, manager), taskId = created.taskId;
  assert.equal((await ok('task-create', input, manager)).duplicate, true);
  assert.equal((await request('task-create', { ...input, fields: { ...input.fields, title: 'Подмена' } }, manager)).status, 409);
  let snapshot = await ok('tasks', undefined, manager), task = snapshot.tasks.find(t => t.id === taskId);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(task.status, 'planned');
  assert.equal(task.due, input.fields.due);
  assert.equal(task.dueTime, '16:30');
  assert.deepEqual(task.protocol, { number: 'ПИЛОТ-01', point: '2.1', date: input.fields.protocolDate });
  assert.equal((await ok('tasks', undefined, other)).tasks.length, 0);
  assert.equal((await request(`memory?taskId=${encodeURIComponent(taskId)}`, undefined, other)).status, 404);

  await ok('task-action', command({ ...await target(taskId, manager), action: 'start' }), manager);
  const beforeReport = await target(taskId, manager);
  const blocked = command({ taskId, text: 'Есть препятствие: исходные данные не получены. Нужна помощь руководителя.' });
  const receipt = await ok('report', blocked, employee);
  assert.equal((await ok('report', blocked, employee)).duplicate, true);
  snapshot = await ok('tasks', undefined, manager);
  assert.equal(snapshot.tasks[0].status, 'blocked');
  assert.equal(snapshot.tasks[0].due, input.fields.due);
  assert.equal(snapshot.brief.metrics.blocked, 1);
  assert.equal(snapshot.brief.metrics.decision, 1);
  assert.equal(snapshot.brief.blocked[0].sourceId, receipt.sourceId);
  assert.match(snapshot.brief.text, /ПРЕПЯТСТВИЕ/);
  assert.equal((await request('task-action', command({ ...beforeReport, action: 'unblock' }), manager)).status, 409, 'Устаревшая карточка не перезаписывает источник');

  await ok('report', command({ taskId, text: `Прошу перенести срок на ${day(10)}: нужно сверить расчёты.` }), employee);
  let memory = await ok(`memory?taskId=${encodeURIComponent(taskId)}`, undefined, manager);
  assert.equal(memory.task.due, input.fields.due);
  assert.equal(memory.task.proposedDue, day(10));
  assert.equal((await request('decision', command({ ...await target(taskId, employee), action: 'approve_due' }), employee)).status, 403);
  await ok('decision', command({ ...await target(taskId, manager), action: 'reject_due' }), manager);
  await ok('report', command({ taskId, text: 'Препятствие устранено, данные получены.' }), employee);
  await ok('report', command({ taskId, text: 'Работа выполнена, результат готов к проверке.' }), employee);
  snapshot = await ok('tasks', undefined, manager);
  assert.equal(snapshot.tasks[0].status, 'review', 'Готовность не равна приёмке');
  assert.equal(snapshot.tasks[0].due, input.fields.due);
  assert.equal(snapshot.brief.metrics.blocked, 0);
  assert.equal(snapshot.brief.metrics.decision, 1);
  assert.match(snapshot.brief.text, /Проверить и принять результат/);

  // A fresh Node process opens the same SQLite files and authenticates with the
  // existing persisted session. It neither imports fixtures nor resets records.
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { handleDashboardRequest } from './agent/lib/dashboard-api.ts';
    import { database } from './agent/lib/store.ts';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    async function request(path, body) {
      const response = await handleDashboardRequest(new Request(input.origin + '/assistant/api/' + path, {
        headers: { cookie: input.auth.cookie, ...(body ? { origin: input.origin, 'content-type':'application/json', 'x-csrf-token':input.auth.csrf } : {}) },
        ...(body ? {method:'POST', body:JSON.stringify(body)} : {})
      }), {assistantAvailable:false});
      if(response.status !== 200) throw Error('Restart request failed: ' + response.status);
      return response.json();
    }
    const snapshot = await request('tasks');
    const memory = await request('memory?taskId=' + encodeURIComponent(input.taskId));
    const duplicate = await request('task-create', input.create);
    console.log(JSON.stringify({snapshot,memory,duplicate}));
    database().close();
  `], { cwd: process.cwd(), env: { ...process.env }, input: JSON.stringify({ origin, auth: manager, taskId, create: input }), encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  const persisted = JSON.parse(restarted.stdout);
  assert.deepEqual(persisted.snapshot.tasks, snapshot.tasks);
  assert.equal(persisted.duplicate.duplicate, true);
  assert.ok(persisted.memory.sources.some(source => source.id === receipt.sourceId && source.text === blocked.text));
  assert.equal(persisted.snapshot.brief.metrics.decision, 1);

  assert.equal((await request('decision', command({ ...await target(taskId, employee), action: 'accept' }), employee)).status, 403);
  await ok('decision', command({ ...await target(taskId, manager), action: 'accept' }), manager);
  snapshot = await ok('tasks', undefined, manager);
  assert.equal(snapshot.tasks[0].status, 'done');
  assert.equal(snapshot.tasks[0].due, input.fields.due);
  assert.equal(snapshot.brief.metrics.open, 0);
  assert.equal(snapshot.brief.metrics.decision, 0);
  assert.equal(snapshot.brief.decision.length, 0);
  memory = await ok(`memory?taskId=${encodeURIComponent(taskId)}`, undefined, manager);
  assert.ok(memory.timeline.some(event => event.kind === 'decision' && event.actorId === 'manager' && event.action === 'accept'));
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n, 0, 'Внешние отправки не создаются');
});
