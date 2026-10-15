import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, editTask } from '../dist/workspace-model.js';
import { runAssistantWorkflow, semanticSearch, findSimilarTasks } from '../dist/langgraph-emb.js';
import { classifyMessageIntent, requestedDate } from '../dist/feedback.js';
import { scopedWorkspace } from '../dist/access.js';
import { taskMemory } from '../dist/task-memory.js';
import { decide, reconcileNoReplies } from '../dist/domain.js';

const NOW = '2026-10-15T12:00:00+03:00';
const actor = (ws, id) => ws.employees.find(p => p.id === id);
const source = (id, text, taskId = 'П-102', employeeId = 'elena', at = NOW) => ({ id, text, taskId, employeeId, receivedAt: at, occurredAt: at });
const report = (ws, s) => runAssistantWorkflow(ws, { mode: 'server', actorId: s.employeeId, source: s, now: NOW });

test('Негативные формулировки не снимают блокер и не объявляют готовность', () => {
  for (const [text, expected] of [
    ['Препятствие не устранено.', 'blocked'], ['Блокировка не снята.', 'blocked'],
    ['Работа не выполнена.', 'unclear'], ['Ещё не готово к проверке.', 'unclear'],
    ['Данные получим завтра.', 'unclear'], ['Работа выполнена?', 'unclear'],
    ['Проблем нет, всё выполнено.', 'review'], ['Данные получены частично.', 'unclear'],
    ['Данные получены, но ещё нет доступа, нужна помощь.', 'unclear'],
  ]) {
    const result = report(createWorkspace(NOW), source(text, text));
    assert.equal(result.run.classification.kind, expected, text);
    if (expected === 'unclear' || expected === 'blocked') assert.equal(result.state.tasks.find(t => t.id === 'П-102').status, 'blocked', text);
  }
});

test('Дата извлекается явно, без придуманного переноса на три дня', () => {
  for (const text of ['Прошу перенести срок.', 'Прошу перенести на 31 ноября.', 'Прошу перенести на 25 или 26 октября.', 'Прошу не переносить срок на 25 октября.']) assert.equal(classifyMessageIntent(text, { defaultDue: '2026-10-16', now: NOW }).kind, 'unclear', text);
  assert.equal(requestedDate('прошу перенести на 25 октября', { now: NOW }), '2026-10-25');
  assert.equal(requestedDate('прошу перенести на 25.10.2026', { now: NOW }), '2026-10-25');
  assert.equal(requestedDate('прошу перенести на 3 дня', { defaultDue: '2026-10-16', now: NOW }), '2026-10-19');
  assert.equal(requestedDate('прошу перенести на 3 дня', { now: NOW }), null);
  assert.equal(requestedDate('прошу перенести на завтра', { now: '2026-10-15T22:30:00Z' }), '2026-10-17');
});

test('Поиск, похожие задачи и граф не раскрывают чужие задачи или черновики', () => {
  const ws = createWorkspace(NOW);
  ws.sources.push(source('unbound', 'Закрытое обсуждение бюджета', null));
  ws.decisionDrafts = [{ id: 'private', taskId: 'П-101', title: 'Секретный черновик', body: 'Решение ещё не принято' }];
  const scoped = scopedWorkspace(ws, actor(ws, 'anna'));
  assert.equal(scoped.decisionDrafts.length, 0);
  assert.ok(!semanticSearch(scoped, 'Закрытое обсуждение бюджета').results.some(r => r.id === 'source:unbound'));
  assert.ok(findSimilarTasks(scoped, 'П-101').every(r => r.employeeId === 'anna'));
  assert.equal(semanticSearch(ws, 'Закрытое обсуждение бюджета', { scopeIds: new Set() }).results.length, 0);
  const denied = runAssistantWorkflow(ws, { actorId: 'dmitry', taskId: 'П-102', message: 'ФОТ и бюджет', now: NOW });
  assert.match(denied.reply, /только свои/);
  assert.ok(denied.embContext.topMatches.every(r => r.employeeId === 'dmitry'));
  assert.equal(denied.embContext.memory, null);
  assert.throws(() => taskMemory(ws, actor(ws, 'anna'), 'П-102'), /Нет доступа/);
});

test('Неоднозначная задача не выбирается по сходству и не меняется', () => {
  const ws = createWorkspace(NOW);
  for (const message of ['По П-101 и П-105 работа полностью готова.', 'Не успеваем, нужна помощь.']) {
    const result = runAssistantWorkflow(ws, { actorId: 'anna', message, now: NOW });
    assert.deepEqual(result.state.tasks, ws.tasks);
    assert.match(result.reply, /Уточните ID/);
  }
  const unbound = report(ws, source('no-task', 'П-102 полностью готова', null));
  assert.deepEqual(unbound.state.tasks, ws.tasks);
});

test('Проверенный источник сохраняет автора, время и идемпотентность', () => {
  const ws = createWorkspace(NOW), s = source('telegram:1:1', 'Препятствие не устранено.');
  const first = report(ws, s), second = report(first.state, s);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.state, first.state);
  assert.equal(second.notifications.length, 0);
  assert.throws(() => runAssistantWorkflow(ws, { mode: 'server', actorId: 'manager', source: s }), /источник автора/);
  assert.throws(() => runAssistantWorkflow(ws, { mode: 'server', actorId: 'elena', message: s.text }), /источник/);
  assert.throws(() => runAssistantWorkflow(ws, { mode: 'server', actorId: 'elena', taskId: 'П-107', source: s }), /привязку/);
  const late = report(first.state, source('telegram:1:2', 'Данные получены, препятствие устранено.', 'П-102', 'elena', '2026-10-14T12:00:00+03:00'));
  assert.equal(late.state.tasks.find(t => t.id === 'П-102').status, 'blocked');
  assert.equal(late.state.events[0].kind, 'late_report');
  assert.equal(late.notifications.length, 0);
});

test('Подготовка запроса не создаёт ложного отсутствия ответа', () => {
  const ws = createWorkspace(NOW), before = ws.tasks.find(t => t.id === 'П-101');
  const result = runAssistantWorkflow(ws, { actorId: 'manager', taskId: 'П-101', eventType: 'check_in_request', now: NOW });
  assert.deepEqual(result.state.tasks.find(t => t.id === 'П-101'), before);
  assert.equal(result.notifications[0].delivery, 'prepared');
  assert.match(result.reply, /Отправка не выполнялась/);
  assert.notEqual(reconcileNoReplies(result.state, '2026-10-15T18:00:00+03:00').tasks.find(t => t.id === 'П-101').contact, 'no_reply');
});

test('Память связывает факты с источниками, отделяет решения и переживает очистку трасс', () => {
  let ws = createWorkspace(NOW);
  ws = report(ws, source('request', 'Прошу перенести на 25 октября.')).state;
  const manager = actor(ws, 'manager');
  ws = decide(ws, 'П-102', 'approve_due', manager, '2026-10-15T12:10:00+03:00');
  ws = report(ws, source('vague', 'Занимаюсь.', 'П-102', 'elena', '2026-10-15T12:15:00+03:00')).state;
  ws.graphRuns = [];
  const memory = taskMemory(JSON.parse(JSON.stringify(ws)), manager, 'П-102', { limit: 1 });
  assert.equal(memory.current.due, '2026-10-25');
  assert.equal(memory.current.proposedDue, null);
  assert.equal(memory.facts.find(f => f.field === 'summary').origin.sourceId, 'request');
  assert.ok(memory.facts.find(f => f.field === 'due').origin.eventId.startsWith('decision:'));
  assert.equal(memory.recentDecisions[0].action, 'approve_due');
  assert.ok(memory.graph.edges.some(e => e.relation === 'supported_by' && e.to === 'source:request'));
  assert.ok(memory.graph.nodes.some(n => n.type === 'decision'));
  assert.ok(memory.openQuestions.some(q => /конкретный результат/.test(q)));
  assert.ok(memory.page.nextBefore);
  const next = taskMemory(ws, manager, 'П-102', { before: memory.page.nextBefore, limit: 1 });
  assert.notEqual(next.timeline[0].key, memory.timeline[0].key);
});

test('Ручная правка имеет своё основание; черновик остаётся предложением', () => {
  let ws = report(createWorkspace(NOW), source('blocker', 'Препятствие не устранено.')).state;
  ws.drafts = { 'П-102:request': { taskId: 'П-102', title: 'Письмо', body: 'Предлагаю запросить данные.', sourceId: 'blocker' } };
  const task = ws.tasks.find(t => t.id === 'П-102');
  ws = editTask(ws, task.id, { ...task, summary: 'Уточнённый руководителем результат' }, '2026-10-15T12:30:00+03:00');
  const memory = taskMemory(ws, actor(ws, 'manager'), task.id);
  const origin = memory.facts.find(f => f.field === 'summary').origin;
  assert.equal(origin.sourceId, null);
  assert.ok(origin.eventId.startsWith('edit:'));
  assert.equal(memory.drafts[0].status, 'draft');
  assert.ok(memory.graph.edges.some(e => e.relation === 'context_from'));
  assert.equal(taskMemory(ws, actor(ws, 'elena'), task.id).drafts.length, 0);
});
