import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, migrateWorkspace, selectTasks } from '../dist/workspace-model.js';
import { togglePin, pinnedIds, attentionSignal, acknowledgeSignal, isUnseen, snapshotTasks, taskUpdates, presentationPreferences, DashboardPlayer } from '../dist/attention.js';

const NOW = '2026-10-14T12:00:00+03:00';
test('Закрепление сохраняет порядок выбора, учитывает область и исключает архив', () => {
  const original = createWorkspace(NOW);
  let state = togglePin(togglePin(original, 'Л-201'), 'П-102');
  assert.deepEqual(pinnedIds(state), ['Л-201', 'П-102']);
  assert.equal(original.settings.pinnedTaskIds, undefined);
  const mine = selectTasks(state, { scope: 'mine' }, NOW);
  assert.deepEqual(pinnedIds(state).filter(id => mine.some(t => t.id === id)), ['Л-201']);
  state.tasks = state.tasks.map(t => t.id === 'Л-201' ? { ...t, status: 'done' } : t);
  assert.deepEqual(pinnedIds(state), ['П-102']);
  assert.deepEqual(togglePin(state, 'Л-201'), state);
});

test('Замеченный сигнал не меняет задачу, но новое препятствие снова привлекает внимание', () => {
  const original = createWorkspace(NOW), task = original.tasks.find(t => t.id === 'П-102');
  const state = acknowledgeSignal(original, task.id, NOW);
  assert.deepEqual(state.tasks, original.tasks);
  assert.equal(isUnseen(state, task, NOW), false);
  assert.equal(isUnseen(state, { ...task, blocker: 'Добавилось новое препятствие' }, NOW), true);
  assert.equal(attentionSignal({ ...task, status: 'done' }, NOW), null);
});

test('Истечение срока создаёт одно новое событие и не повторяется при каждом тике', () => {
  const task = { id: 'a', title: 'Проверка', status: 'active', due: '2026-10-14', dueTime: '12:00' };
  const before = snapshotTasks([task], '2026-10-14T11:59:59+03:00');
  const crossed = taskUpdates(before, [task], NOW);
  assert.equal(crossed.events.length, 1);
  assert.equal(crossed.events[0].view, 'calendar');
  assert.equal(crossed.events[0].label, 'Срок истёк');
  assert.equal(taskUpdates(crossed.snapshot, [task], '2026-10-14T12:05:00+03:00').events.length, 0);
});

test('Обычные обновления, этапы и приёмка направляются на соответствующий экран', () => {
  const initial = { id: 'a', title: 'Проверка', status: 'active', summary: 'В работе' };
  let snapshot = snapshotTasks([initial], NOW);
  const phases = { ...initial, phases: [{ id: 'p', title: 'Этап', done: true }] };
  const changed = taskUpdates(snapshot, [phases], NOW);
  assert.equal(changed.events[0].view, 'timeline');
  assert.equal(changed.events[0].important, false);
  assert.equal(taskUpdates(changed.snapshot, [{ ...phases, status: 'done' }], NOW).events[0].view, 'archive');
});

test('Старое хранилище получает настройки без потери задач и сохранённых закреплений', () => {
  const state = createWorkspace(NOW);
  state.settings = { ...state.settings, pinnedTaskIds: ['Л-201'], presentation: { interval: 2, views: 42, events: 'unknown' } };
  const loaded = migrateWorkspace(JSON.parse(JSON.stringify(state)), NOW);
  assert.deepEqual(loaded.tasks, state.tasks);
  assert.deepEqual(pinnedIds(loaded), ['Л-201']);
  assert.deepEqual(presentationPreferences(loaded), { interval: 30, views: ['board', 'calendar', 'timeline'], events: 'important' });
});

test('Автопоказ ждёт ввода, выдерживает время между событиями и не работает после остановки', () => {
  const player = new DashboardPlayer(), preferences = { interval: 30, views: ['board', 'calendar', 'timeline'], events: 'important' };
  player.start(0, 30);
  player.enqueue({ taskId: 'a', view: 'timeline', priority: 0, label: 'Есть препятствие' });
  assert.equal(player.step({ now: 31000, view: 'board', busy: true, preferences }), null);
  assert.equal(player.pending.length, 1);
  const first = player.step({ now: 32000, view: 'board', busy: false, preferences });
  assert.equal(first.view, 'timeline');
  player.enqueue({ taskId: 'b', view: 'calendar', priority: 1 });
  player.enqueue({ taskId: 'b', view: 'board', priority: 1 });
  assert.equal(player.pending.length, 1, 'повторное событие задачи заменяет предыдущее');
  assert.equal(player.step({ now: 33000, view: 'timeline', busy: false, preferences }), null);
  assert.equal(player.step({ now: 62000, view: 'timeline', busy: false, preferences }).view, 'board');
  player.stop();
  assert.equal(player.step({ now: 999000, view: 'board', busy: false, preferences }), null);
});
