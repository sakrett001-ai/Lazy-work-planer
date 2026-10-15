import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { invoke } from './helpers/server-runtime.mjs';
import { createWorkspace } from '../dist/workspace-model.js';
import { reconcileNoReplies } from '../dist/domain.js';

const dataDir = mkdtempSync(join(tmpdir(), 'rut-memory-test-'));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_DELIVERY_ENABLED = 'false';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network disabled in tests'); };
const store = await import('../agent/lib/store.ts');
const notify = (await import('../agent/tools/notify_employee.ts')).default;
const graph = (await import('../agent/tools/run_monitoring_graph.ts')).default;
const search = (await import('../agent/tools/semantic_search.ts')).default;
const memory = (await import('../agent/tools/get_task_memory.ts')).default;
const recordUpdate = (await import('../agent/tools/record_update.ts')).default;
const reset = () => {
  process.env.ASSISTANT_DELIVERY_ENABLED = 'false';
  globalThis.fetch = () => { throw new Error('Network disabled in tests'); };
  store.database().exec('DELETE FROM inbox; DELETE FROM outbox;');
  store.updateState(() => createWorkspace(new Date()));
};
after(() => { globalThis.fetch = realFetch; store.database().close(); rmSync(dataDir, { recursive: true, force: true }); });

test('Сервер требует сохранённый SOURCE_ID и запрещает подмену автора и текста', async () => {
  reset();
  await assert.rejects(invoke(graph, { eventType: 'employee_feedback', taskId: 'П-101', message: 'Готово' }, 'anna'), /SOURCE_ID/);
  const at = new Date().toISOString();
  store.saveSource({ id: 'telegram:11:12', taskId: 'П-101', employeeId: 'anna', text: 'Препятствие не устранено, нужна помощь.', receivedAt: at, occurredAt: at });
  await assert.rejects(invoke(graph, { eventType: 'employee_feedback', sourceId: 'telegram:11:12' }, 'manager'), /Нет доступа/);
  await assert.rejects(invoke(graph, { eventType: 'employee_feedback', sourceId: 'telegram:11:12', message: 'Всё выполнено' }, 'anna'), /подменять/);
  const input = { eventType: 'employee_feedback', sourceId: 'telegram:11:12' };
  await invoke(graph, input, 'anna');
  const state = store.readState();
  assert.equal((await invoke(graph, input, 'anna')).duplicate, true);
  assert.deepEqual(store.readState(), state);
  assert.equal(state.sources.at(-1).id, input.sourceId);
});

test('Серверный поиск и память не раскрывают личные задачи руководителя', async () => {
  reset();
  const result = await invoke(search, { query: 'П-101', similarToTaskId: 'П-101' }, 'anna');
  assert.ok([...result.results, ...result.similarTasks].every(r => r.employeeId === 'anna'));
  await assert.rejects(invoke(memory, { taskId: 'Л-201' }, 'anna'), /Нет доступа/);
});

test('Модель не может записать выдуманную дату или обратить отрицание в готовность', async () => {
  reset();
  const at = new Date().toISOString();
  store.saveSource({ id: 'no-date', taskId: 'П-101', employeeId: 'anna', text: 'Прошу перенести срок.', receivedAt: at });
  const report = { kind: 'deadline_request', summary: 'Запрос переноса', quote: 'Прошу перенести срок.', proposedDue: '2026-12-25' };
  await assert.rejects(invoke(graph, { eventType: 'employee_feedback', sourceId: 'no-date', report }, 'anna'), /дата не подтверждается/);
  await assert.rejects(invoke(recordUpdate, { ...report, taskId: 'П-101', sourceId: 'no-date' }, 'anna'), /дата не подтверждается/);
  store.saveSource({ id: 'not-ready', taskId: 'П-101', employeeId: 'anna', text: 'Работа не выполнена.', receivedAt: at });
  await assert.rejects(invoke(graph, { eventType: 'employee_feedback', sourceId: 'not-ready', report: { kind: 'review', summary: 'Готово', quote: 'Работа не выполнена.' } }, 'anna'), /отрицание/);
});

test('Нет аккаунта или отправка выключена: ожидание ответа не начинается', async () => {
  reset();
  const before = store.readState().tasks.find(t => t.id === 'П-101');
  const failed = await invoke(notify, { taskId: 'П-101', kind: 'check_in' }, 'manager', 'missing-account');
  assert.equal(failed.notified, false);
  assert.equal(failed.delivery, 'failed');
  assert.equal(store.database().prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  assert.deepEqual(store.readState().tasks.find(t => t.id === 'П-101'), before);
  store.updateState(s => ({ ...s, employees: s.employees.map(p => p.id === 'anna' ? { ...p, telegramId: '12345' } : p) }));
  const draft = await invoke(notify, { taskId: 'П-101', kind: 'check_in' }, 'manager', 'draft');
  assert.equal(draft.delivery, 'draft');
  assert.equal(draft.notified, false);
  assert.equal(store.readState().tasks.find(t => t.id === 'П-101').lastRequestedAt, before.lastRequestedAt);
  const later = new Date(Date.now() + 6 * 3600000).toISOString();
  assert.notEqual(reconcileNoReplies(store.readState(), later).tasks.find(t => t.id === 'П-101').contact, 'no_reply');
});

test('Подтверждённая отправка учитывается один раз; разные сообщения не сливаются по минуте', async () => {
  reset();
  process.env.ASSISTANT_DELIVERY_ENABLED = 'true';
  store.updateState(s => ({ ...s, employees: s.employees.map(p => p.id === 'anna' ? { ...p, telegramId: '12345' } : p) }));
  let sent = 0;
  globalThis.fetch = async url => { assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage'); sent++; return { ok: true, json: async () => ({ ok: true, result: { message_id: sent } }) }; };
  const input = { taskId: 'П-101', kind: 'check_in', message: 'Что готово?' };
  assert.equal((await invoke(notify, input, 'manager', 'delivery-1')).delivery, 'sent');
  const timestamp = store.readState().tasks.find(t => t.id === 'П-101').lastRequestedAt;
  assert.ok(timestamp);
  assert.equal((await invoke(notify, input, 'manager', 'delivery-1')).duplicate, true);
  assert.equal(store.readState().tasks.find(t => t.id === 'П-101').lastRequestedAt, timestamp);
  assert.equal(sent, 1);
  await invoke(notify, { ...input, message: 'Какая нужна помощь?' }, 'manager', 'delivery-2');
  assert.equal(sent, 2);
  await assert.rejects(invoke(notify, { ...input, message: 'Другой текст' }, 'manager', 'delivery-1'), /другое действие/);
});

test('Отказ и неизвестный результат доставки не превращаются в отправку', async () => {
  for (const outcome of ['rejected', 'uncertain']) {
    reset(); process.env.ASSISTANT_DELIVERY_ENABLED = 'true';
    store.updateState(s => ({ ...s, employees: s.employees.map(p => p.id === 'anna' ? { ...p, telegramId: '12345' } : p) }));
    let calls = 0;
    globalThis.fetch = async () => { calls++; if (outcome === 'uncertain') throw new Error('Connection lost'); return { ok: false, json: async () => ({ ok: false }) }; };
    const input = { taskId: 'П-101', kind: 'check_in' };
    const result = await invoke(notify, input, 'manager', 'outcome');
    assert.equal(result.delivery, outcome); assert.equal(result.notified, false);
    assert.equal(store.readState().tasks.find(t => t.id === 'П-101').lastRequestedAt, undefined);
    await invoke(notify, input, 'manager', 'outcome'); assert.equal(calls, 1);
  }
});

test('Память читается из нового процесса после очистки диагностических запусков', async () => {
  reset();
  const at = new Date().toISOString();
  store.saveSource({ id: 'telegram:11:99', taskId: 'П-101', employeeId: 'anna', text: 'Препятствие не устранено, нужна помощь.', receivedAt: at, occurredAt: at });
  await invoke(graph, { eventType: 'employee_feedback', sourceId: 'telegram:11:99' }, 'anna');
  store.updateState(s => ({ ...s, graphRuns: [] }));
  const code = `import './tests/helpers/server-runtime.mjs';
    import { readState, database } from './agent/lib/store.ts';
    import { taskMemory } from './dist/task-memory.js';
    const state=readState();const memory=taskMemory(state,state.employees.find(p=>p.id==='anna'),'П-101');
    console.log(JSON.stringify({status:memory.current.status,source:memory.facts.find(f=>f.field==='blocker').origin.sourceId,traceCount:state.graphRuns.length}));database().close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ASSISTANT_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 'blocked', source: 'telegram:11:99', traceCount: 0 });
});

test('Резервная копия включает состояние, inbox и outbox из работающей WAL-базы', async () => {
  reset();
  const at = new Date().toISOString();
  store.saveSource({ id: 'backup-source', taskId: 'П-101', employeeId: 'anna', text: 'Препятствие не устранено.', receivedAt: at });
  await invoke(graph, { eventType: 'employee_feedback', sourceId: 'backup-source' }, 'anna');
  store.updateState(s => ({ ...s, employees: s.employees.map(p => p.id === 'anna' ? { ...p, telegramId: '12345' } : p) }));
  await invoke(notify, { taskId: 'П-101', kind: 'check_in' }, 'manager', 'backup-draft');
  const target = join(dataDir, 'backup.sqlite');
  const args = ['scripts/backup-state.mjs', target];
  const options = { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ASSISTANT_DATA_DIR: dataDir }, encoding: 'utf8' };
  const result = spawnSync(process.execPath, args, options);
  assert.equal(result.status, 0, result.stderr);
  const restored = new DatabaseSync(target, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(restored.prepare('SELECT data FROM state').get().data), store.readState());
    assert.equal(restored.prepare('SELECT count(*) AS n FROM inbox').get().n, 1);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
  } finally { restored.close(); }
  assert.notEqual(spawnSync(process.execPath, args, options).status, 0, 'Существующая копия не перезаписывается');
  const emptyTarget = join(dataDir, 'existing-empty.sqlite');
  writeFileSync(emptyTarget, '');
  assert.notEqual(spawnSync(process.execPath, ['scripts/backup-state.mjs', emptyTarget], options).status, 0);
  assert.equal(statSync(emptyTarget).size, 0, 'Даже пустой существующий файл не перезаписывается');
});
