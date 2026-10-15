import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createWorkspace, addTask } from '../dist/workspace-model.js';
import {
  EMBEDDING_DIM,
  START,
  END,
  StateGraph,
  stemRussian,
  computeEmbedding,
  cosineSimilarity,
  buildKnowledgeIndex,
  semanticSearch,
  findSimilarTasks,
  classifyMessageIntent,
  runAssistantWorkflow
} from '../dist/langgraph-emb.js';

const NOW = '2026-10-14T12:00:00+03:00';

test('Emb (64d): векторные эмбеддинги нормализованы и сближают близкие по смыслу управленческие понятия', () => {
  assert.equal(stemRussian('подразделениями'), 'подразделен');
  const vBudget = computeEmbedding('Расчёт численности и ФОТ по бюджетной смете подразделений');
  const vFinance = computeEmbedding('Финансовый план затрат и фонд оплаты труда');
  const vProcurement = computeEmbedding('Согласование технического задания на закупку у поставщика');

  assert.equal(vBudget.length, EMBEDDING_DIM);
  const norm = Math.sqrt(vBudget.reduce((acc, x) => acc + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, 'Вектор нормализован до единичной длины');

  const simBudgetFinance = cosineSimilarity(vBudget, vFinance);
  const simBudgetProcurement = cosineSimilarity(vBudget, vProcurement);
  assert.ok(simBudgetFinance > simBudgetProcurement, `Близкие концепты ближе (${simBudgetFinance} > ${simBudgetProcurement})`);
});

test('Emb (64d): семантический поиск и поиск похожих задач находят релевантные поручения и источники', () => {
  const ws = createWorkspace(NOW);
  const index = buildKnowledgeIndex(ws);
  assert.equal(index.dimension, 64);
  assert.ok(index.count >= ws.tasks.length + ws.sources.length);

  const searchFot = semanticSearch(ws, 'нет данных о численности и ФОТ подразделений', { topK: 3 });
  assert.ok(searchFot.results.length > 0);
  assert.equal(searchFot.results[0].taskId, 'П-102');

  const searchTz = semanticSearch(ws, 'дополнительные требования по согласованию ТЗ и закупки', { topK: 3 });
  assert.ok(searchTz.results.some(r => r.taskId === 'П-103'));

  const similar = findSimilarTasks(ws, 'П-102', 3);
  assert.ok(similar.length > 0);
  assert.ok(similar.every(s => s.taskId !== 'П-102'));
});

test('LangGraph StateGraph: поддерживает узлы, условные переходы, редьюсеры каналов и трассировку', () => {
  const g = new StateGraph({
    count: { reducer: (a = 0, b = 0) => a + b, default: () => 0 },
    log: { reducer: (a = [], b = []) => [...a, ...b], default: () => [] },
    flag: { reducer: (_a, b) => b, default: () => false }
  });

  g.addNode('step_a', () => ({ count: 2, log: ['a'], flag: true, nodeSummary: 'Шаг A выполнен' }));
  g.addNode('step_b', () => ({ count: 3, log: ['b'], nodeSummary: 'Шаг B выполнен' }));
  g.addNode('step_c', () => ({ count: 10, log: ['c'], nodeSummary: 'Шаг C выполнен' }));

  g.addEdge(START, 'step_a');
  g.addConditionalEdges('step_a', s => (s.flag ? 'go_b' : 'go_c'), { go_b: 'step_b', go_c: 'step_c' });
  g.addEdge('step_b', END);
  g.addEdge('step_c', END);

  const compiled = g.compile({ name: 'test_graph' });
  const res = compiled.invoke({ count: 1 });
  assert.equal(res.state.count, 6);
  assert.deepEqual(res.state.log, ['a', 'b']);
  assert.equal(res.trace.length, 2);
  assert.equal(res.trace[0].route, 'condition:go_b');
});

test('LangGraph Workflow: обработка фидбека сотрудников (блокер, перенос срока, готовность, снятие блокера, неясный ответ)', () => {
  let ws = createWorkspace(NOW);

  // 1. Сотрудник сообщает о проблеме (блокер) по П-101
  const blockedRun = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'anna',
    taskId: 'П-101',
    message: 'Возникла проблема: два филиала не дают таблицу расходов, нужна помощь руководителя.',
    now: NOW
  });
  ws = blockedRun.state;
  const t101 = ws.tasks.find(t => t.id === 'П-101');
  assert.equal(t101.status, 'blocked');
  assert.equal(t101.needsDecision, true);
  assert.match(t101.blocker, /не дают таблицу расходов/);
  assert.ok(blockedRun.notifications.some(n => n.to === 'manager' && n.kind === 'blocker_escalation'));
  assert.ok(blockedRun.notifications.some(n => n.to === 'anna' && n.kind === 'employee_ack'));
  assert.equal(blockedRun.trace.length, 6);

  // 2. Сотрудник сообщает о снятии блокера по П-101
  const unblockedRun = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'anna',
    taskId: 'П-101',
    message: 'Данные получены, препятствие устранено, продолжаем свод.',
    now: '2026-10-14T12:10:00+03:00'
  });
  ws = unblockedRun.state;
  assert.equal(ws.tasks.find(t => t.id === 'П-101').status, 'active');
  assert.equal(ws.tasks.find(t => t.id === 'П-101').blocker, '');

  // 3. Сотрудник просит перенести срок (утверждённый срок не должен меняться без решения руководителя)
  const dueBefore = ws.tasks.find(t => t.id === 'П-105').due;
  const dueRun = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'anna',
    taskId: 'П-105',
    message: 'Не успеваем к сроку из-за сверки, прошу перенести на 2026-10-25.',
    now: '2026-10-14T12:20:00+03:00'
  });
  ws = dueRun.state;
  const t105 = ws.tasks.find(t => t.id === 'П-105');
  assert.equal(t105.due, dueBefore, 'Утверждённый срок защищён до решения руководителя');
  assert.equal(t105.proposedDue, '2026-10-25');
  assert.equal(t105.needsDecision, true);
  assert.ok(dueRun.notifications.some(n => n.kind === 'deadline_escalation' && n.to === 'manager'));

  // 4. Сотрудник сообщает о готовности результата -> статус review (не done)
  const reviewRun = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'anna',
    taskId: 'П-101',
    message: 'Работа полностью готова, все подразделения прислали данные, отправляю на проверку.',
    now: '2026-10-14T12:30:00+03:00'
  });
  ws = reviewRun.state;
  assert.equal(ws.tasks.find(t => t.id === 'П-101').status, 'review');
  assert.ok(reviewRun.notifications.some(n => n.kind === 'ready_for_review' && n.to === 'manager'));

  // 5. Неясный ответ ("занимаюсь") -> не придумывает прогресс, ставит needsClarification
  const summaryBefore = ws.tasks.find(t => t.id === 'П-107').summary;
  const unclearRun = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'elena',
    taskId: 'П-107',
    message: 'Занимаюсь, смотрю.',
    now: '2026-10-14T12:40:00+03:00'
  });
  ws = unclearRun.state;
  assert.equal(ws.tasks.find(t => t.id === 'П-107').summary, summaryBefore);
  assert.equal(ws.tasks.find(t => t.id === 'П-107').needsClarification, true);
  assert.ok(unclearRun.notifications.some(n => n.kind === 'clarify_followup' && n.to === 'elena'));
});

test('LangGraph Guardrails и уведомления сотрудникам о новых задачах и запросах статуса', () => {
  let ws = createWorkspace(NOW);

  // Попытка чужого сотрудника изменить задачу П-102 (исполнитель elena, пишет dmitry)
  const unauthorized = runAssistantWorkflow(ws, {
    eventType: 'employee_feedback',
    actorId: 'dmitry',
    taskId: 'П-102',
    message: 'Всё готово к проверке',
    now: NOW
  });
  assert.equal(unauthorized.state.tasks.find(t => t.id === 'П-102').status, 'blocked', 'Чужая задача не изменилась');
  assert.match(unauthorized.reply, /только свои поручения/);

  // Создание новой задачи формирует уведомление сотруднику
  const added = addTask(ws, { title: 'Подготовить матрицу рисков ИТ', employeeId: 'dmitry', due: '2026-10-22' }, NOW);
  ws = added.state;
  assert.ok(ws.notifications.some(n => n.taskId === added.task.id && n.to === 'dmitry' && n.kind === 'task_assigned'));

  // Запрос статуса у сотрудника через LangGraph
  const checkin = runAssistantWorkflow(ws, {
    eventType: 'check_in_request',
    actorId: 'manager',
    taskId: added.task.id,
    now: '2026-10-14T13:00:00+03:00'
  });
  assert.equal(checkin.state.tasks.find(t => t.id === added.task.id).contact, 'awaiting');
  assert.ok(checkin.notifications.some(n => n.kind === 'check_in' && n.to === 'dmitry'));
});

test('UI: LangGraph Studio, семантический поиск Emb и интерактивный фидбек сотрудника в разделе Ассистент', async () => {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'), {
    url: 'https://assistant.test/#chat',
    pretendToBeVisual: true,
    virtualConsole
  });
  const w = dom.window, d = w.document, intervals = [], oldInterval = globalThis.setInterval;
  w.matchMedia = () => ({ matches: true, addEventListener() {} });
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  globalThis.setInterval = (fn, ms) => { const t = oldInterval(fn, ms); t.unref(); intervals.push(t); return t; };
  Object.assign(globalThis, { window: w, document: d, location: w.location, history: w.history, localStorage: w.localStorage, FormData: w.FormData, requestAnimationFrame: fn => fn() });

  try {
    await import('../dist/app.js?langgraph-ui');
    assert.ok(d.querySelector('.lg-studio'), 'Панель LangGraph Studio отображается в разделе Ассистент');
    assert.equal(d.querySelectorAll('.lg-node').length, 6, 'Отображаются все 6 узлов LangGraph');
    assert.ok(d.querySelectorAll('.emb-hit').length > 0, 'Отображаются результаты Emb-поиска');

    // Отправка фидбека от сотрудника через форму
    const empSelect = d.querySelector('#feedback-employee');
    empSelect.value = 'anna';
    empSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
    d.querySelector('#feedback-task').value = 'П-101';
    d.querySelector('#feedback-message').value = 'Появилась проблема: нет сводной таблицы от смежников, нужна помощь руководителя.';
    d.querySelector('#employee-feedback-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

    const saved = JSON.parse(w.localStorage.getItem('rut-assistant-demo-v02'));
    assert.equal(saved.tasks.find(t => t.id === 'П-101').status, 'blocked');
    assert.ok(saved.notifications.some(n => n.taskId === 'П-101' && n.kind === 'blocker_escalation'));
    assert.deepEqual(errors, []);
  } finally {
    intervals.forEach(clearInterval);
    globalThis.setInterval = oldInterval;
    dom.window.close();
  }
});
