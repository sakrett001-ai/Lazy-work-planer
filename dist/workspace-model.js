import { initialState, scenarios } from './fixtures.js';
import { clone, validDate, localDateKey, applyReport, decide } from './domain.js';

export const TIMEZONE = 'Europe/Moscow';
export const DAY = 86400000;
export const VIEWER = { id: 'manager', role: 'manager', department: 'planning' };
export function dayKey(now = new Date()) { return localDateKey(now, TIMEZONE); }
export function shiftDay(date, days) { return new Date(Date.parse(date + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10); }
export function shortDate(date, year = false) {
  if (!date || !validDate(date.slice(0, 10))) return 'Без срока';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: TIMEZONE }).format(new Date(date.slice(0, 10) + 'T12:00:00Z')).replace(/ г\.$/, '');
}
export function dueInstant(task) {
  if (!validDate(task.due)) return null;
  return Date.parse(task.due + 'T' + (/^([01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime || '') ? task.dueTime : '18:00') + ':00+03:00');
}
export function deadline(task, now = new Date()) {
  const end = dueInstant(task);
  if (end === null) return { kind: 'none', text: 'Без срока', left: null };
  if (task.status === 'done') return { kind: 'done', text: 'Завершено', left: null };
  const left = end - new Date(now).getTime(), amount = Math.abs(left);
  const days = Math.floor(amount / DAY), hours = Math.floor(amount / 3600000) % 24, minutes = Math.floor(amount / 60000) % 60;
  const text = days ? `${days} д ${hours} ч` : hours ? `${hours} ч ${minutes} мин` : `${Math.max(1, minutes)} мин`;
  return { kind: left <= 0 ? 'overdue' : left < DAY ? 'soon' : 'normal', text: left <= 0 ? `Просрочено на ${text}` : `Осталось ${text}`, left };
}
export function appearance(task, now = new Date()) {
  if (task.status === 'done') return { color: 'mint', label: 'Принято', icon: 'check' };
  if (task.status === 'blocked') return { color: 'coral', label: 'Препятствие', icon: 'alert' };
  if (task.status === 'review') return { color: 'violet', label: 'На проверке', icon: 'eye' };
  if (task.proposedDue) return { color: 'amber', label: 'Запрос переноса', icon: 'clock' };
  if (deadline(task, now).kind === 'overdue') return { color: 'amber', label: 'Срок истёк', icon: 'clock' };
  if (task.contact === 'no_reply') return { color: 'muted', label: 'Нет ответа', icon: 'message' };
  if (task.needsClarification) return { color: 'amber', label: 'Нужно уточнение', icon: 'message' };
  return task.status === 'planned' ? { color: 'muted', label: 'Запланировано', icon: 'calendar' } : { color: 'cyan', label: 'В работе', icon: 'activity' };
}
export function rankTask(task, now = new Date()) {
  if (task.status === 'done') return 9;
  if (task.status === 'blocked') return 0;
  if (task.proposedDue) return 1;
  if (deadline(task, now).kind === 'overdue') return 2;
  if (task.needsDecision || task.status === 'review') return 3;
  if (deadline(task, now).kind === 'soon') return 4;
  if (task.contact === 'no_reply' || task.needsClarification) return 5;
  return task.status === 'planned' ? 7 : 6;
}
export function scopeTasks(state, scope = 'management') {
  return state.tasks.filter(t => scope === 'mine' ? t.employeeId === VIEWER.id : scope === 'department' ? t.department === VIEWER.department : true);
}
export function selectTasks(state, { scope = 'management', filter = 'all', search = '', sort = 'priority', archive = false } = {}, now = new Date()) {
  const term = search.trim().toLocaleLowerCase('ru-RU'), today = dayKey(now);
  return scopeTasks(state, scope).filter(t => {
    if ((t.status === 'done') !== archive) return false;
    if (filter === 'attention' && rankTask(t, now) > 5) return false;
    if (filter === 'week' && (!t.due || t.due < today || t.due > shiftDay(today, 6))) return false;
    if (filter === 'undated' && t.due) return false;
    const owner = state.employees.find(p => p.id === t.employeeId);
    return [t.id, t.title, t.project, owner?.name, t.protocol?.number, t.protocol?.point].join(' ').toLocaleLowerCase('ru-RU').includes(term);
  }).sort((a, b) => {
    if (archive) return String(b.closedAt || '').localeCompare(a.closedAt || '') || a.id.localeCompare(b.id);
    if (sort === 'priority') { const rank = rankTask(a, now) - rankTask(b, now); if (rank) return rank; }
    return (dueInstant(a) ?? Infinity) - (dueInstant(b) ?? Infinity) || a.id.localeCompare(b.id);
  });
}
export function progress(task) {
  const phases = task.phases || [];
  return { total: phases.length, done: phases.filter(p => p.done).length };
}
export function createWorkspace(now = new Date()) {
  const state = initialState(), today = dayKey(now), d = offset => shiftDay(today, offset);
  state.version = 2; state.createdAt = new Date(now).toISOString(); state.drafts = {}; state.chat = [];
  state.settings = { ...state.settings, motion: true, achievements: true, autoArchive: true };
  state.employees = [
    { id: 'manager', name: 'Сергей', initials: 'С', department: 'planning', team: 'ПФУ', color: 'violet' },
    ...state.employees.map(p => ({ ...p, department: p.id === 'dmitry' ? 'procurement' : p.id === 'irina' ? 'accounts' : 'planning', color: ({ anna: 'cyan', elena: 'violet', dmitry: 'amber', irina: 'mint' })[p.id] }))
  ];
  const metadata = [
    { due: d(2), department: 'planning', protocol: { number: '12-БК', point: '3.2', date: d(-7) }, summary: '7 из 10 подразделений прислали уточнения. Ждём оставшиеся три.' },
    { due: d(1), department: 'planning', status: 'blocked', needsDecision: true, blocker: 'Нет данных о численности и ФОТ от двух подразделений.', nextAction: 'Помочь получить исходные данные', summary: 'Расчёты готовы. Для итогового свода не хватает данных от двух подразделений.', protocol: { number: '12-БК', point: '4.1', date: d(-7) }, phases: [
      { id: 'data', title: 'Сбор исходных данных', start: d(-4), end: d(-1), done: false, blocked: true, dependsOn: null },
      { id: 'analysis', title: 'Свод и проверка', start: d(0), end: d(1), done: false, dependsOn: 'data' },
      { id: 'approval', title: 'Материалы на согласование', start: d(1), end: d(1), done: false, dependsOn: 'analysis' }
    ] },
    { due: d(0), proposedDue: d(3), department: 'procurement', needsDecision: true, nextAction: 'Решить вопрос о переносе срока', summary: 'Появились дополнительные требования. Дмитрий просит перенести согласование.' },
    { due: d(0), department: 'accounts', summary: 'Расчёт подготовлен. Осталось проверить и принять результат.' },
    { due: d(4), department: 'planning', summary: 'Список обновляется. На последний запрос статуса ответа пока нет.' },
    { due: d(-2), closedAt: d(-2) + 'T16:00:00+03:00', department: 'planning', protocol: { number: '11-БК', point: '2', date: d(-14) } }
  ];
  state.tasks.forEach((t, i) => {
    Object.assign(t, { start: d(-4), dueTime: '18:00' }, metadata[i]);
    t.lastReply = d(t.contact === 'no_reply' ? -3 : 0) + 'T09:15:00+03:00';
    const source = state.sources.find(s => s.id === t.latestSourceId);
    if (source) { source.receivedAt = t.lastReply; source.text = t.summary; }
  });
  state.tasks.push(
    { id: 'Л-201', title: 'Обновить подход к планированию', employeeId: 'manager', department: 'planning', project: 'Развитие процессов', due: null, status: 'active', summary: 'Собрать свои идеи и подготовить вопросы для обсуждения с командой.', needsDecision: false, contact: 'answered', start: d(0) },
    { id: 'Л-202', title: 'Подготовиться к встрече с институтами', employeeId: 'manager', department: 'planning', project: 'Встречи', due: d(1), dueTime: '12:00', status: 'active', summary: 'Сформировать повестку: изменения в сметах, сроки и спорные вопросы.', contact: 'answered', start: d(0) },
    { id: 'П-107', title: 'Сверить план поступлений', employeeId: 'elena', department: 'planning', project: 'Аналитика', due: d(-1), dueTime: '18:00', status: 'active', summary: 'Нужно сопоставить поступления с последним прогнозом. Срок уже истёк.', contact: 'answered', start: d(-3) },
    { id: 'П-108', title: 'Подготовить финансовый прогноз', employeeId: 'anna', department: 'planning', project: 'Планирование', due: d(8), dueTime: '18:00', status: 'active', summary: 'Исходные данные собраны. Переходим к расчёту сценариев.', contact: 'answered', start: d(-2), phases: [
      { id: 'collect', title: 'Сбор данных', start: d(-2), end: d(-1), done: true, dependsOn: null },
      { id: 'forecast', title: 'Расчёт сценариев', start: d(0), end: d(4), done: false, dependsOn: 'collect' },
      { id: 'review', title: 'Проверка допущений', start: d(5), end: d(6), done: false, dependsOn: 'forecast' },
      { id: 'final', title: 'Итоговый прогноз', start: d(7), end: d(8), done: false, dependsOn: 'review' }
    ] },
    { id: 'П-109', title: 'Обновить календарь регулярных отчётов', employeeId: 'irina', department: 'accounts', project: 'Регулярная работа', due: d(6), dueTime: '18:00', status: 'planned', summary: 'Сверить периодичность отчётов и назначить контрольные даты.', contact: 'answered', start: d(2) }
  );
  state.events = state.events.map(e => ({ ...e, at: d(0) + 'T09:15:00+03:00' }));
  state.notifications = [
    { id: 'notif:seed:102', at: d(0) + 'T09:16:00+03:00', to: 'manager', recipientName: 'Руководитель', fromEmployeeId: 'elena', taskId: 'П-102', kind: 'blocker_escalation', severity: 'coral', title: 'Препятствие по П-102 (Елена)', text: 'Елена сообщила о проблеме: «Нет данных о численности и ФОТ от двух подразделений». Требуется содействие руководителя.', channel: 'dashboard_and_telegram' },
    { id: 'notif:seed:103', at: d(0) + 'T09:18:00+03:00', to: 'manager', recipientName: 'Руководитель', fromEmployeeId: 'dmitry', taskId: 'П-103', kind: 'deadline_escalation', severity: 'amber', title: 'Запрос переноса срока П-103 (Дмитрий)', text: `Дмитрий просит перенести согласование ТЗ на ${shortDate(d(3), true)} из-за дополнительных требований.`, channel: 'dashboard_and_telegram' },
    { id: 'notif:seed:105', at: d(0) + 'T09:20:00+03:00', to: 'anna', recipientName: 'Анна', taskId: 'П-105', kind: 'check_in', severity: 'violet', title: 'Запрос статуса у Анны (П-105)', text: 'Анна, подскажите актуальный статус по реестру рисков (П-105): что уже готово и есть ли препятствия?', channel: 'telegram_or_app' }
  ];
  state.graphRuns = [
    {
      id: 'run:seed:102',
      at: d(0) + 'T09:16:00+03:00',
      eventType: 'employee_feedback',
      actorId: 'elena',
      taskId: 'П-102',
      message: 'Расчёты готовы. Для итогового свода не хватает данных о численности и ФОТ от двух подразделений. Нужна помощь руководителя.',
      classification: { kind: 'blocked', confidence: 0.94, needsDecision: true },
      embContext: { dimension: 64, topMatches: [{ id: 'task:П-102', taskId: 'П-102', title: 'П-102 · Материалы к Комиссии по бюджету', score: 0.91 }] },
      trace: [
        { step: 1, node: 'ingest_signal', next: 'emb_retrieve', route: 'direct', durationMs: 1, outputSummary: 'Принят сигнал [employee_feedback] от Елена по П-102' },
        { step: 2, node: 'emb_retrieve', next: 'classify_intent', route: 'direct', durationMs: 2, outputSummary: 'Emb-поиск (64d): найдено 4 релевантных записей, задача П-102' },
        { step: 3, node: 'classify_intent', next: 'validate_guardrails', route: 'direct', durationMs: 1, outputSummary: 'Классификация: blocked (точность 94%)' },
        { step: 4, node: 'validate_guardrails', next: 'mutate_task_state', route: 'condition:mutate', durationMs: 1, outputSummary: 'Guardrails пройдены для П-102 (цитата проверена, срок защищён)' },
        { step: 5, node: 'mutate_task_state', next: 'dispatch_notifications', route: 'direct', durationMs: 1, outputSummary: 'Обновлена задача П-102: статус → blocked' },
        { step: 6, node: 'dispatch_notifications', next: '__end__', route: 'direct', durationMs: 1, outputSummary: 'Уведомлений создано: 2' }
      ],
      assistantReply: 'Зафиксировал препятствие по П-102 с вашей цитатой. Передал сигнал руководителю для содействия.'
    }
  ];
  return state;
}
export function migrateWorkspace(saved, now = new Date()) {
  if (!saved || !Array.isArray(saved.tasks) || !Array.isArray(saved.employees) || !Array.isArray(saved.events) || !Array.isArray(saved.sources)) return createWorkspace(now);
  if (saved.version === 2) return { ...saved, drafts: saved.drafts || {}, chat: saved.chat || [], notifications: Array.isArray(saved.notifications) ? saved.notifications : [], graphRuns: Array.isArray(saved.graphRuns) ? saved.graphRuns : [], settings: { motion: true, achievements: true, ...saved.settings } };
  const next = createWorkspace(now);
  next.tasks = next.tasks.map(t => {
    const old = saved.tasks.find(item => item.id === t.id);
    if (!old) return t;
    const merged = { ...t, ...old, proposedDue:old.proposedDue || null, blocker:old.blocker || '', nextAction:old.nextAction || '', needsDecision:!!old.needsDecision };
    if (!old.phases && merged.phases) merged.phases = merged.phases.map((p, index) => ({ ...p, done:old.status === 'done' || p.done, blocked:old.status === 'blocked' && index === 0 }));
    if (old.status === 'done') merged.closedAt = old.closedAt || null;
    return merged;
  });
  next.sources = clone(saved.sources); next.events = clone(saved.events); next.settings = { ...next.settings, ...saved.settings };
  return next;
}
export function proposal(task, now = new Date()) {
  if (task.status === 'done') return { type: 'summary', title: 'Сохранить итог', detail: 'Результат принят. История и основания остаются в архиве.', alternatives: [] };
  if (task.proposedDue) return { type: 'extension', title: 'Подготовить письмо о переносе', detail: `Предлагаемый срок — ${shortDate(task.proposedDue)}. До твоего решения действует прежний.`, alternatives: ['Согласовать предложенный срок', 'Сохранить срок и уточнить необходимую помощь'] };
  if (task.status === 'blocked') return { type: 'request', title: 'Запросить недостающие данные', detail: task.blocker || task.summary, alternatives: ['Подготовить адресный запрос', 'Обсудить допустимый промежуточный результат'] };
  if (task.status === 'review') return { type: 'review', title: 'Подготовить проверку результата', detail: 'Проверить полноту, расчёты и соответствие поручению. После проверки можно принять задачу.', alternatives: ['Проверить и принять', 'Вернуть с конкретными замечаниями'] };
  if (task.contact === 'no_reply' || task.needsClarification) return { type: 'clarify', title: 'Подготовить короткое уточнение', detail: 'Спросить о готовом результате и препятствиях. Отсутствие ответа не означает отсутствие работы.', alternatives: ['Запросить конкретный статус', 'Уточнить удобное время для связи'] };
  if (deadline(task, now).kind === 'overdue') return { type: 'extension', title: 'Уточнить срок и подготовить перенос', detail: 'Сначала подтвердить фактический результат и причину задержки. Новую дату нужно согласовать.', alternatives: ['Запросить реалистичную дату', 'Определить результат, который можно получить сейчас'] };
  return { type: 'plan', title: 'Разложить на следующие шаги', detail: 'Зафиксировать ожидаемый результат, зависимости и ближайшую контрольную точку.', alternatives: ['Подготовить план действий', 'Уточнить критерии готовности'] };
}
export function makeDraft(state, task, type = proposal(task).type) {
  const person = state.employees.find(p => p.id === task.employeeId)?.name || '[Исполнитель]';
  const ref = task.protocol ? `\nОснование: протокол № ${task.protocol.number || '[номер]'}${task.protocol.date ? ` от ${shortDate(task.protocol.date, true)}` : ''}${task.protocol.point ? `, пункт ${task.protocol.point}` : ''}.` : '';
  const intro = `Задача: «${task.title}» (${task.id}).${ref}`;
  const fact = task.summary || '[Подтверждённый статус]';
  const templates = {
    extension: { title: 'О переносе срока выполнения', body: `[Адресат]\n\n${intro}\n${task.due ? `Текущий срок: ${shortDate(task.due, true)}.` : 'Срок выполнения пока не установлен.'}\n\nТекущий статус: ${fact}\nПричина переноса: [уточнить и подтвердить причину].\n\nПрошу рассмотреть перенос срока на ${task.proposedDue ? shortDate(task.proposedDue, true) : '[предлагаемая дата]'}. До новой даты планируется: [перечень оставшихся действий].\n\n[Имя и должность отправителя]` },
    request: { title: 'Запрос данных для завершения задачи', body: `[Адресат]\n\n${intro}\n\nДля завершения работы требуется устранить следующее препятствие: ${task.blocker || '[уточнить, чего не хватает]'}.\n\nПросьба предоставить [точный перечень данных] до [дата и время] либо сообщить, когда данные будут готовы и какая помощь требуется.\n\nОтветственный за сбор: ${person}.\n[Имя и должность отправителя]` },
    clarify: { title: 'Уточнение статуса задачи', body: `${person}, добрый день!\n\n${intro}\n\nПодскажите, пожалуйста:\n1. Какой результат уже готов?\n2. Что осталось сделать и есть ли препятствия?\n3. Когда можно ожидать следующий результат?\n\nПоследний зафиксированный статус: ${fact}` },
    review: { title: 'Проверка готового результата', body: `${intro}\n\nСообщённый результат: ${fact}\n\nПеред приёмкой:\n□ Открыть итоговый материал или запросить ссылку.\n□ Сопоставить результат с поручением.\n□ Проверить полноту данных и расчёты.\n□ Зафиксировать замечания либо принять работу.\n\nЗамечания: [заполнить после проверки].\nРешение: [принять / вернуть на доработку].` },
    plan: { title: 'Предлагаемый план действий', body: `${intro}\n\nТекущий статус: ${fact}\n\n1. Уточнить ожидаемый результат и критерии готовности.\n2. Проверить исходные данные и зависимости.\n3. Подготовить рабочий результат.\n4. Проверить и передать на согласование.\n\n${(task.phases || []).length ? 'Уже заданные этапы:\n' + task.phases.map(p => `• ${p.title}: ${shortDate(p.start)} — ${shortDate(p.end)}${p.done ? ' (выполнен)' : ''}`).join('\n') : 'Сроки этапов: [согласовать].'}\n\nБлижайшее действие: [выбрать вместе с исполнителем].` },
    summary: { title: 'Итог выполнения задачи', body: `${intro}\n\nРезультат: ${fact}\nПринято: ${task.closedAt ? shortDate(task.closedAt.slice(0, 10), true) : '[дата]'}\n\nМатериалы: [ссылка на результат].` }
  };
  return { ...templates[type] || templates.plan, type, taskId: task.id, sourceId: task.latestSourceId || null };
}
export function addTask(state, input, now = new Date()) {
  if (!input.title?.trim()) throw new Error('Укажи название задачи');
  if (input.due && !validDate(input.due)) throw new Error('Проверь дату срока');
  if (input.protocolDate && !validDate(input.protocolDate)) throw new Error('Проверь дату протокола');
  const person = state.employees.find(p => p.id === input.employeeId);
  if (!person) throw new Error('Выбери исполнителя');
  const next = clone(state), id = `З-${Math.max(300, ...state.tasks.map(t => Number(t.id.replace(/\D/g, '')) || 0)) + 1}`;
  const task = { id, title: input.title.trim().slice(0, 160), summary: (input.summary || '').trim().slice(0, 2000), employeeId: person.id, department: person.department, project: input.project?.trim() || 'Мои поручения', status: 'planned', contact: 'answered', start: dayKey(now), due: input.due || null, dueTime: input.dueTime || '18:00', needsDecision: false };
  if (input.protocolNumber || input.protocolPoint || input.protocolDate) task.protocol = { number: input.protocolNumber?.trim() || '', point: input.protocolPoint?.trim() || '', date: input.protocolDate || null };
  next.tasks.push(task); next.events.unshift({ key: `created:${id}`, taskId: id, at: new Date(now).toISOString(), kind: 'created', text: 'Задача создана руководителем' });
  next.notifications ||= [];
  next.notifications.unshift({
    id: `notif:${id}:assigned:${new Date(now).getTime()}`,
    at: new Date(now).toISOString(),
    to: person.id,
    recipientName: person.name,
    taskId: id,
    kind: 'task_assigned',
    severity: 'cyan',
    title: `Поступила новая задача ${id} для ${person.name}`,
    text: `${person.name}, назначено поручение ${id} «${task.title}»${task.due ? ` (срок ${shortDate(task.due, true)})` : ' без фиксированного срока'}.`,
    channel: 'telegram_or_app'
  });
  return { state: next, task };
}
export function editTask(state, id, input, now = new Date()) {
  const current = state.tasks.find(t => t.id === id);
  if (!current || current.status === 'done') throw new Error('Архивную задачу сначала нужно вернуть в работу');
  // Reuse the same field validation without creating a second task.
  const { task: checked } = addTask(state, input, now);
  const next = clone(state), task = next.tasks.find(t => t.id === id);
  for (const key of ['title','summary','employeeId','department','project','due','dueTime']) task[key] = checked[key];
  task.protocol = checked.protocol || null;
  const changed = ['title','summary','employeeId','project','due','dueTime'].filter(key => (current[key] || '') !== (task[key] || ''));
  const labels = { title:'название', summary:'описание', employeeId:'исполнитель', project:'проект', due:'срок', dueTime:'время' };
  const sameProtocol = JSON.stringify(current.protocol || null) === JSON.stringify(task.protocol || null);
  if (!sameProtocol) changed.push('protocol');
  if (!changed.length) return next;
  if (changed.includes('due') && task.proposedDue === task.due) { task.proposedDue = null; task.needsDecision = ['review','blocked'].includes(task.status); }
  next.events.unshift({ key: `edit:${id}:${new Date(now).toISOString()}`, taskId:id, kind:'edited', at:new Date(now).toISOString(), text:`Руководитель изменил: ${changed.map(k=>labels[k]||'реквизиты').join(', ')}${changed.includes('due')?`. Срок: ${current.due||'не задан'} → ${task.due||'не задан'}`:''}` });
  return next;
}
export function savePhase(state, taskId, phaseId, input, now = new Date()) {
  const next = clone(state), task = next.tasks.find(t => t.id === taskId);
  if (!task || task.status === 'done') throw new Error('Архивные этапы доступны только для чтения');
  if (!input.title?.trim() || !validDate(input.start) || !validDate(input.end)) throw new Error('Укажи название и корректные даты этапа');
  if (input.start > input.end) throw new Error('Завершение этапа не может быть раньше начала');
  task.phases ||= [];
  const phase = phaseId ? task.phases.find(p => p.id === phaseId) : null;
  if (phaseId && !phase) throw new Error('Этап не найден');
  const id = phaseId || `phase-${new Date(now).getTime()}-${task.phases.length}`, dependsOn = input.dependsOn || null;
  if (dependsOn) {
    const parent = task.phases.find(p => p.id === dependsOn);
    if (!parent) throw new Error('Предшествующий этап не найден');
    const seen = new Set([id]); let cursor = parent;
    while (cursor) { if (seen.has(cursor.id)) throw new Error('Зависимости не должны замыкаться в круг'); seen.add(cursor.id); cursor = task.phases.find(p => p.id === cursor.dependsOn); }
    if (input.start < parent.end) throw new Error('Начало этапа должно быть не раньше завершения предшествующего');
    if (phase?.done && !parent.done) throw new Error('Сначала открой этот этап снова: новый предшественник ещё не завершён');
  }
  if (task.phases.some(p => p.dependsOn === id && p.start < input.end)) throw new Error('Новая дата пересекает начало зависимого этапа. Сначала скорректируй его даты.');
  const value = { ...(phase || { done:false }), id, title:input.title.trim().slice(0,120), start:input.start, end:input.end, dependsOn };
  if (phase) Object.assign(phase, value); else task.phases.push(value);
  if (!phase && task.status === 'review') { task.status = 'active'; task.needsDecision = Boolean(task.proposedDue); task.nextAction = task.proposedDue ? 'Решить вопрос о переносе срока' : ''; }
  next.events.unshift({ key:`phase-edit:${id}:${new Date(now).toISOString()}`, taskId, kind:'phase_edit', at:new Date(now).toISOString(), text:`${phase?'Изменён':'Добавлен'} этап «${value.title}»` });
  return next;
}
export function changeTask(state, id, action, now = new Date()) {
  const at = new Date(now).toISOString();
  if (['accept', 'approve_due', 'reject_due', 'take_control'].includes(action)) {
    const next = decide(state, id, action, VIEWER, at), task = next.tasks.find(t => t.id === id);
    if (action === 'accept') { task.closedAt = at; task.phases?.forEach(p => { p.done = true; p.blocked = false; }); }
    return next;
  }
  const next = clone(state), task = next.tasks.find(t => t.id === id);
  if (!task) throw new Error('Задача не найдена');
  const previous = task.status;
  const changes = {
    start: ['active', 'Работа начата'],
    review: ['review', 'Результат передан на проверку'],
    unblock: ['active', 'Руководитель отметил устранение препятствия'],
    reopen: ['active', 'Задача возвращена из архива'],
    rework: ['active', 'Результат возвращён на доработку']
  };
  const allowed = { start: ['planned'], review: ['active'], unblock: ['blocked'], reopen: ['done'], rework: ['review'] };
  if (!allowed[action]?.includes(previous)) throw new Error('Действие не соответствует состоянию задачи');
  if (action === 'review' && task.phases?.some(p => !p.done)) throw new Error('Сначала заверши этапы либо уточни их состав');
  task.status = changes[action][0]; task.needsDecision = task.status === 'review' || Boolean(task.proposedDue);
  if (action === 'unblock') { task.blocker = ''; task.phases?.forEach(p => { p.blocked = false; }); }
  if (action === 'reopen') task.closedAt = null;
  task.nextAction = action === 'review' ? 'Проверить и принять результат' : task.proposedDue ? 'Решить вопрос о переносе срока' : '';
  next.events.unshift({ key: `${action}:${id}:${at}`, taskId: id, kind: action, at, text: changes[action][1] }); return next;
}
export function setPhase(state, taskId, phaseId, done, now = new Date()) {
  const next = clone(state), task = next.tasks.find(t => t.id === taskId);
  if (!task || task.status === 'done') throw new Error('Архивная задача доступна только для чтения');
  const phase = task.phases?.find(p => p.id === phaseId);
  if (!phase) throw new Error('Этап не найден');
  if (done && phase.dependsOn && !task.phases.find(p => p.id === phase.dependsOn)?.done) throw new Error('Сначала заверши предшествующий этап');
  if (done && phase.blocked) throw new Error('Сначала подтверди устранение препятствия');
  if (!done) {
    const reopen = new Set([phaseId]); let added = true;
    while (added) { added = false; task.phases.forEach(p => { if (reopen.has(p.dependsOn) && !reopen.has(p.id)) { reopen.add(p.id); added = true; } }); }
    task.phases.forEach(p => { if (reopen.has(p.id)) p.done = false; });
    if (task.status === 'review') { task.status = 'active'; task.needsDecision = Boolean(task.proposedDue); task.nextAction = task.proposedDue ? 'Решить вопрос о переносе срока' : ''; }
  } else phase.done = true;
  next.events.unshift({ key: `phase:${taskId}:${phaseId}:${new Date(now).toISOString()}`, taskId, kind: 'phase', at: new Date(now).toISOString(), text: `${done ? 'Завершён' : 'Снова открыт'} этап «${phase.title}»` }); return next;
}
export function calendarDays(month) {
  const first = month + '-01', weekday = new Date(first + 'T12:00:00Z').getUTCDay(), start = shiftDay(first, -((weekday + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => shiftDay(start, i));
}
export function achievements(state) {
  const finished = new Set(state.events.filter(e => e.kind === 'decision' && e.text === 'Руководитель принял результат').map(e => e.taskId)).size;
  return [
    { id: 'finish', icon: 'flag', name: 'Первый финиш', hint: 'Прими результат одной задачи', value: finished, target: 1 },
    { id: 'flow', icon: 'bolt', name: 'Поймать ритм', hint: 'Прими три разные задачи', value: finished, target: 3 },
    { id: 'clear', icon: 'spark', name: 'Путь свободен', hint: 'Подтверди устранение препятствия', value: state.events.filter(e => e.kind === 'unblock').length, target: 1 },
    { id: 'draft', icon: 'pen', name: 'От мысли к делу', hint: 'Сохрани первый черновик решения', value: Object.keys(state.drafts || {}).length, target: 1 }
  ];
}
export function scenarioFor(key, state, now = new Date()) {
  const sc = clone(scenarios[key]), task = state.tasks.find(t => t.id === sc.taskId);
  if (!task) throw new Error('В этой демонстрации нет задачи для сценария');
  if (key === 'deadline') {
    const proposed = shiftDay(task.due || dayKey(now), 3);
    sc.report.proposedDue = proposed; sc.report.quote = `Прошу перенести на ${shortDate(proposed, true)}.`;
    sc.messages[0][1] = `Дмитрий, успеваем согласовать ТЗ к ${shortDate(task.due)}?`;
    sc.messages[1][1] = 'Не успеваем: появились дополнительные требования.'; sc.messages[3][1] = sc.report.quote;
  }
  if (key === 'blocked') sc.messages[0][1] = `Елена, как идут материалы к Комиссии по бюджету? Срок — ${shortDate(task.due)}. Что готово и есть ли препятствия?`;
  return sc;
}
export function applyScenario(state, key, now = new Date()) {
  const sc = scenarioFor(key, state, now), at = new Date(now).toISOString();
  if (key === 'silent') {
    const next = clone(state), task = next.tasks.find(t => t.id === sc.taskId);
    if (task.status === 'done') throw new Error('Задача уже в архиве. Сначала верни её в работу.');
    task.contact = 'no_reply'; next.events.unshift({ key: `silent:${at}`, taskId: sc.taskId, kind: 'no_reply', at, text: 'В демонстрации истёк срок ожидания ответа' }); return next;
  }
  return applyReport(state, { ...sc.report, taskId: sc.taskId }, { id: sc.employeeId, role: 'employee' }, { id: `demo:${key}:${at}`, taskId: sc.taskId, employeeId: sc.employeeId, text: sc.messages.filter(m => m[0] === 'employee').map(m => m[1]).join('\n'), receivedAt: at });
}
