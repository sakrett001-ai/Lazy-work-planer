import { pathToFileURL } from 'node:url';
import { readState, updateState } from '../agent/lib/store.ts';
import { issueInvite, serverOrigin } from '../agent/lib/web-auth.ts';
import { createPilotServer } from './pilot-server.mjs';
import { runAssistantWorkflow } from '../dist/langgraph-emb.js';

export function initializePrototype({ examples = true, now = new Date() } = {}) {
  if (readState().employees.length || readState().tasks.length) return false;
  const at = now.toISOString(), day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now);
  const shift = n => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let state = {
    employees: [{ id: 'manager', name: 'Руководитель', role: 'manager' }],
    tasks: [], sources: [], events: [],
    settings: { timezone: 'Europe/Moscow', startHour: 9, endHour: 18, minHoursBetween: 6, excludedDates: [], prototypeExamples: examples },
  };
  if (examples) {
    state.employees.push({ id: 'employee-1', name: 'Александра · пример', role: 'employee' }, { id: 'employee-2', name: 'Михаил · пример', role: 'employee' });
    const tasks = [
      ['П-001', 'Собрать предложения по проекту', 'employee-1', 3, 'active', 'Общий план'],
      ['П-002', 'Согласовать итоговый план', 'employee-2', 2, 'active', 'Общий план'],
      ['П-003', 'Проверить отчёт и исходные расчёты', 'employee-1', 0, 'active', 'Отчётность'],
      ['П-004', 'Подготовить повестку встречи', 'employee-2', 4, 'planned', 'Команда'],
      ['П-005', 'Разобрать личные приоритеты', 'manager', null, 'planned', 'Личное'],
      ['П-006', 'Сверить исходные данные', 'employee-1', -1, 'active', 'Отчётность'],
    ];
    state.tasks = tasks.map(([id, title, employeeId, days, status, project]) => ({
      id, title, employeeId, project, start: shift(-2), due: days === null ? null : shift(days), dueTime: '18:00',
      status, contact: 'not_requested', summary: 'Ожидаем первое обновление.', description: 'Вымышленное поручение для проверки прототипа. Можно отредактировать или пройти весь цикл выполнения.', needsDecision: false,
    }));
    state.tasks[0].phases = [
      { id: 'collect', title: 'Собрать исходные предложения', start: shift(-2), end: day, done: false, dependsOn: null },
      { id: 'summarize', title: 'Подготовить свод и выводы', start: day, end: shift(3), done: false, dependsOn: 'collect' },
    ];
    state.tasks[3].protocol = { number: 'ПЛ-01 · пример', point: '2', date: shift(-3) };
    state.events = state.tasks.map(task => ({ key: `example:${task.id}`, taskId: task.id, kind: 'created', actorId: 'manager', at, text: 'Создано вымышленное поручение для проверки прототипа.' }));
    for (const [taskId, text] of [
      ['П-002', 'Есть препятствие: не получены исходные предложения. Нужна помощь руководителя.'],
      ['П-003', 'Работа выполнена, отчёт готов к проверке.'],
    ]) {
      const task = state.tasks.find(t => t.id === taskId), source = { id: `example-source:${taskId}`, taskId, employeeId: task.employeeId, text, receivedAt: at, occurredAt: at, simulated: true };
      state = runAssistantWorkflow(state, { eventType: 'employee_feedback', taskId, message: text, mode: 'server', actorId: task.employeeId, source, now: at, operationId: source.id }).state;
    }
  }
  updateState(current => {
    if (current.employees.length || current.tasks.length) throw new Error('База уже заполнена; начальная настройка отменена.');
    return state;
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ASSISTANT_PORT || 8787), host = process.env.ASSISTANT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный ASSISTANT_PORT.');
  if (!process.env.ASSISTANT_SERVER_ORIGIN && host === '127.0.0.1') process.env.ASSISTANT_SERVER_ORIGIN = `http://127.0.0.1:${port}`;
  const origin = serverOrigin();
  const created = initializePrototype({ examples: !process.argv.includes('--empty') });
  const server = createPilotServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Порт занят. Останови прежний сервер или укажи другой ASSISTANT_PORT.' : 'Сервер не удалось запустить.'); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`\nLazy Work Planer · рабочий прототип\n${origin}/assistant/workspace\n`);
    console.log(created ? 'Создана новая база. Стартовые примеры отмечены в интерфейсе.' : 'Открыта существующая база. Данные сохранены.');
    for (const person of readState().employees.filter(p => p.role === 'manager')) console.log(`\nКод входа для «${person.name}» (30 минут, одноразовый):\n${issueInvite(person.id)}`);
    console.log('\nКоды сотрудникам: раздел «Участники» после входа. Для проверки разных ролей используй отдельный браузер или приватное окно.\nИИ-консультации: раздел «Модели и роли», после настройки подключений на сервере.\nОстановить сервер: Ctrl+C.');
  });
}
