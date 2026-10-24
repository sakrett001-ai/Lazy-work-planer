import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { invoke } from './helpers/server-runtime.mjs';

// Only fictional records and a private disposable SQLite directory. No live model,
// external transport, public server, or authentication shortcut is used here.
const directory = mkdtempSync(join(tmpdir(), 'planner-delegation-'));
const origin = 'https://delegation.test';
process.env.ASSISTANT_DATA_DIR = directory;
process.env.ASSISTANT_SERVER_ORIGIN = origin;
process.env.ASSISTANT_DELIVERY_ENABLED = 'false';
const store = await import('../agent/lib/store.ts');
const { sourceVersion } = await import('../agent/lib/assistant-memory.ts');
const listTasks = (await import('../agent/tools/list_tasks.ts')).default;
const recordUpdate = (await import('../agent/tools/record_update.ts')).default;
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


async function reset() {
  store.updateState(() => ({
    employees: [
      { id: 'manager', name: 'Руководитель · тест', role: 'manager' },
      { id: 'second-manager', name: 'Другой руководитель · тест', role: 'manager' },
      { id: 'employee', name: 'Исполнитель А · тест', role: 'employee' },
      { id: 'other', name: 'Исполнитель Б · тест', role: 'employee' },
    ], tasks: [], sources: [], events: [],
    settings: { timezone: 'Europe/Moscow', startHour: 9, endHour: 18, minHoursBetween: 6, excludedDates: [] },
  }));
  return { manager: await signin('manager'), second: await signin('second-manager'), employee: await signin('employee'), other: await signin('other') };
}
const fields = (title, employeeId = 'employee', due = day(7)) => ({ title, employeeId, due, dueTime: '16:30', description: 'Вымышленное поручение.', project: 'Тест' });
async function create(auth, title, employeeId, due, parentId) {
  const parent = parentId ? await target(parentId, auth) : null;
  const result = await ok('task-create', command({ fields: fields(title, employeeId, due), ...(parent ? { parentId, expectedParentVersion: parent.expectedVersion } : {}) }), auth);
  return result.taskId;
}
const memory = (id, auth) => ok(`memory?taskId=${encodeURIComponent(id)}`, undefined, auth);
const snapshotTask = (id, auth) => memory(id, auth).then(result => result.task);
const selected = async (ids, auth) => Promise.all(ids.map(async taskId => ({ taskId, expectedVersion: (await target(taskId, auth)).expectedVersion })));

// These scenarios exercise real authenticated handlers/SQLite, not a browser
// filter or model interpretation. Only fictional records and local processes.
test('Child tasks retain independent assignees, original deadlines and completion; parent never auto-completes', async () => {
  const a = await reset();
  const parent = await create(a.manager, 'Родительское поручение', 'manager', day(14));
  const child = await create(a.manager, 'Дочернее поручение', 'employee', day(4), parent);
  const sibling = await create(a.manager, 'Параллельное поручение', 'other', day(6), parent);
  const parentBefore = await snapshotTask(parent, a.manager);
  let childTask = await snapshotTask(child, a.manager);
  assert.equal(childTask.parentId, parent);
  assert.equal(childTask.employeeId, 'employee');
  assert.equal(childTask.due, day(4));
  assert.equal(childTask.originalDue, day(4));
  assert.equal(childTask.originalDueTime, '16:30');
  const parentMemory = await memory(parent, a.manager);
  assert.deepEqual(parentMemory.children.map(t => t.id).sort(), [child, sibling].sort());
  assert.equal(parentMemory.children.find(t => t.id === child).employeeId, 'employee');
  await ok('task-edit', command({ ...await target(child, a.manager), fields: { ...fields('Дочернее поручение', 'employee', day(5)), dueTime: '17:45' } }), a.manager);
  childTask = await snapshotTask(child, a.manager);
  assert.equal(childTask.due, day(5));
  assert.equal(childTask.originalDue, day(4));
  assert.equal(childTask.originalDueTime, '16:30');
  await ok('report', command({ taskId: child, text: 'Работа выполнена, прошу проверить.' }), a.employee);
  assert.equal((await snapshotTask(child, a.manager)).status, 'review');
  await ok('decision', command({ ...await target(child, a.manager), action: 'accept' }), a.manager);
  assert.equal((await snapshotTask(child, a.manager)).status, 'done');
  const parentAfter = await snapshotTask(parent, a.manager);
  assert.equal(parentAfter.status, parentBefore.status);
  assert.equal(parentAfter.due, parentBefore.due);
  assert.equal(parentAfter.originalDue, parentBefore.originalDue);
});

test('Parent binding requires manager and fresh existing parent; reparenting and corrupt ancestor chains are rejected', async () => {
  const a = await reset();
  const parent = await create(a.manager, 'Родитель', 'manager', day(14));
  const old = await target(parent, a.manager);
  const commandForChild = () => command({ fields: fields('Потомок'), parentId: parent, expectedParentVersion: old.expectedVersion });
  assert.equal((await request('task-create', commandForChild(), a.employee)).status, 403);
  const missingVersion = await request('task-create', command({ fields: fields('Потомок'), parentId: parent }), a.manager);
  assert.equal(missingVersion.status, 400);
  assert.equal((await request('task-create', command({ fields: fields('Потомок'), parentId: 'missing', expectedParentVersion: old.expectedVersion }), a.manager)).status, 404);
  await ok('task-edit', command({ ...old, fields: fields('Изменённый родитель', 'manager', day(15)) }), a.manager);
  assert.equal((await request('task-create', commandForChild(), a.manager)).status, 409);
  const child = await create(a.manager, 'Потомок', 'employee', day(5), parent);
  assert.equal((await request('task-edit', command({ ...await target(child, a.manager), fields: fields('Потомок'), parentId: child }), a.manager)).status, 400);
  // An imported legacy cycle must not be extended or hang parent traversal.
  store.updateState(state => { state.tasks.find(t => t.id === parent).parentId = child; return state; });
  const cyclic = await request('task-create', command({ fields: fields('Недопустимый потомок'), parentId: child, expectedParentVersion: (await target(child, a.manager)).expectedVersion }), a.manager);
  assert.ok([400, 409].includes(cyclic.status));
  assert.equal(store.readState().tasks.length, 2);
});

test('Employee read routes reveal neither unassigned parent metadata nor sibling tasks or private report snapshots', async () => {
  const a = await reset();
  const parent = await create(a.manager, 'СЕКРЕТНЫЙ-РОДИТЕЛЬ-НАИМЕНОВАНИЕ', 'manager', day(14));
  const child = await create(a.manager, 'Разрешённое дочернее поручение', 'employee', day(5), parent);
  const sibling = await create(a.manager, 'СЕКРЕТНЫЙ-СОСЕД-НАИМЕНОВАНИЕ', 'other', day(6), parent);
  const receipt = await ok('message', command({ taskId: parent, text: 'СЕКРЕТНЫЙ-ИСТОЧНИК-РОДИТЕЛЯ' }), a.manager);
  const report = await ok('report-create', command({ selection: await selected([parent], a.manager) }), a.manager);
  for (const path of ['tasks', `memory?taskId=${encodeURIComponent(child)}`, `context?taskId=${encodeURIComponent(child)}`, `assistant?taskId=${encodeURIComponent(child)}`]) {
    const data = await ok(path, undefined, a.employee), text = JSON.stringify(data);
    assert.ok(!text.includes(parent), `Parent ID leaked via ${path}`);
    assert.ok(!text.includes(sibling), `Sibling ID leaked via ${path}`);
    assert.ok(!text.includes('СЕКРЕТНЫЙ'), `Parent/sibling text leaked via ${path}`);
  }
  const listed = await invoke(listTasks, {}, 'employee');
  assert.equal(listed.tasks.length, 1);
  assert.equal(Object.hasOwn(listed.tasks[0], 'parentId'), false);
  const at = new Date(referenceTime).toISOString(), sourceId = `local:${randomUUID()}`;
  store.saveSource({ id: sourceId, taskId: child, employeeId: 'employee', text: 'Подготовил исходные материалы.', occurredAt: at, receivedAt: at });
  const updated = await invoke(recordUpdate, { sourceId, taskId: child, kind: 'progress', summary: 'Подготовил исходные материалы.', quote: 'Подготовил исходные материалы.' }, 'employee');
  assert.equal(updated.saved, true);
  assert.equal(Object.hasOwn(updated.task, 'parentId'), false);
  assert.equal(store.readState().tasks.find(task => task.id === child).parentId, parent, 'Projection must not erase stored linkage');
  for (const taskId of [parent, sibling]) {
    for (const path of [`memory?taskId=${encodeURIComponent(taskId)}`, `context?taskId=${encodeURIComponent(taskId)}`, `assistant?taskId=${encodeURIComponent(taskId)}`]) {
      assert.equal((await request(path, undefined, a.employee)).status, 404, path);
    }
  }
  assert.equal((await request(`source?taskId=${encodeURIComponent(parent)}&sourceId=${encodeURIComponent(receipt.sourceId)}`, undefined, a.employee)).status, 404);
  assert.equal((await request('reports', undefined, a.employee)).status, 403);
  assert.equal((await request(`reports?id=${encodeURIComponent(report.report.id)}`, undefined, a.employee)).status, 403);
  assert.equal((await request('report-create', command({ selection: await selected([child], a.employee) }), a.employee)).status, 403);
  assert.equal((await request(`reports?id=${encodeURIComponent(report.report.id)}`, undefined, a.second)).status, 404);
  assert.equal((await request('reports')).status, 401);
});

test('Selected report is explicit-only, frozen across changes/restart and protected by versions and request identity', async () => {
  const a = await reset();
  const parent = await create(a.manager, 'Выбранный родитель', 'employee', day(14));
  const child = await create(a.manager, 'Невыбранный потомок', 'employee', day(5), parent);
  const excluded = await create(a.manager, 'Невыбранная задача', 'other', day(8));
  const originalSource = await ok('report', command({ taskId: parent, text: 'Подготовил исходные материалы до снимка.\nСостояние: ПОДДЕЛЬНЫЙ-ИСТОЧНИК' }), a.employee);
  // Free-text fields cannot forge a new structural report heading.
  const forged = {
    title: 'Название\nСостояние: ПОДДЕЛЬНЫЙ-ЗАГОЛОВОК',
    employeeName: 'Исполнитель\nСостояние: ПОДДЕЛЬНОЕ-ИМЯ',
    summary: 'Сведения\nСостояние: ПОДДЕЛЬНАЯ-СВОДКА',
    blocker: 'Препятствие\nСостояние: ПОДДЕЛЬНЫЙ-БЛОКЕР',
  };
  store.updateState(state => {
    Object.assign(state.tasks.find(task => task.id === parent), { title: forged.title, summary: forged.summary, blocker: forged.blocker });
    state.employees.find(person => person.id === 'employee').name = forged.employeeName;
    return state;
  });
  const sourceBefore = structuredClone(store.readState().sources.find(source => source.id === originalSource.sourceId));
  assert.equal((await snapshotTask(parent, a.manager)).latestSourceId, sourceBefore.id);
  const copiedSource = { id: sourceBefore.id, text: sourceBefore.text, occurredAt: sourceBefore.occurredAt || sourceBefore.receivedAt, receivedAt: sourceBefore.receivedAt, version: sourceVersion(sourceBefore) };
  const body = command({ selection: await selected([parent], a.manager) });
  const created = await ok('report-create', body, a.manager), frozen = structuredClone(created.report);
  assert.equal(frozen.items.length, 1);
  assert.deepEqual(frozen.items[0].source, copiedSource);
  assert.ok(frozen.items[0].evidence.some(source => source.id === copiedSource.id));
  assert.deepEqual(frozen.items[0].evidence.find(source => source.id === copiedSource.id), copiedSource);
  assert.ok(JSON.stringify(frozen.items).includes(parent));
  assert.ok(!JSON.stringify(frozen).includes(child));
  assert.ok(!JSON.stringify(frozen).includes(excluded));
  assert.equal(typeof frozen.text, 'string');
  for (const value of [...Object.values(forged), copiedSource.text]) {
    assert.ok(frozen.text.includes(JSON.stringify(value)), 'Free text must remain JSON-quoted');
    assert.ok(!frozen.text.includes(value), 'Literal newline must not become a report heading');
  }
  assert.ok(!/^Состояние: ПОДДЕЛЬН/m.test(frozen.text));
  assert.equal((await ok('report-create', body, a.manager)).duplicate, true);
  assert.equal((await request('report-create', { ...body, selection: await selected([child], a.manager) }, a.manager)).status, 409);
  await ok('task-edit', command({ ...await target(parent, a.manager), fields: fields('Название после снимка', 'manager', day(16)) }), a.manager);
  await ok('message', command({ taskId: parent, text: 'Сведения, появившиеся после снимка.' }), a.manager);
  store.updateState(state => { Object.assign(state.sources.find(source => source.id === originalSource.sourceId), { text: 'Изменённый источник после снимка.', occurredAt: new Date(referenceTime - 86400000).toISOString(), receivedAt: new Date(referenceTime + 86400000).toISOString() }); return state; });
  assert.notEqual(sourceVersion(store.readState().sources.find(source => source.id === originalSource.sourceId)), copiedSource.version);
  assert.equal((await request('report-create', { ...body, requestId: randomUUID() }, a.manager)).status, 409);
  assert.deepEqual((await ok(`reports?id=${encodeURIComponent(frozen.id)}`, undefined, a.manager)).report, frozen);
  assert.ok((await ok('reports', undefined, a.manager)).reports.some(report => report.id === frozen.id));
  assert.ok(!(await ok('reports', undefined, a.second)).reports.some(report => report.id === frozen.id));
  const childProcess = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {readFileSync} from 'node:fs';
    import {handleDashboardRequest} from './agent/lib/dashboard-api.ts';
    import {database} from './agent/lib/store.ts';
    const input=JSON.parse(readFileSync(0,'utf8'));
    const response=await handleDashboardRequest(new Request(input.origin+'/assistant/api/reports?id='+encodeURIComponent(input.id),{headers:{cookie:input.cookie}}),{assistantAvailable:false});
    console.log(JSON.stringify({status:response.status,body:await response.json()}));database().close();
  `], { cwd: process.cwd(), env: { ...process.env }, input: JSON.stringify({ origin, id: frozen.id, cookie: a.manager.cookie }), encoding: 'utf8', timeout: 15000 });
  assert.equal(childProcess.status, 0, childProcess.stderr);
  const persisted = JSON.parse(childProcess.stdout);
  assert.equal(persisted.status, 200); assert.deepEqual(persisted.body.report, frozen);
});

test('Legacy tasks do not acquire invented original deadlines when read or exported', async () => {
  const a = await reset();
  store.updateState(state => { state.tasks.push({ id: 'LEGACY-1', title: 'Старая задача', employeeId: 'employee', status: 'active', due: day(8), dueTime: '12:00' }); return state; });
  const before = structuredClone(store.readState().tasks[0]);
  const read = await snapshotTask('LEGACY-1', a.manager);
  assert.ok(read.originalDue === undefined || read.originalDue === null);
  const result = await ok('report-create', command({ selection: await selected(['LEGACY-1'], a.manager) }), a.manager);
  assert.equal(result.report.items.length, 1);
  const item = result.report.items[0];
  assert.ok(item.originalDue === undefined || item.originalDue === null);
  assert.deepEqual(store.readState().tasks[0], before);
});

test('Status request is idempotent while awaiting/no_reply; genuine reply retains history and allows a new request', async () => {
  const a = await reset(), taskId = await create(a.manager, 'Запрос статуса', 'employee', day(7));
  const first = command({ taskId, text: 'Сообщите текущий результат.', requestUpdate: true });
  const initial = await ok('message', first, a.manager);
  assert.equal((await snapshotTask(taskId, a.manager)).contact, 'awaiting');
  const beforeRepeat = structuredClone(store.readState());
  await ok('message', first, a.manager);
  await ok('message', command({ taskId, text: 'Повторно прошу статус.', requestUpdate: true }), a.manager);
  assert.equal(store.readState().sources.length, beforeRepeat.sources.length);
  assert.equal(store.readState().events.length, beforeRepeat.events.length);
  assert.equal((await request('message', { ...first, text: 'Подмена исходного запроса.' }, a.manager)).status, 409);
  store.updateState(state => { state.tasks.find(t => t.id === taskId).contact = 'no_reply'; return state; });
  const beforeNoReply = structuredClone(store.readState());
  await ok('message', command({ taskId, text: 'Ещё один запрос без ответа.', requestUpdate: true }), a.manager);
  assert.equal(store.readState().sources.length, beforeNoReply.sources.length);
  assert.equal(store.readState().events.length, beforeNoReply.events.length);
  const feedback = await ok('report', command({ taskId, text: 'Подготовил исходные материалы для дальнейшей проверки.' }), a.employee);
  assert.equal((await snapshotTask(taskId, a.manager)).contact, 'answered');
  const afterReply = store.readState().sources.length;
  await ok('message', command({ taskId, text: 'Каков следующий результат?', requestUpdate: true }), a.manager);
  assert.equal(store.readState().sources.length, afterReply + 1);
  const history = (await memory(taskId, a.manager)).conversation;
  assert.ok(history.some(source => source.id === initial.sourceId));
  assert.ok(history.some(source => source.id === feedback.sourceId));
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
});

test('Manual and automatic status requests share pending dedup; silence escalates without restarting the clock', async t => {
  const { monitorWorkspace } = await import('../agent/lib/workspace-monitor.ts');
  const { shouldCheckIn } = await import('../dist/domain.js');
  const a = await reset();
  const taskId = await create(a.manager, 'Общий контроль запросов', 'employee', '2026-11-02');
  store.updateState(state => { state.settings.prototypeAutoCheckins = true; state.settings.minHoursBetween = 5; return state; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T07:00:00Z') });
  try {
    a.manager = await signin('manager');
    a.employee = await signin('employee');
    await ok('message', command({ taskId, text: 'Сообщите статус утром.', requestUpdate: true }), a.manager);
    const requested = store.readState(), firstAt = requested.tasks[0].lastRequestedAt;
    assert.equal(firstAt, '2026-10-26T07:00:00.000Z');
    const firstCount = requested.sources.length;
    store.updateState(state => monitorWorkspace(state, '2026-10-26T13:00:00Z'));
    const silent = store.readState();
    assert.equal(silent.sources.length, firstCount, 'Automatic monitor must not duplicate manual request after the interval');
    assert.equal(silent.tasks[0].lastRequestedAt, firstAt);
    assert.equal(silent.tasks[0].contact, 'no_reply');
    assert.ok(silent.events.some(event => event.taskId === taskId && event.kind === 'no_reply'));
    assert.equal(shouldCheckIn(silent.tasks[0], '2026-10-26T13:00:00Z', silent.settings), false);
    assert.deepEqual(monitorWorkspace(silent, '2026-10-26T13:01:00Z'), silent, 'Repeated escalation is idempotent');
    t.mock.timers.setTime(Date.parse('2026-10-26T13:05:00Z'));
    const reply = await ok('report', command({ taskId, text: 'Подготовил исходные материалы, продолжаю работу.' }), a.employee);
    assert.equal(store.readState().tasks[0].contact, 'answered');
    const afterReply = store.readState().sources.length;
    store.updateState(state => monitorWorkspace(state, '2026-10-26T13:06:00Z'));
    assert.equal(store.readState().sources.length, afterReply, 'Fresh reply still observes minimum interval');
    store.updateState(state => monitorWorkspace(state, '2026-10-27T07:00:00Z'));
    const automatic = store.readState();
    assert.equal(automatic.sources.length, afterReply + 1);
    assert.equal(automatic.sources.at(-1).kind, 'assistant_check_in');
    assert.equal(automatic.tasks[0].contact, 'awaiting');
    assert.equal(automatic.tasks[0].lastRequestedAt, '2026-10-27T07:00:00Z');
    t.mock.timers.setTime(Date.parse('2026-10-27T07:01:00Z'));
    a.manager = await signin('manager');
    await ok('message', command({ taskId, text: 'Ручной повтор автоматического запроса.', requestUpdate: true }), a.manager);
    const repeated = store.readState();
    assert.equal(repeated.sources.length, automatic.sources.length);
    assert.equal(repeated.events.length, automatic.events.length);
    assert.equal(repeated.tasks[0].lastRequestedAt, automatic.tasks[0].lastRequestedAt);
    assert.ok(repeated.sources.some(source => source.id === reply.sourceId));
    assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  } finally { t.mock.timers.reset(); }
});
