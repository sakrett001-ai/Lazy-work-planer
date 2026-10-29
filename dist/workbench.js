const __modules={};
__modules["stage-workflow.js"]=(()=>{
/** Shared stage protocol. The server supplies the authenticated actor and checks task version. */
const stageAssignee = (task, phase) => phase.assigneeId || task.employeeId;
function stageAccepted(phase) {
  return Boolean(phase.reviewStatus === 'accepted' && phase.acceptedResultId &&
    phase.acceptedResultId === phase.submittedResultId &&
    phase.submissions?.some(s => s.id === phase.acceptedResultId && (phase.requiredVersion == null || String(s.documentVersion ?? s.version) === String(phase.requiredVersion))) &&
    phase.reviews?.some(r => r.resultId === phase.acceptedResultId && r.action === 'accept'));
}
function requireAcceptedStages(task) {
  if (task.phases?.some(p => !p.archived && !stageAccepted(p))) throw new Error('Сначала куратор должен принять результаты всех действующих этапов. Отметка о завершении не является приёмкой.');
}
function invalidateFinalResult(task) {
  task.submittedResultSourceId = null; task.submittedResultAt = null;
  if (task.status === 'review') task.status = 'active';
  task.needsDecision = Boolean(task.proposedDue);
  task.nextAction = task.proposedDue ? 'Решить вопрос о переносе срока' : '';
}
function applyStageAction(state, taskId, actor, input, at, key) {
  const next = JSON.parse(JSON.stringify(state)), task = next.tasks.find(t => t.id === taskId);
  const registered = next.employees.find(p => p.id === actor.id && p.enabled !== false);
  if (!task || !registered) throw new Error('Нет доступа к этапу.');
  const phase = task.phases?.find(p => p.id === input.phaseId && !p.archived);
  if (!phase) throw new Error('Этап не найден.');
  if (task.archived || task.status === 'done') throw new Error('Закрытое поручение доступно только для чтения.');
  if (task.paused) throw new Error('Сначала возобновите работу по поручению.');
  if (input.action === 'submit') {
    if (stageAssignee(task, phase) !== registered.id) throw new Error('Результат этапа передаёт назначенный ответственный.');
    if (!input.text?.trim() || input.text.trim().length > 4000) throw new Error('Опишите результат этапа (до 4000 знаков).');
    if (phase.dependsOn && !task.phases.some(p => p.id === phase.dependsOn && !p.archived && stageAccepted(p))) throw new Error('Сначала куратор должен принять предшествующий этап.');
    const submission = { id: key, version: (phase.submissions?.length || 0) + 1, text: input.text.trim(), employeeId: registered.id, at };
    (phase.submissions ||= []).push(submission);
    phase.submittedResultId = submission.id; phase.acceptedResultId = null; phase.reviewStatus = 'submitted'; phase.done = false;
    next.sources.push({ id:key, taskId, phaseId:phase.id, employeeId:registered.id, kind:'stage_result', text:submission.text, occurredAt:at, receivedAt:at, resultVersion:submission.version });
  } else if (['accept', 'return'].includes(input.action)) {
    if (task.employeeId !== registered.id) throw new Error('Результат этапа проверяет куратор поручения.');
    if (phase.reviewStatus !== 'submitted' || !input.resultId || input.resultId !== phase.submittedResultId || !phase.submissions?.some(s => s.id === input.resultId)) throw new Error('Проверяемый результат этапа изменился. Откройте его снова.');
    if (input.action === 'return' && (!input.reason?.trim() || input.reason.trim().length > 1000)) throw new Error('Укажите замечания для доработки (до 1000 знаков).');
    if (input.action === 'accept' && phase.requiredVersion != null) { const submitted=phase.submissions.find(s=>s.id===input.resultId); if(String(submitted.documentVersion??submitted.version)!==String(phase.requiredVersion)) throw new Error('Требуется точная версия обязательного подготовительного документа. Передайте актуальную версию.'); }
    const review = { id:key, resultId:input.resultId, action:input.action, reason:input.action === 'return' ? input.reason.trim() : '', actorId:registered.id, at };
    (phase.reviews ||= []).push(review);
    phase.reviewStatus = input.action === 'accept' ? 'accepted' : 'returned';
    phase.acceptedResultId = input.action === 'accept' ? input.resultId : null;
    phase.done = input.action === 'accept';
    next.sources.push({ id:key, taskId, phaseId:phase.id, employeeId:registered.id, kind:'stage_review', text:input.action === 'accept' ? `Куратор принял этап «${phase.title}».` : review.reason, occurredAt:at, receivedAt:at, resultSourceId:input.resultId });
  } else throw new Error('Неизвестное действие с результатом этапа.');
  if (input.action !== 'accept') invalidateStageChain(task, phase.id, false);
  // A changed stage always requires a fresh final submission; previous evidence remains immutable.
  invalidateFinalResult(task);
  task.lastMessageSourceId = key; task.lastMessageAuthorId = registered.id;
  const text = input.action === 'submit' ? `Результат этапа «${phase.title}» передан куратору.` : input.action === 'accept' ? `Куратор принял этап «${phase.title}».` : `Этап «${phase.title}» возвращён на доработку: ${input.reason.trim()}`;
  next.events.unshift({ key, taskId, phaseId:phase.id, sourceId:key, actorId:registered.id, kind:'stage_'+input.action, at, text, resultId:phase.submittedResultId });
  return next;
}
function invalidateStageChain(task, phaseId, includeRoot = true) {
  const ids = new Set([phaseId]); let changed = true;
  while (changed) { changed = false; for (const p of task.phases || []) if (ids.has(p.dependsOn) && !ids.has(p.id)) { ids.add(p.id); changed = true; } }
  for (const p of task.phases || []) if (ids.has(p.id) && (includeRoot || p.id !== phaseId)) {
    p.done = false; p.reviewStatus = 'pending'; p.acceptedResultId = null;
  }
  invalidateFinalResult(task);
}
function applyFinalResult(state, taskId, actor, text, at, key) {
  const next = JSON.parse(JSON.stringify(state)), task = next.tasks.find(t => t.id === taskId);
  if (!task || task.employeeId !== actor.id || !next.employees.some(p => p.id === actor.id && p.enabled !== false)) throw new Error('Итоговый результат передаёт куратор поручения.');
  if (task.archived || task.status === 'done' || task.paused) throw new Error('Сначала верните поручение в работу.');
  requireAcceptedStages(task);
  if (!text?.trim() || text.trim().length > 4000) throw new Error('Опишите итоговый результат (до 4000 знаков).');
  next.sources.push({ id:key, taskId, employeeId:actor.id, kind:'final_result', text:text.trim(), occurredAt:at, receivedAt:at });
  Object.assign(task, { submittedResultSourceId:key, submittedResultAt:at, status:'review', blocker:'', needsDecision:true, needsClarification:false, clarificationQuestion:'', nextAction:'Проверить и принять результат', summary:text.trim().slice(0,240), lastReply:at, reportedAt:at, contact:'answered', lastMessageSourceId:key, lastMessageAuthorId:actor.id });
  next.events.unshift({ key, taskId, actorId:actor.id, sourceId:key, kind:'review', at, text:'Куратор передал итоговый результат руководителю.' });
  return next;
}

return {stageAssignee,stageAccepted,requireAcceptedStages,invalidateFinalResult,applyStageAction,invalidateStageChain,applyFinalResult};})();
__modules["access.js"]=(()=>{
/** Shared read policy. UI scopes are filters; server callers supply a verified actor. */
function registeredActor(state, actorId) {
  const actor = state.employees.find(person => person.id === actorId);
  if (!actor || actor.enabled === false) throw new Error('Участник не зарегистрирован');
  return actor;
}

function canReadTask(actor, task) {
  return Boolean(actor.enabled !== false && task && (actor.role === 'manager' || task.employeeId === actor.id || task.coexecutorIds?.includes(actor.id) || task.phases?.some(p => !p.archived && p.assigneeId === actor.id)));
}

function scopedWorkspace(state, actor) {
  const tasks = state.tasks.filter(task => canReadTask(actor, task));
  const ids = new Set(tasks.map(task => task.id));
  const manager = actor.role === 'manager';
  const participants = new Set([actor.id, ...tasks.flatMap(t => [t.employeeId, ...(t.coexecutorIds || []), ...(t.phases || []).filter(p => !p.archived).map(p => p.assigneeId).filter(Boolean)])]);
  return {
    tasks,
    employees: state.employees.filter(p => manager || participants.has(p.id)).map(p => ({ id: p.id, name: p.name, role: p.role, enabled: p.enabled !== false })),
    sources: (state.sources || []).filter(s => s.taskId ? ids.has(s.taskId) : manager || s.employeeId === actor.id),
    events: (state.events || []).filter(e => ids.has(e.taskId) && (manager || e.kind !== 'decision_draft')),
    decisionDrafts: manager ? (state.decisionDrafts || []).filter(d => ids.has(d.taskId)) : [],
    drafts: manager ? Object.fromEntries(Object.entries(state.drafts || {}).filter(([, d]) => ids.has(d.taskId))) : {},
    notifications: (state.notifications || []).filter(n => ids.has(n.taskId) && (manager || n.to === actor.id)),
    settings: state.settings,
  };
}

/** Parent linkage never grants read access or exposes an unreadable parent. */
function visibleTask(state, actor, task) {
  const result = { ...task };
  if (result.parentId && !canReadTask(actor, state.tasks.find(t => t.id === result.parentId))) delete result.parentId;
  return result;
}

return {registeredActor,canReadTask,scopedWorkspace,visibleTask};})();
__modules["task-memory.js"]=(()=>{
const { canReadTask, scopedWorkspace }=__modules["access.js"];
const MEMORY_FIELDS = ['status', 'summary', 'blocker', 'due', 'proposedDue', 'needsDecision', 'nextAction'];

/** Record the origin of each changed fact, independently of the latest reply. */
function rememberChanges(task, before, eventId, sourceId = null) {
  const changes = {};
  task.factOrigins ||= {};
  for (const field of MEMORY_FIELDS) {
    if ((before[field] ?? null) !== (task[field] ?? null)) {
      changes[field] = { before: before[field] ?? null, after: task[field] ?? null };
      task.factOrigins[field] = { eventId, sourceId };
    }
  }
  return changes;
}

/** A read model rebuilt from durable records; never from graph traces or model recollection.
 * @param {any} state
 * @param {any} actor
 * @param {string} taskId
 * @param {{before?: string | null, limit?: number}} options
 */
function taskMemory(state, actor, taskId, { before = null, limit = 20 } = {}) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!canReadTask(actor, task)) throw new Error('Нет доступа к задаче или задача не найдена');
  const scoped = scopedWorkspace(state, actor);
  const allEvents = scoped.events.filter(e => e.taskId === taskId)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at) || a.index - b.index)
    .map(item => item.event);
  const offset = before ? allEvents.findIndex(e => e.key === before) + 1 : 0;
  if (before && offset === 0) throw new Error('Запись истории не найдена');
  const size = Math.max(1, Math.min(50, Number(limit) || 20));
  const page = allEvents.slice(offset, offset + size);
  const sourceIds = new Set(page.map(e => e.sourceId).filter(Boolean));
  const facts = MEMORY_FIELDS.map(field => {
    const origin = task.factOrigins?.[field];
    // Legacy records remain explicitly unattributed rather than borrowing the latest reply.
    if (origin?.sourceId) sourceIds.add(origin.sourceId);
    return { field, value: task[field] ?? null, origin: origin || { kind: 'task_record' } };
  });
  if (task.latestSourceId) sourceIds.add(task.latestSourceId);
  const localDrafts = Object.entries(scoped.drafts).map(([id, draft]) => ({ ...draft, id }));
  const drafts = [...scoped.decisionDrafts, ...localDrafts].filter(d => d.taskId === taskId).slice(-5)
    .map(d => ({ id: d.id, title: d.title, body: d.body, status: d.status || 'draft', kind: d.kind || d.type, reason: d.reason || '', options: d.options || [], generator: d.generator || 'assistant', references: d.references || [], contextSourceId: d.sourceId || null, createdAt: d.createdAt || d.savedAt || d.updatedAt || null }));
  for (const draft of drafts) {
    for (const ref of draft.references) sourceIds.add(ref.sourceId);
    if (draft.contextSourceId) sourceIds.add(draft.contextSourceId);
  }
  const sources = scoped.sources.filter(s => s.taskId === taskId && sourceIds.has(s.id))
    .map(s => ({ id: s.id, taskId, employeeId: s.employeeId, authorName: s.authorName || null, text: s.text, occurredAt: s.occurredAt || s.receivedAt, receivedAt: s.receivedAt, simulated: Boolean(s.simulated) }));
  const decisions = allEvents.filter(e => e.kind === 'decision').slice(0, 5);
  const openQuestions = [];
  if (task.needsClarification) openQuestions.push(task.clarificationQuestion || 'Нужно уточнить фактический результат и следующий шаг.');
  if (task.proposedDue) openQuestions.push(`Предлагаемая дата ${task.proposedDue} ожидает решения. Утверждённый срок: ${task.due || 'не задан'}.`);
  if (task.status === 'blocked') openQuestions.push(`Препятствие сохраняется: ${task.blocker || 'причину нужно уточнить'}`);
  if (task.status === 'review') openQuestions.push('Результат ожидает проверки и приёмки руководителем.');
  if (task.contact === 'no_reply') openQuestions.push('На отправленный запрос нет ответа; состояние работы из этого не выводится.');

  const nodes = new Map(), edges = [];
  const node = (id, type, data) => { nodes.set(id, { ...data, id, type }); return id; };
  const edge = (from, to, relation) => { if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, relation }); };
  const taskNode = node(`task:${taskId}`, 'task', { title: task.title, status: task.status });
  const person = scoped.employees.find(p => p.id === task.employeeId);
  if (person) edge(taskNode, node(`person:${person.id}`, 'person', { name: person.name }), 'assigned_to');
  if (task.protocol) edge(taskNode, node(`protocol:${task.protocol.number}:${task.protocol.date}:${task.protocol.point}`, 'protocol', { ...task.protocol }), 'required_by');
  if (task.project) edge(taskNode, node(`project:${task.project}`, 'project', { title: task.project }), 'part_of');
  for (const phase of task.phases || []) node(`phase:${taskId}:${phase.id}`, 'phase', { title: phase.title, done: phase.done });
  for (const phase of task.phases || []) {
    edge(`phase:${taskId}:${phase.id}`, taskNode, 'step_of');
    if (phase.dependsOn) edge(`phase:${taskId}:${phase.id}`, `phase:${taskId}:${phase.dependsOn}`, 'depends_on');
  }
  for (const source of sources) edge(node(`source:${source.id}`, 'source', source), taskNode, 'reports_on');
  const originEvents = new Set(facts.map(f => f.origin.eventId).filter(Boolean));
  const graphEvents = new Map([...page, ...decisions, ...allEvents.filter(e => originEvents.has(e.key))].map(e => [e.key, e]));
  for (const event of graphEvents.values()) {
    const id = node(`event:${event.key}`, event.kind === 'decision' ? 'decision' : 'event', { eventId: event.key, kind: event.kind, at: event.at, text: event.text, changes: event.changes || {} });
    edge(id, taskNode, event.kind === 'late_report' ? 'history_only' : 'recorded_for');
    if (event.sourceId) edge(id, `source:${event.sourceId}`, 'supported_by');
  }
  for (const draft of drafts) {
    const id=node(`draft:${draft.id}`, 'draft', { title: draft.title, status: 'draft' });
    edge(id, taskNode, 'proposes');
    for (const ref of draft.references) edge(id, `source:${ref.sourceId}`, 'supported_by');
    if (draft.contextSourceId) edge(id, `source:${draft.contextSourceId}`, 'context_from');
  }
  return {
    taskId, title: task.title,
    current: { status: task.status, summary: task.summary || '', due: task.due || null, proposedDue: task.proposedDue || null, blocker: task.blocker || '', nextAction: task.nextAction || '', contact: task.contact, lastReply: task.lastReply || null },
    facts, openQuestions, recentDecisions: decisions, drafts,
    sources, timeline: page,
    page: { total: allEvents.length, nextBefore: offset + size < allEvents.length ? page.at(-1)?.key || null : null },
    graph: { nodes: [...nodes.values()], edges },
    provenance: 'stored_records',
  };
}

/** Small, attributed context for every verified incoming task message. */
function memoryBrief(state, actor, taskId) {
  const memory = taskMemory(state, actor, taskId, { limit: 5 });
  return { taskId, current: memory.current, facts: memory.facts, openQuestions: memory.openQuestions,
    recentDecisions: memory.recentDecisions, sources: memory.sources.map(s => ({ id: s.id, text: s.text.slice(0, 600), occurredAt: s.occurredAt })),
    moreHistory: memory.page.nextBefore, retrievalTool: 'get_task_memory' };
}

return {MEMORY_FIELDS,rememberChanges,taskMemory,memoryBrief};})();
__modules["domain.js"]=(()=>{
/** Pure task rules shared by the demonstration and the agent's tools. */
const { requireAcceptedStages }=__modules['stage-workflow.js'];
const { rememberChanges }=__modules['task-memory.js'];
const STATUS = { planned: 'Запланировано', active: 'В работе', blocked: 'Есть препятствие', review: 'На проверке', done: 'Принято' };
const clone = value => JSON.parse(JSON.stringify(value));
function validDate(s) { if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s; }
function localDateKey(now,timezone='Europe/Moscow'){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));const get=t=>parts.find(x=>x.type===t).value;return `${get('year')}-${get('month')}-${get('day')}`;}
function mentionedTaskIds(text,tasks){const tokens=String(text).split(/[\s#,:;.!?()\[\]{}]+/);return tasks.filter(t=>tokens.includes(t.id)).map(t=>t.id);}
function taskById(state,id) { const task=state.tasks.find(t=>t.id===id); if(!task)throw new Error('Задача не найдена'); return task; }
function applyReport(state, report, actor, source) {
  const next=clone(state), task=taskById(next,report.taskId);
  const before=clone(task);
  if (source.employeeId !== actor.id || source.taskId !== task.id || task.employeeId !== actor.id) throw new Error('Нет доступа к этой задаче или источнику');
  if (next.events.some(e=>e.key===source.id)) return next;
  if (!report.quote?.trim() || !source.text.includes(report.quote)) throw new Error('В сообщении нет указанной цитаты');
  if (!['progress','blocked','unblocked','review','deadline_request','unclear'].includes(report.kind)) throw new Error('Неизвестный вид обновления');
  if (report.kind==='deadline_request' && !validDate(report.proposedDue)) throw new Error('Требуется конкретная корректная дата');
  if (!report.summary?.trim()) throw new Error('Нужна краткая фактическая сводка');
  if (task.archived) throw new Error('Поручение в архиве; сначала восстановите его');
  if (report.kind==='review') requireAcceptedStages(task);
  if (task.status==='done') throw new Error('Принятая задача закрыта; открыть её может руководитель');
  const reportedAt=source.occurredAt||source.receivedAt;
  if(!Number.isFinite(Date.parse(reportedAt))||!Number.isFinite(Date.parse(source.receivedAt)))throw new Error('Некорректная дата исходного сообщения');
  task.lastMessageSourceId=source.id;task.lastMessageAuthorId=actor.id;
  if((task.lastReply&&Date.parse(reportedAt)<Date.parse(task.lastReply))||(task.lastDecisionAt&&Date.parse(reportedAt)<Date.parse(task.lastDecisionAt))){
    next.sources.push(clone(source));next.events.unshift({key:source.id,taskId:task.id,kind:'late_report',at:source.receivedAt,text:'Получено более раннее сообщение. Актуальный статус сохранён.',sourceId:source.id});return next;
  }
  task.lastReply=reportedAt;
  task.contact='answered';
  task.latestSourceId=source.id;
  // An unclear reply is evidence of contact, not evidence of progress.
  if (report.kind==='unclear') {task.needsClarification=true;task.clarificationQuestion=report.question||'Что уже готово и какой следующий шаг?';}
  else {
    task.needsClarification=false;
    task.clarificationQuestion='';
    task.summary=report.summary;
    task.reportedAt=source.receivedAt;
    if(report.kind==='progress') {task.status=['planned','review'].includes(task.status)?'active':task.status;task.submittedResultSourceId=null;task.submittedResultAt=null;if(task.status==='active'){task.needsDecision=Boolean(task.proposedDue);task.nextAction=task.proposedDue?'Решить вопрос о переносе срока':'';}}
    if(report.kind==='blocked') { task.submittedResultSourceId=null;task.submittedResultAt=null;task.status='blocked'; task.blocker=report.blocker||report.summary; }
    if(report.kind==='unblocked') {task.submittedResultSourceId=null;task.submittedResultAt=null;task.status='active';task.blocker='';task.needsDecision=Boolean(task.proposedDue);task.nextAction=task.proposedDue?'Решить вопрос о переносе срока':'';}
    if(report.kind==='review') { task.submittedResultSourceId=source.id;task.submittedResultAt=reportedAt;task.status='review'; task.blocker=''; task.needsDecision=true; task.nextAction='Проверить и принять результат'; }
    if(report.kind==='deadline_request') { task.proposedDue=report.proposedDue; task.needsDecision=true; task.nextAction='Решить вопрос о переносе срока'; }
    if(report.needsDecision===true) { task.needsDecision=true; task.nextAction=report.nextAction||'Уточнить требуемое решение'; }
  }
  next.sources.push(clone(source));
  const changes=rememberChanges(task,before,source.id,source.id);
  next.events.unshift({key:source.id,taskId:task.id,kind:report.kind,at:source.receivedAt,occurredAt:reportedAt,text:report.kind==='unclear'?'Ответ получен; требуется уточнение':report.summary,sourceId:source.id,actorId:actor.id,quote:report.quote,changes});
  return next;
}
function markNoReply(state,id,at,key) {
  const next=clone(state); if(next.events.some(e=>e.key===key))return next;
  const task=taskById(next,id); if(task.archived||task.supervision===false||task.paused||task.status==='done'||isDeferredStart(task,at)) return next;
  task.contact='no_reply'; task.requestedAt=at;
  next.events.unshift({key,taskId:id,kind:'no_reply',at,text:'Ответ на запрос статуса не получен. Состояние работы не изменено.'});
  return next;
}
function decide(state,id,action,actor,at) {
  if(actor.role!=='manager')throw new Error('Решение доступно руководителю');
  const next=clone(state),task=taskById(next,id),before=clone(task); let text;
  if(task.archived)throw new Error('Поручение в архиве; сначала восстановите его');
  if(action==='accept' && task.paused)throw new Error('Сначала снимите поручение с паузы.');
  if(action==='accept' && task.status==='review') {if(next.tasks.some(child=>child.parentId===task.id&&!child.archived&&child.status!=='done'))throw new Error('Сначала примите результаты дочерних поручений или уточните их состав');if(task.needsClarification)throw new Error('Сначала уточните последнее сообщение исполнителя');requireAcceptedStages(task);const result=next.sources.find(s=>s.id===task.submittedResultSourceId&&s.taskId===task.id&&s.employeeId===task.employeeId&&s.kind!=='manager_message'&&s.text?.trim());if(!result)throw new Error('Сначала требуется сообщение исполнителя с результатом работы');task.acceptedSourceId=result.id;task.status='done';task.needsDecision=false;task.nextAction='';text='Руководитель принял результат';}
  else if(action==='approve_due' && task.proposedDue) {const old=task.due;task.due=task.proposedDue;task.proposedDue=null;task.needsDecision=false;task.nextAction='';text=`Перенос согласован: ${old} → ${task.due}`;}
  else if(action==='reject_due' && task.proposedDue) {task.proposedDue=null;task.needsDecision=false;task.nextAction='Сохранить согласованный срок';text='Перенос отклонён, исходный срок сохранён';}
  else if(action==='take_control' && task.needsDecision) {text='Руководитель ознакомился с вопросом. Решение ещё требуется; ответственность не изменена';}
  else throw new Error('Действие не соответствует состоянию задачи');
  const key=`decision:${id}:${at}:${action}`;
  task.lastDecisionAt=at;
  const changes=rememberChanges(task,before,key);
  next.events.unshift({key,taskId:id,kind:'decision',action,actorId:actor.id||null,at,text,changes}); return next;
}
function metrics(state,now) {
  const open=state.tasks.filter(t=>!t.archived&&t.status!=='done'), today=localDateKey(now,state.settings?.timezone||'Europe/Moscow');
  return {open:open.length,decision:open.filter(t=>t.needsDecision).length,blocked:open.filter(t=>t.status==='blocked').length,noReply:open.filter(t=>t.contact==='no_reply').length,overdue:open.filter(t=>t.due<today).length};
}
function buildBrief(state,now) {
  const m=metrics(state,now), name=t=>state.employees.find(e=>e.id===t.employeeId)?.name||'Исполнитель';
  const decision=state.tasks.filter(t=>!t.archived&&t.status!=='done'&&t.needsDecision).map(t=>({id:t.id,text:`${t.title} — ${t.nextAction}. ${name(t)}.`,sourceId:t.latestSourceId}));
  const blocked=state.tasks.filter(t=>!t.archived&&t.status==='blocked').map(t=>({id:t.id,text:`${t.title}: ${t.blocker}`,sourceId:t.latestSourceId}));
  const silent=state.tasks.filter(t=>!t.archived&&t.status!=='done'&&t.contact==='no_reply').map(t=>({id:t.id,text:`${t.title} — нет ответа от ${name(t)}; прогресс не подтверждён.`,sourceId:t.latestSourceId}));
  return {asOf:now,metrics:m,decision,blocked,silent,text:[`На контроле: ${m.open}. Требуют решения: ${m.decision}. Препятствия: ${m.blocked}. Нет ответа: ${m.noReply}.`,...decision.map(x=>'РЕШЕНИЕ · '+x.text),...blocked.map(x=>'ПРЕПЯТСТВИЕ · '+x.text),...silent.map(x=>'НЕТ ОТВЕТА · '+x.text)].join('\n\n')};
}
function isDeferredStart(task, now) { return task.status === 'planned' && Boolean(task.startAt) && Date.parse(task.startAt) > Date.parse(now); }
function hasPendingStatusRequest(task) { return ['awaiting','no_reply'].includes(task.contact); }
function shouldCheckIn(task,now,settings) {
  if(task.archived||task.supervision===false||task.paused||isDeferredStart(task,now)) return false;
  if(hasPendingStatusRequest(task)) return false;
  if(task.status==='done'||task.status==='review') return false;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone||'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(new Date(now));
  const get=t=>parts.find(p=>p.type===t)?.value; const date=`${get('year')}-${get('month')}-${get('day')}`;
  if(['Sat','Sun'].includes(get('weekday'))||settings.excludedDates?.includes(date))return false;
  const hour=Number(get('hour')); if(hour<settings.startHour||hour>=settings.endHour)return false;
  if(task.lastReply&&Date.parse(now)-Date.parse(task.lastReply)<settings.minHoursBetween*3600000)return false;
  if(task.lastRequestedAt&&Date.parse(now)-Date.parse(task.lastRequestedAt)<settings.minHoursBetween*3600000)return false;
  return true;
}
function reconcileNoReplies(state,now){let result=state;for(const task of state.tasks){if(!task.archived&&task.supervision!==false&&!task.paused&&!isDeferredStart(task,now)&&!['done','review'].includes(task.status)&&task.lastRequestedAt&&Date.parse(now)-Date.parse(task.lastRequestedAt)>=(state.settings.replyWaitHours||4)*3600000&&(!task.lastReply||Date.parse(task.lastReply)<Date.parse(task.lastRequestedAt)))result=markNoReply(result,task.id,now,`no-reply:${task.id}:${task.lastRequestedAt}`);}return result;}

return {STATUS,clone,validDate,localDateKey,mentionedTaskIds,taskById,applyReport,markNoReply,decide,metrics,buildBrief,isDeferredStart,hasPendingStatusRequest,shouldCheckIn,reconcileNoReplies};})();
__modules["pulse-signal.js"]=(()=>{
// Selected B: new samples are written into a sweeping lane, then fade in place.
// This is a task-state visual metaphor, not a medical signal or measurement.
const PULSE_BODY_SECONDS = .82;
const PULSE_SWEEP_SECONDS = 3.8;
const PULSE_TAIL_SECONDS = 2.6;
const HISTORY_SECONDS = 8;
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

function pulseBeat(seconds) {
  if (seconds < 0 || seconds > PULSE_BODY_SECONDS) return 0;
  const gaussian = (center, spread, amplitude) => amplitude * Math.exp(-.5 * ((seconds - center) / spread) ** 2);
  return gaussian(.15,.043,.14) + gaussian(.295,.016,-.16) + gaussian(.335,.014,1)
    + gaussian(.375,.021,-.32) + gaussian(.56,.075,.25);
}
function configuration(config) {
  const period = config.period ?? 1.8, amplitude = config.amplitude ?? 1;
  if (!Number.isFinite(period) || period < PULSE_BODY_SECONDS || !Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
    throw new RangeError('Pulse period must contain the fixed beat body; amplitude must be within 0..1.');
  }
  return {period, amplitude};
}
function createPulseSignal(config = {}) {
  const {period, amplitude} = configuration(config);
  const model = {time:0, phase:.5, period, amplitude, beats:[]};
  // Seed only past samples, so the first frame has a fading tail and an empty gap.
  for (let time = -period * .5; time >= -HISTORY_SECONDS - period; time -= period) model.beats.unshift({time, amplitude});
  return model;
}
function advancePulseSignal(model, seconds, config = model) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Pulse elapsed time must be finite and non-negative.');
  const {period, amplitude} = configuration(config);
  const end = model.time + seconds, totalPhase = model.phase + seconds / period;
  const count = Math.floor(totalPhase + 1e-12);
  // Retain fractional progress when cadence changes. Only the pause changes;
  // existing beat timestamps and amplitudes are never rescaled or rewritten.
  const first = model.time + (1 - model.phase) * period;
  const earliest = Math.max(0, count - Math.ceil(HISTORY_SECONDS / period) - 1);
  for (let index = earliest; index < count; index++) model.beats.push({time:first + index * period, amplitude});
  model.time = end;
  model.phase = Math.max(0, totalPhase - count);
  model.period = period;
  model.amplitude = amplitude;
  model.beats = model.beats.filter(beat => beat.time >= end - HISTORY_SECONDS);
  return model;
}
function sampleSignal(model, time) {
  for (let index = model.beats.length - 1; index >= 0; index--) {
    const beat = model.beats[index];
    if (beat.time <= time) return pulseBeat(time - beat.time) * beat.amplitude;
  }
  return 0;
}
function generatePulsePoints(model, width = 300) {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('Pulse width must be finite and positive.');
  const sweep = mod(model.time + 1.4, PULSE_SWEEP_SECONDS), result = [];
  const columns = Math.ceil(width / 2);
  for (let index = 0; index <= columns; index++) {
    const x = Math.min(index * 2, width), position = x / width * PULSE_SWEEP_SECONDS;
    const age = mod(sweep - position, PULSE_SWEEP_SECONDS);
    if (age > PULSE_TAIL_SECONDS) { result.push(null); continue; }
    result.push([x, .62 - sampleSignal(model, model.time - age) * .42, (1 - age / PULSE_TAIL_SECONDS) ** 1.3]);
  }
  return result;
}

return {PULSE_BODY_SECONDS,PULSE_SWEEP_SECONDS,PULSE_TAIL_SECONDS,pulseBeat,createPulseSignal,advancePulseSignal,generatePulsePoints};})();
__modules["pulse-motion.js"]=(()=>{
const {createPulseSignal,advancePulseSignal,generatePulsePoints}=__modules["pulse-signal.js"];
// Presentation cadence only. No extra urgency threshold or invented start date.
const boundedProgress=value=>Math.max(0,Math.min(1,Number(value)||0));
function pulseUrgencyColor(progress) {
  const p=boundedProgress(progress),from=p<.5?[245,216,105]:[255,171,95],to=p<.5?[255,171,95]:[255,118,141],mix=p<.5?p*2:(p-.5)*2;
  return `rgb(${from.map((v,i)=>Math.round(v+(to[i]-v)*mix)).join(', ')})`;
}
function pulseMotionConfig(mode,tone,progress=0) {
  if(mode==='done')return {static:true,period:2.8,amplitude:.72};
  // Awaiting approval is still alive, but never borrows overdue urgency.
  if(mode==='review')return {static:false,period:2.4,amplitude:.85};
  const p=boundedProgress(progress),soonPeriod=p<.5?1.5-p*.5:1.25-(p-.5)*.4;
  const period=tone==='overdue'?1.05:tone==='soon'?soonPeriod:mode==='active'?1.8:2.8;
  return {static:false,period,amplitude:(mode==='planned'||mode==='blocked') ? .72 : 1};
}

// One frame loop/observer set for the board, not one timer per card.
function createCardPulseController(root, options={}) {
  const win=root.ownerDocument.defaultView, doc=root.ownerDocument;
  const raf=options.requestFrame||win.requestAnimationFrame?.bind(win);
  const cancel=options.cancelFrame||win.cancelAnimationFrame?.bind(win);
  const contextFor=options.contextFor||(canvas=>win.CanvasRenderingContext2D?canvas.getContext('2d'):null);
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const records=new Map();let frame=null,last=null,destroyed=false;
  const stopped=()=>doc.hidden||doc.body.classList.contains('quiet-motion')||reduced?.matches;
  const config=node=>{const card=node.closest('[data-card-id]');return pulseMotionConfig(card.dataset.pulse,card.dataset.pulseTone,card.dataset.pulseProgress);};
  function measure(record){const rect=record.node.getBoundingClientRect();record.width=Math.min(1000,rect.width);record.height=rect.height;record.color=win.getComputedStyle(record.node).color;}
  function draw(record) {
    if(doc.hidden||!record.context||!record.visible||record.config.static)return;
    if(record.width<=0||record.height<=0)return;
    const width=record.width,height=record.height,dpr=Math.min(2,win.devicePixelRatio||1);
    const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr),cv=record.canvas,ctx=record.context;
    if(cv.width!==pixelWidth||cv.height!==pixelHeight){cv.width=pixelWidth;cv.height=pixelHeight;}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    ctx.strokeStyle=record.color;ctx.lineWidth=record.mode==='blocked'?1:1.25;ctx.lineCap='round';ctx.lineJoin='round';
    let previous=null;
    for(const point of generatePulsePoints(record.signal,width)) {
      if(!point){previous=null;continue;}
      if(previous){ctx.globalAlpha=(previous[2]+point[2])/2;ctx.beginPath();ctx.moveTo(previous[0],previous[1]*height);ctx.lineTo(point[0],point[1]*height);ctx.stroke();}
      previous=point;
    }
    ctx.globalAlpha=1;if(!record.ready){record.node.classList.add('pulse-live-ready');record.ready=true;}
  }
  const running=()=>!stopped()&&[...records.values()].some(r=>r.visible&&r.context&&!r.config.static);
  function schedule(){if(!destroyed&&raf&&frame===null&&running())frame=raf(tick);}
  function tick(timestamp){
    frame=null;if(destroyed||!running()){last=null;return;}
    if(last===null)last=timestamp;
    if(timestamp-last>=40){const dt=Math.min(.2,(timestamp-last)/1000);last=timestamp;
      for(const record of records.values())if(record.visible&&record.context&&!record.config.static){advancePulseSignal(record.signal,dt,record.config);draw(record);}
    }
    schedule();
  }
  function sync(){
    if(!running()){if(frame!==null)cancel?.(frame);frame=null;last=null;}
    for(const record of records.values())draw(record);
    schedule();
  }
  const intersection=win.IntersectionObserver?new win.IntersectionObserver(entries=>{for(const entry of entries){const record=[...records.values()].find(r=>r.node===entry.target);if(record){record.visible=entry.isIntersecting;measure(record);draw(record);}}sync();}):null;
  const resize=win.ResizeObserver?new win.ResizeObserver(()=>{for(const record of records.values()){measure(record);draw(record);}}):null;
  function refresh(){
    if(destroyed)return;
    const found=new Set();
    for(const node of root.querySelectorAll('.card-pulse')){
      const card=node.closest('[data-card-id]'),id=card?.dataset.cardId;if(!id)continue;found.add(id);
      const next=config(node);let record=records.get(id);
      if(!next.static&&['soon','overdue'].includes(card.dataset.pulseTone))node.style.setProperty('--pulse-color',pulseUrgencyColor(card.dataset.pulseTone==='overdue'?1:card.dataset.pulseProgress));
      else node.style.removeProperty('--pulse-color');
      if(!record||record.node!==node){
        if(record){intersection?.unobserve(record.node);resize?.unobserve(record.node);}
        const canvas=node.querySelector('canvas'),signal=record?.signal||createPulseSignal(next);
        record={node,canvas,signal,context:canvas?contextFor(canvas):null,visible:!intersection,config:next,mode:card.dataset.pulse};records.set(id,record);
        intersection?.observe(node);resize?.observe(node);
      }else{record.config=next;record.mode=card.dataset.pulse;}
      if(next.static){node.classList.remove('pulse-live-ready');record.ready=false;}
      measure(record);draw(record);
    }
    for(const [id,record] of records)if(!found.has(id)){intersection?.unobserve(record.node);resize?.unobserve(record.node);records.delete(id);}
    sync();
  }
  const mutation=new win.MutationObserver(refresh);mutation.observe(root,{childList:true,subtree:true});
  const visibility=()=>{last=null;sync();};
  doc.addEventListener('visibilitychange',visibility);reduced?.addEventListener?.('change',visibility);
  win.addEventListener('resize',refresh);
  refresh();
  return {refresh,sync,destroy(){destroyed=true;if(frame!==null)cancel?.(frame);frame=null;mutation.disconnect();intersection?.disconnect();resize?.disconnect();records.clear();doc.removeEventListener('visibilitychange',visibility);reduced?.removeEventListener?.('change',visibility);win.removeEventListener('resize',refresh);},
    // Read-only diagnostics for bounded lifecycle verification; no application data.
    inspect(){return {count:records.size,scheduled:frame!==null,signals:[...records].map(([id,r])=>({id,time:r.signal.time,phase:r.signal.phase,visible:r.visible}))};}};
}

return {pulseUrgencyColor,pulseMotionConfig,createCardPulseController};})();
__modules["notification-state.js"]=(()=>{
/** Relevant evidence, not task serialization, drives per-person attention.
 * Callers must pass an access-scoped workspace. Cursor is opaque to clients.
 */
const metadataKinds = new Set(['edited', 'decision_draft', 'task_archived', 'task_restored', 'employee_disabled']);
function notificationKeys(state, actor, task) {
  const sources = (state.sources || []).filter(source => source.taskId === task.id);
  const byId = new Map(sources.map(source => [source.id, source]));
  const keys = sources.filter(source => source.employeeId !== actor.id && source.id).map(source => `source:${source.id}`);
  for (const event of state.events || []) {
    if (event.taskId !== task.id || metadataKinds.has(event.kind) || !event.key) continue;
    // A source and its classified event are one notification, including legacy
    // events without actorId. Classification/reprocessing cannot re-arm it.
    if (event.sourceId && byId.has(event.sourceId)) continue;
    if (byId.has(event.key)) continue;
    if (event.actorId === actor.id) continue;
    keys.push(`event:${event.key}`);
  }
  return [...new Set(keys)].sort();
}
function notificationState(state, actor, task, prefs, hash, taskVersion) {
  const keys = notificationKeys(state, actor, task);
  const notificationCursor = hash(JSON.stringify(keys));
  const seen = prefs.seenNotifications?.[task.id];
  const legacyRead = seen === undefined && prefs.seen?.[task.id] === taskVersion;
  return { notificationCursor, unread: keys.length > 0 && seen !== notificationCursor && !legacyRead };
}

return {notificationKeys,notificationState};})();
__modules['document-storage.js']=(()=>{
'use strict';
// This store is local to this browser and origin. It is not a server, a backup,
// Office editing, malware scanning, or a guarantee against browser-data removal.
const MAX_BYTES=20*1024*1024;
const MIME_TYPES=Object.freeze({
  doc:'application/msword',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:'application/pdf'
});
const DB_NAME='pulse-local-document-files-v1', STORE='immutable-files', DRAFT_PREFIX='pulse-document-draft-v1:';
const failure=message=>new Error(message);
function validateFile(file){
  if(!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>240||/[\x00-\x1f\x7f/\\]/.test(file.name))throw failure('Укажите файл с обычным именем длиной до 240 символов.');
  const ext=file.name.lastIndexOf('.')>0?file.name.split('.').pop().toLowerCase():'',type=MIME_TYPES[ext];
  if(!type)throw failure('Поддерживаются только Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx) и PDF.');
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_BYTES)throw failure('Файл должен быть непустым и не больше 20 МиБ (20 971 520 байт).');
  if(file.type&&file.type.toLowerCase()!==type&&file.type.toLowerCase()!=='application/octet-stream')throw failure('Тип файла не соответствует расширению. Проверьте исходный файл; он не сохранён.');
  return {name:file.name.trim(),size:file.size,type};
}
function cryptoAPI(){
  if(!globalThis.crypto?.subtle?.digest)throw failure('В этом браузере недоступна проверка целостности файла. Файл не сохранён. Откройте прототип в поддерживаемом безопасном контексте.');
  return globalThis.crypto;
}
async function digest(bytes){return Array.from(new Uint8Array(await cryptoAPI().subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
function bytesOf(file){
  if(typeof file.arrayBuffer==='function')return file.arrayBuffer();
  if(typeof FileReader==='undefined')return Promise.reject(failure('Этот браузер не может прочитать выбранный файл.'));
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(failure('Файл не удалось прочитать. Выберите его заново.'));reader.onabort=()=>reject(failure('Чтение файла прервано.'));reader.readAsArrayBuffer(file);});
}
function storageError(error){
  if(error?.name==='QuotaExceededError')return failure('В локальном хранилище браузера недостаточно места. Файл не сохранён; прежние версии не изменены.');
  if(error?.name==='ConstraintError')return failure('Такой идентификатор файла уже существует. Перезапись запрещена; прежняя версия не изменена.');
  return failure('Локальное файловое хранилище недоступно. Файл не сохранён или не прочитан; прежние версии не изменены.');
}
function openStore(){
  if(!globalThis.indexedDB?.open)return Promise.reject(failure('Этот браузер не предоставляет локальное файловое хранилище. Файл не сохранён.'));
  return new Promise((resolve,reject)=>{
    let request,settled=false;
    try{request=indexedDB.open(DB_NAME,1);}catch(error){reject(storageError(error));return;}
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'blobKey'});};
    request.onerror=()=>{settled=true;reject(storageError(request.error));};
    request.onblocked=()=>{settled=true;reject(failure('Локальное хранилище занято другой вкладкой. Закройте старые вкладки Pulse и повторите; файл не сохранён.'));};
    request.onsuccess=()=>{if(settled){request.result.close();return;}resolve(request.result);};
  });
}
async function transact(mode,operation){
  const db=await openStore();
  try{return await new Promise((resolve,reject)=>{
    let tx,result,failed=false;
    const rejectOnce=error=>{if(!failed){failed=true;reject(storageError(error));}};
    try{tx=db.transaction(STORE,mode);const request=operation(tx.objectStore(STORE));request.onsuccess=()=>{result=request.result;};request.onerror=()=>rejectOnce(request.error);}catch(error){rejectOnce(error);return;}
    tx.oncomplete=()=>{if(!failed)resolve(result);};tx.onabort=()=>rejectOnce(tx.error);tx.onerror=()=>rejectOnce(tx.error);
  });}finally{db.close();}
}
function uniqueKey(){
  const crypto=cryptoAPI();
  if(typeof crypto.randomUUID==='function')return 'pulse-file:'+crypto.randomUUID();
  if(typeof crypto.getRandomValues!=='function')throw failure('Невозможно создать независимую версию файла в этом браузере.');
  return 'pulse-file:'+Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
}
async function storeFile(file,{documentId}={}){
  const metadata=validateFile(file);
  if(typeof documentId!=='string'||!documentId.trim()||documentId.length>1000)throw failure('Для файла требуется постоянный идентификатор документа.');
  const bytes=await bytesOf(file);
  if(bytes.byteLength!==metadata.size)throw failure('Размер прочитанного файла изменился. Выберите исходный файл заново.');
  const attachment={...metadata,blobKey:uniqueKey(),sha256:await digest(bytes)};
  // add, never put: a collision must fail rather than replace prior bytes.
  await transact('readwrite',store=>store.add({...attachment,documentId,bytes,storedAt:new Date().toISOString()}));
  return attachment;
}
async function readFile(attachment){
  const metadata=validateFile(attachment);
  if(typeof attachment.blobKey!=='string'||!attachment.blobKey||typeof attachment.sha256!=='string'||!/^([a-f0-9]{64})$/.test(attachment.sha256))throw failure('Ссылка на версию файла повреждена. Исходный файл не изменён.');
  const record=await transact('readonly',store=>store.get(attachment.blobKey));
  if(!record)throw failure('Байты этой версии отсутствуют в этом браузере. Возможно, данные браузера очищены или документ открыт на другом устройстве.');
  if(record.name!==metadata.name||record.size!==metadata.size||record.type!==metadata.type||record.sha256!==attachment.sha256||!record.bytes||record.bytes.byteLength!==metadata.size||await digest(record.bytes)!==attachment.sha256)throw failure('Проверка целостности не пройдена. Эта версия файла не будет скачана; исходная запись сохранена.');
  return new Blob([record.bytes],{type:metadata.type});
}
function draftKey(key){if(typeof key!=='string'||!key||key.length>2000)throw failure('Не задана область черновика.');return DRAFT_PREFIX+key;}
function loadDraft(key){try{const raw=localStorage.getItem(draftKey(key));return raw===null?null:JSON.parse(raw);}catch{return null;}}
function saveDraft(key,data){try{const serialized=JSON.stringify(data);if(serialized===undefined)throw failure('Черновик пуст.');localStorage.setItem(draftKey(key),serialized);return {persisted:true};}catch(error){return {persisted:false,error:'Черновик не удалось сохранить в браузере. Не закрывайте форму, пока не скопируете текст.'};}}
function clearDraft(key){try{localStorage.removeItem(draftKey(key));return {persisted:true};}catch{return {persisted:false,error:'Черновик не удалось удалить из локального хранилища.'};}}
return {MAX_BYTES,MIME_TYPES,validateFile,storeFile,readFile,loadDraft,saveDraft,clearDraft};
})();
__modules['document-workbench.js']=(()=>{
'use strict';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={superseded:'Заменён новым запросом',answered:'Ответ получен',requested:'Ожидается документ',submitted:'Проверка куратора',returned:'На доработке',curator_accepted:'Приёмка руководителя',accepted:'Принято'};
const button=(attrs,label,primary=false)=>`<button type="button" class="${primary?'primary':'secondary'}" ${attrs}>${esc(label)}</button>`;
function installDocumentWorkbench({ctx,state,selectedTask,mutate,changeView}){
 const store=__modules['document-storage.js'], selections=new Map(), volatileDrafts=new Map(), draftPersistence=new Map();
 const $=s=>document.querySelector(s), actor=()=>state().identity?.id;
 const scope=()=>JSON.stringify([actor(),state().selected]);
 const current=()=>selections.get(scope())||{};
 const select=value=>selections.set(scope(),value);
 const data=()=>state().memory?.requestState;
 const request=id=>data()?.requests.find(r=>r.id===id);
 const artifact=id=>data()?.artifacts.find(a=>a.id===id);
 const person=id=>state().snapshot?.employees.find(p=>p.id===id)?.name||id||'Не назначен';
 const docId=r=>r.documentId||__modules['request-workflow.js'].documentIdFor(r.taskId,r.id);
 const draftKey=(r,mode,base)=>JSON.stringify([actor(),state().selected,r.id,mode,base||'first']);
 const actionAttrs=(r,a)=>`data-request="${esc(r.id)}" data-version="${r.version}" data-artifact="${esc(a?.id||'')}" data-document="${esc(docId(r))}"`;
 const command=(r,action,extra={},version=r.version)=>mutate('request-action',{taskId:state().selected,input:{action,requestId:r.id,documentId:docId(r),expectedVersion:Number(version),...extra}});
 function focus(selector){const el=$(selector);if(el){el.focus({preventScroll:true});el.scrollIntoView?.({block:selector==='#document-reader-title'?'start':'nearest'});}}
 function render(focusTo){const host=$('#document-workbench');if(!host||!data())return;host.outerHTML=markup(selectedTask(),state().memory);if(focusTo)focus(focusTo);}
 function message(text,error=false){const el=$('#document-message');if(el){el.textContent=text;el.classList.toggle('error',error===true);el.classList.toggle('success',error===false);el.classList.toggle('pending',error===null);}}
 function clearFieldError(form,name){const id='document-error-'+name;form.querySelector('#'+id)?.remove();for(const field of form.querySelectorAll('[name]'))if(field.name===name){field.removeAttribute('aria-invalid');const ids=(field.getAttribute('aria-describedby')||'').split(' ').filter(x=>x&&x!==id);if(ids.length)field.setAttribute('aria-describedby',ids.join(' '));else field.removeAttribute('aria-describedby');}}
 function formError(form,text,name){clearFieldError(form,name);const fields=[...form.querySelectorAll('[name]')].filter(f=>f.name===name),field=fields[0],id='document-error-'+name;if(!field){message(text,true);return;}const notice=document.createElement('p');notice.id=id;notice.className='document-field-error';notice.setAttribute('role','alert');notice.textContent=text;const anchor=name==='sourceIds'?field.closest('fieldset'):field.closest('label')||field;anchor.insertAdjacentElement('afterend',notice);for(const f of fields){f.setAttribute('aria-invalid','true');f.setAttribute('aria-describedby',[f.getAttribute('aria-describedby'),id].filter(Boolean).join(' '));}field.focus({preventScroll:true});field.scrollIntoView?.({block:'center'});}
 function guard(r,a){return r.artifactReads?.some(x=>x.actorId===actor()&&x.artifactId===a?.id);}
 function decisionActions(r,a){
  const t=selectedTask(),own=r.curatorId===actor(),control=state().identity.role==='manager';
  if(!a||a.id!==r.artifactId||t.archived||t.paused||t.status==='done')return '';
  const canReview=r.status==='submitted'&&own||r.status==='curator_accepted'&&control;
  if(!canReview)return '';
  const blocked=!guard(r,a),disabled=blocked?' disabled data-unavailable="true" title="Сначала откройте содержимое этой версии"':'';
  const label=r.status==='submitted'?'Принять v'+a.version+' как куратор':'Принять итог · v'+a.version;
  return `<div class="document-decision" aria-label="Решение по версии ${a.version}"><p>Решение относится только к <strong>v${a.version}</strong> «${esc(a.title)}».</p><div class="actions">${button(`data-request-action="${r.status==='submitted'?'curator_accept':'manager_accept'}" ${actionAttrs(r,a)}${disabled}`,label,true)}${r.status==='submitted'?button(`data-request-edit="return" ${actionAttrs(r,a)}${disabled}`,'Вернуть v'+a.version+' с замечаниями'):''}</div>${blocked?'<p class="report-note">Сначала откройте документ. Прочтение само по себе не означает приёмку.</p>':''}</div>`;
 }
 function remarksMarkup(r,a){const reviews=(r.reviews||[]).filter(x=>x.artifactId===a.id);return reviews.length?`<section class="document-remarks" aria-label="Замечания и решения по версии ${a.version}"><h4>Замечания и решения · v${a.version}</h4>${reviews.map(v=>`<p><strong>${v.action==='return'?'Возвращено на доработку':v.action==='manager_accept'?'Принято руководителем':'Принято куратором'}</strong> · ${esc(person(v.actorId))} · ${esc(ctx.date(v.at,true))}${v.reason?`<br>${esc(v.reason)}`:''}</p>`).join('')}</section>`:'';}
 function reader(r,a){
  const latest=a.id===r.artifactId;
  return `<section class="document-reader" data-workarea-reader data-viewed-artifact="${esc(a.id)}" aria-labelledby="document-reader-title"><div class="document-reader-heading"><h3 id="document-reader-title" tabindex="-1">${esc(a.title)} · v${a.version}</h3>${button('data-document-collapse','Свернуть просмотр')}</div><p class="document-version-line"><strong>Просматривается v${a.version}</strong> · ${latest?'актуальная':'историческая, актуальная v'+(artifact(r.artifactId)?.version||'—')} · ${esc(ctx.date(a.createdAt,true))}</p>${!latest?'<p class="pause-note">Историческая версия только для чтения. Приёмка и доработка не переносятся на неё.</p>':''}${a.sections.map(s=>`<section class="document-text"><h4>${esc(s.heading)}</h4><p>${esc(s.body)}</p></section>`).join('')}${a.attachments?.length?`<section class="document-files"><h4>Файлы этой версии</h4>${a.attachments.map((f,i)=>`<div class="document-file"><span>${esc(f.name)}<small>${(f.size/1024).toFixed(1)} КиБ · серверная версия</small></span>${button(`data-file-download="${i}" data-artifact="${esc(a.id)}"`,'Скачать')}<p class="document-download-status report-note" role="status" aria-live="polite"></p></div>`).join('')}<p class="report-note">Содержимое файлов не анализировалось. Скачивание проверяет целостность сохранённых байтов.</p></section>`:''}<section class="document-criteria"><h4>Критерии проверки</h4>${a.criteria.map(c=>`<p><strong>${esc(a.requiredCriteria?.find(x=>x.id===c.id)?.label||c.id)} — ${c.passed?'подтверждён':'не пройден'}</strong><br>${esc(c.evidence)}</p>`).join('')}</section>${a.response?`<section class="document-remarks"><h4>Как устранены замечания ${a.respondsToArtifactId?'к v'+(artifact(a.respondsToArtifactId)?.version||'—'):''}</h4><p>${esc(a.response)}</p></section>`:''}${remarksMarkup(r,a)}<details class="document-sources"><summary>Источники этой версии · ${a.sourceIds.length}</summary>${a.sourceIds.map(id=>`<blockquote>${esc(state().memory.sources.find(s=>s.id===id)?.text||'Источник недоступен в этой роли')}<small>${esc(id)}</small></blockquote>`).join('')}</details>${current().mode==='return'&&current().requestId===r.id?returnForm(r,a):decisionActions(r,a)}</section>`;
 }
 function draftFor(r,mode,base){const key=draftKey(r,mode,base),memory=volatileDrafts.get(key),saved=store.loadDraft(key);return {key,value:memory||saved,persisted:false};}
 function artifactForm(r){
  const sel=current(),base=artifact(sel.baseArtifactId),{key,value,persisted}=draftFor(r,'edit',sel.baseArtifactId);
  const initial={title:base?.title||r.text,body:base?.sections.map(s=>base.sections.length>1?s.heading+'\n'+s.body:s.body).join('\n\n')||'',criteria:r.criteria.map(c=>{const old=base?.criteria.find(x=>x.id===c.id);return {id:c.id,passed:old?.passed||false,evidence:old?.evidence||''};}),sourceIds:base?.sourceIds||[],response:'',attachments:base?.attachments||[]};
  const v=value||initial;sel.attachments=v.attachments||[];selections.set(scope(),sel);
  const stale=r.version!==sel.expectedVersion||r.artifactId!==sel.baseArtifactId&&Boolean(r.artifactId||sel.baseArtifactId);
  const fields=r.criteria.map((c,i)=>{const old=v.criteria?.find(x=>x.id===c.id)||{};return `<fieldset><legend>${esc(c.label)}</legend><label class="check-label"><input type="checkbox" name="passed-${i}"${old.passed?' checked':''}> Критерий подтверждён</label><label>Доказательство / измерение<textarea name="evidence-${i}" required>${esc(old.evidence||'')}</textarea></label></fieldset>`}).join('');
  return `<section class="document-edit" aria-labelledby="document-edit-title"><h3 id="document-edit-title" tabindex="-1">Новая версия · v${(base?.version||0)+1}</h3><p class="report-note">${base?'Предыдущий текст и основания перенесены. Измените нужное; v'+base.version+' останется неизменной.':'Опишите результат и его проверку. Файл не заменяет содержательное пояснение.'}</p>${r.requiredRemarks?`<div class="document-remarks"><strong>Исправить замечания к v${base?.version||'—'}</strong><p>${esc(r.requiredRemarks)}</p></div>`:''}${stale?'<p class="pause-note">Запрос изменился. Черновик сохранён, но эта форма не может передать версию. Вернитесь к документу и откройте новую версию заново.</p>':''}<form id="recursive-artifact" data-request="${esc(r.id)}" data-version="${sel.expectedVersion}" data-base="${esc(sel.baseArtifactId||'')}" data-draft-key="${esc(key)}"><label>Название документа<input name="title" value="${esc(v.title)}" readonly maxlength="200"></label><label>Содержательный результат, проверка и ограничения<textarea name="body" required minlength="1" maxlength="100000" class="document-body">${esc(v.body)}</textarea></label><div class="document-criteria-edit">${fields}</div>${r.status==='returned'?`<label>Как устранены замечания<textarea name="response" required minlength="10">${esc(v.response)}</textarea></label>`:''}<fieldset class="document-upload"><legend>Файлы новой версии · необязательно</legend><div id="document-attachment-list">${editFiles(v.attachments||[])}</div><label>Добавить TXT, MD, CSV, PDF, DOCX или XLSX<input id="document-file-input" type="file" accept=".txt,.md,.csv,.pdf,.docx,.xlsx" multiple></label><p class="report-note">До 4 файлов, каждый до 2 МиБ. Только хранение и скачивание; редактирования Office и извлечения содержимого нет.</p><p id="document-file-status" role="status" class="report-note"></p></fieldset><p id="document-draft-status" class="report-note" role="status">${value?(persisted?'Восстановлен черновик из этого браузера.':'Черновик только в памяти вкладки: сохранение недоступно. Не закрывайте вкладку; скопируйте текст. Не передан на проверку.'):'Изменения сохраняются как локальный черновик, не отправляются.'}</p><div class="actions"><button type="submit" class="primary"${stale?' disabled data-unavailable="true"':''}>Передать v${(base?.version||0)+1} куратору</button>${button('data-document-cancel','Назад к документу')}</div></form></section>`;
 }
 function editFiles(files){return files.map((f,i)=>`<div class="document-file"><span>${esc(f.name)}<small>${(f.size/1024).toFixed(1)} КиБ · ссылка в черновике</small></span>${button(`data-file-remove="${i}"`,'Не включать в новую версию')}</div>`).join('')||'<p class="report-note">Файлы не выбраны. Текстовый документ можно передать без них.</p>';}
 function returnForm(r,a){const sel=current(),{key,value,persisted}=draftFor(r,'return',a.id);return `<form id="recursive-request-return" class="document-return" data-request="${esc(r.id)}" data-version="${sel.expectedVersion}" data-artifact="${esc(a.id)}" data-draft-key="${esc(key)}"><h4>Замечания к v${a.version}</h4><label>Что исправить<textarea name="reason" required minlength="10">${esc(value?.reason||'')}</textarea></label><p class="report-note" id="document-draft-status" role="status">${value?(persisted?'Черновик замечаний восстановлен.':'Замечания только в памяти вкладки: сохранение недоступно. Скопируйте текст до закрытия вкладки.'):'Замечания будут связаны с этой версией.'}</p><div class="actions"><button type="submit" class="primary">Вернуть v${a.version} на доработку</button>${button('data-document-cancel','Отменить возврат')}</div></form>`;}
 function record(r){
  const latest=artifact(r.artifactId),sel=current(),viewed=sel.requestId===r.id?artifact(sel.artifactId):null;
  const t=selectedTask(),active=!t.archived&&!t.paused&&t.status!=='done',canSubmit=active&&r.deliveredAt&&(r.ownerId===actor()||r.coexecutorIds?.includes(actor())),versions=data().artifacts.filter(a=>a.requestId===r.id).slice().sort((a,b)=>b.version-a.version);
  const accepted=artifact(r.acceptedArtifactId),editing=sel.requestId===r.id&&sel.mode==='edit';
  return `<article class="document-record" data-document-id="${esc(docId(r))}"><div class="document-record-heading"><h3>${esc(latest?.title||r.text)}</h3><span>${esc(statuses[r.status]||r.status)}</span></div><p class="document-version-line">Актуальная: <strong>${latest?'v'+latest.version:'ещё нет'}</strong> · Принята руководителем: <strong>${accepted?'v'+accepted.version:'не принята'}</strong></p><p class="report-note">Срок: ${esc(ctx.date(r.deadline,true))}${r.nextOwnerId?' · Следующий шаг: '+esc(person(r.nextOwnerId)):''}</p>${r.status==='returned'&&!editing?`<div class="document-remarks"><strong>Доработать v${latest?.version||'—'}</strong><p>${esc(r.requiredRemarks)}</p></div>`:''}<div class="actions">${latest&&!viewed&&!editing?button(`data-artifact-open="${esc(latest.id)}"`,'Открыть актуальную · v'+latest.version,true):''}${viewed&&viewed.id!==latest?.id?button(`data-artifact-open="${esc(latest?.id)}"`,'К актуальной · v'+latest?.version,true):''}${canSubmit&&!editing?button(`data-request-edit="submit" ${actionAttrs(r,latest)}`,latest?'Подготовить новую версию':'Передать документ',!latest):''}${r.kind==='status'&&r.status==='requested'&&r.ownerId===actor()?button('data-detail-view="chat"','Ответить в переписке'):''}</div>${!viewed&&!editing?decisionActions(r,latest):''}${editing?artifactForm(r):viewed?reader(r,viewed):''}${versions.length>1?`<details class="document-history"><summary>История версий · ${versions.length}</summary><ol>${versions.map(a=>`<li>${button(`data-artifact-open="${esc(a.id)}"${a.id===viewed?.id?' aria-current="true"':''}`,'v'+a.version+' · '+ctx.date(a.createdAt,true))}<span>${a.id===latest?.id?'Актуальная · ':''}${a.id===r.acceptedArtifactId?'Принята руководителем':(r.reviews||[]).some(v=>v.artifactId===a.id&&v.action==='return')?'Есть замечания':''}</span></li>`).join('')}</ol></details>`:''}<details class="document-technical"><summary aria-label="Сведения о запросе и идентификаторы">⋯ Сведения о запросе</summary><p>${esc(r.text)}</p><p>Документ: <span class="document-id">${esc(docId(r))}</span></p><p>Доставка: ${r.deliveredAt?'запрос сохранён на сервере':'ожидается'} · получение: ${r.acknowledgedAt?'подтверждено':'не подтверждено'}. Получение не означает выполнение.</p>${r.status==='requested'&&!r.deliveredAt&&active?button(`data-request-action="deliver" ${actionAttrs(r,latest)}`,'Повторить локальную доставку'):''}${r.status==='requested'&&r.deliveredAt&&!r.acknowledgedAt&&r.ownerId===actor()?button(`data-request-action="acknowledge" ${actionAttrs(r,latest)}`,'Подтвердить получение'):''}</details></article>`;
 }
 function markup(task,memory){
  const rs=memory.requestState;if(!rs)return '';
  const results=rs.requests.filter(r=>r.kind!=='status'),statusRequests=rs.requests.filter(r=>r.kind==='status');
  const canCreate=state().identity.role==='manager'&&!task.documentOnly&&!task.paused&&!task.archived&&task.status!=='done';
  return `<section id="document-workbench" class="workspace-section document-workbench" aria-label="Документ и проверка"><div class="section-heading"><h3>Документ и проверка</h3>${canCreate?button('data-request-new','Запросить результат'):''}</div><p id="document-message" class="message" role="status" aria-live="polite"></p>${results.map(record).join('')||'<p class="report-note">Запросов документа пока нет. Для простого поручения можно передать текстовый итог ниже.</p>'}${statusRequests.length?`<details class="document-history"><summary>Запросы статуса · ${statusRequests.length}</summary>${statusRequests.map(r=>`<p><strong>${esc(statuses[r.status]||r.status)}</strong> · ${esc(r.text)}</p>${r.status==='requested'&&r.ownerId===actor()?button('data-detail-view="chat"','Ответить в переписке'):''}`).join('')}</details>`:''}<details class="document-storage-note"><summary>Как здесь сохраняются документы</summary><p>Текст, версии, решения и файлы общие и сохраняются на сервере. Доступ проверяется по персональному сеансу. Черновики и выбранные, но не переданные файлы остаются только в памяти вкладки. Проверка сигнатуры и целостности — не антивирус; содержимое Office и PDF не анализируется.</p></details></section>`;
 }
 function collect(form){const r=request(form.dataset.request),v=n=>form.elements.namedItem(n)?.value||'';
  if(form.id==='recursive-request-return')return {reason:v('reason')};
  return {title:v('title'),body:v('body'),response:v('response'),criteria:r.criteria.map((c,i)=>({id:c.id,passed:form.elements.namedItem('passed-'+i).checked,evidence:v('evidence-'+i)})),sourceIds:[...form.querySelectorAll('[name=sourceIds]:checked')].map(e=>e.value),attachments:current().attachments||[]};
 }
 function saveForm(form){if(!form?.dataset.draftKey)return;const value=collect(form),key=form.dataset.draftKey;volatileDrafts.set(key,value);const result=store.saveDraft(key,value);draftPersistence.set(key,result.persisted);const msg=$('#document-draft-status');if(msg)msg.textContent=result.persisted?'Черновик сохранён в этом браузере. Не передан на проверку.':result.error;}
 const dialog=$('#task-dialog');
 dialog.addEventListener('input',e=>{const form=e.target.closest('#recursive-artifact,#recursive-request-return');if(form){if(e.target.name)clearFieldError(form,e.target.name);saveForm(form);}});
 dialog.addEventListener('change',async e=>{
  const form=e.target.closest('#recursive-artifact,#recursive-request-return');if(!form)return;
  if(e.target.id!=='document-file-input'){saveForm(form);return;}
  const files=[...e.target.files],sel=current(),r=request(form.dataset.request),status=$('#document-file-status'),selectionScope=scope();
  if(!files.length)return;
  if(ctx.busy()){status.textContent='Дождитесь текущего сохранения, затем выберите файлы снова.';e.target.value='';return;}
  if((sel.attachments?.length||0)+files.length>4){status.textContent='Можно включить до четырёх файлов. Новые файлы не сохранены.';e.target.value='';return;}
  try{files.forEach(store.validateFile);}catch(error){status.textContent=error.message;e.target.value='';return;}
  e.target.disabled=true;ctx.setBusy(true);status.textContent='Читаем выбранные файлы в память вкладки…';
  try{for(const file of files){const saved=await store.storeFile(file,{documentId:docId(r)});sel.attachments=[...(sel.attachments||[]),saved];if(scope()===selectionScope){select(sel);saveForm(form);}}if(scope()===selectionScope){$('#document-attachment-list').innerHTML=editFiles(sel.attachments);status.textContent='Файлы включены в черновик в памяти вкладки. На сервер ещё не переданы.';}}
  catch(error){if(scope()===selectionScope){$('#document-attachment-list').innerHTML=editFiles(sel.attachments||[]);status.textContent=error.message;}}
  finally{e.target.value='';e.target.disabled=false;ctx.setBusy(false);}
 });
 dialog.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||b.disabled||ctx.busy())return;
  if(b.dataset.artifactOpen){
   const a=artifact(b.dataset.artifactOpen),r=a&&request(a.requestId);if(!a||!r)return;changeView?.('workspace');
   select({requestId:r.id,artifactId:a.id,mode:'read'});
   if(a.id===r.artifactId&&!['accepted','answered','superseded'].includes(r.status)&&!guard(r,a)){const result=await command(r,'open_artifact',{artifactId:a.id});if(!result){select({});render();return;}}
   render('#document-reader-title');return;
  }
  if(b.hasAttribute('data-document-collapse')){select({});render('#document-workbench h3');return;}
  if(b.hasAttribute('data-document-cancel')){saveForm($('#recursive-artifact,#recursive-request-return'));const sel=current(),r=request(sel.requestId);select({requestId:r?.id,artifactId:r?.artifactId,mode:'read'});render('#document-reader-title');return;}
  if(b.dataset.requestEdit){const r=request(b.dataset.request);if(!r)return;const mode=b.dataset.requestEdit==='submit'?'edit':'return';select({requestId:r.id,artifactId:b.dataset.artifact||r.artifactId,baseArtifactId:b.dataset.artifact||r.artifactId,expectedVersion:Number(b.dataset.version),mode});render(mode==='edit'?'#recursive-artifact [name=title]':'#recursive-request-return [name=reason]');return;}
  if(b.dataset.requestAction){const r=request(b.dataset.request);if(!r)return;const result=await command(r,b.dataset.requestAction,{artifactId:b.dataset.artifact||undefined},b.dataset.version);if(result){render('#document-reader-title');message('Решение сохранено с точной версией.');}return;}
  if(b.hasAttribute('data-file-remove')){const form=$('#recursive-artifact'),sel=current();sel.attachments=(sel.attachments||[]).filter((_,i)=>i!==Number(b.dataset.fileRemove));select(sel);saveForm(form);$('#document-attachment-list').innerHTML=editFiles(sel.attachments);focus('#document-file-input');return;}
  if(b.hasAttribute('data-file-download')){const a=artifact(b.dataset.artifact),f=a?.attachments?.[Number(b.dataset.fileDownload)];if(!f)return;const notice=b.closest('.document-file')?.querySelector('[role=status]');const feedback=(text,error=false)=>{if(notice){notice.textContent=text;notice.classList.toggle('error',error===true);notice.classList.toggle('success',error===false);}else message(text,error);};ctx.setBusy(true);feedback('Проверяем сохранённый файл…',null);try{const blob=await store.readFile(f),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=f.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);feedback('Файл проверен; скачивание запрошено в браузере.');}catch(error){feedback(error.message,true);}finally{ctx.setBusy(false);b.focus({preventScroll:true});}return;}
 });
 dialog.addEventListener('submit',async e=>{
  const form=e.target;if(!['recursive-artifact','recursive-request-return'].includes(form.id))return;e.preventDefault();if(ctx.busy())return;
  const r=request(form.dataset.request);if(!r)return;saveForm(form);const values=collect(form),sel={...current()},key=form.dataset.draftKey;
  const error=(text,name)=>formError(form,text,name);
  if(form.id==='recursive-request-return'&&values.reason.trim().length<10){error('Укажите конкретное замечание: не менее 10 значащих символов.','reason');return;}
  if(form.id==='recursive-artifact'){
   if(!values.title.trim()){error('Укажите название документа.','title');return;}
   if(values.body.trim().length<1){error('Опишите фактический результат и проверку: не менее одного символа.','body');return;}
   const incomplete=values.criteria.findIndex(c=>!c.evidence.trim());if(incomplete>=0){error('Добавьте доказательство по каждому критерию.','evidence-'+incomplete);return;}
   
   if(r.status==='returned'&&values.response.trim().length<10){error('Опишите, как устранены замечания к предыдущей версии.','response');return;}
  }
  select({requestId:r.id,artifactId:r.artifactId,mode:'read'});
  const input=form.id==='recursive-request-return'?{artifactId:form.dataset.artifact,reason:values.reason}:{response:values.response,artifact:{title:values.title,sections:[{heading:'Результат, проверка и ограничения',body:values.body}],criteria:values.criteria,sourceIds:values.sourceIds,attachments:values.attachments}};
  const result=await command(r,form.id==='recursive-request-return'?'return':'submit',input,form.dataset.version);
  if(result){volatileDrafts.delete(key);draftPersistence.delete(key);store.clearDraft(key);const fresh=request(r.id);select(form.id==='recursive-artifact'?{}:{requestId:r.id,artifactId:fresh.artifactId,mode:'read'});render(form.id==='recursive-artifact'?'#document-workbench [data-artifact-open]':'#document-reader-title');message(form.id==='recursive-artifact'?'Новая версия сохранена. Предыдущая версия и её замечания не изменены.':'Замечания сохранены к проверенной версии.');}
  else {select(sel);render(form.id==='recursive-artifact'?'#recursive-artifact [name=title]':'#recursive-request-return [name=reason]');formError($('#'+form.id),$('#detail-message')?.textContent||'Действие не подтверждено. Черновик сохранён; повторите после проверки данных.',form.id==='recursive-artifact'?'title':'reason');}
 });
 return {markup,mounted(){},reset(){selections.clear();}};
}
return {installDocumentWorkbench};
})();
__modules['recursive-ui.js']=(()=>{
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(attrs,label)=>`<button type="button" class="secondary" ${attrs}>${esc(label)}</button>`;
const status={superseded:'Заменён запросом результата',answered:'Ответ получен',requested:'Ожидается ответ или результат',submitted:'Проверка куратора',returned:'На доработке',curator_accepted:'Приёмка руководителя',accepted:'Принято'};
function installRecursiveUI({ctx,state,selectedTask,mutate,openEditor,changeView}){
 const documents=__modules['document-workbench.js'].installDocumentWorkbench({ctx,state,selectedTask,mutate,changeView});
 const id=()=>state().identity.id;
 const req=rid=>state().memory.requestState?.requests.find(r=>r.id===rid);
 const action=(r,a,extra={})=>mutate('request-action',{taskId:state().selected,input:{action:a,requestId:r.id,expectedVersion:r.version,...extra}});
 const panel=document.createElement('details');panel.className='brief-panel';panel.id='recursive-coordination';document.querySelector('.brief-panel').after(panel);
 function renderQueues(){const q=state().snapshot?.queues;if(!q){panel.hidden=true;return;}panel.hidden=false;const names={needsManagerDecision:'Нужно решение человека',waitingAnswer:'Ожидается ответ',selfChecked:'Проверено по источникам'};panel.innerHTML=`<summary>Маркус · три рабочие очереди</summary><p class="report-note">Детерминированная локальная политика. Не живой ИИ, не отправка сотрудникам, не замена приёмки.</p><div class="actions">${state().identity.role==='manager'?button('data-markus-tick','Выполнить один цикл координации')+button('data-monthly-draft','Месячный черновик по источникам')+button('data-routine-new','План повторяющейся рутины'):''}</div>${(state().snapshot.routineSeries||[]).length?`<details><summary>Серии рутины · ${state().snapshot.routineSeries.length}</summary>${state().snapshot.routineSeries.map(s=>`<p>${esc(s.title)} · ${esc(({active:'Действует',paused:'На паузе',cancelled:'Отменена'})[s.status]||s.status)} · ${esc(({monthly:'Ежемесячно',quarterly:'Ежеквартально',yearly:'Ежегодно'})[s.frequency]||s.frequency)}${s.controlOwnerId===id()&&s.status!=='cancelled'?button(`data-series-action="${s.status==='active'?'pause_series':'resume_series'}" data-series="${esc(s.id)}"`,s.status==='active'?'Пауза новых циклов':'Возобновить новые циклы')+button(`data-series-action="cancel_series" data-series="${esc(s.id)}"`,'Отменить будущие циклы'):''}</p>`).join('')}</details>`:''}${Object.entries(names).map(([key,label])=>`<details><summary>${label} · ${(q[key]||[]).length}</summary>${(q[key]||[]).map(r=>`<p>${button(`data-recursive-task="${esc(r.taskId)}"`,r.taskId+' · '+r.title)}<small>${esc(r.reason)}${r.forecastDate?' · прогноз '+esc(r.forecastDate):''}</small></p>`).join('')}</details>`).join('')}`;}
 panel.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b||ctx.busy())return;if(b.dataset.seriesAction){await mutate('routine-action',{input:{action:b.dataset.seriesAction,seriesId:b.dataset.series}});return;}if(b.dataset.recursiveTask){ctx.openTask(b.dataset.recursiveTask);return;}if(b.hasAttribute('data-markus-tick')){await mutate('markus-tick',{});return;}if(b.hasAttribute('data-monthly-draft')){const out=await mutate('monthly-draft',{asOf:state().snapshot.asOf});if(out?.report)openEditor('Месячный черновик · на дату '+out.report.asOf,`<pre class="workbench-pre">${esc(out.report.text)}</pre><p class="report-note">Черновик сохранён в разделе отчётов. Не является согласованным отчётом.</p>`);return;}if(b.hasAttribute('data-routine-new'))openEditor('Повторяемая рутина · независимые циклы',`<form id="recursive-routine"><label>Название<input name="title" required></label><label>Ответственный<select name="ownerId">${state().snapshot.employees.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>Период<select name="frequency"><option value="monthly">Месяц</option><option value="quarterly">Квартал</option><option value="yearly">Год</option></select></label><label>Первый основной старт (МСК)<input name="firstStartAt" type="datetime-local" required></label><label>До даты<input name="untilDate" type="date" required></label><label>Дней от основного старта до результата<input name="dueOffsetDays" type="number" min="0" value="5" required></label><label>Подготовительный комплект<input name="preparation" required></label><label>Подготовить за дней до старта<input name="preparationDays" type="number" min="1" value="7" required></label><p class="report-note">Незавершённые циклы не исчезают. Пауза серии останавливает создание новых циклов, не принимает и не закрывает существующие.</p><button type="submit" class="primary">Сохранить локальный план</button></form>`);});

 function detailMarkup(task,memory){
  const rstate=memory.requestState;if(!rstate)return '';
  const own=task.employeeId===id(),control=task.canControl&&state().identity.role==='manager';
  const evidence=memory.evidence,ready=memory.readiness;
  return `${documents.markup(task,memory)}${evidence?`<details class="workspace-section"><summary>План, прогноз и подтверждения · ${esc(evidence.forecastDate||'прогноз неизвестен')}</summary><pre class="workbench-pre">${esc(evidence.text)}</pre>${(own||control)?(memory.sources.length?button('data-planning-new','Уточнить прогноз с источником'):'<p class="report-note">Сначала добавьте сообщение-основание в переписку. Без источника прогноз не записывается.</p>'):''}</details>`:''}${ready?.mainStartAt?`<details class="workspace-section" open><summary>Подготовка к основному старту</summary><p>Основной старт: ${esc(ready.mainStartAt)} · ${ready.ready?'готовность подтверждена':'есть условия старта'}</p>${(ready.blockers||[]).map(b=>`<p>${esc(b.message||b)}</p>`).join('')}${control&&task.status==='planned'&&ready.blockers.some(b=>b.code==='before_main_start')?button('data-early-start','Разрешить досрочный основной старт…'):''}<p class="report-note">Подготовительные этапы доступны до основного старта. Наступление даты само по себе не подтверждает комплект документов.</p></details>`:''}`;
 }
 document.querySelector('#task-dialog').addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||ctx.busy())return;const task=selectedTask();if(!task)return;
  if(b.hasAttribute('data-early-start')){openEditor('Досрочный основной старт',`<form id="recursive-early-start"><label>Основание решения руководителя<textarea name="reason" required></textarea></label><p>Готовность обязательной подготовки всё равно проверяется. Плановая дата сохраняется отдельно от фактического старта.</p><button type="submit" class="primary">Начать досрочно с основанием</button></form>`);return;}
  if(b.hasAttribute('data-request-new')){openEditor('Запрос документа',`<form id="recursive-request-create"><label>Название и результат<input name="text" required maxlength="200"></label><label>Куратор проверки<select name="curatorId" required>${state().snapshot.employees.filter(p=>p.id!==task.employeeId&&p.enabled!==false).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><p class="report-note">Исполнитель — ответственный по поручению. Куратор проверяет версию; руководитель принимает согласованный итог. Запрос сохраняется на сервере, внешние уведомления не отправляются.</p><button type="submit" class="primary">Создать запрос</button></form>`);return;}
  if(b.hasAttribute('data-planning-new')){openEditor('Прогноз отдельно от утверждённого плана',`<form id="recursive-forecast"><label>Ожидаемая дата<input name="date" type="date" required></label><label>Минимальный срок, календарных дней (пусто — неизвестно)<input name="leadDays" type="number" min="0"></label><label>Основание<select name="sourceId" required>${state().memory.sources.map(s=>`<option value="${esc(s.id)}">${esc(s.text.slice(0,120))}</option>`).join('')}</select></label><label>Что изменилось<textarea name="note" required></textarea></label><button type="submit" class="primary">Сохранить прогноз с источником</button></form>`);}
 });
 document.querySelector('#editor-dialog').addEventListener('submit',event=>{
  const f=event.target;if(!f.id.startsWith('recursive-'))return;event.preventDefault();const v=n=>f.elements.namedItem(n)?.value||'',taskId=state().selected;
  if(f.id==='recursive-early-start')mutate('task-action',{taskId,action:'start',early:true,reason:v('reason'),expectedVersion:state().memory.taskVersion},{dialog:'#editor-dialog'});
  if(f.id==='recursive-routine')mutate('routine-action',{input:{action:'create_series',series:{id:crypto.randomUUID(),title:v('title'),ownerId:v('ownerId'),frequency:v('frequency'),firstStartAt:v('firstStartAt')+':00+03:00',untilDate:v('untilDate'),template:{dueOffsetDays:Number(v('dueOffsetDays')),preparation:[{id:'preparation-docs',title:v('preparation'),ownerId:v('ownerId'),offsetDays:-Number(v('preparationDays')),mandatory:true}]}}}},{dialog:'#editor-dialog'});
  if(f.id==='recursive-request-create')mutate('request-action',{taskId,input:{action:'create',text:v('text'),curatorId:v('curatorId')}},{dialog:'#editor-dialog'});
  if(f.id==='recursive-forecast')mutate('planning-action',{taskId,input:{kind:'forecast',date:v('date'),leadDays:v('leadDays')===''?null:Number(v('leadDays')),sourceId:v('sourceId'),note:v('note'),expectedVersion:state().memory.evidence.planningVersion??state().memory.evidence.version??0}},{dialog:'#editor-dialog'});
 });
 return {detailMarkup,renderQueues,mounted:documents.mounted,reset:documents.reset};
}
return {installRecursiveUI};})();
__modules["prototype-ui.js"]=(()=>{
const {stageAccepted, stageAssignee}=__modules['stage-workflow.js'];
const {createCardPulseController}=__modules['pulse-motion.js'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const labels = { planned:'Ожидает старта', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const boardColumns = [['planned','Ожидает старта'],['active','В работе'],['blocked','Препятствие'],['review','На проверке']];
const draftNames = { extension:'Письмо о переносе', request:'Запрос данных', clarify:'Уточнение статуса', plan:'План действий', review:'Проверка результата' };
const fieldNames = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const shift = (day, n) => new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow' }).format(new Date());

function decisionEvidenceMarkup(job) {
  if (job.status !== 'completed') return '';
  return (job.decisionReferences || []).map(ref => `<blockquote>По записи платформы результат принят.<small>${esc(ref.actorName || 'Руководитель')} · ${esc(ref.at || '')}</small></blockquote>`).join('');
}

// Host-recorded state, never inferred from model prose or presence of a route.
function assistantReviewLabel(job) {
  if (!job.execution) return 'Независимая проверка не подтверждена.';
  if (job.execution.reviewStatus === 'passed' && job.status === 'completed') return 'Ответ прошёл проверку моделью; решение остаётся за тобой.';
  if (job.execution.reviewStatus === 'rejected') return 'Проверяющий отклонил ответ; черновик не опубликован.';
  if (job.execution.reviewStatus === 'not_run' && job.status === 'completed') return 'Независимая проверка не выполнялась.';
  return 'Независимая проверка не подтверждена.';
}

// Derived presentation only: approved deadline, never creation/start or proposedDue.
function deadlineState(task, now = Date.now()) {
  if (task.status === 'done') return { text:'Завершено', kind:'done' };
  if (!task.due) return { text:'Без срока', kind:'none' };
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  if (!Number.isFinite(remaining)) return { text:'Без срока', kind:'none' };
  const hours = Math.max(1, Math.ceil(Math.abs(remaining) / 3600000));
  const span = hours >= 24 ? `${Math.ceil(hours / 24)} дн.` : `${hours} ч.`;
  return { text:remaining === 0 ? 'Срок наступил' : remaining < 0 ? `Просрочено на ${span}` : remaining < 3600000 ? 'Срок меньше часа' : `Осталось ${span}`,
    kind:remaining <= 0 ? 'overdue' : remaining < 86400000 ? 'soon' : 'normal' };
}
function cardPulseProgress(task, now = Date.now()) {
  if (!task.due || task.status === 'review' || task.status === 'done') return 0;
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  return Number.isFinite(remaining) ? Math.max(0, Math.min(1, 1 - remaining / 86400000)) : 0;
}
function cardPulseState(task, now = Date.now()) {
  const due = deadlineState(task, now);
  if (task.paused || (task.status==='planned'&&task.startAt&&Date.parse(task.startAt)>now)) return { mode:'planned', tone:'planned' };
  if (task.status === 'done') return { mode:'done', tone:'accepted' };
  if (task.status === 'review') return { mode:'review', tone:'review' };
  const urgency = due.kind === 'overdue' ? 'overdue' : due.kind === 'soon' ? 'soon' : null;
  if (task.status === 'blocked' || task.blocker?.trim()) return { mode:'blocked', tone:urgency || 'blocked' };
  if (urgency) return { mode:urgency, tone:urgency };
  return task.status === 'active' ? { mode:'active', tone:'active' } : { mode:'planned', tone:'planned' };
}
// Exact approved demo waveforms; only presentation, never a medical measurement.
const pulsePaths = {
  "planned": "M0 26H65 C80 26 85 23 95 23 S115 29 125 29 S145 26 160 26 H300",
  "active": "M0 26H15 C23 26 23 20 28 20 S35 32 40 32 S48 8 54 8 S61 43 68 43 S77 18 84 18 S93 26 102 26 H127 C135 26 135 20 140 20 S147 32 152 32 S160 8 166 8 S173 43 180 43 S189 18 196 18 S205 26 214 26 H239 C247 26 247 20 252 20 S259 32 264 32 S272 8 278 8 S285 26 292 26 H300",
  "soon": "M0 26H7 C12 26 12 20 17 20 S23 33 28 33 S35 8 40 8 S47 43 52 43 S59 19 64 19 S71 26 78 26 H83 C88 26 88 20 93 20 S99 33 104 33 S111 8 116 8 S123 43 128 43 S135 19 140 19 S147 26 154 26 H159 C164 26 164 20 169 20 S175 33 180 33 S187 8 192 8 S199 43 204 43 S211 19 216 19 S223 26 230 26 H235 C240 26 240 20 245 20 S251 33 256 33 S263 8 268 8 S275 43 280 43 S287 26 294 26 H300",
  "overdue": "M0 26H5 C9 26 9 31 13 31 S20 6 25 6 S31 45 36 45 S42 19 47 19 S53 26 58 26 H63 C67 26 67 31 71 31 S78 6 83 6 S89 45 94 45 S100 19 105 19 S111 26 116 26 H121 C125 26 125 31 129 31 S136 6 141 6 S147 45 152 45 S158 19 163 19 S169 26 174 26 H179 C183 26 183 31 187 31 S194 6 199 6 S205 45 210 45 S216 19 221 19 S227 26 232 26 H237 C241 26 241 31 245 31 S252 6 257 6 S263 45 268 45 S274 19 279 19 S285 26 290 26 H300",
  "blocked": "M0 26H55 C64 26 66 24 71 24 S79 29 84 29 S92 22 97 22 S105 29 110 29 S119 26 128 26 H205 C214 26 216 24 221 24 S229 29 234 29 S242 22 247 22 S255 29 260 29 S269 26 278 26 H300",
  "review": "M0 26H52 C60 26 61 22 67 22 S74 29 79 29 L86 12 L93 36 L100 23 C107 19 111 26 122 26 H205 C213 26 214 22 220 22 S227 29 232 29 L239 12 L246 36 L253 23 C260 19 264 26 275 26 H300",
  "done": "M0 26H300"
};
function cardPulsePath(mode) { return pulsePaths[mode] || pulsePaths.planned; }
function pulseMarkup(mode) {
  const path = cardPulsePath(mode);
  return `<div class="card-pulse" aria-hidden="true"><canvas aria-hidden="true"></canvas><svg viewBox="0 0 300 52" preserveAspectRatio="none" focusable="false" aria-hidden="true"><path class="pulse-track" pathLength="740" d="${path}"/><path class="pulse-wave" pathLength="740" d="${path}"/></svg></div>`;
}

// Explicit board ordering only; no unread/attention inputs and no clock-based ranking.
// Pins remain first in every mode. Invalid/missing approved deadlines sort last.
function sortBoardTasks(tasks, pins = [], mode = 'priority') {
  const priority = {urgent:2, high:1, normal:0};
  const status = {planned:0, active:1, blocked:2, review:3, done:4};
  const due = task => {
    const value = task.due ? Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) : NaN;
    return Number.isFinite(value) ? value : Infinity;
  };
  const compareDue = (a,b) => due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1;
  const comparePriority = (a,b) => (priority[b.priority] || 0) - (priority[a.priority] || 0);
  const compareStatus = (a,b) => (status[a.status] ?? 5) - (status[b.status] ?? 5);
  return tasks.map((task,index)=>({task,index})).sort((a,b)=>
    Number(pins.includes(b.task.id))-Number(pins.includes(a.task.id)) ||
    (mode === 'deadline' ? compareDue(a.task,b.task) : mode === 'status' ? compareStatus(a.task,b.task) : comparePriority(a.task,b.task)) ||
    (mode === 'priority' ? compareDue(a.task,b.task) : 0) ||
    String(a.task.id).localeCompare(String(b.task.id), 'en') || a.index-b.index
  ).map(item=>item.task);
}

function installPrototype(ctx) {
  const $ = s => document.querySelector(s);
  let sortMode='priority';
  let view='board', month=today().slice(0,7)+'-01', lastInteraction=Date.now(), auto=false, draft=null, editingTask=null, editingPhase=null, jobsFor=null, lastSignal='', llmSettings=null;
  const pending=new Map();
  // Actor-scoped, in-memory only. Never persist cookies, CSRF or a generic mutation queue.
  // Keep the original JSON immutable until its create receipt is known, even after sign-out.
  const pendingCreates=new Map();
  function uncertainCreate() { const item=pendingCreates.get(state().identity?.id);return item?.uncertain?item:null; }
  function protectCreateForm() {
    const item=uncertainCreate(),form=$('#task-editor');if(!item||!form||editingTask)return;
    const input=JSON.parse(item.input);
    $('#editor-title').textContent='Подтвердить сохранение поручения';
    creatingChild=input.parentId?{parentId:input.parentId,expectedParentVersion:input.expectedParentVersion}:null;
    for(const [name,value] of Object.entries(input.fields)) {
      const field=form.elements.namedItem(name);if(field){field.value=value;field.disabled=true;}
    }
    form.querySelector('[type="submit"]').hidden=true;
    if(form.querySelector('[data-create-recovery]'))return;
    const box=document.createElement('div');box.className='report-note';box.dataset.createRecovery='';
    const text=document.createElement('p');text.textContent='Поручение могло сохраниться. Повторим только исходный запрос с прежним номером: сервер вернёт сохранённую карточку или создаст её, если запрос не дошёл. Данные пока нельзя менять.';
    const retry=document.createElement('button');retry.type='button';retry.className='primary';retry.dataset.retryCreate='';retry.textContent='Повторить исходный запрос';
    const limit=document.createElement('p');limit.textContent='Запрос хранится только в памяти этой вкладки. Не обновляй страницу и не закрывай вкладку до подтверждения. После перезагрузки сначала проверь доску — не создавай поручение заново вслепую.';
    box.append(text,retry,limit);
    if(input.parentId){const parent=document.createElement('p');parent.textContent='Исходное родительское поручение: '+input.parentId;box.prepend(parent);}
    form.append(box);retry.focus();
  }
  window.addEventListener('beforeunload',event=>{if(pendingCreates.size){event.preventDefault();event.returnValue='';}});
  let creatingChild=null, reportEpoch=0, displayedReport=null, detailView='workspace', boardHovered=false;
  const jobViews=new WeakMap();
  const state=()=>ctx.get();
  const pulseController=createCardPulseController($('#board'));
  const manager=()=>state().identity?.role==='manager';
  const selectedTask=()=>state().memory?.task || state().snapshot?.tasks.find(t=>t.id===state().selected);
  const recursive=__modules["recursive-ui.js"].installRecursiveUI({ctx,state,selectedTask,mutate,openEditor,changeView:changeDetailView});
  const modalOpen=()=>Boolean(document.querySelector('dialog[open]'));
  const message=(selector,text,success=false)=>ctx.note(selector,text,success);
  const inputValue=(form,name)=>form.elements.namedItem(name)?.value || '';
  const interval = task => deadlineState(task);
  function unread(task) { return typeof task.unread==='boolean'?task.unread:Boolean(task.lastMessageSourceId&&task.lastMessageAuthorId!==state().identity?.id&&state().snapshot.preferences.seen[task.id]!==task.version); }
  function stageAttention(task) {
    if(task.archived||task.paused||task.status==='done')return '';
    const actorId=state().identity?.id, phases=(task.phases||[]).filter(p=>!p.archived);
    const pending=task.employeeId===actorId?phases.filter(p=>p.reviewStatus==='submitted').length:0;
    if(pending)return `Проверить этапы · ${pending}`;
    const returned=phases.filter(p=>stageAssignee(task,p)===actorId&&p.reviewStatus==='returned').length;
    return returned?`Доработать этапы · ${returned}`:'';
  }
  function important(task) { return Boolean(stageAttention(task)) || unread(task) || task.needsDecision || task.needsClarification || ['blocked','review'].includes(task.status) || ['no_reply','awaiting'].includes(task.contact) || ['overdue','soon'].includes(interval(task).kind); }
  function person(id) { return state().snapshot?.employees.find(p=>p.id===id)?.name || 'Участник'; }
  function smallButton(action,label,attrs='') { return `<button type="button" class="secondary" ${action} ${attrs}>${label}</button>`; }
  function attention(task) {
    if(task.archived)return 'В архиве';
    if(task.needsClarification)return 'Нужно уточнение';
    if(task.status==='review')return 'Результат на проверку';
    if(stageAttention(task))return stageAttention(task);
    if(task.proposedDue)return 'Согласовать новый срок';
    if(task.needsDecision)return 'Нужно решение';
    if(task.blocker)return 'Есть препятствие';
    if(unread(task))return 'Новое сообщение';
    if(task.contact==='no_reply')return 'Нет ответа на запрос';
    if(task.needsClarification)return 'Нужно уточнение';
    return '';
  }
  function orderTasks(tasks) { return sortBoardTasks(tasks,state().snapshot.preferences.pins,sortMode); }
  function taskLabel(task) { if(task.paused)return 'На паузе';return task.status==='planned'&&task.startAt&&Date.parse(task.startAt)>Date.now()?'Отложенный старт':labels[task.status]||labels.planned; }
  function card(task) {
    const {snapshot}=state(), status=Object.hasOwn(labels,task.status)?task.status:'planned';
    const pin=snapshot.preferences.pins.includes(task.id), signal=unread(task);
    const due=interval(task), pulse=cardPulseState(task), need=attention(task);
    return `<article data-card-id="${esc(task.id)}" data-pulse="${pulse.mode}" data-pulse-tone="${pulse.tone}" data-pulse-progress="${cardPulseProgress(task)}" class="task compact-task ${status} ${pin?'pinned':''} ${task.paused?'is-paused':''} ${signal?'has-signal':''}" tabindex="0" aria-label="${esc(task.title)}. Один клик — прочитано, двойной — открыть">
      <div class="task-top"><div class="card-badges"><span class="status">${task.archived?'В архиве':taskLabel(task)}</span><span class="status priority-badge priority-${['high','urgent'].includes(task.priority)?task.priority:'normal'}" aria-label="Приоритет: ${task.priority==='urgent'?'срочный':task.priority==='high'?'высокий':'обычный'}" title="Приоритет">${task.priority==='urgent'?'Срочный':task.priority==='high'?'Высокий':'Обычный'}</span></div><button type="button" class="pin-button ${pin?'is-pinned':''}" data-pin="${esc(task.id)}" aria-pressed="${pin}" aria-label="${pin?'Открепить':'Закрепить'} ${esc(task.title)}" title="${pin?'Убрать из поля зрения':'Держать в поле зрения'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/></svg></button></div>
      <div class="card-body"><small class="card-id">${esc(task.id)}</small><h2>${esc(task.title)}</h2>
      ${need&&task.status!=='review'?`<p class="card-attention">${esc(need)}</p>`:''}<div class="task-meta">${esc(person(task.employeeId))}</div>
      <div class="card-status"><strong>Статус</strong><p>${esc(task.lastUpdateText||task.summary||'Обновлений пока нет.')}</p>${task.lastUpdateAt?`<time datetime="${esc(task.lastUpdateAt)}">${esc(ctx.date(task.lastUpdateAt,true))} мск</time>`:'<small>Дата обновления не указана</small>'}</div>
      ${task.status==='planned'&&task.startAt?`<small class="scheduled-start">Старт: ${esc(ctx.date(task.startAt,true))} мск</small>`:''}
      <div class="card-deadline">${task.due?`<time datetime="${esc(task.due)}T${esc(task.dueTime||'18:00')}:00+03:00">${esc(ctx.date(task.due))} · ${esc(task.dueTime||'18:00')} мск</time>`:'<span>Срок не задан</span>'}</div>
      <div class="task-bottom"><span data-deadline-state class="${due.kind}">${esc(due.text)}</span><button class="card-open-arrow" type="button" data-task="${esc(task.id)}" aria-label="Открыть ${esc(task.title)}" title="Открыть рабочую область"><svg width="16" height="16" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 10 10 2M3 2h7v7"/></svg></button></div></div>
      ${pulseMarkup(pulse.mode)}
      <svg class="card-unread-outline" aria-hidden="true" focusable="false"><rect class="unread-glow" x="1" y="1" rx="12" pathLength="100"/><rect class="unread-core" x="1" y="1" rx="12" pathLength="100"/></svg>
    </article>`;
  }
  // Update only presentation nodes: do not rebuild cards, inputs, focus, or filters.
  function refreshCardTime() {
    if (document.hidden || !state().snapshot) return;
    const tasks = new Map(state().snapshot.tasks.map(task => [task.id, task]));
    const now = Date.now();
    document.querySelectorAll('[data-card-id]').forEach(node => {
      const task = tasks.get(node.dataset.cardId);
      if (!task) return;
      const pulse = cardPulseState(task, now), due = deadlineState(task, now);
      node.dataset.pulse = pulse.mode;
      node.dataset.pulseTone = pulse.tone;
      node.dataset.pulseProgress = String(cardPulseProgress(task, now));
      const path = cardPulsePath(pulse.mode);
      node.querySelectorAll('.card-pulse path').forEach(trace => { if (trace.getAttribute('d') !== path) trace.setAttribute('d', path); });
      const label = node.querySelector('[data-deadline-state]');
      if (label) { label.textContent = due.text; label.className = due.kind; }
    });
    pulseController.refresh();
  }
  function syncVisibility() {
    document.body.classList.toggle('page-hidden', document.hidden);
    if (!document.hidden) refreshCardTime();
  }
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
  function calendar(tasks) {
    const first=new Date(month+'T12:00:00Z'), offset=(first.getUTCDay()+6)%7, start=shift(month,-offset);
    const days=Array.from({length:42},(_,i)=>shift(start,i));
    return `<div class="calendar-scroll"><div class="calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<div class="weekday">${d}</div>`).join('')}${days.map(day=>`<section class="calendar-day ${day.slice(0,7)!==month.slice(0,7)?'outside':''} ${day===today()?'today':''}"><span class="day-number">${Number(day.slice(-2))}</span>${tasks.filter(t=>t.due===day).map(t=>`<button class="calendar-task ${esc(t.status)}" data-task="${esc(t.id)}"><span>${esc(t.title)}</span><small>${esc(person(t.employeeId))}</small></button>`).join('')}</section>`).join('')}</div></div>${tasks.some(t=>!t.due)?`<section class="undated"><h3>Без срока</h3>${tasks.filter(t=>!t.due).map(t=>smallButton(`data-task="${esc(t.id)}"`,esc(t.title))).join('')}</section>`:''}`;
  }
  function gantt(tasks) {
    const days=Array.from({length:28},(_,i)=>shift(month,i));
    const rows=tasks.flatMap(t=>(t.phases?.filter(p=>!p.archived).length?t.phases.filter(p=>!p.archived).map(p=>({task:t,...p,done:stageAccepted(p)})): [{ task:t, title:t.title, start:t.start||today(), end:t.due, done:t.status==='done' }]));
    return `<p class="report-note">28 дней с ${ctx.date(month)}. Этапы раскрыты под задачами; общий срок меняется отдельным решением.</p><div class="gantt-scroll"><div class="gantt"><div class="gantt-header"><span>Задача / этап</span><div class="timeline-track">${days.map(day=>`<span>${Number(day.slice(-2))}</span>`).join('')}</div></div>${rows.map(p=>`<div class="gantt-row"><button data-task="${esc(p.task.id)}"><small>${esc(p.task.id)}${p.dependsOn?' · есть предшествующий этап':''}</small>${esc(p.title)}<small>${p.end?`${ctx.date(p.start)} — ${ctx.date(p.end)}`:'Срок не задан'}</small></button><div class="timeline-track">${days.map(day=>`<span class="phase-cell ${p.end&&day>=p.start&&day<=p.end?'filled':''} ${p.done?'complete':''} ${day===today()?'today':''}"></span>`).join('')}</div></div>`).join('')}</div></div>`;
  }
  function renderBoard(tasks) {
    recursive.renderQueues();
    const {snapshot}=state();
    $('#new-task').hidden=!manager(); $('#team').hidden=!manager(); $('#llm-settings').hidden=!manager(); $('#reports').hidden=!manager();
    $('#mode-label').textContent=snapshot.assistant.available?'ИИ: консультации по задачам':'Сводка и шаблоны · ИИ не подключён';
    $('#example-banner').hidden=!snapshot.examples;
    $('#brief-text').textContent=snapshot.brief.text;
    const signals=tasks.filter(important).map(t=>t.id+':'+t.version).join('|');
    if(auto&&lastSignal&&signals!==lastSignal&&canRefresh())view='board';
    lastSignal=signals;
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
    $('#month-tools').hidden=view==='board';
    $('#month-label').textContent=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'T12:00:00Z'));
    const archive=['done','archived'].includes(state().filter);
    $('#board').className=view==='board'?`board focus-board${archive?' focus-archive':''}`:'alternate-view';
    $('#board-order').hidden=view!=='board';
    $('#board-sort').value=sortMode;
    $('#board-guide').textContent=archive?'История сохранена. Закреплённые — первыми.':({priority:'Закреплённые → срочный → высокий → обычный → ближайший срок.',status:'Закреплённые → ожидает старта → в работе → препятствие → на проверке → принято.',deadline:'Закреплённые → ближайший срок. Без срока — в конце каждой группы.'}[sortMode]);
    if(!tasks.length)return '<div class="empty"><span class="empty-mark">✦</span>Здесь пока нет задач.<br><small>Измени фильтр или создай первое поручение.</small></div>';
    if(view==='calendar')return calendar(tasks);
    if(view==='gantt')return gantt(tasks);
    return orderTasks(tasks).map(card).join('');
  }

  function delegationMarkup(task) {
    if(!manager())return '';
    const children=state().memory.children||[], done=children.filter(t=>t.status==='done').length;
    const original=Object.hasOwn(task,'originalDue')?(task.originalDue?`${ctx.date(task.originalDue)} · ${esc(task.originalDueTime||'18:00')} мск`:'При постановке срок не задан'):'Первоначальный срок не зафиксирован';
    return `<section class="detail-section delegation"><div class="section-heading"><h3>Дочерние поручения · ${done}/${children.length} принято</h3>${task.status!=='done'&&!task.archived?smallButton('data-new-child','+ Поручение исполнителю'):''}</div><p class="report-note">Ответственность за результат остаётся у исполнителя родительского поручения. Дочерние поручения — не последовательные этапы и не закрывают родителя автоматически.</p><p class="report-note">Первоначальный срок: ${original}. Текущий: ${task.due?ctx.date(task.due)+' · '+esc(task.dueTime||'18:00')+' мск':'не задан'}. ${esc(interval(task).text)}</p>${task.parentId?`<p class="report-note">Родительское поручение: ${smallButton(`data-child-open="${esc(task.parentId)}"`,esc(task.parentId))}</p>`:''}${children.map(child=>`<article class="child-task"><button type="button" class="quiet" data-child-open="${esc(child.id)}"><strong>${esc(child.title)}</strong><small>${esc(child.id)} · ${esc(person(child.employeeId))}</small></button><p>${esc(labels[child.status]||child.status)} · ${child.due?ctx.date(child.due)+' · '+esc(child.dueTime||'18:00')+' мск':'Без срока'} · ${esc(interval(child).text)}</p><p>${esc(child.blocker||child.summary||'Ожидаем обновление')}</p></article>`).join('')||'<p class="report-note">Можно распределить части работы между исполнителями, сохранив общий срок и ответственность.</p>'}</section>`;
  }
  function conversationMarkup(source) {
    return `<article data-conversation-source="${esc(source.id)}" class="bubble ${['manager_message','rework_feedback'].includes(source.kind)?'from-manager':''}"><small>${esc(source.authorName)} · ${ctx.date(source.occurredAt||source.receivedAt,true)}</small><p>${esc(source.text)}</p>${source.artifactId&&state().memory.requestState?.artifacts.some(a=>a.id===source.artifactId)?`<p>${smallButton(`data-artifact-open="${esc(source.artifactId)}"`,'Документ · v'+(state().memory.requestState.artifacts.find(a=>a.id===source.artifactId)?.version||'—'))}</p>`:''}${source.kind==='rework_feedback'&&source.resultSourceId?`<small>Замечания к переданному результату</small>${sourceReader(source.resultSourceId,source.resultVersion)}`:''}</article>`;
  }
  function systemEventMarkup(event) {
    return `<article data-conversation-event="${esc(event.key)}" class="report-note"><small>Событие системы · ${ctx.date(event.at,true)}</small><p>${esc(event.text)}</p><small>Это не ответ сотрудника и не подтверждение прогресса.</small></article>`;
  }
  function appendDetail(fresh) {
    const box=$('.conversation');if(!box)return;
    const dialog=$('#task-dialog'),top=dialog.scrollTop,conversationTop=box.scrollTop;
    const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    const tail=box.scrollHeight-box.clientHeight-conversationTop<32;
    const anchor=[...dialog.querySelectorAll('.conversation,textarea,summary,.detail-header,.history-item,.source')].find(el=>el.getBoundingClientRect().bottom>dialog.getBoundingClientRect().top);
    const anchorTop=anchor?.getBoundingClientRect().top;
    const sourceIds=new Set([...box.querySelectorAll('[data-conversation-source]')].map(el=>el.dataset.conversationSource));
    const incoming=fresh.conversation||[];
    if(incoming.length===50 && (!sourceIds.size || !incoming.some(s=>sourceIds.has(s.id)))){
      $('#conversation-gap').hidden=false;
    }
    const added=incoming.filter(s=>!sourceIds.has(s.id));
    if(added.length){box.querySelector('[data-empty-conversation]')?.remove();box.insertAdjacentHTML('beforeend',added.map(conversationMarkup).join(''));}
    const eventIds=new Set([...box.querySelectorAll('[data-conversation-event]')].map(el=>el.dataset.conversationEvent));
    const events=fresh.timeline.filter(e=>e.kind==='no_reply'&&!eventIds.has(e.key));
    box.insertAdjacentHTML('beforeend',events.slice().reverse().map(systemEventMarkup).join(''));
    // Add source references without changing the action snapshot/version or existing nodes.
    let addedSources=0;
    for(const source of fresh.sources)if(!state().memory.sources.some(s=>s.id===source.id)){
      addedSources++;$('#sources [data-empty-sources]')?.remove();state().memory.sources.push(source);
      const template=document.createElement('template');template.innerHTML=ctx.sourcesMarkup();
      const node=template.content.lastElementChild;if(node)$('#sources').append(node);
    }
    const keys=new Set([...$('#timeline').querySelectorAll('[data-event-key]')].map(el=>el.dataset.eventKey));
    const newEvents=fresh.timeline.filter(e=>!keys.has(e.key));
    $('#timeline').insertAdjacentHTML('afterbegin',newEvents.map(ctx.eventMarkup).join(''));
    if(added.length||events.length){
      message('#conversation-updates',`Новых сообщений: ${added.length}. Событий системы: ${events.length}.`);
    }
    if(added.length||newEvents.length||addedSources){
      box.scrollTop=tail&&!typing?box.scrollHeight:conversationTop;
      if(anchor?.isConnected)dialog.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
      else dialog.scrollTop=top;
    }
  }
  function stageMarkup(task,phase,active) {
    const identity=state().identity, accepted=stageAccepted(phase), result=(phase.submissions||[]).find(r=>r.id===phase.submittedResultId), reviews=phase.reviews||[];
    const latestReview=reviews.filter(r=>r.resultId===phase.submittedResultId).at(-1), canWork=active&&!phase.archived&&!task.paused;
    const status=accepted?'Принят куратором':phase.reviewStatus==='submitted'?'На проверке у куратора':phase.reviewStatus==='returned'?'На доработке':phase.done?'Ранее отмечен готовым · приёмка не подтверждена':'Ожидает результата';
    return `<article class="workspace-section" data-stage-id="${esc(phase.id)}"><div class="section-heading"><h3>${esc(phase.title)}</h3>${manager()&&canWork?`<details class="task-options"><summary aria-label="Опции этапа">⋯</summary><div class="task-options-panel">${smallButton(`data-edit-phase="${esc(phase.id)}"`,'Изменить этап')}${smallButton(`data-archive-phase="${esc(phase.id)}"`,'Убрать в архив')}<small>Результаты и история сохраняются.</small></div></details>`:''}</div><p class="report-note">${esc(status)} · Ответственный: ${esc(person(stageAssignee(task,phase)))} · ${ctx.date(phase.start)} — ${ctx.date(phase.end)}</p>${result?`<article class="submitted-result"><small>Версия ${esc(result.version)} · ${esc(person(result.employeeId))} · ${ctx.date(result.at,true)}</small><p>${esc(result.text)}</p></article>`:''}${latestReview?.action==='return'?`<p class="pause-note">Замечания к версии ${esc(result?.version)}: ${esc(latestReview.reason)}</p>`:''}<div class="actions">${canWork&&stageAssignee(task,phase)===identity.id&&!accepted&&phase.reviewStatus!=='submitted'?smallButton(`data-stage-action="submit" data-phase-id="${esc(phase.id)}"`,phase.reviewStatus==='returned'?'Передать исправленный результат':'Передать результат этапа'):''}${canWork&&task.employeeId===identity.id&&phase.reviewStatus==='submitted'&&result?smallButton(`data-stage-action="accept" data-phase-id="${esc(phase.id)}" data-result-id="${esc(result.id)}"`,'Принять этап')+smallButton(`data-stage-action="return" data-phase-id="${esc(phase.id)}" data-result-id="${esc(result.id)}"`,'Вернуть с замечаниями'):''}</div>${(phase.submissions||[]).length?`<details><summary>История результатов · ${phase.submissions.length}</summary>${phase.submissions.map(r=>`<article class="submitted-result"><small>Версия ${esc(r.version)} · ${esc(person(r.employeeId))} · ${ctx.date(r.at,true)}</small><p>${esc(r.text)}</p>${reviews.filter(v=>v.resultId===r.id).map(v=>`<p class="report-note">${v.action==='accept'?'Принято':'Возвращено'} · ${esc(person(v.actorId))} · ${ctx.date(v.at,true)}${v.reason?' · '+esc(v.reason):''}</p>`).join('')}</article>`).join('')}</details>`:''}</article>`;
  }
  function stageResultEditor(task,phase,action,resultId='') {
    const submit=action==='submit';
    openEditor(submit?'Результат этапа':'Вернуть этап с замечаниями',`<form id="stage-result-editor" data-task-id="${esc(task.id)}" data-phase-id="${esc(phase.id)}" data-version="${esc(state().memory.taskVersion)}" data-action="${action}" data-result-id="${esc(resultId)}"><p>${esc(phase.title)}</p><label>${submit?'Содержание результата':'Что нужно исправить'}<textarea name="${submit?'text':'reason'}" required maxlength="${submit?4000:1000}"></textarea></label><p class="report-note">${submit?'Будет сохранена новая неизменяемая версия. Проверяет куратор.':'Замечания сохранятся со ссылкой на проверенную версию.'}</p><button class="primary" type="submit">${submit?'Передать куратору':'Вернуть с замечаниями'}</button></form>`);
  }
  function detailMarkup() {
    const {memory,identity,selected}=state(),task=selectedTask(),current=memory.current;
    if(task.documentOnly)return `<header class="detail-header"><h2 id="task-title">${esc(memory.title)}</h2><p>Только назначенный документ. Поручение и переписка вне вашего доступа.</p></header><p id="detail-message" class="message" role="status"></p><p id="detail-updates" class="report-note" role="status"></p><button type="button" id="reload-detail" class="secondary" hidden>Документ изменился · обновить</button>${recursive.detailMarkup(task,memory)}`;
    const own=task.employeeId===identity.id&&current.status!=='done'&&!task.archived;
    const controls=manager()&&task.canControl!==false&&!task.simulationGates?.length;
    const active=!(task.archived||current.status==='done'), phases=(task.phases||[]).filter(p=>!p.archived), archivedPhases=(task.phases||[]).filter(p=>p.archived);
    const reportId=current.status==='done'?task.acceptedSourceId:task.submittedResultSourceId;
    const report=[...(memory.conversation||[]),...(memory.sources||[])].find(s=>s.id===reportId&&s.employeeId===task.employeeId&&s.kind!=='manager_message'&&s.text?.trim());
    const pendingParts=phases.some(p=>!stageAccepted(p))||(memory.children||[]).some(t=>!t.archived&&t.status!=='done');
    const decisions=controls&&active&&current.proposedDue?[['approve_due','Согласовать срок'],['reject_due','Сохранить прежний срок']]:[];
    const extras=task.archived||task.paused?[]:controls?({planned:[['start','Начать работу']],blocked:[['unblock','Препятствие устранено']],review:[['rework','Вернуть на доработку']],done:[['reopen','Вернуть в работу']]}[current.status]||[]):own&&current.status==='planned'?[['start','Начать работу']]:[];
    return `<header class="detail-header"><span class="eyebrow">${esc(selected)} · ${task.archived?'В архиве':esc(taskLabel(task))}</span><div class="workspace-title-row"><h2 id="task-title">${esc(memory.title)}</h2>${controls?`<details class="task-options"><summary aria-label="Опции поручения" title="Опции поручения">⋯</summary><div class="task-options-panel">${active?smallButton('data-edit-task','Изменить поручение')+smallButton('data-pause-task',task.paused?'Возобновить работу':'Поставить на паузу'):''}${smallButton('data-archive-task',task.archived?'Восстановить из архива':'Убрать в архив')}<small>Архив сохраняет историю, но не принимает работу.</small></div></details>`:''}</div><p class="workspace-meta">Куратор: ${esc(person(task.employeeId))} · ${esc(task.project||'Без проекта')} · ${ctx.date(current.due)}${current.due?' · '+esc(task.dueTime||'18:00')+' мск':''}</p>${task.protocol?`<p class="workspace-provenance">Протокол ${esc(task.protocol.number||'без номера')}${task.protocol.point?' · п. '+esc(task.protocol.point):''}${task.protocol.date?' · '+esc(ctx.date(task.protocol.date)):''}</p>`:''}<nav class="workspace-tabs" aria-label="Работа с поручением"><button type="button" data-detail-view="workspace" aria-pressed="${detailView==='workspace'}">Рабочая область</button><button type="button" data-detail-view="chat" aria-pressed="${detailView==='chat'}">Чат</button></nav></header>
    <p id="detail-message" class="message" role="status" aria-live="polite"></p><p id="detail-updates" class="report-note" role="status" aria-live="polite"></p><button type="button" id="reload-detail" class="secondary" hidden>В задаче есть обновления · показать</button>
    <div class="workspace-content" ${detailView==='chat'?'hidden':''}>
    ${task.controlOwnerName?`<p class="report-note">Итог принимает: ${esc(task.controlOwnerName)}${task.canControl===false?' · у вас просмотр и участие, не приёмка':''}</p>`:''}
${task.dependencyDetails?.length?`<details class="workspace-section" open><summary>Связанные результаты · ${task.dependencyDetails.length}</summary>${task.dependencyDetails.map(d=>`<p>${d.status==='restricted'?esc(d.id)+' · '+esc(d.title):smallButton(`data-task="${esc(d.id)}"`,esc(d.id)+' · '+esc(d.title))} · ${esc(labels[d.status]||d.status)}${d.archived?' · в архиве':''}</p>`).join('')}<p class="report-note">Подготовку можно вести параллельно. Итог нельзя принять до обязательных связанных результатов.</p></details>`:''}
${(task.simulationGates||[]).map(g=>`<section class="decision-box"><h3>Контрольная точка · ${esc(g.id)}</h3><p>${esc(g.prompt)}</p><p>Решение до ${esc(g.deadline)}. Ответственный: ${esc(person(g.ownerId))}</p>${g.ownerId===state().identity.id?`<form data-simulation-gate="${esc(g.id)}"><label>Вариант<select name="optionId" required><option value="">Выберите после проверки данных</option>${g.options.map(o=>`<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label>${g.options.map(o=>`<p class="report-note">${esc(o.label)}: ${esc(o.description||'')}</p>`).join('')}<label>Основание и проверенные сведения<textarea name="reason" required maxlength="4000"></textarea></label><button class="primary" type="submit">Зафиксировать решение в модели</button></form>`:''}</section>`).join('')}
${task.paused?`<p class="pause-note">На паузе · ${esc(task.pauseReason||'Причина не указана')}</p>`:''}
    ${attention(task)&&active&&(current.status!=='review'||current.proposedDue||task.needsClarification)?`<section class="decision-box"><h3>${esc(attention(task))}</h3><p>${current.proposedDue?`Предложено: ${ctx.date(current.proposedDue)}. Действующий срок: ${ctx.date(current.due)}.`:esc(task.needsClarification?task.clarificationQuestion||'Уточни последнее сообщение с куратором.':task.blocker||task.summary||'Посмотри актуальное обновление.')}</p><div class="actions">${decisions.map(([action,label])=>smallButton(`data-decision="${action}"`,label)).join('')}${current.status==='review'?smallButton('data-show-result','Посмотреть результат'):stageAttention(task)?smallButton('data-show-stages','Посмотреть этапы'):smallButton('data-detail-view="chat"','Обсудить с куратором')}</div></section>`:''}
    <section class="workspace-section"><div class="section-heading"><h3>Поручение</h3></div><p class="task-description">${esc(task.description||'Ожидаемый результат пока не описан.')}</p><div class="actions">${extras.filter(([action])=>action!=='rework'||!memory.requestState?.pending.some(r=>r.kind==='result')).map(([action,label])=>smallButton(`data-task-action="${action}"`,label)).join('')}</div></section>
    ${own?`<div id="workspace-status-slot" class="workspace-status-slot"><details class="inline-status" ${memory.requestState?.artifacts?.length?'':'open'}><summary>Обновить статус или задать вопрос</summary><form id="report-form"><label for="report-text">Сообщение и обновление статуса</label><textarea id="report-text" maxlength="4000" required placeholder="Что готово? Приведи результат или вопрос…"></textarea><button class="primary" type="submit">Отправить</button><small class="report-note">Статус обновляется по правилам. Приёмка и перенос срока требуют решения.</small></form></details></div>`:''}
    ${recursive.detailMarkup(task,memory)}
    <details class="workspace-section" id="result-section" ${memory.requestState?.requests.some(r=>r.kind!=='status')?'hidden':'open'}><summary>Результат ${current.status==='review'?'· ожидает проверки':''}</summary>${report?`<article class="submitted-result"><small>${esc(report.authorName||person(report.employeeId))} · ${ctx.date(report.occurredAt||report.receivedAt,true)}</small><p>${esc(report.text)}</p><small>Сообщение исполнителя. Приложенные файлы в этом этапе не поддерживаются.</small></article>`:current.status==='review'?'<p class="report-note">Ранее отмечено «готово», но результат не привязан для приёмки. История сохранена. Куратору нужно повторно передать итог руководителю.</p>':'<p class="report-note">Итоговый результат ещё не представлен. Куратор передаёт итог после проверки этапов; для простого поручения — сразу.</p>'}${controls&&!memory.requestState?.pending.some(r=>r.kind==='result')&&current.status==='review'&&!task.archived&&report&&!task.needsClarification&&!pendingParts&&!task.paused&&!task.dependencyDetails?.some(d=>d.status!=='done'||d.archived)?`<label class="check-label"><input id="result-reviewed" type="checkbox"> Ознакомился с представленным результатом</label><button class="primary" type="button" data-decision="accept" disabled data-unavailable="true">Принять результат</button>`:''}${own&&!memory.requestState?.pending.some(r=>r.kind==='result')&&!task.paused&&!pendingParts&&current.status!=='review'?smallButton('data-final-result','Передать итог руководителю'):''}${current.status==='review'&&task.needsClarification?'<p class="report-note">Перед приёмкой нужно уточнить последнее сообщение с куратором в чате.</p>':''}${current.status==='review'&&pendingParts?'<p class="report-note">До итоговой приёмки куратор должен принять результаты действующих этапов; дочерние поручения также должны быть приняты.</p>':''}</details>
    <details class="workspace-section ${phases.length?'':'workspace-empty'}" id="stages-section" open><summary>Этапы · ${phases.filter(stageAccepted).length}/${phases.length} принято куратором</summary>${controls&&active?smallButton('data-new-phase','+ Этап'):''}${phases.length?`<progress max="${phases.length}" value="${phases.filter(stageAccepted).length}"></progress><div class="phase-list">${phases.map(p=>stageMarkup(task,p,active)).join('')}</div><small class="report-note">Исполнитель передаёт результат этапа куратору. Руководитель принимает итог поручения. Файлы пока не поддерживаются.</small>`:'<p class="report-note">Этапов пока нет. Для простого поручения они не обязательны.</p>'}${archivedPhases.length?`<details><summary>Убранные этапы · ${archivedPhases.length}</summary>${archivedPhases.map(p=>stageMarkup(task,p,false)+`<p>${controls&&active?smallButton(`data-restore-phase="${esc(p.id)}"`,'Восстановить этап'):''}</p>`).join('')}</details>`:''}</details>
    <details class="workspace-section ${(memory.children||[]).length?'':'workspace-empty'}" open><summary>Поручения соисполнителям · ${(memory.children||[]).length}</summary>${delegationMarkup(task)}</details>
    ${controls?`<details class="workspace-section" open><summary>Черновики шаблонов · ${(memory.drafts||[]).length}</summary><p class="report-note">Рабочие черновики, не переданные версии результата. Документ с приёмкой хранится выше, в блоке «Документ и проверка».</p>${(memory.drafts||[]).map(d=>`<article class="draft"><small>${d.status==='approved'?'Текст согласован':'Черновик'} · ${d.generator==='template'?'шаблон':'ассистент'}</small><h3>${esc(d.title)}</h3>${smallButton(`data-edit-draft="${esc(d.id)}"`,'Открыть и редактировать')}</article>`).join('')||'<p class="report-note">Подготовленные здесь документы появятся в этом разделе.</p>'}<details><summary>Подготовить документ</summary><div class="actions">${active?Object.entries(draftNames).map(([kind,label])=>smallButton(`data-template="${kind}"`,label)).join(''):''}</div></details></details>`:''}
    <details class="workspace-section"><summary>История статусов и основания</summary><div class="facts">${memory.facts.map(f=>`<article class="fact"><span>${esc(fieldNames[f.field]||f.label||f.field)}</span><p>${esc(typeof f.value==='boolean'?(f.value?'Да':'Нет'):f.value??'Не задано')}</p>${f.origin?.sourceId?ctx.sourceLink(f.origin.sourceId):'<small>Запись карточки / решение</small>'}</article>`).join('')}</div><h3>Исходные сообщения</h3><div id="sources">${ctx.sourcesMarkup()}</div><h3>История</h3><div id="timeline">${memory.timeline.map(ctx.eventMarkup).join('')}</div>${memory.page.nextBefore?smallButton('id="older"','Более ранние записи'):''}</details>

    </div>
    <section class="workspace-chat" ${detailView==='workspace'?'hidden':''} aria-label="Единый вход в обсуждения">
    <aside class="chat-index"><label for="chat-task-search">Задача или проект</label><input id="chat-task-search" type="search" placeholder="/П-001 или название проекта" autocomplete="off"><div id="chat-task-list">${state().snapshot.tasks.filter(t=>!t.archived).map(t=>`<button type="button" data-chat-task="${esc(t.id)}" aria-current="${t.id===selected?'true':'false'}"><strong>${esc(t.id)}</strong><span>${esc(t.title)}</span><small>${esc(t.project||'Без проекта')}</small></button>`).join('')}</div></aside>
    <div class="chat-main"><p class="chat-context">Обсуждение ${esc(selected)} · ${smallButton('data-detail-view="workspace"','Открыть задачу')}</p><p id="conversation-updates" class="report-note" role="status" aria-live="polite"></p><p id="conversation-gap" class="report-note" ${(memory.conversation||[]).length===50?'':'hidden'}>Показаны последние 50 сообщений. Более ранние записи доступны в истории задачи.</p><div class="conversation">${(memory.conversation||[]).map(conversationMarkup).join('')||'<p class="report-note" data-empty-conversation>Сообщений пока нет.</p>'}${memory.timeline.filter(e=>e.kind==='no_reply').slice().reverse().map(systemEventMarkup).join('')}</div>
    <div id="chat-status-slot"></div>${controls&&active?`<form id="message-form"><label for="manager-message">Сообщение куратору</label><textarea id="manager-message" name="text" maxlength="4000" required placeholder="Напиши вопрос или решение…"></textarea><label>Связать с точной версией<select name="documentVersion"><option value="">Без ссылки</option>${(memory.requestState?.artifacts||[]).map(a=>`<option value="${esc(a.id)}">${esc(a.title)} · v${a.version}</option>`).join('')}</select></label><label class="check-label"><input type="checkbox" id="manager-request-update" name="requestUpdate"> Запросить обновление статуса</label><button class="primary" type="submit">Отправить</button></form>`:''}
    ${controls?`<details class="assistant-section"><summary>Маркус · помочь с этой задачей</summary>${state().snapshot.assistant.available?`<form id="assistant-form"><label for="assistant-question">Что подготовить?</label><textarea id="assistant-question" name="question" maxlength="2000" required placeholder="Изучи переписку и подготовь проект ответа…"></textarea><button type="submit" class="secondary">Поручить Маркусу</button></form>`:'<p class="report-note">ИИ сейчас не подключён. Можно запросить статус у куратора или подготовить документ по шаблону в рабочей области.</p>'}<div id="assistant-jobs"></div><details class="context-preview"><summary>Контекст и источники</summary>${smallButton('id="preview-context"','Показать контекст')}<div id="context-preview-content"></div></details></details>`:''}</div></section>`;
  }
  function changeDetailView(next) {
    if(selectedTask()?.documentOnly){detailView='workspace';$('#task-dialog').classList.remove('chat-view');return;}
    detailView=next==='chat'?'chat':'workspace';
    $('.workspace-content').hidden=detailView==='chat';$('.workspace-chat').hidden=detailView!=='chat';
    document.querySelectorAll('.workspace-tabs [data-detail-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.detailView===detailView)));
    $('#task-dialog').classList.toggle('chat-view',detailView==='chat');
    const reportForm=$('#report-form'),slot=detailView==='chat'?$('#chat-status-slot'):$('#workspace-status-slot .inline-status');if(reportForm&&slot)slot.append(reportForm);
    if(detailView==='chat')($('#report-text')||$('#manager-message')||$('#chat-task-search'))?.focus({preventScroll:true});
  }
  async function mutate(path,input,{dialog,taskId,after,recoverCreate=false}={}) {
    if(ctx.busy())return;
    const actorId=state().identity?.id;
    if(path==='task-create'&&uncertainCreate()&&!recoverCreate){protectCreateForm();message('#editor-message','Сначала подтверди исходный запрос. Новое поручение не отправлено.');return;}
    ctx.setBusy(true);
    const messageTarget=dialog?'#editor-message':$('#task-dialog').open?'#detail-message':'#workspace-message';
    const taskForm=dialog&&['task-create','task-edit'].includes(path)?$('#task-editor'):null;
    if(taskForm)taskForm.setAttribute('aria-busy','true');
    message(messageTarget,taskForm?'Сохраняем…':'');
    if(taskForm)$(messageTarget).classList.add('pending');
    const key=JSON.stringify({path,input});
    let create;
    if(path==='task-create') {
      create=pendingCreates.get(actorId);
      if(!create){create={input:JSON.stringify(input),key,requestId:crypto.randomUUID(),uncertain:false};pendingCreates.set(actorId,create);}
    }else if(!pending.has(key))pending.set(key,crypto.randomUUID());
    let saved=false;
    try {
      const result=await ctx.api(path,create?{...JSON.parse(create.input),requestId:create.requestId}:{...input,requestId:pending.get(key)});
      if(create&&!(result?.ok===true&&typeof result.taskId==='string'&&result.taskId.trim()&&result.taskId.length<=150&&typeof result.duplicate==='boolean')){
        const error=new Error('Подтверждение сохранения поручения повреждено. Результат пока неизвестен.');error.outcomeUnknown=true;throw error;
      }
      saved=true;
      if(create)pendingCreates.delete(actorId);else pending.delete(key);
      if(state().identity?.id!==actorId)return result;
      if(dialog)$(dialog).close();
      if(after)after(result);
      await ctx.refresh();
      const task=['pin','notice'].includes(path)?null:result.taskId||taskId;
      if(task) {if(path==='message'&&$('#manager-message'))$('#manager-message').value='';await ctx.openTask(task);message('#detail-message',result.alreadyPending?'Запрос уже ожидает ответа. Новое сообщение не добавлено.':'Сохранено.',true);}
      else message('#workspace-message','Сохранено.',true);
      return result;
    } catch(error) {
      if(create&&!saved) {
        if(create.uncertain||error.outcomeUnknown!==false){create.uncertain=true;protectCreateForm();}
        else pendingCreates.delete(actorId);
      }
      const target=error.status===401?'#login-message':saved?'#workspace-message':messageTarget;
      message(target,saved?'Изменение сохранено. Обнови данные, когда связь восстановится.':error.message,saved);
    }
    finally {
      if(taskForm){taskForm.removeAttribute('aria-busy');$(messageTarget).classList.remove('pending');if($(messageTarget).textContent==='Сохраняем…')message(messageTarget,'');}
      ctx.setBusy(false);
    }
  }
  function openEditor(title,markup) {
    $('#editor-title').textContent=title;$('#editor-content').innerHTML=markup;message('#editor-message','');if(!$('#editor-dialog').open)$('#editor-dialog').showModal();
  }
  function input(name,label,value='',type='text',extra='') { return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
  function showSnapshot(report) {
    displayedReport=report;
    openEditor('Сохранённый отчёт',`<p class="report-note">Снимок на ${esc(ctx.date(report.createdAt,true))}. Последующие изменения карточек не меняют этот отчёт.</p><pre id="snapshot-report-text" class="snapshot-report-text"></pre><div class="actions">${smallButton('id="download-report"','Скачать текст')}${smallButton('id="new-report-selection"','К списку и новому отчёту')}</div>`);
    $('#snapshot-report-text').textContent=report.text;
  }
  async function reportsEditor() {
    if(ctx.busy()||!manager())return;
    const epoch=++reportEpoch,actor=state().identity.id;
    openEditor('Отчёты по поручениям','<p role="status" class="report-note">Загружаем текущие поручения…</p>');
    ctx.setBusy(true);
    try {
      await ctx.refresh();const data=await ctx.api('reports');
      if(epoch!==reportEpoch||state().identity?.id!==actor||!$('#editor-dialog').open)return;
      const tasks=state().snapshot.tasks;
      $('#editor-content').innerHTML=`<form id="snapshot-report-form"><p class="report-note">Выбери до 50 поручений. При выборе родителя дочерние отмечаются автоматически, пока включена опция ниже. Любую галочку можно снять; в отчёт попадут только отмеченные поручения. Отчёт сохранит факты и сроки на момент формирования, без ответа модели.</p><label class="check-label"><input id="include-report-children" type="checkbox" checked> При выборе поручения включать дочерние</label><fieldset class="report-selection"><legend>Поручения в отчёте</legend>${tasks.map(task=>`<label class="report-choice"><input type="checkbox" name="taskIds" value="${esc(task.id)}" data-version="${esc(task.version)}"><span><strong>${esc(task.title)}</strong><small>${esc(task.id)} · ${esc(person(task.employeeId))} · ${esc(labels[task.status]||task.status)}${task.parentId?' · часть '+esc(task.parentId):''}</small></span></label>`).join('')||'<p>Поручений пока нет.</p>'}</fieldset><button class="primary" type="submit" ${tasks.length?'':'disabled'}>Сохранить датированный отчёт</button></form><section class="detail-section"><h3>Сохранённые отчёты</h3><div class="saved-reports">${data.reports.map(report=>smallButton(`data-saved-report="${esc(report.id)}"`,`${ctx.date(report.createdAt,true)} · ${report.taskCount} поручений`)).join('')||'<p class="report-note">Отчётов пока нет.</p>'}</div></section>`;
    }catch(error){if(epoch===reportEpoch)message('#editor-message',error.message);}
    finally{ctx.setBusy(false);}
  }
  async function loadSavedReport(id) {
    if(ctx.busy()||!manager())return;
    const epoch=++reportEpoch,actor=state().identity.id;ctx.setBusy(true);
    try{const data=await ctx.api('reports?id='+encodeURIComponent(id));if(epoch===reportEpoch&&state().identity?.id===actor&&$('#editor-dialog').open)showSnapshot(data.report);}
    catch(error){if(epoch===reportEpoch)message('#editor-message',error.message);}
    finally{ctx.setBusy(false);}
  }
  function includeReportChildren(form, roots) {
    const tasks=state().snapshot.tasks, selected=new Set(roots), visited=new Set();
    let frontier=[...roots];
    for(let depth=0;depth<20&&frontier.length;depth++) {
      const next=[];
      for(const id of frontier){if(visited.has(id))continue;visited.add(id);for(const task of tasks)if(task.parentId===id&&!visited.has(task.id)){selected.add(task.id);next.push(task.id);}}
      frontier=next;
    }
    for(const box of form.querySelectorAll('input[name="taskIds"]'))if(selected.has(box.value))box.checked=true;
  }
  async function saveReportForm(form) {
    if(ctx.busy()||!manager())return;
    const selection=[...form.querySelectorAll('input[name="taskIds"]:checked')].map(el=>({taskId:el.value,expectedVersion:el.dataset.version}));
    if(!selection.length||selection.length>50){message('#editor-message','Выбери от 1 до 50 поручений.');return;}
    const key=JSON.stringify({path:'report-create',selection});if(!pending.has(key))pending.set(key,crypto.randomUUID());
    const epoch=reportEpoch,actor=state().identity.id;ctx.setBusy(true);message('#editor-message','');
    try{const data=await ctx.api('report-create',{requestId:pending.get(key),selection});pending.delete(key);if(epoch===reportEpoch&&state().identity?.id===actor&&$('#editor-dialog').open)showSnapshot(data.report);}
    catch(error){if(epoch===reportEpoch)message('#editor-message',error.status===409?'Поручения изменились. Закрой окно и открой «Отчёты» заново, затем проверь выбор.':error.message);}
    finally{ctx.setBusy(false);}
  }
  function taskEditor(task=null,parent=null) {
    if(!task&&uncertainCreate())parent=null; // Recovery belongs to the original parent, not a newly opened card.
    creatingChild=parent?{parentId:parent.id,expectedParentVersion:state().memory.taskVersion}:null;
    editingTask=task?{id:task.id,version:state().memory.taskVersion}:null;
    openEditor(task?'Изменить поручение':parent?'Дочернее поручение':'Новое поручение',`${parent?`<p class="report-note">Часть поручения «${esc(parent.title)}». Назначь отдельного исполнителя и срок. Срок и ответственность родителя не меняются.</p>`:''}<form id="task-editor"><label>Что нужно сделать?<input name="title" required maxlength="160" value="${esc(task?.title||'')}" placeholder="Например: подготовить свод предложений"></label><label>Ожидаемый результат<textarea name="description" maxlength="2000" placeholder="Что должно получиться и как понять, что задача выполнена">${esc(task?.description||'')}</textarea></label><div class="form-grid"><label>Куратор<select name="employeeId">${state().snapshot.employees.map(p=>`<option value="${esc(p.id)}" ${p.enabled===false?'disabled':''} ${p.id===(task?.employeeId||state().identity.id)?'selected':''}>${esc(p.name)}${p.enabled===false?' — доступ отключён':''}</option>`).join('')}</select></label>${input('project','Проект',task?.project||'','text','maxlength="120"')}<label>Приоритет<select name="priority">${[['normal','Обычный'],['high','Высокий'],['urgent','Срочный']].map(([value,label])=>`<option value="${value}" ${task?.priority===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Контроль статуса<select name="supervision"><option value="true" ${task?.supervision!==false?'selected':''}>Включён</option><option value="false" ${task?.supervision===false?'selected':''}>Выключен</option></select></label>${input('startAt','Отложенный старт (Москва)',task?.startAt?new Date(Date.parse(task.startAt)+10800000).toISOString().slice(0,16):'','datetime-local')}${input('due','Срок (необязательно)',task?.due||'','date')}${input('dueTime','Время, Москва',task?.dueTime||'18:00','time','required')}</div><details ${task?.protocol?'open':''}><summary>Реквизиты протокола — если есть</summary><div class="form-grid">${input('protocolNumber','Номер',task?.protocol?.number||'','text','maxlength="100"')}${input('protocolPoint','Пункт',task?.protocol?.point||'','text','maxlength="100"')}${input('protocolDate','Дата',task?.protocol?.date||'','date')}</div></details><button type="submit" class="primary">${task?'Сохранить изменения':'Поставить задачу'} ↗</button></form>`);
    if(!task)protectCreateForm();
  }
  function phaseEditor(phase=null) {
    const task=selectedTask();editingPhase={id:phase?.id||null,taskId:task.id,version:state().memory.taskVersion};
    openEditor(phase?'Изменить этап':'Новый этап',`<form id="phase-editor"><label class="check-label"><input type="checkbox" name="preparation" ${phase?.kind==='preparation'?'checked':''}> Обязательная подготовка перед основным стартом</label>${input('title','Название этапа',phase?.title||'','text','required maxlength="120"')}<div class="form-grid">${input('start','Начало',phase?.start||today(),'date','required')}${input('end','Завершение',phase?.end||task.due||today(),'date','required')}</div><label>Ответственный за этап<select name="assigneeId"><option value="">Куратор поручения</option>${state().snapshot.employees.filter(p=>p.enabled!==false).map(p=>`<option value="${esc(p.id)}" ${p.id===phase?.assigneeId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Начать после<select name="dependsOn"><option value="">Без зависимости</option>${(task.phases||[]).filter(p=>!p.archived&&p.id!==phase?.id).map(p=>`<option value="${esc(p.id)}" ${p.id===phase?.dependsOn?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><p class="report-note">Зависимости проверяются на циклы. Даты этапов не переносят общий срок задачи.</p><button type="submit" class="primary">Сохранить этап</button></form>`);
  }
  function draftEditor(id) {
    const stored=state().memory.drafts.find(d=>d.id===id);if(!stored)return;draft={...stored,taskVersion:state().memory.taskVersion};
    const evidence=`<details><summary>Варианты и основания</summary><p>${esc(draft.reason||'Основание отдельно не указано.')}</p><ul>${(draft.options||[]).map(option=>`<li><strong>${esc(option.label)}</strong> — ${esc(option.consequence)}</li>`).join('')}</ul>${(draft.references||[]).map(ref=>`<blockquote>${esc(ref.quote)}<small>Источник: ${esc(ref.sourceId)} · исходные сообщения доступны в памяти задачи</small></blockquote>`).join('')}</details>`;
    openEditor('Документ к решению',`${evidence}<form id="draft-editor">${input('title','Заголовок',draft.title,'text','required maxlength="200"')}<label>Текст<textarea class="document-body" name="body" required maxlength="6000">${esc(draft.body)}</textarea></label><label>Состояние<select name="status"><option value="draft">Черновик</option><option value="approved" ${draft.status==='approved'?'selected':''}>Текст согласован</option></select></label><p class="report-note">Согласование текста не меняет срок задачи и не отправляет письмо. Поля в квадратных скобках требуют заполнения.</p><div class="actions"><button class="primary" type="submit">Сохранить документ</button>${smallButton('id="download-draft"','Скачать .txt')}</div></form>`);
  }
  function sourceReader(sourceId,version='') {
    return `<div class="source-reader"><div class="source-pages"></div>${smallButton(`data-source-open="${esc(sourceId)}" data-source-version="${esc(version)}" data-source-offset="0"`,'Читать исходное сообщение')}</div>`;
  }
  async function previewContext(button) {
    const {selected,identity}=state(),box=$('#context-preview-content');button.disabled=true;
    try {
      const pack=await ctx.api('context?taskId='+encodeURIComponent(selected));
      if(state().selected!==selected||state().identity?.id!==identity.id||!box.isConnected)return;
      box.innerHTML=`<p><strong>${esc(labels[pack.current.status]||pack.current.status)}</strong> · Срок: ${ctx.date(pack.current.due)}${pack.current.proposedDue?' · Предложено: '+ctx.date(pack.current.proposedDue):''}</p><p>${esc(pack.current.summary)}</p>${pack.current.blocker?`<p>Препятствие: ${esc(pack.current.blocker)}</p>`:''}<ul>${pack.openQuestions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul><p class="report-note">Фрагментов: ${pack.sources.length} из ${pack.coverage.totalSources}. ${pack.coverage.omittedSources||pack.coverage.truncatedFields.length?'Часть сведений сокращена; ассистент может дочитать память и оригиналы.':'Для дополнительной проверки можно открыть оригиналы.'}</p>${pack.sources.map(s=>`<article class="context-source"><small>${esc(s.author)} · ${ctx.date(s.occurredAt,true)}</small><p>${esc(s.preview)}${s.nextOffset!==null?'…':''}</p>${sourceReader(s.sourceId,s.version)}</article>`).join('')}`;
      button.textContent='Обновить контекст';
    }catch(error){if(box.isConnected&&state().selected===selected&&state().identity?.id===identity.id)box.textContent=error.message;}
    finally{button.disabled=false;}
  }
  async function readSource(button) {
    if(button.disabled)return;
    const {selected,identity}=state(),reader=button.closest('.source-reader'),pages=reader.querySelector('.source-pages');button.disabled=true;
    reader.querySelector('.source-error')?.remove();
    const query=new URLSearchParams({taskId:selected,sourceId:button.dataset.sourceOpen,offset:button.dataset.sourceOffset,limit:'1600'});
    if(button.dataset.sourceVersion)query.set('version',button.dataset.sourceVersion);
    try {
      const page=await ctx.api('source?'+query);
      if(state().selected!==selected||state().identity?.id!==identity.id||!reader.isConnected)return;
      pages.insertAdjacentHTML('beforeend',`<article class="source-page"><small>${esc(page.authorName)} · ${ctx.date(page.occurredAt,true)} · ${page.offset+1}–${page.end} из ${page.totalCharacters}</small><p>${esc(page.text)}</p></article>`);
      if(page.nextOffset===null)button.remove();
      else{button.dataset.sourceVersion=page.version;button.dataset.sourceOffset=String(page.nextOffset);button.textContent='Читать дальше';}
    }catch(error){if(reader.isConnected&&state().selected===selected&&state().identity?.id===identity.id)reader.insertAdjacentHTML('beforeend',`<p class="message source-error">${esc(error.message)}</p>`);}
    finally{button.disabled=false;}
  }
  async function loadJobs() {
    const {selected,identity}=state();if(!selected||!identity||!manager()||!$('#assistant-jobs'))return;
    const id=selected, actorId=identity.id, context=ctx.detailContext(); jobsFor=id;
    try { const data=await ctx.api('assistant?taskId='+encodeURIComponent(id));if(context!==ctx.detailContext()||state().selected!==id||state().identity?.id!==actorId||!$('#assistant-jobs'))return;
      const box=$('#assistant-jobs'),signature=JSON.stringify(data.jobs);if(jobViews.get(box)===signature)return;
      box.innerHTML=data.jobs.map(job=>`<article class="ai-result"><small>${ctx.date(job.createdAt,true)} · ${({pending:'В очереди',running:'Ассистент работает',completed:'Ответ подготовлен',failed:'Ответ не опубликован'})[job.status]}</small><h4>${esc(job.question)}</h4>${executionMarkup(job)}<p class="report-note">${esc(assistantReviewLabel(job))}</p>${job.stale?'<p class="message">В задаче появились новые сведения. Сверь ответ с актуальной памятью или задай новый вопрос.</p>':''}<p>${esc(job.text||job.error||'Можно продолжать работать с доской.')}</p>${decisionEvidenceMarkup(job)}${(job.references||[]).map(ref=>`<blockquote>${esc(ref.quote)}<small>Цитата из сообщения по задаче</small>${sourceReader(ref.sourceId,ref.version)}</blockquote>`).join('')}</article>`).join('');
      jobViews.set(box,signature);
    } catch(error) {if(context===ctx.detailContext()&&state().selected===id&&state().identity?.id===actorId&&$('#assistant-jobs')){jobViews.delete($('#assistant-jobs'));$('#assistant-jobs').textContent=error.message;}}
  }
  async function checkDetail() { return ctx.pollDetail?.(); }
  async function reloadDetail() {
    if(ctx.busy())return;
    const id=state().selected;
    ctx.setBusy(true);
    try {await ctx.refresh();await ctx.openTask(id);}
    catch(error){message('#detail-message',error.message);}finally{ctx.setBusy(false);}
  }
  function teamEditor() {
    openEditor('Участники прототипа',`<form id="automation-form"><label class="check-label"><input name="enabled" type="checkbox" ${state().snapshot.autoCheckins?'checked':''}> Ассистент запрашивает статусы в приложении</label><p class="report-note">По будням, 09:00–18:00 по Москве; не чаще раза в 6 часов. Свежий ответ откладывает следующий запрос. Это сообщения внутри задач.</p><button type="submit" class="secondary">Сохранить режим</button></form><div id="team-list">${state().snapshot.employees.map(p=>`<div class="person-row"><div><strong>${esc(p.name)}</strong><small>${p.role==='manager'?'Руководитель':'Сотрудник'}${p.enabled===false?' · Доступ отключён':''}</small></div>${p.enabled!==false&&(p.role!=='manager'||p.id===state().identity.id)?smallButton(`data-invite="${esc(p.id)}"`,'Код входа'):''}${p.enabled!==false&&p.role!=='manager'&&p.id!==state().identity.id?smallButton(`data-disable-person="${esc(p.id)}"`,'Отключить доступ'):''}</div>`).join('')}</div><div id="invite-result" role="status"></div><form id="person-editor"><h3>Добавить сотрудника</h3>${input('name','Имя','','text','required maxlength="120"')}<button class="primary" type="submit">Добавить</button></form>`);
  }
  function disablePersonEditor(employeeId) {
    const employee=state().snapshot.employees.find(p=>p.id===employeeId);
    if(!manager()||!employee||employee.role==='manager'||employee.id===state().identity.id||employee.enabled===false)return;
    openEditor('Отключить доступ сотрудника?',`<form id="person-disable-form" data-employee-id="${esc(employee.id)}"><p><strong>${esc(employee.name)}</strong> больше не сможет войти в рабочее пространство. Все его сеансы и неиспользованные коды входа будут отозваны.</p><p>Поручения, сообщения и история с именем автора сохранятся. Включение доступа обратно здесь недоступно.</p><div class="actions"><button type="button" class="secondary" id="cancel-person-disable">Отмена</button><button type="submit" class="primary">Отключить доступ</button></div></form>`);
  }
  const roleNames={coordinator:'Координатор',analyst:'Аналитик',reviewer:'Проверяющий'};
  const roleDescriptions={coordinator:'Выделяет вопросы и планирует разбор.',analyst:'Готовит сводку, варианты действий и тексты.',reviewer:'Сверяет выводы с источниками и отмечает ошибки.'};
  function modelOptions(connectionId,selected) {
    const connection=llmSettings.connections.find(c=>c.id===connectionId);
    return '<option value="">Выбери модель</option>'+(connection?.models||[]).map(model=>`<option value="${esc(model)}" ${model===selected?'selected':''}>${esc(model)}</option>`).join('');
  }
  async function modelsEditor() {
    if(ctx.busy()||!manager())return;
    const actorId=state().identity.id;ctx.setBusy(true);
    try {
      const settings=await ctx.api('llm-settings');
      if(state().identity?.id!==actorId||!manager())return;
      renderModels(settings);
    }catch(error){message('#workspace-message',error.message);}finally{ctx.setBusy(false);}
  }
  function renderModels(settings) {
      llmSettings=settings;
      openEditor('Модели и роли',`<p class="report-note">Сначала добавь подключение с ключом, затем выбери его для нужных ролей. Для начала достаточно аналитика.</p>
        <div class="section-heading"><h3>Подключения</h3>${smallButton('id="add-connection"','+ Добавить подключение')}</div>
        <div class="connections-list">${settings.connections.map(c=>`<div class="connection-chip ${c.ready?'ready':''}"><strong>${esc(c.label)}</strong> · ${esc(c.providerLabel)} · ${c.ready?'ключ сохранён':'ключ недоступен'}${c.editable?`<button class="quiet" type="button" data-edit-connection="${esc(c.id)}">Изменить / заменить ключ</button>`:'<small>Задано на сервере</small>'}</div>`).join('')||'<p class="message">Подключений пока нет. Нажми «Добавить подключение» и вставь свой API-ключ.</p>'}</div><div id="connection-editor-host"></div>
        ${settings.enabledOnServer?'':'<p class="message">Вызовы ИИ выключены на сервере. Назначения можно сохранить заранее.</p>'}
        <form id="llm-editor">${Object.entries(roleNames).map(([id,label])=>{const role=settings.roles[id];return `<fieldset class="role-settings" data-role="${id}"><legend>${label}</legend><p class="report-note">${roleDescriptions[id]}</p><label class="check-label"><input name="${id}-enabled" type="checkbox" ${role.enabled?'checked':''}> Включена</label><div class="form-grid"><label>Подключение<select name="${id}-connection" data-llm-connection="${id}"><option value="">Выбери подключение</option>${settings.connections.map(c=>`<option value="${esc(c.id)}" ${c.id===role.connectionId?'selected':''}>${esc(c.label)} · ${esc(c.providerLabel)}${c.ready?'':' · нет ключа'}</option>`).join('')}</select></label><label>Модель<select name="${id}-model">${modelOptions(role.connectionId,role.model)}</select></label></div></fieldset>`;}).join('')}
        <p class="report-note">Изменения применятся к новым вопросам. Если подключение недоступно, ответ остановится с ошибкой. Настроенный ключ ещё не означает, что соединение проверено.</p><button type="submit" class="primary">Сохранить назначения</button></form>`);
  }
  function connectionEditor(id=null) {
    if(!llmSettings||ctx.busy())return;
    const c=llmSettings.connections.find(item=>item.id===id);if(id&&!c?.editable)return;
    $('#connection-editor-host').innerHTML=`<form id="connection-editor" class="role-settings" data-connection-id="${esc(c?.id||'')}" data-version="${esc(llmSettings.version)}" data-request-id="${crypto.randomUUID()}" autocomplete="off">
      <h3>${c?'Изменить подключение':'Новое подключение'}</h3><div class="form-grid">${input('label','Название подключения',c?.label||'','text','required maxlength="100" placeholder="Например: VseGPT · рабочий"')}<label>Провайдер<select name="provider" required ${c?'disabled':''}><option value="">Выбери провайдера</option>${Object.entries(llmSettings.providerLabels).map(([value,label])=>`<option value="${value}" ${value===c?.provider?'selected':''}>${esc(label)}</option>`).join('')}</select></label></div>
      <label>API-ключ ${c?'· оставь пустым, чтобы сохранить текущий':''}<input name="apiKey" type="password" ${c?'':'required'} maxlength="8192" autocomplete="new-password" spellcheck="false" autocapitalize="none" placeholder="${c?'Сохранённый ключ скрыт':'Вставь существующий ключ выбранного провайдера'}"></label>
      <label>ID моделей<textarea name="models" required maxlength="8000" rows="3" placeholder="ID из кабинета провайдера, по одному на строку">${esc(c?.models.join('\n')||'')}</textarea></label><p class="report-note">Можно указать несколько моделей через запятую или с новой строки. Они появятся в выборе для ролей.</p>
      <label id="giga-scope-field" ${c?.provider==='gigachat'?'':'hidden'}>Тип доступа GigaChat<select name="scope"><option value="GIGACHAT_API_PERS">Физическое лицо</option><option value="GIGACHAT_API_B2B" ${c?.scope==='GIGACHAT_API_B2B'?'selected':''}>ИП / организация · пакеты</option><option value="GIGACHAT_API_CORP" ${c?.scope==='GIGACHAT_API_CORP'?'selected':''}>ИП / организация · по использованию</option></select></label>
      <p class="report-note">Ключ будет сохранён на сервере в зашифрованном виде. Сохранение не отправляет запрос к модели. Для GigaChat нужен ключ авторизации.</p><p id="connection-message" class="message" role="status"></p><div class="actions"><button type="submit" class="primary">Сохранить подключение</button>${smallButton('id="cancel-connection"','Отмена')}</div></form>`;
    $('#connection-editor input').focus();
  }
  function readRoleForm() {
    const form=$('#llm-editor');return form?Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}])):null;
  }
  async function saveConnectionForm(form) {
    if(ctx.busy()||!manager()||!llmSettings)return;
    const actorId=state().identity.id,roleDraft=readRoleForm(),provider=inputValue(form,'provider');
    const input={requestId:form.dataset.requestId,expectedVersion:form.dataset.version,connectionId:form.dataset.connectionId||null,label:inputValue(form,'label').trim(),provider,
      apiKey:inputValue(form,'apiKey').trim(),models:[...new Set(inputValue(form,'models').split(/[,\n\r]+/).map(s=>s.trim()).filter(Boolean))],...(provider==='gigachat'?{scope:inputValue(form,'scope')}:{})};
    const fields=[...form.querySelectorAll('input,textarea,select')].map(el=>[el,el.disabled]);fields.forEach(([el])=>el.disabled=true);
    ctx.setBusy(true);message('#connection-message','');let saved=false;
    try {
      await ctx.api('llm-connection',input);saved=true;form.elements.namedItem('apiKey').value='';
      const settings=await ctx.api('llm-settings');
      if(state().identity?.id!==actorId||!manager())return;
      renderModels(settings);
      // Adding a connection must not discard role choices still being edited.
      const roles=$('#llm-editor');for(const [id,choice] of Object.entries(roleDraft||{})){
        roles.elements.namedItem(id+'-enabled').checked=choice.enabled;
        roles.elements.namedItem(id+'-connection').value=choice.connectionId||'';
        const model=roles.elements.namedItem(id+'-model');model.innerHTML=modelOptions(choice.connectionId,choice.model);model.value=choice.model||'';
      }
      message('#editor-message','Подключение сохранено. Выбери его для аналитика и сохрани назначения.',true);
      await ctx.refresh();
    }catch(error){message(saved?'#editor-message':'#connection-message',saved?'Подключение сохранено. Открой «Модели и роли» снова, чтобы обновить список.':error.message,saved);}
    finally{input.apiKey='';fields.forEach(([el,disabled])=>el.disabled=disabled);ctx.setBusy(false);}
  }
  function executionMarkup(job) {
    if(!job.execution)return '';
    const errors={auth:'Провайдер отклонил ключ или доступ к модели.',rate_limit:'Достигнут лимит провайдера.',timeout:'Истекло время ожидания модели.',network:'Не удалось связаться с провайдером.',context_changed:'Данные задачи изменились во время разбора. Задай вопрос заново.',review_rejected:'Проверяющий не подтвердил ответ.',disabled:'ИИ выключен на сервере.',configuration:'Подключение требует настройки.',evidence:'Не удалось подтвердить основания ответа.',step_limit:'Достигнут лимит чтения источников.',incomplete:'Модель не завершила ответ.',provider:'Провайдер вернул ошибку.',protocol:'Формат ответа не прошёл проверку.',validation:'Ответ или доступ к задаче не прошёл проверку.',context_size:'Контекст превысил лимит консультации.',response_size:'Ответ превысил допустимый размер.'};
    return `<details class="role-trace"><summary>Кто подготовил ответ</summary><ul>${job.execution.routes.map(r=>`<li><strong>${esc(roleNames[r.roleId]||r.roleId)}</strong> · ${esc(r.connectionLabel)} · ${esc(r.provider)} · ${esc(r.model)}</li>`).join('')}</ul>${job.execution.errorCode?`<p class="message">${esc(errors[job.execution.errorCode]||'Ответ не подтверждён.')}</p>`:''}</details>`;
  }
  function canRefresh() {return !boardHovered&&!$('#board details[open]')&&!$('#board')?.contains(document.activeElement)&&!modalOpen()&&!ctx.busy()&&!document.hidden&&Date.now()-lastInteraction>8000&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);}
  $('#board').addEventListener('pointerenter',()=>{boardHovered=true;});$('#board').addEventListener('pointerleave',()=>{boardHovered=false;lastInteraction=Date.now();});
  const interact=()=>{lastInteraction=Date.now();};document.addEventListener('pointerdown',interact);document.addEventListener('keydown',interact);
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;ctx.renderBoard();}));
  $('#prev-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#next-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#today-month').addEventListener('click',()=>{month=today().slice(0,7)+'-01';ctx.renderBoard();});
  $('#murmuration').addEventListener('change',event=>{auto=event.target.checked;lastInteraction=Date.now();$('#motion-note').textContent=auto?'Смена видов каждые 30 секунд; пауза при взаимодействии.':'Ты управляешь доской.';});
  $('#board-sort').addEventListener('change',event=>{sortMode=['priority','status','deadline'].includes(event.target.value)?event.target.value:'priority';lastInteraction=Date.now();ctx.renderBoard();});
  $('#pulse').addEventListener('change',event=>{document.body.classList.toggle('quiet-motion',!event.target.checked);pulseController.sync();});
  $('#open-chat')?.addEventListener('click',()=>{const task=state().snapshot?.tasks.find(t=>!t.archived);if(task){detailView='chat';ctx.openTask(task.id);}else message('#workspace-message','Пока нет доступных задач для обсуждения.');});
  $('#new-task').addEventListener('click',()=>taskEditor());$('#team').addEventListener('click',teamEditor);$('#llm-settings').addEventListener('click',modelsEditor);$('#reports').addEventListener('click',reportsEditor);
  $('#close-editor').addEventListener('click',()=>{if(!ctx.busy())$('#editor-dialog').close();});
  $('#editor-dialog').addEventListener('cancel',event=>{if(ctx.busy())event.preventDefault();});
  $('#editor-dialog').addEventListener('close',()=>{$('#editor-content').replaceChildren();draft=null;editingTask=null;editingPhase=null;llmSettings=null;creatingChild=null;displayedReport=null;reportEpoch++;});
  $('#editor-dialog').addEventListener('change',event=>{
    if(event.target.form?.id==='snapshot-report-form'&&$('#include-report-children')?.checked){const form=event.target.form;if(event.target.name==='taskIds'&&event.target.checked)includeReportChildren(form,[event.target.value]);if(event.target.id==='include-report-children')includeReportChildren(form,[...form.querySelectorAll('input[name="taskIds"]:checked')].map(box=>box.value));}

    if(event.target.form?.id==='connection-editor'){
      event.target.form.dataset.requestId=crypto.randomUUID();
      if(event.target.name==='provider')$('#giga-scope-field').hidden=event.target.value!=='gigachat';
    }
    const role=event.target.dataset.llmConnection;if(!role||!llmSettings)return;
    const model=event.target.form.elements.namedItem(role+'-model');model.innerHTML=modelOptions(event.target.value,null);
  });
  $('#editor-dialog').addEventListener('input',event=>{
    if(['final-result-editor','stage-result-editor','rework-editor'].includes(event.target.form?.id))event.target.setCustomValidity('');
    if(event.target.form?.id==='task-editor'&&event.target.name==='title')event.target.setCustomValidity('');
    if(event.target.form?.id==='connection-editor')event.target.form.dataset.requestId=crypto.randomUUID();
  });
  const acknowledging=new Map();
  async function acknowledgeCard(node) {
    const id=node?.dataset.cardId,task=state().snapshot?.tasks.find(t=>t.id===id);if(!task||!node.classList.contains('has-signal')||acknowledging.has(id))return;
    const version=task.version,cursor=task.notificationCursor,actor=state().identity.id;acknowledging.set(id,version);
    try {await ctx.api('notice',{taskId:id,expectedVersion:version,...(cursor!==undefined?{expectedNotificationCursor:cursor}:{}),requestId:crypto.randomUUID()});const current=state().snapshot.tasks.find(t=>t.id===id);if(state().identity?.id===actor&&current?.version===version&&current.notificationCursor===cursor){state().snapshot.preferences.seen[id]=version;current.unread=false;node.classList.remove('has-signal');const label=node.querySelector('.card-attention'),need=attention(current);if(label){if(need)label.textContent=need;else label.remove();}}}
    catch(error){message('#workspace-message',error.message);}finally{acknowledging.delete(id);}
  }
  $('#board').addEventListener('click',event=>{
    if(event.target.closest('[data-task]')){detailView='workspace';return;}
    const pin=event.target.closest('[data-pin]');if(pin){const id=pin.dataset.pin;mutate('pin',{taskId:id,pinned:!state().snapshot.preferences.pins.includes(id)});return;}
    if(event.target.closest('button,a,input,select,textarea,summary'))return;
    acknowledgeCard(event.target.closest('[data-card-id]'));
  });
  $('#board').addEventListener('dblclick',event=>{if(event.target.closest('button,a,input,select,textarea,summary'))return;const card=event.target.closest('[data-card-id]');if(card&&!ctx.busy()){detailView='workspace';ctx.openTask(card.dataset.cardId);}});
  $('#board').addEventListener('keydown',event=>{if(event.target.matches('[data-card-id]')&&(event.key===' '||event.key==='Enter')){event.preventDefault();acknowledgeCard(event.target);}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=document.querySelector('.task-options[open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}}},true);
  document.addEventListener('click',event=>{document.querySelectorAll('.task-options[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
  $('#task-dialog').addEventListener('click',event=>{
    if(ctx.busy())return;const button=event.target.closest('button');if(!button)return;const task=selectedTask();if(!task)return;
    if(button.dataset.detailView){changeDetailView(button.dataset.detailView);return;}
    if(button.dataset.chatTask){detailView='chat';ctx.openTask(button.dataset.chatTask);return;}
    if(button.hasAttribute('data-show-stages')){const stages=$('#stages-section');stages.open=true;stages.scrollIntoView?.({behavior:'smooth',block:'start'});return;}
    if(button.hasAttribute('data-show-result')){const result=$('#result-section')?.hidden?$('#document-workbench'):$('#result-section');if(result){result.open=true;result.scrollIntoView?.({block:'start'});}return;}
    if(button.hasAttribute('data-pause-task')){if(task.paused){mutate('task-action',{taskId:task.id,expectedVersion:state().memory.taskVersion,action:'resume'});}else{openEditor('Поставить поручение на паузу',`<form id="pause-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}"><label>Причина паузы<textarea name="reason" required maxlength="1000" placeholder="Почему работа временно остановлена?"></textarea></label><p class="report-note">Срок, ответственный и история сохранятся. Обсуждение останется доступно.</p><button class="primary" type="submit">Поставить на паузу</button></form>`);}return;}
    if(button.hasAttribute('data-archive-task')){mutate('task-archive',{taskId:task.id,expectedVersion:state().memory.taskVersion,archived:!task.archived});return;}
    if(button.dataset.archivePhase||button.dataset.restorePhase){mutate('phase-archive',{taskId:task.id,expectedVersion:state().memory.taskVersion,phaseId:button.dataset.archivePhase||button.dataset.restorePhase,archived:Boolean(button.dataset.archivePhase)});return;}
    if(button.hasAttribute('data-final-result')){openEditor('Передать итог руководителю',`<form id="final-result-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}"><label>Итоговый результат<textarea name="text" required maxlength="4000" placeholder="Что получено по поручению?"></textarea></label><p class="report-note">Итог сохраняется отдельной версией. Принять его может руководитель.</p><button class="primary" type="submit">Передать руководителю</button></form>`);return;}
    if(button.hasAttribute('data-edit-task'))taskEditor(task);
    if(button.hasAttribute('data-new-child'))taskEditor(null,task);
    if(button.dataset.childOpen)ctx.openTask(button.dataset.childOpen).catch(error=>message('#detail-message',error.message));
    if(button.id==='preview-context')previewContext(button);
    if(button.dataset.sourceOpen)readSource(button);
    if(button.id==='reload-detail')reloadDetail();
    if(button.hasAttribute('data-new-phase'))phaseEditor();
    if(button.dataset.editPhase)phaseEditor(task.phases.find(p=>p.id===button.dataset.editPhase));
    if(button.dataset.editDraft)draftEditor(button.dataset.editDraft);
    const target={taskId:task.id,expectedVersion:state().memory.taskVersion};
    if(button.dataset.taskAction==='rework'){openEditor('Вернуть результат на доработку',`<form id="rework-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}" data-result-id="${esc(task.submittedResultSourceId)}"><label>Что нужно исправить<textarea name="reason" required maxlength="1000" placeholder="Укажи конкретные замечания к переданному результату"></textarea></label><p class="report-note">Замечания сохранятся в истории и переписке по задаче вместе со ссылкой на этот результат. Утверждённый срок не изменится.</p><button class="primary" type="submit">Вернуть с замечаниями</button></form>`);return;}
    if(button.dataset.taskAction)mutate('task-action',{...target,action:button.dataset.taskAction});
    if(button.dataset.stageAction){const phase=task.phases.find(p=>p.id===button.dataset.phaseId);if(!phase)return;if(button.dataset.stageAction==='accept')mutate('stage-result',{...target,phaseId:phase.id,action:'accept',resultId:button.dataset.resultId});else stageResultEditor(task,phase,button.dataset.stageAction,button.dataset.resultId);return;}
    if(button.dataset.template)mutate('draft-create',{...target,kind:button.dataset.template});
  });
  $('#task-dialog').addEventListener('change',event=>{
    if(event.target.id==='result-reviewed'){const accept=$('[data-decision="accept"]');if(accept){accept.disabled=!event.target.checked;accept.dataset.unavailable=String(!event.target.checked);}}
  });
  $('#task-dialog').addEventListener('input',event=>{
    if(event.target.id==='chat-task-search'){const term=event.target.value.trim().replace(/^\//,'').toLocaleLowerCase('ru');document.querySelectorAll('[data-chat-task]').forEach(button=>button.hidden=!button.textContent.toLocaleLowerCase('ru').includes(term));}
  });
  $('#task-dialog').addEventListener('submit',event=>{
    if(event.target.id==='message-form'){event.preventDefault();mutate('message',{taskId:state().selected,text:inputValue(event.target,'text').trim(),requestUpdate:event.target.elements.requestUpdate.checked,...(event.target.elements.documentVersion?.value?{documentReference:{documentId:state().memory.requestState.artifacts.find(a=>a.id===event.target.elements.documentVersion.value).documentId,versionId:event.target.elements.documentVersion.value}}:{})});}
    if(event.target.id==='assistant-form'){event.preventDefault();mutate('assistant',{taskId:state().selected,expectedVersion:state().memory.taskVersion,question:inputValue(event.target,'question').trim()},{taskId:state().selected});}
  });
  $('#editor-dialog').addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,dialog='#editor-dialog';
    if(form.id==='snapshot-report-form'){saveReportForm(form);return;}
    if(form.id==='task-editor'){
      if(ctx.busy())return;
      if(!editingTask&&uncertainCreate()){protectCreateForm();message('#editor-message','Сначала подтверди исходный запрос. Новое поручение не отправлено.');return;}
      const title=form.elements.namedItem('title');
      title.setCustomValidity(title.value.trim()?'':'Напиши, что нужно сделать — не только пробелы.');
      if(!title.reportValidity()){title.focus();return;}
      const fields=Object.fromEntries(['title','description','employeeId','project','due','dueTime','protocolNumber','protocolPoint','protocolDate','priority','supervision','startAt'].map(k=>[k,k==='supervision'?inputValue(form,k)==='true':k==='startAt'?(inputValue(form,k)?inputValue(form,k)+':00+03:00':null):inputValue(form,k)]));mutate(editingTask?'task-edit':'task-create',{fields,...(editingTask?{taskId:editingTask.id,expectedVersion:editingTask.version}:creatingChild||{})},{dialog});}
    if(form.id==='rework-editor'){const reason=form.elements.namedItem('reason');reason.setCustomValidity(reason.value.trim()?'':'Укажи, что именно нужно исправить.');if(!reason.reportValidity()){reason.focus();return;}mutate('task-action',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,submittedResultSourceId:form.dataset.resultId,action:'rework',reason:reason.value.trim()},{dialog});}
    if(form.id==='pause-editor')mutate('task-action',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,action:'pause',reason:inputValue(form,'reason').trim()},{dialog});
    if(form.id==='final-result-editor'){const field=form.elements.namedItem('text');field.setCustomValidity(field.value.trim()?'':'Опиши итоговый результат.');if(!field.reportValidity())return;mutate('final-result',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,text:field.value.trim()},{dialog});}
    if(form.id==='stage-result-editor'){const field=form.elements.namedItem(form.dataset.action==='submit'?'text':'reason');field.setCustomValidity(field.value.trim()?'':'Заполни содержательно, не только пробелами.');if(!field.reportValidity())return;mutate('stage-result',{taskId:form.dataset.taskId,phaseId:form.dataset.phaseId,expectedVersion:form.dataset.version,action:form.dataset.action,...(form.dataset.action==='submit'?{text:field.value.trim()}:{reason:field.value.trim(),resultId:form.dataset.resultId})},{dialog});}
    if(form.id==='phase-editor')mutate('phase-save',{taskId:editingPhase.taskId,expectedVersion:editingPhase.version,phaseId:editingPhase.id,phase:{preparation:form.elements.preparation.checked,title:inputValue(form,'title'),start:inputValue(form,'start'),end:inputValue(form,'end'),dependsOn:inputValue(form,'dependsOn')||null,assigneeId:inputValue(form,'assigneeId')||null}},{dialog});
    if(form.id==='draft-editor')mutate('draft-save',{draftId:draft.id,expectedVersion:draft.version,expectedTaskVersion:draft.taskVersion,title:inputValue(form,'title'),body:inputValue(form,'body'),status:inputValue(form,'status')},{dialog});
    if(form.id==='automation-form')mutate('automation',{enabled:form.elements.enabled.checked},{dialog});
    if(form.id==='person-disable-form')mutate('person-disable',{employeeId:form.dataset.employeeId},{dialog}).then(result=>{if(result)teamEditor();});
    if(form.id==='person-editor')mutate('person-create',{name:inputValue(form,'name')},{dialog});
    if(form.id==='connection-editor')saveConnectionForm(form);
    if(form.id==='llm-editor'&&llmSettings)mutate('llm-settings',{expectedVersion:llmSettings.version,roles:Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}]))},{dialog});
  });
  $('#editor-dialog').addEventListener('click',async event=>{
    if(!ctx.busy()){
      if(event.target.closest('[data-retry-create]')){
        const item=uncertainCreate();if(item)mutate('task-create',JSON.parse(item.input),{dialog:'#editor-dialog',recoverCreate:true});return;
      }
      if(event.target.closest('#cancel-person-disable'))teamEditor();
      const disable=event.target.closest('[data-disable-person]');if(disable)disablePersonEditor(disable.dataset.disablePerson);
      if(event.target.closest('#new-report-selection'))reportsEditor();
      const reportButton=event.target.closest('[data-saved-report]');if(reportButton)loadSavedReport(reportButton.dataset.savedReport);
      if(event.target.closest('#download-report')&&displayedReport){const blob=new Blob([displayedReport.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='report-'+displayedReport.id+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      if(event.target.closest('#add-connection'))connectionEditor();
      const edit=event.target.closest('[data-edit-connection]');if(edit)connectionEditor(edit.dataset.editConnection);
      if(event.target.closest('#cancel-connection'))$('#connection-editor-host').replaceChildren();
    }
    const invite=event.target.closest('[data-invite]');
    if(invite&&!ctx.busy()){ctx.setBusy(true);try{const data=await ctx.api('invite',{employeeId:invite.dataset.invite});$('#invite-result').innerHTML=`<p>Код для ${esc(person(data.employeeId))}. Действует 30 минут, одноразовый.</p><label>Передай код этому участнику<input readonly type="text" value="${esc(data.code)}" autocomplete="off"></label>`;}catch(error){message('#editor-message',error.message);}finally{ctx.setBusy(false);}}
    if(event.target.closest('#download-draft')){const form=$('#draft-editor'),blob=new Blob([inputValue(form,'title')+'\n\n'+inputValue(form,'body')],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='document.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  });
  const rotation=setInterval(()=>{if(auto&&state().identity&&canRefresh()){view=({board:'calendar',calendar:'gantt',gantt:'board'})[view];ctx.renderBoard();}},30000);
  const jobsTimer=setInterval(()=>{if(jobsFor&&state().identity&&!document.hidden&&$('#task-dialog').open&&!ctx.busy())loadJobs();},6000);
  const detailTimer=setInterval(()=>{refreshCardTime();return checkDetail();},15000);
  window.addEventListener('pagehide',()=>{pulseController.destroy();document.removeEventListener('visibilitychange',syncVisibility);clearInterval(rotation);clearInterval(jobsTimer);clearInterval(detailTimer);const field=$('#connection-editor input[name="apiKey"]');if(field){field.value='';field.form.dataset.requestId=crypto.randomUUID();}});
  return {renderBoard,detailMarkup,appendDetail,detailMounted(){changeDetailView(detailView);recursive.mounted();loadJobs();},canRefresh,isImportant:important,reset(){recursive.reset();pending.clear();jobsFor=null;auto=false;view='board';sortMode='priority';lastSignal='';$('#murmuration').checked=false;if($('#editor-dialog').open)$('#editor-dialog').close();$('#brief-text').textContent='';}};
}

return {sortBoardTasks,decisionEvidenceMarkup,assistantReviewLabel,deadlineState,cardPulseProgress,cardPulseState,cardPulsePath,installPrototype};})();
__modules["request-workflow.js"]=(()=>{
'use strict';
const copy = x => JSON.parse(JSON.stringify(x));
const fail = text => { throw new Error(text); };
const timestamp = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const nonempty = x => typeof x === 'string' && Boolean(x.trim());
const member = (db,id) => db.employees?.find(p=>p.id===id && p.enabled!==false);
const participant = (t,id) => t.employeeId===id || t.coexecutorIds?.includes(id) || t.phases?.some(p=>!p.archived&&p.assigneeId===id);
// One stable local document identity per result request; versions keep their own IDs.
const documentIdFor = (taskId,requestId) => 'doc:'+encodeURIComponent(taskId)+':'+encodeURIComponent(requestId);
const artifactRecord = a => ({...copy(a),documentId:documentIdFor(a.taskId,a.requestId),attachments:copy(a.attachments||[])});
function artifactView(db,id) { const a=(db.artifacts||[]).find(x=>x.id===id); return a ? artifactRecord(a) : null; }
const attachmentTypes = Object.freeze({
  doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:'application/pdf'
});
function validateAttachments(value) {
  if(value===undefined) return [];
  if(!Array.isArray(value)||value.length>5) fail('В одной версии можно сохранить до пяти файлов Word, Excel, PowerPoint или PDF.');
  const keys=new Set();
  return value.map(file=>{
    if(!file||!nonempty(file.name)||file.name.length>240||/[\\/\x00-\x1f\x7f]/.test(file.name)) fail('Укажите корректное имя файла без пути.');
    const extension=file.name.lastIndexOf('.')>0?file.name.split('.').pop().toLowerCase():'',type=attachmentTypes[extension];
    if(!type) fail('Поддерживаются только файлы Word, Excel, PowerPoint или PDF. Содержимое не проверяется и не редактируется прототипом.');
    if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>20*1024*1024) fail('Размер одного файла должен быть от 1 байта до 20 МиБ.');
    if(file.type!==type) fail('Тип файла не соответствует расширению.');
    if(!nonempty(file.blobKey)||file.blobKey.length>240||/[\x00-\x1f\x7f]/.test(file.blobKey)||keys.has(file.blobKey)) fail('Нужна уникальная локальная ссылка на каждый файл версии.');
    if(typeof file.sha256!=='string'||!(/^[a-f0-9]{64}$/).test(file.sha256)) fail('Нужна контрольная сумма SHA-256 локального файла.');
    keys.add(file.blobKey);
    return {name:file.name.trim(),size:file.size,type,blobKey:file.blobKey,sha256:file.sha256};
  });
}
function requestState(db,taskId,asOf) {
  const now=timestamp(asOf)?Date.parse(asOf):null;
  const requests=copy((db.requests||[]).filter(r=>r.taskId===taskId).flatMap(r=>{
    if(now===null) return [r];
    if(Date.parse(r.createdAt)>now) return [];
    const history=(db.requestOperations||[]).filter(o=>o.requestId===r.id&&o.snapshot&&Date.parse(o.at)<=now);
    if(history.length) return [history[history.length-1].snapshot];
    return [r];
  }));
  for(const r of requests) { r.documentId=r.kind==='status'?null:documentIdFor(r.taskId,r.id); r.reviews=(r.reviews||[]).map(v=>({...v,documentId:r.documentId})); r.overdue=Boolean(!['accepted','answered','superseded'].includes(r.status)&&now!==null&&Date.parse(r.deadline)<now); r.controlDue=Boolean(!['accepted','answered','superseded'].includes(r.status)&&now!==null&&Date.parse(r.nextControlAt)<=now); }
  return { requests, pending:requests.filter(r=>!['accepted','answered','superseded'].includes(r.status)), latest:requests[requests.length-1]||null, artifacts:(db.artifacts||[]).filter(a=>a.taskId===taskId&&(now===null||Date.parse(a.createdAt)<=now)).map(artifactRecord) };
}
function validateArtifact(db,task,r,data,at) {
  if(!data || !nonempty(data.title) || !Array.isArray(data.sections) || !data.sections.length || data.sections.some(s=>!nonempty(s.heading)||!nonempty(s.body)) || data.sections.map(s=>s.body).join('\n').trim().length<80) fail('Нужен содержательный документ: название, разделы и фактический результат, а не сообщение о готовности.');
  if(!Array.isArray(data.sourceIds)||!data.sourceIds.length||new Set(data.sourceIds).size!==data.sourceIds.length||data.sourceIds.some(id=>!db.sources.some(s=>s.id===id&&s.taskId===task.id&&timestamp(s.occurredAt)&&timestamp(s.receivedAt)&&Date.parse(s.occurredAt)<=Date.parse(at)&&Date.parse(s.receivedAt)<=Date.parse(at)))) fail('Укажите существующие источники этого поручения.');
  if(!Array.isArray(data.criteria)||r.criteria.some(c=>!data.criteria.some(v=>v.id===c.id))||new Set(data.criteria.map(c=>c.id)).size!==data.criteria.length||data.criteria.some(c=>!r.criteria.some(x=>x.id===c.id)||typeof c.passed!=='boolean'||!nonempty(c.evidence))) fail('Каждый критерий требует явного результата проверки и доказательства.');
  return { title:data.title.trim().slice(0,240), sections:copy(data.sections), criteria:copy(data.criteria), sourceIds:copy(data.sourceIds), attachments:validateAttachments(data.attachments), synthetic:data.synthetic===true };
}
function applyRequestAction(db,taskId,actor,input,at,key) {
  const registered=member(db,actor?.id), original=db.tasks?.find(t=>t.id===taskId);
  if(!registered||!original||!(registered.role==='manager'||participant(original,registered.id))) fail('Нет доступа к запросу.');
  if(!input||!nonempty(key)||!timestamp(at)) fail('Нужны действие, ключ операции и корректное время.');
  input=copy(input);
  input.ownerId ||= input.targetEmployeeId; input.text ||= input.expectedResult; input.deadline ||= input.dueAt; input.nextControlAt ||= input.responseDueAt;
  const fingerprint=JSON.stringify({taskId,actorId:registered.id,input});
  const prior=(db.requestOperations||[]).find(o=>o.key===key);
  if(prior) { if(prior.fingerprint!==fingerprint) fail('Ключ операции уже использован для другого действия.'); return copy(db); }
  if((db.sources||[]).some(s=>s.id===key)||(db.events||[]).some(e=>e.key===key)) fail('Ключ уже принадлежит другому источнику.');
  if(original.archived||original.status==='done'||original.paused) fail('Поручение закрыто, архивировано или приостановлено.');
  let next=copy(db); next.requests ||= []; next.artifacts ||= []; next.requestOperations ||= []; next.sources ||= []; next.events ||= [];
  let task=next.tasks.find(t=>t.id===taskId), r;
  const manager=registered.role==='manager'&&(!task.controlOwnerId||task.controlOwnerId===registered.id), curator=registered.id===task.employeeId;
  const action=input.action;
  if(action==='create') {
    if(!manager&&!curator) fail('Запрос создаёт руководитель или куратор.');
    if(next.requests.some(q=>q.id===(input.requestId||key))) fail('Запрос уже существует.');
    const outstanding=next.requests.filter(q=>q.taskId===taskId&&!['accepted','answered','superseded'].includes(q.status));
    if(outstanding.some(q=>input.kind==='status'||q.kind!=='status')) fail('По поручению уже есть открытый запрос результата.');
    const ownerId=input.ownerId||task.employeeId;
    if(!member(next,ownerId)||!participant(task,ownerId)) fail('Ответственный должен участвовать в поручении.');
    if(!nonempty(input.text)||!timestamp(input.deadline)||Date.parse(input.deadline)<=Date.parse(at)||!timestamp(input.nextControlAt)||Date.parse(input.nextControlAt)<Date.parse(at)||Date.parse(input.nextControlAt)>Date.parse(input.deadline)) fail('Нужны содержание запроса, будущий срок и ближайшая контрольная точка не позже срока.');
    const criteria=input.criteria||[{id:'result',label:'Результат соответствует поручению и подтверждён источниками'}];
    if(!criteria.length||new Set(criteria.map(c=>c.id)).size!==criteria.length||criteria.some(c=>!nonempty(c.id)||!nonempty(c.label))) fail('Нужны уникальные критерии приёмки.');
    r={id:input.requestId||key,documentId:input.kind==='status'?null:documentIdFor(taskId,input.requestId||key),taskId,kind:input.kind==='status'?'status':'result',ownerId,targetEmployeeId:ownerId,curatorId:task.employeeId,createdBy:registered.id,createdAt:at,version:1,status:'requested',text:input.text.trim(),expectedResult:input.text.trim(),deadline:input.deadline,dueAt:input.deadline,responseDueAt:input.nextControlAt,nextControlAt:input.nextControlAt,criteria:copy(criteria),sourceId:key,receipts:[],reviews:[],reminders:[],help:[],artifactIds:[]}; next.requests.push(r);
    for(const old of outstanding) { old.status='superseded';old.supersededBy=r.id;old.supersededAt=at;old.updatedAt=at;old.version++;old.nextOwnerId=null;next.requestOperations.push({parentKey:key,taskId,requestId:old.id,actorId:registered.id,at,action:'superseded',sourceId:key,snapshot:copy(old)}); }
    r.supersedesRequestIds=outstanding.map(q=>q.id);
  } else {
    r=next.requests.find(q=>q.id===input.requestId&&q.taskId===taskId);
    if(!r) fail('Запрос не найден.');
    r.documentId=r.kind==='status'?null:documentIdFor(taskId,r.id);
    if(input.documentId!==undefined&&input.documentId!==r.documentId) fail('Документ изменился. Откройте нужный документ в поручении.');
    if(input.expectedVersion!==r.version) fail('Запрос изменился. Откройте актуальную версию.');
    if(Date.parse(at)<Date.parse(r.updatedAt||r.createdAt)) fail('Устаревшее действие не изменяет запрос.');
    if(['accepted','answered','superseded'].includes(r.status)) fail('Принятый запрос доступен только для чтения.');
    const owner=registered.id===r.ownerId;
    if(['deliver','read','acknowledge'].includes(action)) {
      if(action==='deliver'?!manager&&!curator:!owner) fail('Получение подтверждает адресат; доставку — отправитель.');
      if(action!=='deliver'&&!r.deliveredAt) fail('Сначала подтвердите доставку запроса.');
      const field={deliver:'deliveredAt',read:'readAt',acknowledge:'acknowledgedAt'}[action];
      if(!r[field]) r[field]=at;
      r.receipts.push({id:key,kind:action,actorId:registered.id,at});
    } else if(action==='reply') {
      if(r.kind!=='status'||!owner||!r.deliveredAt) fail('На статусный запрос отвечает адресат после доставки.');
      const source=next.sources.find(s=>s.id===input.sourceId&&s.taskId===taskId&&s.employeeId===r.ownerId&&nonempty(s.text)&&Date.parse(s.occurredAt||s.receivedAt)>=Date.parse(r.createdAt)&&s.kind!=='manager_message'&&!String(s.kind).startsWith('request_')&&timestamp(s.receivedAt)&&Date.parse(s.receivedAt)<=Date.parse(at)&&Date.parse(s.occurredAt||s.receivedAt)<=Date.parse(at));
      if(!source) fail('Нужен актуальный исходный ответ адресата по этому поручению.');
      if(!r.acknowledgedAt) { r.acknowledgedAt=at;r.receipts.push({id:key,kind:'acknowledge',evidenceKind:'substantive_reply',sourceId:source.id,actorId:registered.id,at}); }
      r.status='answered';r.replySourceId=source.id;r.answeredAt=at;
    } else if(action==='submit') {
      if(r.kind!=='result') fail('Статусный запрос закрывается ответом, не приёмкой документа.');
      if(!owner) fail('Документ передаёт ответственный по запросу.');
      if(!r.deliveredAt) fail('Сначала запрос должен быть доставлен адресату.');
      if(!['requested','returned'].includes(r.status)) fail('Сначала завершите проверку текущей версии.');
      if(r.status==='returned'&&(!nonempty(input.response)||input.response.trim().length<10)) fail('Опишите, как устранены замечания к предыдущей версии.');
      const data=validateArtifact(next,task,r,input.artifact,at);
      const artifact={...data,id:key+':artifact',documentId:r.documentId,taskId,requestId:r.id,version:r.artifactIds.length+1,createdAt:at,authorId:registered.id,submissionSourceId:key,supersedesId:r.artifactId||null,response:input.response||'',respondsToArtifactId:r.status==='returned'?r.artifactId:null,requiredCriteria:copy(r.criteria)};
      if(!r.acknowledgedAt) { r.acknowledgedAt=at;r.receipts.push({id:key,kind:'acknowledge',evidenceKind:'substantive_submission',sourceId:key,artifactId:artifact.id,actorId:registered.id,at}); }
      next.artifacts.push(artifact); r.artifactIds.push(artifact.id); r.artifactId=artifact.id; r.status='submitted'; r.acceptedArtifactId=null;r.curatorAcceptedArtifactId=null;r.finalSourceId=null;
      __modules['stage-workflow.js'].invalidateFinalResult(task);
    } else if(action==='open_artifact') {
      if(!manager&&!curator&&!owner) fail('Документ доступен участникам проверки.');
      if(input.artifactId!==r.artifactId||!next.artifacts.some(a=>a.id===input.artifactId&&a.requestId===r.id)) fail('Открываемая версия документа изменилась.');
      (r.artifactReads ||= []).push({id:key,documentId:r.documentId,artifactId:input.artifactId,actorId:registered.id,at});
    } else if(['return','curator_accept','manager_accept'].includes(action)) {
      const artifact=next.artifacts.find(a=>a.id===input.artifactId&&a.taskId===taskId&&a.requestId===r.id);
      if(!artifact||input.artifactId!==r.artifactId) fail('Документ отсутствует или версия изменилась. Откройте текущую версию.');
      if(!r.artifactReads?.some(v=>v.artifactId===artifact.id&&v.actorId===registered.id)) fail('Сначала откройте содержимое проверяемой версии документа.');
      if(action==='return') {
        if(!(r.status==='submitted'&&curator || r.status==='curator_accepted'&&manager)) fail('Возврат доступен проверяющему текущего шага.');
        if(!nonempty(input.reason)||input.reason.trim().length<10) fail('Укажите конкретные обязательные замечания для доработки.');
        r.status='returned';r.requiredRemarks=input.reason.trim();r.requiredRemarksArtifactId=artifact.id;r.curatorAcceptedArtifactId=null;r.finalSourceId=null;
        __modules['stage-workflow.js'].invalidateFinalResult(task);
      } else {
        if(artifact.criteria.some(c=>!c.passed)) fail('В документе есть невыполненные критерии. Требуется доработка.');
        __modules['stage-workflow.js'].requireAcceptedStages(task);
        if(action==='curator_accept') {
          if(!curator||r.status!=='submitted') fail('Текущую версию сначала принимает куратор.');
          r.status='curator_accepted';r.curatorAcceptedArtifactId=artifact.id;
          const finalKey=key+':final';
          if(next.sources.some(s=>s.id===finalKey)) fail('Источник итогового результата уже существует.');
          next=__modules['stage-workflow.js'].applyFinalResult(next,taskId,registered,artifact.title+'\n'+artifact.sections.map(s=>s.heading+': '+s.body).join('\n').slice(0,3500),at,finalKey);
          task=next.tasks.find(t=>t.id===taskId);r=next.requests.find(q=>q.id===r.id);r.finalSourceId=finalKey;
          Object.assign(next.sources.find(s=>s.id===finalKey),{artifactId:artifact.id,documentId:r.documentId,requestId:r.id,resultVersion:artifact.version});
        } else {
          if(!manager||(task.controlOwnerId&&task.controlOwnerId!==registered.id)||r.status!=='curator_accepted'||r.curatorAcceptedArtifactId!==artifact.id||task.submittedResultSourceId!==r.finalSourceId) fail('Сначала нужна актуальная приёмка этой версии куратором.');
          if((task.dependencyIds||task.dependsOnIds||[]).some(id=>!next.tasks.some(t=>t.id===id&&!t.archived&&t.status==='done'))) fail('Сначала примите результаты зависимостей поручения.');
          next=__modules['domain.js'].decide(next,taskId,'accept',registered,at);task=next.tasks.find(t=>t.id===taskId);r=next.requests.find(q=>q.id===r.id);
          r.status='accepted';r.acceptedArtifactId=artifact.id;r.acceptedAt=at;
        }
      }
      r.reviews.push({id:key,action,documentId:r.documentId,artifactId:artifact.id,artifactVersion:artifact.version,reason:input.reason||'',actorId:registered.id,at});
    } else if(action==='remind') {
      if(!manager&&!curator) fail('Напоминание назначает куратор или руководитель.');
      if(!timestamp(input.nextControlAt)||Date.parse(input.nextControlAt)<=Date.parse(at)) fail('Назначьте следующую контрольную точку в будущем.');
      r.reminders.push({id:key,actorId:registered.id,at});r.nextControlAt=input.nextControlAt;
    } else if(action==='help') {
      if(!owner||!nonempty(input.text)) fail('Ответственный должен описать требуемую помощь.');
      r.help.push({id:key,actorId:registered.id,text:input.text.trim(),at,status:'open'});
    } else fail('Неизвестное действие с запросом.');
    r.version++;
  }
  task.version=(Number.isInteger(task.version)?task.version:0)+1;
  r.updatedAt=at; r.latestArtifactId=r.artifactId||null;
  r.nextOwnerId=r.status==='submitted'?r.curatorId:r.status==='curator_accepted'?(task.controlOwnerId||next.employees.find(e=>e.role==='manager'&&e.enabled!==false)?.id||null):['accepted','answered','superseded'].includes(r.status)?null:r.ownerId;
  if(action!=='reply') {
  next.sources.push({id:key,taskId,localSynthetic:input.localSynthetic===true,employeeId:registered.id,requestId:r.id,documentId:r.documentId,kind:'request_'+action,text:input.text||input.reason||input.response||({'deliver':'Доставка смоделирована локально; внешнее сообщение не отправлялось.','submit':'Передана содержательная версия документа.','curator_accept':'Куратор принял конкретную версию документа.','manager_accept':'Руководитель принял конкретную версию документа.'}[action])||action,occurredAt:at,receivedAt:at,artifactId:r.artifactId||null,artifactVersion:next.artifacts.find(a=>a.id===r.artifactId)?.version||null});
  next.events.unshift({key,taskId,requestId:r.id,documentId:r.documentId,sourceId:key,actorId:registered.id,kind:'request_'+action,at,text:next.sources[next.sources.length-1].text,artifactId:r.artifactId||null,artifactVersion:next.artifacts.find(a=>a.id===r.artifactId)?.version||null,requestVersion:r.version});
  }
  next.requestOperations.push({key,fingerprint,taskId,requestId:r.id,actorId:registered.id,at,sourceId:action==='reply'?input.sourceId:key,snapshot:copy(r)});
  return next;
}
function sampleArtifact(db,taskId,requestId,valid=true) {
  const task=db.tasks.find(t=>t.id===taskId),r=(db.requests||[]).find(q=>q.id===requestId&&q.taskId===taskId);
  if(!task||!r) fail('Сначала создайте запрос.');
  return {title:'Проверочный протокол: '+task.title,synthetic:true,sourceIds:[r.sourceId],sections:[{heading:'Объект и метод',body:'Учебный документ для виртуальной обкатки. Объект проверки — '+task.title+'. Сопоставлены требования запроса, проверяемые критерии и представленная версия результата. Это не свидетельство реальных выполненных работ.'},{heading:'Результаты проверки',body:r.criteria.map((c,i)=>`${i+1}. ${c.label}. Учебный контрольный набор № ${i+1}: ожидается ${100+i*10} проверенных единиц, фактически ${valid?100+i*10:90+i*10}; расхождение ${valid?0:10} единиц. Допуск: 0. Вывод: ${valid?'соответствует':'не соответствует; требуется пересчёт и повторная сверка'}.`).join('\n')},{heading:'Происхождение и ограничения',body:'Основание: запрос '+r.id+'. Все значения синтетические; протокол предназначен только для проверки маршрута получения, доработки и приёмки конкретной версии.'}],criteria:r.criteria.map(c=>({id:c.id,passed:valid,evidence:valid?'В разделе «Результаты проверки» указан положительный результат соответствующего учебного контрольного примера.':'В разделе «Результаты проверки» зафиксировано несоответствие учебного контрольного примера.'}))};
}
return {applyRequestAction,requestState,artifactView,sampleArtifact,documentIdFor,attachmentTypes,validateAttachments};
})();
__modules["evidence-planning.js"]=(()=>{
'use strict';
const {registeredActor,canReadTask}=__modules['access.js'];
const copy=x=>JSON.parse(JSON.stringify(x));
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const day=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&time(x)&&new Date(x).toISOString().slice(0,10)===x;
const visible=(r,at)=>time(r.recordedAt)&&time(r.observedAt)&&Date.parse(r.recordedAt)<=Date.parse(at)&&Date.parse(r.observedAt)<=Date.parse(at);
const taskOf=(db,id)=>{const t=(db.tasks||[]).find(x=>x.id===id);if(!t)throw Error('Задача не найдена');return t;};
const records=(db,id)=>(db.planningRecords||[]).filter(r=>r.taskId===id);
const version=(db,id)=>records(db,id).reduce((n,r)=>Math.max(n,r.version||0),0);
function sourceRef(db,id){const s=(db.sources||[]).find(x=>x.id===id);return s?{sourceId:s.id,sourceVersion:s.version??1,authorId:s.employeeId||s.authorId||null,authorName:s.authorName||null,observedAt:s.occurredAt||s.observedAt||s.receivedAt,recordedAt:s.receivedAt||s.recordedAt}:null;}
function applyPlanningAction(db,taskId,actor,input,at,key){
 const t=taskOf(db,taskId),a=registeredActor(db,actor?.id||actor);
 if(!canReadTask(a,t))throw Error('Нет доступа к планированию задачи');
 if(!input||!time(at)||typeof key!=='string'||!key.trim())throw Error('Нужны действие, время и ключ');
 if(!['plan','forecast','fact','risk','dependency'].includes(input.kind))throw Error('Неизвестное действие планирования');
 if((input.kind==='plan'||input.accepted===true)&&a.role!=='manager')throw Error('Утверждение доступно руководителю');
 const fingerprint=JSON.stringify({taskId,actorId:a.id,input});
 const prior=(db.planningActions||[]).find(x=>x.key===key);
 if(prior){if(prior.fingerprint!==fingerprint)throw Error('Ключ уже использован для другого действия');return copy(db);}
 if(input.expectedVersion!==version(db,taskId))throw Error('Устаревшая версия планирования');
 if(t.archived)throw Error('Задача в архиве');
 const source=sourceRef(db,input.sourceId),raw=(db.sources||[]).find(x=>x.id===input.sourceId);
 if(!source||raw.taskId!==taskId||!time(source.recordedAt)||!time(source.observedAt)||Date.parse(source.recordedAt)>Date.parse(at)||Date.parse(source.observedAt)>Date.parse(at))throw Error('Нужен доступный источник этой задачи');
 const observedAt=input.observedAt||source.observedAt;
 if(!time(observedAt)||Date.parse(observedAt)>Date.parse(at))throw Error('Нельзя записать ещё не наблюдавшийся факт');
 if(input.date!=null&&!day(input.date))throw Error('Некорректная дата');
 if(input.decisionDeadline!=null&&!day(input.decisionDeadline))throw Error('Некорректный срок решения');
 if(input.leadDays!=null&&(!Number.isInteger(input.leadDays)||input.leadDays<0))throw Error('Длительность должна быть известным числом календарных дней');
 if(input.probability!=null)throw Error('Вероятность не поддерживается без отдельного основания');
 if(input.kind==='fact'&&input.date&&Date.parse(input.date)>Date.parse(observedAt))throw Error('Будущая дата не является подтверждённым фактом');
 if(input.kind==='fact'&&!input.note?.trim())throw Error('Нужно описание подтверждённого факта');
 const supersedes=input.supersedesId&&records(db,taskId).find(r=>r.id===input.supersedesId&&r.kind===input.kind);
 if(input.supersedesId&&!supersedes)throw Error('Предыдущая версия не найдена');
 if(supersedes&&records(db,taskId).some(r=>r.supersedesId===supersedes.id))throw Error('Версия уже заменена');
 if(input.kind==='dependency'){
  const dep=taskOf(db,input.dependsOnTaskId);if(!canReadTask(a,dep))throw Error('Нет доступа к зависимости');
  const links=(db.planningRecords||[]).filter(r=>r.kind==='dependency'&&r.state!=='closed'&&!(db.planningRecords||[]).some(n=>n.supersedesId===r.id));
  const seen=new Set(),visit=id=>{if(id===taskId)return true;if(seen.has(id))return false;seen.add(id);return links.filter(r=>r.taskId===id).some(r=>visit(r.dependsOnTaskId));};
  if(visit(dep.id))throw Error('Цикл зависимостей');
 }
 if(input.accepted===true&&(!input.artifactId||input.artifactVersion==null||!Array.isArray(input.criteria)||!input.criteria.length||input.criteria.some(c=>!c||typeof c.name!=='string'||c.checked!==true)))throw Error('Для принятой версии нужны материал, версия и проверенные критерии');
 const next=copy(db),v=version(db,taskId)+1;
 const r={id:`planning:${key}`,taskId,kind:input.kind,version:v,sourceId:input.sourceId,sourceVersion:source.sourceVersion,authorId:a.id,recordedAt:at,observedAt,note:input.note||'',date:input.date||null,leadDays:input.leadDays??null,leadTimeConfirmed:input.leadTimeConfirmed===true,state:input.state==='closed'?'closed':'open',accepted:input.accepted===true,supersedesId:input.supersedesId||null};
 for(const f of ['decisionDeadline','outcome','dependsOnTaskId','artifactId','artifactVersion','criteria'])if(input[f]!=null)r[f]=copy(input[f]);
 next.planningRecords=[...(next.planningRecords||[]),r];
 next.planningActions=[...(next.planningActions||[]),{key,fingerprint,taskId,version:v,at}];
 // The original task, deadline, source, and event records remain untouched.
 return next;
}
function projectEvidence(db,taskId,asOf){
 if(!time(asOf))throw Error('Нужен момент среза');const task=taskOf(db,taskId);
 const history=records(db,taskId).filter(r=>visible(r,asOf)).sort((a,b)=>a.version-b.version).map(copy);
 const live=history.filter(r=>!history.some(n=>n.supersedesId===r.id));
 const last=kind=>live.filter(r=>r.kind===kind).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)||a.version-b.version).at(-1)||null;
 const gaps=[];
 const ev=(db.events||[]).filter(e=>e.taskId===taskId&&time(e.at)&&Date.parse(e.at)<=Date.parse(asOf)&&(!e.occurredAt||Date.parse(e.occurredAt)<=Date.parse(asOf)));
 const legacy=(field,value)=>{
  const match=ev.filter(e=>e.changes?.[field]||e.updates?.[field]!==undefined).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).at(-1);
  if(match){const val=match.changes?.[field]?.after??match.updates?.[field];return {date:val,kind:field==='forecastFinish'?'forecast':'plan',version:null,sourceId:match.sourceId||null,authorId:match.actorId||null,recordedAt:match.at,observedAt:match.occurredAt||match.at,legacy:true};}
  // A legacy current value has unknown historical applicability: retain it, clearly marked, only at/after its known update.
  const selected=(db.simulation?.decisions||[]).filter(d=>d.taskId===taskId&&time(d.at)&&Date.parse(d.at)<=Date.parse(asOf)).map(d=>({d,effect:(db.simulation?.eventPlan||[]).find(e=>e.gate?.id===d.gateId)?.gate?.consequencesByOption?.[d.optionId]})).filter(x=>x.effect?.updates?.[field]!==undefined).at(-1);
  if(selected)return {date:selected.effect.updates[field],kind:field==='forecastFinish'?'forecast':'plan',version:null,sourceId:'decision-'+selected.d.gateId,authorId:selected.d.actorId,recordedAt:selected.d.at,observedAt:selected.d.at,legacy:true};
  const stamp=task.lastDecisionAt||task.updatedAt||task.reportedAt||(field==='forecastFinish'?db.simulation?.day:null)||task.createdAt||db.simulation?.day||ev.map(e=>e.at).sort().at(-1);
  if(value&&(!stamp||Date.parse(stamp)<=Date.parse(asOf))){gaps.push({field,reason:'legacy_provenance_or_historical_version_unknown'});return {date:value,kind:field==='forecastFinish'?'forecast':'plan',version:null,sourceId:task.factOrigins?.[field]?.sourceId||null,authorId:null,recordedAt:stamp||null,observedAt:stamp||null,legacy:true,historicalApplicability:'unknown'};}
  return null;
 };
 const plan=last('plan')||legacy('due',task.due),currentForecast=last('forecast')||legacy('forecastFinish',task.forecastFinish);
 if(!plan?.date)gaps.push({field:'plan',reason:'date_unknown'});
 if(!currentForecast?.date)gaps.push({field:'forecast',reason:'date_unknown'});
 const decisionWindows=[];
 if(currentForecast){
  if(currentForecast.leadTimeConfirmed&&Number.isInteger(currentForecast.leadDays)&&currentForecast.date){const date=new Date(currentForecast.date+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-currentForecast.leadDays);decisionWindows.push({deadline:date.toISOString().slice(0,10),basis:'forecast_minus_confirmed_calendar_leadtime',leadDays:currentForecast.leadDays,sourceId:currentForecast.sourceId,forecastVersion:currentForecast.version});}
  else gaps.push({field:'leadTime',reason:'required_decision_deadline_unknown'});
 }
 const confirmedFacts=live.filter(r=>r.kind==='fact');
 // Existing source-backed progress remains useful even when no final artifact exists.
 for(const e of ev.filter(e=>['progress','unblocked','stage_accept'].includes(e.kind)||e.action==='accept')){const ref=sourceRef(db,e.sourceId);if(ref&&time(ref.recordedAt)&&Date.parse(ref.recordedAt)<=Date.parse(asOf)&&time(ref.observedAt)&&Date.parse(ref.observedAt)<=Date.parse(asOf))confirmedFacts.push({id:e.key,kind:'fact',note:e.text||'',sourceId:e.sourceId,authorId:e.actorId||ref.authorId,recordedAt:e.at,observedAt:e.occurredAt||e.at,version:null,accepted:e.kind==='stage_accept'||e.action==='accept',scope:e.phaseId?'stage':'reported_progress',phaseId:e.phaseId||null,resultId:e.resultId||null});}
 for(const fact of confirmedFacts.filter(f=>f.accepted&&f.phaseId)){const phase=(task.phases||[]).find(p=>p.id===fact.phaseId);const review=(phase?.reviews||[]).find(r=>r.id===fact.id);const submission=(phase?.submissions||[]).find(s=>s.id===(fact.resultId||review?.resultId));fact.artifactId=submission?.id||fact.resultId||null;fact.artifactVersion=submission?.version??null;fact.criteria=review?.criteria||[];fact.superseded=(phase?.submissions||[]).some(s=>time(s.at)&&Date.parse(s.at)<=Date.parse(asOf)&&submission&&Date.parse(s.at)>Date.parse(submission.at));if(!fact.criteria.length)gaps.push({field:'acceptedCriteria',phaseId:fact.phaseId,reason:'historical_review_has_no_structured_checklist'});}
 const openRisks=live.filter(r=>r.kind==='risk'&&r.state!=='closed');
 for(const r of openRisks)if(r.decisionDeadline)decisionWindows.push({deadline:r.decisionDeadline,basis:'explicit_source',sourceId:r.sourceId,riskId:r.id});
 const dependencies=live.filter(r=>r.kind==='dependency'&&r.state!=='closed').map(r=>{const upstream=records(db,r.dependsOnTaskId).filter(x=>x.kind==='forecast'&&visible(x,asOf)).at(-1);return {...r,attention:upstream?{kind:'forecast_changed_requires_review',forecastDate:upstream.date,forecastVersion:upstream.version,sourceId:upstream.sourceId}:null};});
 const references=[...new Set([plan?.sourceId,currentForecast?.sourceId,...history.map(r=>r.sourceId),...confirmedFacts.map(r=>r.sourceId)].filter(Boolean))].map(id=>sourceRef(db,id)).filter(r=>r&&time(r.recordedAt)&&time(r.observedAt)&&Date.parse(r.recordedAt)<=Date.parse(asOf)&&Date.parse(r.observedAt)<=Date.parse(asOf));
 const gapFields={due:'плановый срок',plan:'плановый срок',forecastFinish:'прогноз завершения',forecast:'прогноз завершения',leadTime:'длительность подготовки и исполнения',acceptedCriteria:'критерии приёмки'};
 const gapReasons={legacy_provenance_or_historical_version_unknown:'для прежней записи не установлены источник или история изменений',date_unknown:'дата не установлена',required_decision_deadline_unknown:'срок решения нельзя рассчитать без подтверждённой длительности',historical_review_has_no_structured_checklist:'в прежней записи приёмки нет перечня проверенных критериев'};
 const windowBasis={forecast_minus_confirmed_calendar_leadtime:'прогноз и подтверждённая длительность в календарных днях',explicit_source:'срок явно указан в источнике'};
 const displayVersion=value=>value==null?'историческая версия не установлена':`версия ${value}`;
 const text=[`Срез ${asOf}. План: ${plan?.date||'дата неизвестна'}. Прогноз: ${currentForecast?.date||'дата неизвестна'} (не факт завершения; источник ${currentForecast?.sourceId||'не установлен'}; ${displayVersion(currentForecast?.version)}).`,...(currentForecast?.note?[currentForecast.note]:[]),...decisionWindows.map(w=>`Решение до ${w.deadline}; основание: ${windowBasis[w.basis]||'требует уточнения'}; источник ${w.sourceId||'не установлен'}.`),...dependencies.filter(d=>d.attention).map(d=>`Зависимость ${d.dependsOnTaskId}: прогноз ${d.attention.forecastDate||'неизвестен'} требует проверки, не подтверждает завершение [${d.attention.sourceId}].`),...confirmedFacts.map(r=>`Факт: ${r.note} [${r.sourceId}; ${displayVersion(r.version)}]`),...openRisks.map(r=>`Открытый риск: ${r.note} [${r.sourceId}; ${displayVersion(r.version)}]`),...gaps.map(g=>`Нужно уточнить: ${gapFields[g.field]||'сведения'} — ${gapReasons[g.reason]||'основание не установлено'}`)].join('\n');
 return {taskId,asOf,planningVersion:history.reduce((n,r)=>Math.max(n,r.version),0),plan,currentForecast,forecastDate:currentForecast?.date||null,confirmedFacts,acceptedVersions:confirmedFacts.filter(r=>r.accepted),openRisks,dependencies,decisionWindows,gaps,history:history.map(r=>({...r,superseded:history.some(n=>n.supersedesId===r.id)||(r.kind==='forecast'||r.kind==='plan')&&last(r.kind)?.id!==r.id})),references,text};
}
function monthlyDraft(db,{actorId,asOf,taskIds}={}){
 const actor=registeredActor(db,actorId);if(!time(asOf))throw Error('Нужен момент среза');
 const ids=taskIds||db.tasks.filter(t=>canReadTask(actor,t)).map(t=>t.id);
 if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw Error('Некорректный охват отчёта');
 const entries=ids.map(id=>{const t=taskOf(db,id);if(!canReadTask(actor,t))throw Error('Нет доступа к задаче отчёта');const evidence=projectEvidence(db,id,asOf);const hidden=evidence.dependencies.filter(d=>!canReadTask(actor,(db.tasks||[]).find(t=>t.id===d.dependsOnTaskId)));evidence.dependencies=evidence.dependencies.filter(d=>!hidden.includes(d));if(hidden.length)evidence.text=evidence.text.split('\n').filter(line=>!hidden.some(d=>line.startsWith('Зависимость '+d.dependsOnTaskId+':'))).join('\n');return {taskId:id,title:t.title,...evidence};});
 const references=Array.from(new Map(entries.flatMap(e=>e.references).map(r=>[r.sourceId,r])).values());
 return {kind:'monthly_draft',status:'draft',accepted:false,published:false,asOf,period:asOf.slice(0,7),actorId,entries,references,coverage:{taskIds:ids,taskCount:ids.length,gaps:entries.flatMap(e=>e.gaps.map(g=>({taskId:e.taskId,...g}))),complete:false,policy:'existing_evidence_as_of; no end_of_month assumption'},text:`Черновик свода за ${asOf.slice(0,7)} на ${asOf}. Не принят и не опубликован.\n\n`+entries.map(e=>`${e.title||e.taskId}\n${e.text}`).join('\n\n')};
}
return {projectEvidence,applyPlanningAction,monthlyDraft};})();
__modules["routine-plans.js"]=(()=>{
/** Calendar plans, never forecasts of completion. All commands return independent state. */
const clone=x=>JSON.parse(JSON.stringify(x));
function instant(value){if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('Нужны дата, время и часовой пояс.');return Date.parse(value);}
function dateValid(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function local(ms){return new Date(ms+10800000).toISOString().slice(0,19)+'+03:00';}
function dayOffset(at,days){const d=new Date(instant(at)+10800000);d.setUTCDate(d.getUTCDate()+days);return local(d.getTime()-10800000);}
function cycleAt(series,index){const start=new Date(instant(series.firstStartAt)+10800000),month=start.getUTCMonth()+index*({monthly:1,quarterly:3,yearly:12}[series.frequency]);const day=start.getUTCDate();start.setUTCDate(1);start.setUTCMonth(month);const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();start.setUTCDate(Math.min(day,end));return local(start.getTime()-10800000);}
function member(db,id){const p=(db.employees||[]).find(p=>p.id===id&&p.enabled!==false);if(!p)throw Error('Участник не зарегистрирован.');return p;}
function controller(db,task){return task.controlOwnerId||task.managerId||(db.employees||[]).find(p=>p.role==='manager'&&p.enabled!==false)?.id;}
function validateSeries(db,s){if(!s.id||!s.title?.trim()||!['monthly','quarterly','yearly'].includes(s.frequency))throw Error('Укажите название и периодичность серии.');member(db,s.ownerId);instant(s.firstStartAt);if(!dateValid(s.firstStartAt.slice(0,10)))throw Error('Некорректная дата старта.');if(!s.firstStartAt.endsWith('+03:00'))throw Error('План рутины использует UTC+03:00.');if(s.untilDate&&(!dateValid(s.untilDate)||s.untilDate<s.firstStartAt.slice(0,10)))throw Error('Некорректная граница серии.');const t=s.template||{};if([s.calendarBasis,t.calendarBasis,t.dueOffsetBasis].some(x=>x!=null&&x!=='calendar_days'))throw Error('Поддержаны только календарные дни UTC+03:00; рабочий календарь не задан.');if(t.dueOffsetDays!=null&&(!Number.isInteger(t.dueOffsetDays)||t.dueOffsetDays<0))throw Error('Срок задаётся числом календарных дней после старта.');const ids=new Set();for(const p of t.preparation||[]){if(!p.id||ids.has(p.id)||!p.title?.trim())throw Error('Подготовке нужны уникальный код и название.');ids.add(p.id);if([p.offsetBasis,p.offsetUnit,p.leadTimeBasis].some(x=>x!=null&&x!=='calendar_days'))throw Error('Подготовка рассчитана только в календарных днях; рабочий календарь не задан.');member(db,p.ownerId||s.ownerId);if(p.offsetDays!=null&&(!Number.isInteger(p.offsetDays)||p.offsetDays>0))throw Error('Подготовка задаётся календарным смещением до старта или неизвестным сроком.');}}
function materializeRoutineInstances(db,{asOf}){const horizon=instant(asOf),next=clone(db);next.tasks||=[];next.routineSeries||=[];for(const s of next.routineSeries){if(s.status!=='active')continue;validateSeries(next,s);const offsets=(s.template?.preparation||[]).map(p=>p.offsetDays).filter(Number.isInteger),lead=Math.min(0,...offsets);for(let index=0;;index++){if(index>12000)throw Error('Слишком большой горизонт плана.');const start=cycleAt(s,index),date=start.slice(0,10);if(s.untilDate&&date>s.untilDate)break;if(instant(dayOffset(start,lead))>horizon)break;const id='routine:'+s.id+':'+date;const existing=next.tasks.find(t=>t.id===id);if(existing){if(existing.routineSeriesId!==s.id||existing.cycleKey!==date)throw Error('Код цикла занят другим поручением.');continue;}const phases=(s.template?.preparation||[]).map(p=>({id:id+':prep:'+p.id,title:p.title,kind:'preparation',preparation:true,assigneeId:p.ownerId||s.ownerId,mandatory:p.mandatory!==false,offsetDays:p.offsetDays??null,offsetBasis:'calendar_days',leadTimeKnown:Number.isInteger(p.offsetDays),due:Number.isInteger(p.offsetDays)?dayOffset(start,p.offsetDays).slice(0,10):null,dueAt:Number.isInteger(p.offsetDays)?dayOffset(start,p.offsetDays):null,requiredVersion:p.requiredVersion??null,documentId:p.documentId||null,reviewStatus:'pending',done:false,submissions:[],reviews:[]}));next.tasks.push({id,title:s.title,employeeId:s.ownerId,controlOwnerId:s.controlOwnerId,routineSeriesId:s.id,cycleKey:date,routineTemplateVersion:s.version,calendarPolicy:{timezone:'UTC+03:00',offsetBasis:'calendar_days',monthEnd:'clamp_to_last_day_then_rebound',holidayAdjustment:'none'},originalPlan:{mainStartAt:start,due:s.template?.dueOffsetDays!=null?dayOffset(start,s.template.dueOffsetDays).slice(0,10):null,templateVersion:s.version},templateSnapshot:clone(s.template||{}),mainStartAt:start,startAt:start,due:s.template?.dueOffsetDays!=null?dayOffset(start,s.template.dueOffsetDays).slice(0,10):null,dueKnown:s.template?.dueOffsetDays!=null,status:'planned',version:'1',planOnly:true,createdAt:asOf,phases,materials:[],history:[],supervision:true,paused:false,archived:false,contact:'idle',summary:'План цикла; выполнение не подтверждено.',fieldProvenance:{mainStartAt:{sourceType:'routine_template',seriesId:s.id,version:s.version},due:{sourceType:'routine_template',seriesId:s.id,version:s.version}}});}}
return next;}
function applyRoutineAction(db,actor,input,at,key){instant(at);const registered=member(db,actor.id);if(registered.role!=='manager')throw Error('План рутины изменяет руководитель.');if(!key)throw Error('Нужен ключ команды.');const next=clone(db);next.routineSeries||=[];next.routineCommands||=[];next.events||=[];const replay=next.routineCommands.find(c=>c.key===key);if(replay){if(replay.actorId!==registered.id||replay.payload!==JSON.stringify(input))throw Error('Ключ уже использован другой командой.');return next;}if(next.events.some(e=>e.key===key)||(next.sources||[]).some(s=>s.id===key))throw Error('Ключ уже принадлежит другому источнику.');let s;
if(input.action==='create_series'){s=clone(input.series||{});if(next.routineSeries.some(x=>x.id===s.id))throw Error('Серия уже существует.');Object.assign(s,{status:'active',version:1,controlOwnerId:registered.id,createdAt:at,history:[]});validateSeries(next,s);next.routineSeries.push(s);}
else if(input.action!=='materialize'){s=next.routineSeries.find(x=>x.id===input.seriesId);if(!s)throw Error('Серия не найдена.');if(s.controlOwnerId!==registered.id)throw Error('Серию изменяет её руководитель.');if(input.expectedVersion!=null&&input.expectedVersion!==s.version)throw Error('Версия серии изменилась.');if(s.status==='cancelled')throw Error('Отменённая серия сохранена только для чтения.');if(input.action==='update_series'){const allowed=['title','ownerId','template','untilDate'];for(const k of Object.keys(input.patch||{})){if(!allowed.includes(k))throw Error('Начало и период серии неизменны: создайте новую серию.');s[k]=clone(input.patch[k]);}validateSeries(next,s);s.version++;}else if(input.action==='pause_series')s.status='paused';else if(input.action==='resume_series')s.status='active';else if(input.action==='cancel_series')s.status='cancelled';else throw Error('Неизвестное действие серии.');}
if(s)(s.history||=[]).push({key,action:input.action,at,actorId:registered.id,version:s.version});next.routineCommands.push({key,actorId:registered.id,payload:JSON.stringify(input),at});next.events.unshift({key,kind:'routine_'+input.action,seriesId:s?.id||null,actorId:registered.id,at,text:'Изменён план серии; результаты циклов не изменены.'});return input.action==='materialize'?materializeRoutineInstances(next,{asOf:input.asOf||at}):next;}
function startReadiness(db,taskId,asOf){const now=instant(asOf),task=(db.tasks||[]).find(t=>t.id===taskId);if(!task)throw Error('Задача не найдена.');const blockers=[],mainStartAt=task.mainStartAt||task.startAt||null;const phases=[...(task.phases||[]).filter(p=>p.kind==='preparation'||p.preparation===true),...(Array.isArray(task.preparation)?task.preparation:[])].filter(p=>!p.archived);const seen=new Set();const preparation=phases.filter(p=>!seen.has(p.id)&&seen.add(p.id)).map(p=>{const ownerId=p.assigneeId||p.ownerId||task.employeeId;const submission=p.submissions?.find(s=>s.id===p.acceptedResultId);let ready=Boolean(p.reviewStatus==='accepted'&&p.acceptedResultId===p.submittedResultId&&submission&&p.reviews?.some(r=>r.resultId===p.acceptedResultId&&r.action==='accept'&&(!r.at||Date.parse(r.at)<=now))&&(!submission.at||Date.parse(submission.at)<=now));if(p.requiredVersion!=null)ready=ready&&String(submission?.documentVersion??submission?.version)===String(p.requiredVersion);const ownerKnown=(db.employees||[]).some(e=>e.id===ownerId&&e.enabled!==false);ready=ready&&ownerKnown;if(p.mandatory!==false&&!ready)blockers.push({code:ownerKnown?'preparation_not_accepted':'preparation_owner_missing',phaseId:p.id,message:'Обязательная подготовка требует приёмки точной версии: '+p.title});return {phaseId:p.id,title:p.title,ownerId,mandatory:p.mandatory!==false,due:p.dueAt||p.due||null,leadTimeKnown:p.leadTimeKnown??Boolean(p.dueAt||p.due),ready,requiredVersion:p.requiredVersion??null};});if(mainStartAt&&instant(mainStartAt)>now)blockers.push({code:'before_main_start',message:'Время основного старта ещё не наступило.'});if(task.paused)blockers.push({code:'task_paused',message:'Поручение на паузе.'});if(task.archived||task.status==='done'||task.cancelled)blockers.push({code:'task_closed',message:'Поручение закрыто.'});return {ready:blockers.length===0,blockers,preparation,mainStartAt};}
function guardTaskStart(db,taskId,actor,{early=false,reason}={},at){const registered=member(db,actor.id),task=(db.tasks||[]).find(t=>t.id===taskId);if(!task)throw Error('Задача не найдена.');const owner=controller(db,task);if(registered.id!==task.employeeId&&registered.id!==owner)throw Error('Нет полномочий на основной старт.');const result=startReadiness(db,taskId,at),before=result.blockers.some(b=>b.code==='before_main_start');if(early&&(registered.id!==owner||!reason?.trim()))throw Error('Досрочный старт требует решения руководителя и причины.');const blockers=result.blockers.filter(b=>!(early&&b.code==='before_main_start'));if(blockers.length)throw Error(blockers.map(b=>b.message).join(' '));return {...result,ready:true,blockers:[],early:Boolean(early&&before),reason:early?reason.trim():null};}
return {applyRoutineAction,materializeRoutineInstances,startReadiness,guardTaskStart};})();
__modules["markus-policy.js"]=(()=>{
'use strict';
// Deterministic, local-only coordination. This is not a provider, transport or acceptance authority.
const clone=x=>JSON.parse(JSON.stringify(x)), DAY=86400000;
const ms=x=>typeof x==='string'?Date.parse(x):NaN;
const visibleAt=(x,at)=>Number.isFinite(ms(x))&&ms(x)<=ms(at);
const addDays=(at,n)=>new Date(ms(at)+n*DAY).toISOString();
const closed=r=>['accepted','answered','cancelled','superseded'].includes(r.status);
function time(db,at){const v=at||db.asOf;if(!Number.isFinite(ms(v)))throw Error('Markus требует корректное модельное время.');return v;}
function actor(db,id){return (db.employees||[]).find(p=>p.id===id&&p.enabled!==false);}
function controls(db,p,t){
 if(!p)return false;
 if([t.employeeId,t.controlOwnerId,t.decisionOwnerId].includes(p.id)||t.coexecutorIds?.includes(p.id)||t.phases?.some(s=>!s.archived&&s.assigneeId===p.id))return true;
 if(p.role!=='manager')return false;
 let current=actor(db,t.employeeId),seen=new Set();
 while(current&&!seen.has(current.id)){seen.add(current.id);if(current.reportsTo===p.id)return true;current=actor(db,current.reportsTo);}
 // The legacy two-role demo lacks a hierarchy; a sole manager owns its control scope.
 return !t.controlOwnerId&&!t.decisionOwnerId&&(db.employees||[]).filter(e=>e.enabled!==false&&e.role==='manager').length===1;
}
function controller(db,t){const managers=(db.employees||[]).filter(p=>p.role==='manager'&&p.enabled!==false);return actor(db,t.controlOwnerId)||actor(db,t.decisionOwnerId)||(!t.controlOwnerId&&!t.decisionOwnerId&&managers.length===1?managers[0]:null)||actor(db,t.employeeId);}
function actualSources(db,t,at){return (db.sources||[]).filter(s=>s.taskId===t.id&&visibleAt(s.receivedAt||s.occurredAt,at)&&visibleAt(s.occurredAt||s.receivedAt,at)&&[t.employeeId,...(t.coexecutorIds||[]),...(t.phases||[]).map(p=>p.assigneeId)].includes(s.employeeId)&&!/^request_|^markus_|manager_message|stage_review|planning_decision/.test(s.kind||'')).sort((a,b)=>ms(a.occurredAt||a.receivedAt)-ms(b.occurredAt||b.receivedAt));}
function requestList(db,t,at){const api=__modules['request-workflow.js'];const list=api?.requestState(db,t.id,at)?.requests||(db.requests||[]).filter(r=>r.taskId===t.id);return list.filter(r=>visibleAt(r.createdAt,at));}
function evidence(db,t,at){const e=__modules['evidence-planning.js']?.projectEvidence(db,t.id,at);return e||{plan:t.due?{date:t.due}:null,currentForecast:t.forecastFinish?{date:t.forecastFinish}:null,confirmedFacts:[],openRisks:[],gaps:[],references:[]};}
function inspect(db,t,at){
 const day=at.slice(0,10),sources=actualSources(db,t,at),last=sources.at(-1),requests=requestList(db,t,at),pending=requests.filter(r=>!closed(r)),latest=pending.at(-1),ev=evidence(db,t,at);
 const readiness=__modules['routine-plans.js']?.startReadiness(db,t.id,at);
 const preparation=(t.phases||[]).filter(p=>!p.archived&&p.reviewStatus!=='accepted'&&((p.start&&p.start<=day)||((p.dueAt||p.end)&&(p.dueAt||p.end).slice(0,10)<=addDays(at,7).slice(0,10))));
 for(const p of readiness?.preparation||[])if(!p.ready&&p.mandatory&&p.due&&p.due.slice(0,10)<=addDays(at,7).slice(0,10)&&!preparation.some(x=>x.id===p.phaseId))preparation.push({id:p.phaseId,title:p.title,end:p.due.slice(0,10)});
 const active=!t.archived&&!t.paused&&t.status!=='done'&&t.supervision!==false;
 const mainStart=readiness?.mainStartAt||t.mainStartAt||t.startAt||t.start;
 const monitoring=active&&(!mainStart||ms(mainStart)<=ms(at)||preparation.length>0);
 const missing=!last, stale=!!last&&ms(at)-ms(last.occurredAt||last.receivedAt)>=7*DAY;
 const gates=(db.simulation?.gates||[]).filter(g=>g.taskId===t.id&&g.status==='open'&&(!g.openedAt||g.openedAt<=day));
 const overdue=latest&&!['submitted','curator_accepted'].includes(latest.status)&&ms(latest.deadline)<ms(at);
 const missedPrep=preparation.filter(p=>(p.dueAt||p.end)&&(p.dueAt||p.end).slice(0,10)<day);
 const decisionWindows=(ev.decisionWindows||[]).filter(w=>w.deadline&&w.deadline<=addDays(at,7).slice(0,10));
 const forecastSlips=ev.currentForecast?.date&&ev.plan?.date&&ev.currentForecast.date>ev.plan.date;
 const conflicts=(ev.gaps||[]).filter(g=>/conflict/.test(typeof g==='string'?g:(g.reason||g.code||'')));
 const unknownLead=forecastSlips&&(ev.gaps||[]).some(g=>g.field==='leadTime');
 const needsInquiry=Boolean(missing||stale||t.needsClarification||conflicts.length||unknownLead);
 const material=Boolean(decisionWindows.length&&(forecastSlips||(ev.openRisks||[]).length)||gates.length||t.proposedDue||(t.status==='review'&&t.submittedResultSourceId)||t.needsDecision&&t.nextAction);
 const execution=(db.events||[]).filter(e=>e.taskId===t.id&&visibleAt(e.at,at)&&['pending','failed','blocked'].includes(e.executionStatus));
 const diagnostics=[];
 if(missing)diagnostics.push('data_absent');
 if(monitoring&&needsInquiry&&!latest)diagnostics.push('not_requested');
 if(latest&&!latest.deliveredAt)diagnostics.push('not_delivered');
 if(latest&&latest.deliveredAt&&!closed(latest)&&!['submitted','curator_accepted'].includes(latest.status))diagnostics.push('no_answer');
 if((ev.gaps||[]).some(g=>/summary[_ -]?loss/.test(typeof g==='string'?g:g.code||'')))diagnostics.push('summary_loss');
 if(execution.length)diagnostics.push('decision_not_executed');
 let question=t.needsClarification?t.clarificationQuestion:null;
 if(!question&&conflicts.length)question='Источники противоречат друг другу. Уточните действующую версию факта или прогноза и приведите подтверждающий источник.';
 if(!question&&unknownLead)question='Прогноз позже плана. Сколько календарных дней нужно на подготовку решения? Подтвердите срок подготовки и источник; дата решения пока неизвестна.';
 if(!question&&preparation.length)question='Подтвердите готовность подготовительных материалов: '+preparation.map(p=>p.title||p.id).join('; ')+'. Укажите источник, фактическую готовность и прогноз срока; основной старт не означает готовность документов.';
 if(!question&&(missing||stale))question=missing?'По поручению нет исходного подтверждения. Что фактически готово, каков прогноз срока и где проверяемый источник?':'Обновите устаревший статус: что изменилось в факте и прогнозе срока? Укажите источник и требуемую помощь.';
 return {active,monitoring,preparation,needsInquiry,decisionWindows,missing,stale,last,requests,pending,latest,ev,overdue,missedPrep,material,gates,execution,diagnostics,question,sourceIds:[...new Set([...sources.map(s=>s.id),...(ev.references||[]).map(s=>typeof s==='string'?s:s.sourceId||s.id).filter(Boolean)])]};
}
function markusQueues(db,{actorId,asOf}={}){
 const at=time(db,asOf),p=actor(db,actorId||db.actorId);if(!p)throw Error('Участник не зарегистрирован.');
 const result={asOf:at,actorId:p.id,autonomy:'local-deterministic',notice:'Локальная модельная координация, без ИИ-провайдера и внешней доставки.',needsManagerDecision:[],waitingAnswer:[],selfChecked:[],diagnostics:[]};
 for(const t of db.tasks||[]){if(!controls(db,p,t)||t.createdAt&&!visibleAt(t.createdAt,at))continue;const s=inspect(db,t,at);if(t.archived)continue;
 s.ev=clone(s.ev);s.ev.dependencies=(s.ev.dependencies||[]).map(d=>{const upstream=(db.tasks||[]).find(x=>x.id===d.dependsOnTaskId);return upstream&&controls(db,p,upstream)?d:{restricted:true,note:'Связанный результат вне вашего контура'};});
 const responsible=t.decisionOwnerId||t.controlOwnerId||controller(db,t)?.id;
 const decision=s.active&&(s.material||s.overdue||s.missedPrep.length>0||s.execution.length>0);
 const row={taskId:t.id,title:t.title,ownerId:t.employeeId,decisionOwnerId:responsible,canDecide:p.role==='manager'&&responsible===p.id,plan:clone(s.ev.plan||null),forecast:clone(s.ev.currentForecast||null),forecastDate:s.ev.forecastDate||s.ev.currentForecast?.date||null,facts:clone(s.ev.confirmedFacts||[]),deadline:s.latest?.deadline||t.decisionDeadline||s.decisionWindows[0]?.deadline||t.due||null,deadlines:{task:t.due||null,request:s.latest?.deadline||null,decision:t.decisionDeadline||null,decisionWindows:clone(s.ev.decisionWindows||[]),preparation:s.preparation.map(p=>({phaseId:p.id,due:p.dueAt||p.end||null}))},sourceIds:s.sourceIds,evidence:clone(s.ev),diagnostics:s.diagnostics,requestId:s.latest?.id||null,question:s.question,certainty:'source-backed facts; policy assessment is inference',status:t.paused?'paused':decision?'decision_required':s.latest?(['submitted','curator_accepted'].includes(s.latest.status)?'waiting_review':'waiting_answer'):s.missing?'unconfirmed':'checked',reason:s.execution.length?'Решение не исполнено':s.material?'Требуется решение уполномоченного руководителя':s.overdue?'Пропущен срок ответа; получение и выполнение не подтверждены':s.missedPrep.length?'Пропущен срок подготовки документов':t.paused?'Контроль приостановлен вместе с поручением':s.latest?(s.latest.status==='submitted'?'Документ представлен; ожидается проверка конкретной версии куратором':s.latest.status==='curator_accepted'?'Куратор проверил версию; приёмка остаётся за руководителем':'Ожидается фактический ответ, не подтверждение от Markus'):s.missing?'Нет подтверждающего источника':'Источники сверены; приёмка не выполнялась'};
 if(decision)result.needsManagerDecision.push(row);else if(s.active&&s.latest)result.waitingAnswer.push(row);else result.selfChecked.push(row);
 if(s.diagnostics.length)result.diagnostics.push({taskId:t.id,stages:clone(s.diagnostics),sourceIds:clone(s.sourceIds)});
 }
 return clone(result);
}
function tickMarkus(db,{at,maxActions=20}={}){
 at=time(db,at);if(!Number.isInteger(maxActions)||maxActions<0||maxActions>1000)throw Error('maxActions должен быть целым числом от 0 до 1000.');
 let next=clone(db),used=0;next.markusActionLog ||= [];
 const api=__modules['request-workflow.js'];
 const log=(id,t,action,details={})=>{if(next.markusActionLog.some(x=>x.id===id))return false;next.markusActionLog.push({id,taskId:t.id,at,action,autonomy:'local-deterministic',...details});return true;};
 const apply=(t,r,action,input={})=>{if(used>=maxActions||!api)return false;const who=action==='reply'?actor(next,r?.ownerId):controller(next,t);if(!who)return false;const key='markus:'+t.id+':'+action+':'+(r?.id||at.slice(0,10))+':'+(action==='remind'?at.slice(0,10):action==='reply'?input.sourceId:'once');if(next.markusActionLog.some(x=>x.id===key||x.id===key+':blocked'))return false;
 const attemptContext=JSON.stringify({actorId:who.id,role:who.role,taskVersion:t.version||null,requestId:r?.id||null,requestVersion:r?.version||null,sourceId:input.sourceId||null,openRequests:(next.requests||[]).filter(q=>q.taskId===t.id&&!closed(q)).map(q=>[q.id,q.version,q.status])});
 if(next.markusActionLog.some(x=>x.taskId===t.id&&x.action==='blocked'&&x.attemptedAction===action&&x.attemptContext===attemptContext))return false;
 try{next=api.applyRequestAction(next,t.id,who,{action,...(r?{requestId:r.id,expectedVersion:r.version}:{}),...input},at,key);log(key,t,action,{requestId:r?.id||key,actorId:who.id,localOnly:true,sourceIds:input.sourceId?[input.sourceId]:[]});used++;return true;}catch(error){log(key+':blocked',t,'blocked',{attemptedAction:action,attemptContext,target:r?.id||t.id,reason:error.message,status:'not_executed'});used++;return false;}};
 // Delivery is an in-flight operation. Business waiting itself never freezes model time.
 for(const t of next.tasks||[]){if(used>=maxActions)break;const s=inspect(next,t,at);if(!s.active)continue;for(const r of s.pending){if(used>=maxActions)break;if(!r.deliveredAt)apply(t,r,'deliver',{localSynthetic:true});}}
 for(const initial of next.tasks||[]){if(used>=maxActions)break;const t=next.tasks.find(x=>x.id===initial.id),s=inspect(next,t,at);if(!s.active)continue;
 const r=s.latest;
 if(r){
 const reply=actualSources(next,t,at).find(x=>x.employeeId===r.ownerId&&ms(x.receivedAt||x.occurredAt)>ms(r.createdAt)&&ms(x.occurredAt||x.receivedAt)>=ms(r.createdAt));
 if((r.kind==='status'||r.intent==='status')&&reply&&api){apply(t,r,'reply',{sourceId:reply.id,localSynthetic:true});continue;}
 const lastReminder=(r.reminders||[]).at(-1)?.at||r.deliveredAt||r.createdAt;
 if(!['submitted','curator_accepted'].includes(r.status)&&r.deliveredAt&&ms(r.nextControlAt)<=ms(at)&&ms(at)-ms(lastReminder)>=3*DAY)apply(t,r,'remind',{nextControlAt:addDays(at,3),localSynthetic:true});
 }else if(s.monitoring&&s.needsInquiry){
 const previous=s.requests.at(-1);if(previous&&ms(at)-ms(previous.updatedAt||previous.createdAt)<7*DAY)continue;
 if(apply(t,null,'create',{kind:'status',intent:'status',ownerId:t.employeeId,text:s.question,deadline:addDays(at,3),nextControlAt:addDays(at,1),localSynthetic:true,criteria:[{id:'status_source',label:'Факт, прогноз срока и проверяемый источник раздельно'}]})){
 const created=(next.requests||[]).filter(x=>x.taskId===t.id).at(-1);if(created&&used<maxActions)apply(t,created,'deliver',{localSynthetic:true});
 }
 }else if(s.last){const id='markus:'+t.id+':checked:'+s.last.id;if(log(id,t,'evidence_checked',{sourceIds:[s.last.id],fact:'Источник доступен',inference:'Рутинная сверка; результат не принят'}))used++;}
 }
 return next;
}
return {tickMarkus,markusQueues};
})();
__modules["simulation.js"]=(()=>{
const {createRun,advanceDay,decideGate,publicSnapshot}=(()=>{// Pure synthetic simulation. No provider calls, production writes or hidden reads by role packets.
const copy=x=>JSON.parse(JSON.stringify(x));
const iso=day=>day+'T09:00:00+03:00';
const nextDate=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
function scenarioUpdates(task,raw,{decision=false}={}){
 const updates=copy(raw||{});
 // Scenario observations cannot create, replace or invalidate human-owned evidence.
 for(const field of ['submittedResultSourceId','submittedResultAt','acceptedSourceId','acceptedAt','phases','version'])delete updates[field];
 if(!decision&&['done','review'].includes(updates.status)){delete updates.status;updates.completionClaimed=true;}
 if(!decision&&['done','review'].includes(task.status)){delete updates.status;delete updates.needsDecision;}
 return updates;
}

function createRun(seed){
 const db=copy(seed);db.simulation={...db.simulation,start:'2026-07-01',end:'2026-12-31',day:'2026-07-01',dayIndex:1,dailyLog:[],decisions:[],gates:[],appliedEvents:[],rejectedEvents:[]};
 db.asOf=iso(db.simulation.day);db.actorId='director';enterDay(db);return db;
}
function enterDay(db){
 const sim=db.simulation;db.asOf=iso(sim.day);
 const record={day:sim.day,index:sim.dayIndex,events:[],decisions:[],status:'recorded'};sim.dailyLog.push(record);
 for(const event of sim.eventPlan||[]){
  if(event.date!==sim.day||sim.appliedEvents.includes(event.id))continue;
  const conditions=event.whenAll|| (event.when?[event.when]:[]);if(conditions.length){if(!conditions.every(c=>sim.decisions.some(d=>d.gateId===c.gateId&&d.optionId===c.optionId))){sim.rejectedEvents.push({id:event.id,date:sim.day,reason:'condition-not-met'});continue;}}
  const task=db.tasks.find(t=>t.id===event.taskId);if(!task)throw Error('Сценарий ссылается на отсутствующее поручение '+event.taskId);
  const updates=scenarioUpdates(task,event.updates);Object.assign(task,updates);task.version=String(Number(task.version||0)+1);
  const at=iso(sim.day);// Scenario claims never substitute for submitted artifacts or human acceptance.
  const src={id:'sim-'+event.id,taskId:task.id,employeeId:event.authorId||task.employeeId,authorName:db.employees.find(p=>p.id===(event.authorId||task.employeeId))?.name||'Участник',kind:'simulation_report',text:event.text,sourceLabel:event.sourceLabel,eventId:event.id,simulation:true,occurredAt:at,receivedAt:at};
  db.sources.push(src);task.reportedAt=at;task.lastReply=at;task.lastMessageSourceId=src.id;task.lastMessageAuthorId=src.employeeId;if(event.text)task.summary=event.text.slice(0,400);
  db.events.unshift({key:src.id,taskId:task.id,actorId:src.employeeId,kind:event.kind==='completion'?'review':'progress',sourceId:src.id,at,text:event.text});
  if(event.gate){const {consequencesByOption,...gate}=copy(event.gate);sim.gates.push({...gate,taskId:task.id,divisionId:event.divisionId||task.divisionId,openedAt:sim.day,status:'open'});task.needsDecision=true;task.decisionDeadline=gate.deadline;task.nextAction=gate.prompt;}
  sim.appliedEvents.push(event.id);record.events.push(event.id);
 }
}
function pendingGates(db,actorId){return copy(db.simulation.gates.filter(g=>g.status==='open'&&(!actorId||g.ownerId===actorId)));}
function advanceDay(db,{deferReason}={}){
 const next=copy(db),sim=next.simulation;if(sim.day>=sim.end)throw Error('Полугодие завершено: 184 дня записаны.');
 const day=nextDate(sim.day),due=sim.gates.filter(g=>g.status==='open'&&g.deadline<day);
 if(due.length&&!deferReason?.trim())throw Error('Истекает срок решения: '+due.map(g=>g.id).join(', ')+'. Выберите вариант или явно пропустите срок с причиной.');
 for(const gate of due){const event=sim.eventPlan.find(e=>e.gate?.id===gate.id),optionId=event?.gate?.timeoutOptionId||'timeout',effect=event?.gate?.consequencesByOption?.[optionId];gate.status='expired';gate.optionId=optionId;gate.decidedAt=sim.day;sim.decisions.push({gateId:gate.id,optionId,reason:deferReason.trim(),actorId:'director',day:sim.day,at:iso(sim.day),taskId:gate.taskId,missed:true});const t=next.tasks.find(t=>t.id===gate.taskId);Object.assign(t,scenarioUpdates(t,effect?.updates));t.needsDecision=true;t.summary='Срок управленческого решения пропущен. '+(effect?.text||'Последствия требуют проверки.');t.version=String(Number(t.version||0)+1);for(const e of effect?.effects||[]){const target=next.tasks.find(t=>t.id===e.taskId);Object.assign(target,scenarioUpdates(target,e.updates));}sim.dailyLog.at(-1).decisions.push(gate.id);}

 sim.day=day;sim.dayIndex++;enterDay(next);return next;
}
function decideGate(db,{gateId,optionId,reason,actorId='director'}){
 const next=copy(db),sim=next.simulation,gate=sim.gates.find(g=>g.id===gateId);
 if(!gate||gate.status!=='open')throw Error('Решение недоступно или уже принято.');
 if(gate.ownerId!==actorId)throw Error('Решение относится к другому уровню контроля.');
 if(!gate.options.some(o=>o.id===optionId))throw Error('Выберите существующий вариант.');
 if(!reason?.trim())throw Error('Запишите основание решения и проверенные сведения.');
 if(reason.length>4000)throw Error('Основание слишком длинное.');
 const event=sim.eventPlan.find(e=>e.gate?.id===gateId),consequence=event?.gate?.consequencesByOption?.[optionId];
 if(consequence?.updates?.status==='done'){const task=next.tasks.find(t=>t.id===gate.taskId);if(task.archived||task.status!=='review'||task.needsClarification)throw Error('Для приёмки нужен актуальный открытый результат на проверке.');if(next.tasks.some(t=>t.parentId===task.id&&!t.archived&&t.status!=='done')||(task.dependencyIds||[]).some(id=>!next.tasks.some(t=>t.id===id&&t.status==='done'&&!t.archived)))throw Error('Приёмка невозможна: есть непринятые обязательные дочерние или связанные результаты.');__modules['stage-workflow.js'].requireAcceptedStages(task);if(task.controlOwnerId!==actorId)throw Error('Итог принимает назначенный руководитель.');if(task.paused)throw Error('Сначала снимите паузу.');if(!task.submittedResultSourceId||!next.sources.some(s=>s.id===task.submittedResultSourceId&&s.kind==='final_result'&&s.employeeId===task.employeeId&&s.text?.trim()&&Date.parse(s.occurredAt)<=Date.parse(iso(sim.day))&&Date.parse(s.receivedAt)<=Date.parse(iso(sim.day))))throw Error('Приёмка невозможна без представленного результата.');
 const request=(next.requests||[]).find(r=>r.taskId===task.id&&r.kind==='result'&&!['accepted','superseded'].includes(r.status));
 if(request){const manager=next.employees.find(p=>p.id===actorId);const accepted=__modules['request-workflow.js'].applyRequestAction(next,task.id,manager,{action:'manager_accept',requestId:request.id,expectedVersion:request.version,artifactId:request.artifactId},iso(sim.day),'gate-accept:'+gateId+':'+request.artifactId);accepted.simulation=sim;Object.assign(next,accepted);}
 }
 if(optionId==='return'&&consequence?.updates?.status==='active'){
 const request=(next.requests||[]).find(r=>r.taskId===gate.taskId&&r.kind==='result'&&['submitted','curator_accepted'].includes(r.status));
 if(request){const returned=__modules['request-workflow.js'].applyRequestAction(next,gate.taskId,next.employees.find(p=>p.id===actorId),{action:'return',requestId:request.id,expectedVersion:request.version,artifactId:request.artifactId,reason:reason.trim()},iso(sim.day),'gate-return:'+gateId+':'+request.artifactId);returned.simulation=sim;Object.assign(next,returned);}
 }
 const record={gateId,optionId,reason:reason.trim(),actorId,at:iso(sim.day),day:sim.day,taskId:gate.taskId};sim.decisions.push(record);gate.status='decided';gate.optionId=optionId;gate.decidedAt=sim.day;
 const task=next.tasks.find(t=>t.id===gate.taskId);Object.assign(task,scenarioUpdates(task,consequence?.updates,{decision:true}));if(task.status==='done'){task.acceptedSourceId=task.submittedResultSourceId;task.acceptedAt=iso(sim.day);}
 task.needsDecision=sim.gates.some(g=>g.taskId===task.id&&g.status==='open');task.version=String(Number(task.version||0)+1);
 for(const effect of consequence?.effects||[]){const target=next.tasks.find(t=>t.id===effect.taskId);if(!target)throw Error('Некорректное последствие сценария');Object.assign(target,scenarioUpdates(target,effect.updates));target.version=String(Number(target.version||0)+1);}
 const source={id:'decision-'+gateId,taskId:task.id,employeeId:actorId,authorName:next.employees.find(p=>p.id===actorId)?.name,kind:'manager_message',text:'Решение: '+gate.options.find(o=>o.id===optionId).label+'. Основание: '+reason.trim(),occurredAt:iso(sim.day),receivedAt:iso(sim.day)};next.sources.push(source);next.events.unshift({key:source.id,taskId:task.id,actorId,kind:'decision',sourceId:source.id,at:iso(sim.day),text:source.text});
 sim.dailyLog.at(-1).decisions.push(gateId);return next;
}
function publicSnapshot(db,{divisionId=null,actorId='director',includeHistory=true}={}){
 const person=db.employees.find(p=>p.id===actorId&&p.enabled!==false);if(!person)throw Error('Участник не зарегистрирован.');
 const readable=t=>person.id==='director'||t.employeeId===person.id||t.controlOwnerId===person.id||t.coexecutorIds?.includes(person.id)||t.phases?.some(p=>!p.archived&&p.assigneeId===person.id)||(person.role==='manager'&&(person.departmentId?person.departmentId===t.departmentId:person.divisionId&&person.divisionId===t.divisionId));
 const sim=db.simulation,tasks=db.tasks.filter(t=>readable(t)&&(!divisionId||t.divisionId===divisionId)),ids=new Set(tasks.map(t=>t.id));
 const cleanTask=t=>{const {unreadActorIds,...rest}=t;return copy(rest);};
 return {requests:tasks.flatMap(t=>__modules['request-workflow.js'].requestState(db,t.id,db.asOf).requests),artifacts:copy((db.artifacts||[]).filter(a=>ids.has(a.taskId)&&Date.parse(a.createdAt)<=Date.parse(db.asOf))),projects:copy(db.projects||[]),routineSeries:copy((db.routineSeries||[]).filter(s=>s.controlOwnerId===actorId||s.ownerId===actorId)),organization:copy(db.org),asOf:db.asOf,day:sim.day,dayIndex:sim.dayIndex,totalDays:184,actorId,tasks:tasks.map(cleanTask),employees:copy(db.employees.filter(p=>!divisionId||p.divisionId===divisionId||p.id==='director')),sources:copy(db.sources.filter(s=>ids.has(s.taskId)&&Date.parse(s.occurredAt)<=Date.parse(db.asOf)&&(!s.receivedAt||Date.parse(s.receivedAt)<=Date.parse(db.asOf)))),events:copy(db.events.filter(e=>ids.has(e.taskId)&&Date.parse(e.at)<=Date.parse(db.asOf))),gates:copy(sim.gates.filter(g=>ids.has(g.taskId))),decisions:copy(sim.decisions.filter(d=>ids.has(d.taskId)&&Date.parse(d.at)<=Date.parse(db.asOf))),dailyLog:includeHistory?copy(sim.dailyLog):undefined,notice:'Синтетический сценарий. Сведения открыты только до текущего модельного дня. Плановые сроки не означают выполненную работу.'};
}
;return {createRun,advanceDay,decideGate,publicSnapshot};})();
const {createDepartmentCase}=(()=>{/** Synthetic, offline H2-2026 development-department case. No real people or company data. */
function createDecemberSnapshot() {
 const asOf='2026-12-18T06:00:00.000Z';
 const divisions=[
 {id:'build',name:'Управление строительства',departments:['Подготовка и проектирование','Капитальное строительство','Инженерные сети','Приёмка и эксплуатация']},
 {id:'commerce',name:'Коммерческое управление',departments:['Развитие и инвестиции','Аренда и продажи','Договорная работа','Закупки и поставки']},
 {id:'pmo',name:'Проектный офис',departments:['Планирование портфеля','Бюджет и экономика','Контроль рисков и качества','Отчётность и аналитика']}
 ];
 const surnames=['Лазарев','Тихонов','Орлов','Серов','Миронов','Белов','Зорин','Крылов','Соколов','Титов','Громов','Волков','Морозов','Егоров','Сафонов','Климов','Власов','Мартынов','Лукин','Фомин','Быков','Макаров'];
 const names=['Алексей','Дмитрий','Павел','Илья','Максим']; let index=0;
 const employees=[],departments=[];
 function person(id,position,reportsTo,divisionId=null,departmentId=null,role='manager'){const i=index++;const p={id,name:`${names[Math.floor(i/surnames.length)%names.length]} ${surnames[i%surnames.length]}`,position,reportsTo,divisionId,departmentId,role,enabled:true};employees.push(p);return p;}
 person('director','Директор департамента проектов развития',null);
 divisions.forEach(v=>{person(v.id+'-head','Начальник управления','director',v.id);for(let j=1;j<=3;j++)person(v.id+'-deputy-'+j,'Заместитель начальника управления',v.id+'-head',v.id);v.departments=v.departments.map((name,i)=>{const d={id:v.id+'-d'+(i+1),name,divisionId:v.id,supervisorId:v.id+'-deputy-'+(i%3+1)};departments.push(d);person(d.id+'-head','Начальник отдела',d.supervisorId,v.id,d.id);person(d.id+'-deputy','Заместитель начальника отдела',d.id+'-head',v.id,d.id);for(let j=1;j<=6;j++)person(d.id+'-s'+j,'Специалист',d.id+'-head',v.id,d.id,'employee');return d.id;});});
 const tasks=[],sources=[],events=[],projects=[];let seq=0;
 const personBy=id=>employees.find(p=>p.id===id);
 const at=(date,time='09:00')=>date+'T'+time+':00+03:00';
 function add(raw){const t={id:'Д-'+String(++seq).padStart(3,'0'),title:'',employeeId:'pmo-d1-head',controlOwnerId:'pmo-deputy-1',status:'active',project:'',due:'2026-12-28',dueTime:'18:00',start:'2026-07-01',summary:'',description:'',version:'1',priority:'normal',supervision:true,contact:'answered',needsDecision:false,...raw};const p=personBy(t.employeeId);t.divisionId||=p.divisionId;t.departmentId||=p.departmentId;t.decisionOwnerId||=t.controlOwnerId;t.coexecutorIds||=[];t.phases||=[];tasks.push(t);return t;}
 function source(t,text,when='2026-12-16T09:00:00+03:00',kind='employee_report',who=t.employeeId){const s={id:'src-'+t.id+'-'+(sources.filter(x=>x.taskId===t.id).length+1),taskId:t.id,employeeId:who,authorName:personBy(who)?.name||who,kind,text,occurredAt:when,receivedAt:when};sources.push(s);t.latestSourceId=s.id;t.reportedAt=when;t.lastReply=when;return s;}
 function stage(t,id,title,assignee,start,end,accepted=false,dependsOn=null){const p={id,title,assigneeId:assignee,start,end,done:accepted,dependsOn,reviewStatus:accepted?'accepted':'pending',submissions:[],reviews:[]};if(accepted){const when=at(end<='2026-12-17'?end:'2026-12-16');const s=source(t,`Результат этапа «${title}»: комплект проверен, замечания закрыты.`,when,'stage_result',assignee);s.phaseId=id;s.resultVersion=1;const r=source(t,`Куратор принял этап «${title}».`,when,'stage_review');r.phaseId=id;r.resultSourceId=s.id;p.submissions=[{id:s.id,version:1,text:s.text,employeeId:assignee,at:when}];p.reviews=[{id:r.id,resultId:s.id,action:'accept',reason:'',actorId:t.employeeId,at:when}];p.submittedResultId=s.id;p.acceptedResultId=s.id;}t.phases.push(p);return p;}
 function finish(t,when,text){const s=source(t,text,when,'final_result');t.submittedResultSourceId=s.id;t.submittedResultAt=when;if(t.status==='done'){t.acceptedSourceId=s.id;t.acceptedAt=when;events.push({key:'accepted-'+t.id,taskId:t.id,sourceId:s.id,kind:'decision',action:'accept',actorId:t.controlOwnerId,at:when,text:'Результат принят назначенным руководителем. Объём и источник сохранены.'});}else{t.needsDecision=true;t.nextAction='Проверить представленный результат';}}
 const configs=[
 ['Кампус «Север»: ввод лабораторного корпуса','build','build-d2','2026-12-29','blocked','Строительная готовность 96%. Нет постоянного электроснабжения и итогового протокола испытаний.'],
 ['Технопарк: сдача первой очереди арендаторам','commerce','commerce-d2','2026-12-30','active','Договоры подписаны на 8 из 10 помещений. Передача зависит от приёмки инженерных сетей.'],
 ['Подключение постоянного электроснабжения','build','build-d3','2026-12-28','blocked','Поставка автоматики задержана. Испытания требуют пять рабочих дней после монтажа.'],
 ['Цифровой паспорт инвестиционного портфеля','pmo','pmo-d4','2026-12-23','review','Витрина содержит 15 паспортов. Сверка бюджетов завершена, доступы проверены.'],
 ['Южный склад: запуск логистической площадки','build','build-d4','2026-12-31','blocked','Приёмка перенесена из-за замечаний пожарной автоматики; требуется повторное испытание.'],
 ['Якорный арендатор: договор и обеспечительный платёж','commerce','commerce-d3','2026-12-22','blocked','Арендатор готов подписать договор после подтверждения даты готовности помещений.'],
 ['Реконструкция производственного корпуса','build','build-d1','2026-12-26','active','Работы идут по утверждённому графику. Последний акт требует проверки объёмов.'],
 ['Закупка оборудования центра прототипирования','commerce','commerce-d4','2026-12-24','blocked','Поставщик предлагает замену оборудования. Совместимость не подтверждена техническим заключением.'],
 ['Бюджет развития на 2027 год','pmo','pmo-d2','2026-12-28','active','Базовый сценарий собран. Нужно выбрать перенос двух проектов без обеспеченного финансирования.'],
 ['Единый стандарт месячной отчётности','pmo','pmo-d4','2026-09-30','done','Стандарт внедрён в трёх управлениях, контрольная сверка сентября пройдена.'],
 ['Коммерческая модель парковочного комплекса','commerce','commerce-d1','2026-11-27','done','Инвестиционный расчёт и чувствительность к загрузке приняты.'],
 ['Обследование объектов второй очереди','build','build-d1','2026-10-30','done','Заключения по пяти объектам приняты, риски включены в портфель.'],
 ['Резервный пул подрядчиков на 2027 год','commerce','commerce-d4','2026-12-29','active','Три участника прошли проверку, по четвёртому ждём подтверждение опыта.'],
 ['Реестр рисков и контроль страхового покрытия','pmo','pmo-d3','2026-12-25','active','Открыто шесть существенных рисков; два требуют решения директора до 19 декабря.'],
 ['Концепция общественно-делового центра','pmo','pmo-d1','2026-12-30','planned','Работа приостановлена до подтверждения земельных ограничений. Расходы на проектирование не открыты.']
 ];
 const chains=[];
 configs.forEach((c,i)=>{const [name,divisionId,dept,due,status,summary]=c,projectId='PR-'+String(i+1).padStart(2,'0'),cross=[0,1,2,4,5,7,8,13].includes(i);projects.push({id:projectId,name,divisionId,ownerId:divisionId+'-deputy-'+(i%3+1),due,baselineDue:due,start:'2026-07-01',budgetMillion:[185,72,28,4,46,0,63,31,0,2,1.5,6,0,0.8,9][i],expectedResult:summary});const root=add({title:name,project:name,projectId,divisionId,departmentId:dept,employeeId:divisionId+'-deputy-'+(i%3+1),controlOwnerId:cross?'director':divisionId+'-head',status,due,summary,description:`Проект ${projectId}. Горизонт: второе полугодие 2026 года. ${summary} Итог принимается по проверенным документам и фактической готовности, не по проценту в сводке.`,priority:cross?'high':'normal',needsDecision:status==='blocked'||status==='review',nextAction:status==='blocked'?'Уточнить ограничение и принять решение по указанному сроку':''});if(status==='blocked')root.blocker=summary;if(i===14){root.paused=true;root.pauseReason='До получения ограничений участка не открывать расходы';root.pausedAt=at('2026-11-30');}
 const childTitles=['Подтвердить исходные требования','Сверить договоры и ресурсы','Выполнить основной пакет работ','Проверить готовность и закрыть замечания'];const childDepartments=[dept,'commerce-d3',dept,'pmo-d3'];const children=[];for(let j=0;j<4;j++){const d=childDepartments[j],childStatus=status==='done'||j<2?'done':status==='review'?'done':j===2?(status==='blocked'?'blocked':'active'):'planned';const child=add({title:childTitles[j]+' · '+name,project:name,projectId,parentId:root.id,employeeId:d+'-head',controlOwnerId:personBy(d+'-head').reportsTo,status:childStatus,due:childStatus==='done'?(status==='done'?due:'2026-12-14'):due,start:status==='done'?'2026-07-01':'2026-11-02',summary:childStatus==='done'?'Пакет принят ответственным руководителем.':j===2?summary:'Ожидается подтверждённый результат основного пакета.',description:'Смежное поручение проекта. Изменение срока не означает приёмку результата.',coexecutorIds:[dept+'-deputy'],dependencyIds:j?[children[j-1].id]:[]});if(childStatus==='blocked')child.blocker=summary;stage(child,'prepare','Подготовить материалы',d+'-s'+(i%6+1),'2026-07-01',childStatus==='done'?child.due:'2026-12-21',childStatus==='done');stage(child,'verify','Проверить и передать комплект',d+'-deputy',childStatus==='done'?child.due:'2026-12-21',child.due,childStatus==='done','prepare');if(childStatus==='done')finish(child,at(child.due),'Материалы представлены, этапы приняты куратором; результат принят контролирующим руководителем.');else source(child,child.summary);children.push(child);}
 root.dependencyIds=children.map(t=>t.id);root.coexecutorIds=[dept+'-head','pmo-d1-head','commerce-d3-head'];source(root,summary,status==='done'?at(due):'2026-12-17T12:00:00+03:00');if(status==='done'||status==='review')finish(root,status==='done'?at(due):'2026-12-17T15:00:00+03:00',summary+' Подтверждающие результаты смежных поручений приняты.');chains.push({root,children});});
 // Explicit project-to-project dependencies, in addition to ordinary child-work chains.
 chains[0].root.dependencyIds.push(chains[2].root.id);chains[1].root.dependencyIds.push(chains[0].root.id);chains[5].root.dependencyIds.push(chains[1].children[1].id);chains[8].root.dependencyIds.push(chains[13].root.id);chains[7].root.dependencyIds.push(chains[6].children[1].id);
 const decisionData=[
 [0,'2026-12-18T16:00:00+03:00','Не обещать ввод корпуса без протокола электроснабжения; решение влияет на договор аренды и приёмку.', ['Разделить строительную готовность и юридический ввод, утвердить реалистичный график','Принять корпус по проценту готовности']],
 [2,'2026-12-18T12:00:00+03:00','До полудня можно зарезервировать проверенный комплект автоматики; иначе ближайшая поставка 28 декабря.', ['Резервировать совместимый комплект за 1,2 млн ₽ после технического подтверждения','Ждать основной поставки 28 декабря']],
 [4,'2026-12-19T15:00:00+03:00','Без повторного испытания пожарной автоматики эксплуатация не допускается; новый подрядчик готов к работам 21 декабря.', ['Выделить ресурс на исправление и независимое испытание','Подписать итоговую приёмку с незакрытыми замечаниями']],
 [5,'2026-12-18T17:00:00+03:00','Отправка безусловной гарантии передачи 30 декабря создаст штраф 0,4 млн ₽ за день просрочки.', ['Согласовать условный график и поэтапную передачу с арендатором','Гарантировать передачу всего объекта 30 декабря']],
 [7,'2026-12-19T12:00:00+03:00','Замена дешевле на 3 млн ₽, но пока нет подтверждения совместимости; подписание акта не заменяет техническую проверку.', ['Поручить техническую экспертизу замены и сохранить исходные требования','Согласовать замену только ради экономии']],
 [8,'2026-12-21T12:00:00+03:00','Резерв портфеля 2 млн ₽. Дополнительные запросы превышают резерв; финансирование не возникает от переноса срока.', ['Сопоставить приоритеты и вынести перенос необеспеченных работ на решение','Подтвердить все дополнительные расходы без источника']],
 [13,'2026-12-18T15:00:00+03:00','Сводка показывает пять зелёных объектов, но открытые допуски и зависимости в первичных карточках не закрыты.', ['Пересчитать прогноз по подтверждённым ограничениям и эскалировать разрывы','Принять зелёную сводку как подтверждение готовности']]
 ];
 decisionData.forEach(([i,deadline,consequence,options])=>Object.assign(chains[i].root,{needsDecision:true,decisionOwnerId:'director',controlOwnerId:'director',decisionDeadline:deadline,consequence,decisionOptions:options,nextAction:'Решение директора до '+deadline.slice(0,16).replace('T',' '),description:chains[i].root.description+'\n\nСрок решения: '+deadline+'\nПоследствия: '+consequence+'\nВарианты для обсуждения: '+options.join('; ')}));
 Object.assign(chains[2].root,{minimumLeadDays:5,availableDeliveryDate:'2026-12-28',expediteDeliveryDate:'2026-12-21',expediteCostMillion:1.2});
 Object.assign(chains[4].root,{safetyGate:'Повторное независимое испытание пожарной автоматики',safetyGatePassed:false});
 Object.assign(chains[5].root,{commitmentRiskMillionPerDay:0.4});
 // Half-year reports: 12 departments → 3 divisions → department director, six separate reporting periods.
 for(let month=7;month<=12;month++){const mm=String(month).padStart(2,'0'),period='2026-'+mm,closed=month<12,end=new Date(Date.UTC(2026,month,0)).toISOString().slice(0,10),divisionReports=[];for(const v of divisions){const deptReports=[];for(const did of v.departments){const dn=departments.find(d=>d.id===did).name;const t=add({title:`Отчёт за ${mm}.2026 · ${dn}`,project:'Ежемесячная отчётность',projectId:'REPORTS',reportPeriod:period,taskType:'monthly_report',employeeId:did+'-head',controlOwnerId:departments.find(d=>d.id===did).supervisorId,divisionId:v.id,departmentId:did,status:closed?'done':'active',start:period+'-01',due:closed?end:'2026-12-25',summary:closed?'Месячный отчёт проверен, отклонения объяснены.':'Собираются фактические результаты декабря, прогноз отделён от принятого результата.',description:`Отчётный период ${period}: план, факт, причины отклонений, открытые риски и решения. Декабрьский прогноз не является закрытием работ.`});stage(t,'report','Сверить данные периода',did+'-s'+(month%6+1),period+'-01',closed?end:'2026-12-25',closed);if(closed)finish(t,at(end),'Показатели месяца сверены с источниками, отклонения отражены и приняты.');else source(t,'Включены данные по 17 декабря. Непринятые результаты остаются прогнозом.','2026-12-17T13:00:00+03:00');deptReports.push(t);}
 const div=add({title:`Свод управления за ${mm}.2026 · ${v.name}`,project:'Ежемесячная отчётность',projectId:'REPORTS',reportPeriod:period,taskType:'monthly_report',employeeId:v.id+'-deputy-3',controlOwnerId:v.id+'-head',divisionId:v.id,status:closed?'done':'planned',start:period+'-01',due:closed?end:'2026-12-28',summary:closed?'Свод четырёх отделов проверен и принят.':'Свод формируется после четырёх отчётов отделов.',dependencyIds:deptReports.map(t=>t.id),coexecutorIds:v.departments.map(d=>d+'-head')});if(closed)finish(div,at(end,'12:00'),'Свод управления принят. Источники: четыре проверенных отчёта отделов.');divisionReports.push(div);}
 const directorReport=add({title:`Итоги департамента за ${mm}.2026`,project:'Ежемесячная отчётность',projectId:'REPORTS',reportPeriod:period,taskType:'monthly_report',employeeId:'pmo-head',controlOwnerId:'director',status:closed?'done':'planned',start:period+'-01',due:closed?end:'2026-12-30',summary:closed?'Итоги трёх управлений приняты директором.':'Ожидаются три сверенных свода. Отдельно показать неподтверждённые обещания к концу года.',dependencyIds:divisionReports.map(t=>t.id),coexecutorIds:['build-head','commerce-head'],divisionId:'pmo'});if(closed)finish(directorReport,at(end,'16:00'),'Консолидированный месячный отчёт принят на основании трёх сводов.');}
 const operations=[
 ['Согласовать перенос окна шумных работ','build-d2','2026-12-21','active','Работы не влияют на критический путь; вопрос решается на уровне отдела.'],
 ['Обновить перечень допусков подрядчика','build-d4','2026-12-22','review','Документы сверены, требуется формальная приёмка начальника отдела.'],
 ['Сверить реестр обеспечительных платежей','commerce-d2','2026-12-21','active','Один платёж уточняется, кассового разрыва нет.'],
 ['Подготовить старт тендера 2027 года','commerce-d4','2026-12-29','planned','Старт 22 декабря; предварительные требования доступны для работы.'],
 ['Проверить комплект протокола портфельного комитета','pmo-d1','2026-12-23','review','Повестка и приложения сверены; замечания устранены.'],
 ['Обновить словарь показателей отчётности','pmo-d4','2026-12-24','active','Техническое обновление не требует решения директора.']
 ];
 operations.forEach(([title,dept,due,status,summary],i)=>{const t=add({title,project:'Текущая работа подразделений',projectId:'OPS',employeeId:dept+'-deputy',controlOwnerId:dept+'-head',status,due,summary,description:summary,coexecutorIds:[dept+'-s'+(i+1)]});if(status==='planned')t.startAt='2026-12-22T06:00:00.000Z';if(status==='review')finish(t,'2026-12-17T14:00:00+03:00',summary);else source(t,summary);});
 const preferences={pins:[],seen:{},seenByActor:{},seenNotificationsByActor:{}};
 for(const p of employees){preferences.seenByActor[p.id]=Object.fromEntries(tasks.map(t=>[t.id,t.version]));}
 // Only a bounded set of fresh signals starts unread; unresolved decisions remain in attention after acknowledgement.
 for(const [i,offset] of [[2,0],[5,1],[13,2],[3,3]]){const t=chains[i].root;const when='2026-12-18T0'+(8-offset)+':10:00+03:00';source(t,t.summary+' '+(t.consequence||''),when);delete preferences.seenByActor.director[t.id];}
 return {caseId:'development-h2-2026',asOf,scenario:{name:'Департамент проектов развития · «Вектор»',fictional:true,asOf,horizonStart:'2026-07-01',horizonEnd:'2026-12-31',description:'Синтетическая девелоперская организация. 109 участников. Замороженный срез 18 декабря 2026, 09:00 МСК; события и факты после этой точки не моделируются автоматически.',budgetReserveMillion:2},org:{name:'Департамент проектов развития',directorId:'director',divisions,departments},employees,tasks,sources,events,projects,drafts:[],reports:[],settings:{timezone:'Europe/Moscow',automaticCheckins:false},preferences,actorId:'director'};
}

/** Day-gated replay; eventPlan is internal simulation data, not a current-facts API. */
function createDepartmentCase(){
 const december=createDecemberSnapshot(), db=JSON.parse(JSON.stringify(december));
 const eventPlan=[],root=id=>december.tasks.find(t=>t.projectId===id&&!t.parentId),byId=id=>december.tasks.find(t=>t.id===id);
 const addEvent=(date,taskId,text,updates={},extra={})=>{const t=byId(taskId);const e={id:'sim-'+String(eventPlan.length+1).padStart(4,'0'),date,divisionId:t?.divisionId||'pmo',taskId,kind:'progress',text,sourceLabel:(t?.employeeId?december.employees.find(p=>p.id===t.employeeId)?.position:'Проектный офис')+' · модельный журнал',updates,...extra};eventPlan.push(e);return e;};
 const gate=(date,taskId,id,prompt,deadline,options,outcomes,extra={})=>addEvent(date,taskId,prompt,{needsDecision:true,nextAction:prompt},{kind:'decision_required',gate:{id,prompt,ownerId:'director',deadline:deadline.slice(0,10),decisionTime:deadline,options:options.map(([id,label,description])=>({id,label,description})),consequencesByOption:outcomes},...extra});
 const outcome=(text,updates={},effects=[])=>({text,updates,effects});
 // Every scheduled report has its own evidence arrival; approval dates are not visible beforehand.
 for(const t of december.tasks){
   if(t.taskType==='monthly_report'){
     const start=t.reportPeriod+'-01',end=new Date(Date.UTC(2026,Number(t.reportPeriod.slice(5)),0)).toISOString().slice(0,10);
     addEvent(start,t.id,'Открыт сбор данных отчётного периода '+t.reportPeriod+'.',{status:'active',summary:'Сбор фактических данных месяца начат; будущий результат не подтверждён.'});
     if(t.controlOwnerId==='director'){
       addEvent(end,t.id,'Проектный офис представил свод трёх управлений. Непринятые результаты отделены от прогноза.',{status:'review',summary:'Месячный свод представлен директору; требуется его решение.',needsDecision:true},{materializeResult:true});
       gate(end,t.id,'report-'+t.reportPeriod,'Рассмотреть месячный свод '+t.reportPeriod,end+'T18:00:00+03:00',[
         ['accept','Принять свод с зафиксированными отклонениями','Принять документ об отчётном периоде; это не закрывает открытые проекты.'],
         ['return','Вернуть свод на уточнение','Зафиксировать неполноту и поручить повторную сверку.']
       ],{accept:outcome('Свод периода принят директором. Прогнозы проектов не превращены в фактическое выполнение.',{status:'done',needsDecision:false}),return:outcome('Свод возвращён на уточнение, задачи и обязательства не закрыты.',{status:'active',needsDecision:false})});
     }else{
       addEvent(end,t.id,'Отчёт за '+t.reportPeriod+' проверен назначенным руководителем. Факты и прогноз отделены.',{status:'done',summary:'Отчёт периода проверен; открытые риски сохранены в карточках проектов.',needsDecision:false},{materializeResult:true,materializeStages:true});
     }
     continue;
   }
   const project=december.projects.find(p=>p.id===t.projectId);if(!project)continue;
   addEvent(t.start||'2026-07-01',t.id,'Поручение включено в утверждённый план второго полугодия.',{status:'active',summary:'План и ответственные определены; выполнение предстоит подтвердить.'});
   if(t.parentId&&t.status==='done'){
     const actual=t.due;addEvent(actual,t.id,'Пакет работ завершён, материалы проверены куратором и приняты назначенным руководителем.',{status:'done',summary:'Материалы проверены и приняты по результатам этапов.',needsDecision:false},{materializeResult:true,materializeStages:true});
   }else if(!t.parentId&&t.status==='done'){
     addEvent(t.due,t.id,'Получен итог проекта: '+t.summary,{status:'review',summary:t.summary,needsDecision:true},{materializeResult:true});
     gate(t.due,t.id,'close-'+t.projectId,'Принять итог проекта «'+t.project+'»',t.due+'T18:00:00+03:00',[
       ['accept','Принять подтверждённый результат','В модельном пакете представлены проверенные результаты дочерних поручений.'],
       ['return','Вернуть на дополнительную проверку','Приёмка остаётся открытой; выполнение не считается подтверждённым.']
     ],{accept:outcome('Директор принял результат по представленным материалам.',{status:'done',needsDecision:false}),return:outcome('Потребована дополнительная проверка.',{status:'active',needsDecision:false})});
   }
 }
 // Routine status updates create load, but never silently resolve decisions.
 for(let month=7;month<=12;month++)for(let week=0;week<3;week++)for(let i=0;i<december.projects.length;i++){
   const p=december.projects[i],t=root(p.id),day=String(4+week*7+(i%3)).padStart(2,'0'),date=`2026-${String(month).padStart(2,'0')}-${day}`;
   if(date>=t.due)continue;
   addEvent(date,t.id,['Получен недельный статус: план работ актуализирован; приёмка результата ещё не состоялась.','Проверена обеспеченность следующего пакета работ. Открытые вопросы остаются в реестре.','Сверка с подрядчиком проведена. Процент готовности не заменяет документы приёмки.'][week],{}, {kind:'status_update'});
 }
 gate('2026-07-08',root('PR-09').id,'portfolio-capacity','Портфель превышает свободную мощность команды проектирования на 20%. Выбрать базовый план.','2026-07-10T18:00:00+03:00',[
 ['focus','Зафиксировать приоритет первой очереди','Перенести концепцию общественно-делового центра за основной план; сохранить ресурс ввода.'],
 ['parallel','Запустить весь портфель параллельно','Сохранить все обещанные даты при неизменной численности.']
 ],{focus:outcome('Приоритет первой очереди закреплён. Концепция центра остаётся в резерве.',{},[{taskId:root('PR-15').id,updates:{paused:true,pauseReason:'Резерв портфеля, ресурс направлен на первую очередь'}}]),parallel:outcome('Все проекты открыты при той же мощности. Риск перегрузки не снят.',{},[{taskId:root('PR-09').id,updates:{resourceOverload:true}}])});
 gate('2026-08-11',root('PR-07').id,'survey-scope','Обследование обнаружило ограничение несущих конструкций. Дополнительная проверка занимает 10 рабочих дней.','2026-08-13T18:00:00+03:00',[
 ['survey','Выполнить проверку до продолжения работ','Зафиксировать паузу затронутого участка и уточнить проект.'],
 ['continue','Продолжить по исходному проекту','Не менять ближайший график до получения полного заключения.']
 ],{survey:outcome('Назначена дополнительная проверка. Работы вне ограниченного участка продолжаются.',{technicalSurveyOrdered:true}),continue:outcome('Работы продолжены без закрытого ограничения. Техническое подтверждение отсутствует.',{unresolvedStructuralRisk:true})});
 addEvent('2026-08-27',root('PR-07').id,'Дополнительное обследование завершено: локальное усиление включено в рабочий проект.',{technicalSurveyComplete:true},{when:{gateId:'survey-scope',optionId:'survey'}});
 addEvent('2026-09-02',root('PR-07').id,'Контроль качества остановил участок: требуется переделка после неучтённого ограничения.',{status:'blocked',blocker:'Переделка ограниченного участка; дополнительные затраты 3 млн ₽',needsDecision:true},{when:{gateId:'survey-scope',optionId:'continue'}});
 gate('2026-09-09',root('PR-03').id,'automation-supplier','Для автоматики доступны основной поставщик и совместимый резервный комплект с платным резервированием.','2026-09-11T18:00:00+03:00',[
 ['reserve','Подтвердить совместимость и зарезервировать комплект','Резервирование 0,3 млн ₽, закупка только при необходимости.'],
 ['single','Остаться с основным поставщиком','Не расходовать резервирование, сохранить одного поставщика.']
 ],{reserve:outcome('Техническая совместимость подтверждена. Резервный комплект удерживается до 18 декабря.',{reserveConfirmed:true,reservationCostMillion:0.3}),single:outcome('Работа остаётся на одном поставщике. Резерв не закреплён.',{reserveConfirmed:false})});
 gate('2026-10-14',root('PR-02').id,'handover-plan','Арендаторы просят подтвердить передачу всех помещений одной датой. Разрешительные процедуры идут отдельно от стройки.','2026-10-16T18:00:00+03:00',[
 ['phased','Согласовать поэтапную передачу','Привязать помещения к подтверждённой инженерной и правовой готовности.'],
 ['single-date','Подтвердить единую дату 30 декабря','Договорное обещание на весь объект без раздельных условий.']
 ],{phased:outcome('Поэтапная передача согласована предварительно; каждое помещение требует подтверждения.',{phasedHandover:true}), 'single-date':outcome('Установлено безусловное обещание 30 декабря. Риск обязательства принят.',{unconditionalCommitment:true})});
 gate('2026-11-10',root('PR-09').id,'reserve-allocation','Свободный резерв 2 млн ₽. Есть запрос на ускорение инфраструктуры и улучшение отделки на 1,5 млн ₽.','2026-11-12T18:00:00+03:00',[
 ['protect','Сохранить резерв для критической инфраструктуры','Отделку сверх базового стандарта перенести.'],
 ['finish','Выделить 1,5 млн ₽ на улучшенную отделку','На непредвиденные затраты останется 0,5 млн ₽.']
 ],{protect:outcome('Резерв 2 млн ₽ сохранён для критических работ.',{reserveRemainingMillion:2}),finish:outcome('1,5 млн ₽ направлены на отделку; свободный резерв 0,5 млн ₽.',{reserveRemainingMillion:0.5})});
 // December evidence becomes available only on its actual date.
 for(const t of december.tasks.filter(t=>!t.parentId&&t.projectId!=='REPORTS'&&t.projectId!=='OPS'&&t.status!=='done'&&t.projectId!=='PR-07')){
   addEvent('2026-12-17',t.id,t.summary,{status:t.status,summary:t.summary,blocker:t.blocker||'',paused:!!t.paused,pauseReason:t.pauseReason||null,needsDecision:t.status==='review'},{materializeResult:t.status==='review'});
 }
 gate('2026-12-18',root('PR-03').id,'power-expedite','Основной комплект автоматики прибудет 28 декабря. После монтажа нужны пять рабочих дней испытаний. Решение по резерву требуется сегодня до 12:00.','2026-12-18T12:00:00+03:00',[
 ['expedite','Выделить 1,2 млн ₽ на резервный комплект','Доставка 21 декабря возможна только при сентябрьском резервировании; нужен свободный лимит.'],
 ['normal','Сохранить основную поставку','Испытания и ввод выходят за декабрьский горизонт.']
 ],{expedite:outcome('Заявка на ускорение направлена; возможность исполнения зависит от резервирования и свободного лимита.',{expediteRequested:true}),normal:outcome('Основная поставка сохранена. Декабрьский ввод электроснабжения не подтверждается.',{forecastFinish:'2027-01-12'})});
 gate('2026-12-18',root('PR-06').id,'tenant-commitment','Арендатор требует окончательное подтверждение передачи 30 декабря. Штраф безусловного обещания: 0,4 млн ₽ за день.','2026-12-18T17:00:00+03:00',[
 ['conditional','Предложить подтверждённую поэтапную передачу','Не обещать доступ в помещения до инженерной и правовой готовности.'],
 ['guarantee','Гарантировать всю площадь 30 декабря','Зафиксировать безусловную дату даже при незакрытых зависимостях.']
 ],{conditional:outcome('Арендатору направлен реалистичный условный график. Переговоры не равны подписанному соглашению.',{conditionalOfferSent:true}),guarantee:outcome('Направлено безусловное подтверждение даты. Потенциальный штраф 0,4 млн ₽ в день.',{unconditionalCommitment:true})});
 gate('2026-12-18',root('PR-14').id,'forecast-integrity','В зелёной сводке готовность корпуса 96%, но испытания и допуски открыты. Как представить прогноз портфельному комитету?','2026-12-18T15:00:00+03:00',[
 ['evidence','Разделить стройготовность, допуски и прогноз','Сообщить комитету разрыв дат и требуемые решения.'],
 ['green','Сохранить зелёный статус по проценту готовности','Не менять общий прогноз до фактической просрочки.']
 ],{evidence:outcome('Комитет получил доказательный прогноз: готовность работ отделена от допуска к эксплуатации.',{forecastDisclosed:true}),green:outcome('Сводка сохранена зелёной при открытых ограничениях.',{forecastDisclosed:false})});
 gate('2026-12-19',root('PR-05').id,'fire-safety','Повторное испытание пожарной автоматики не пройдено. Подрядчик готов устранить дефект 21 декабря, независимая проверка доступна 23 декабря.','2026-12-19T15:00:00+03:00',[
 ['repair-test','Устранить дефект и пройти независимую проверку','Не подписывать приёмку до подтверждения результата.'],
 ['accept-conditionally','Подписать приёмку с обязательством устранить позже','Эксплуатационный допуск при этом всё равно отсутствует.']
 ],{'repair-test':outcome('Устранение и повторная проверка назначены. Результата испытания пока нет.',{repairOrdered:true}),'accept-conditionally':outcome('Условная подпись не создаёт допуска. Объект остаётся небезопасным для запуска.',{unsafeAcceptance:true})});
 gate('2026-12-19',root('PR-08').id,'equipment-substitution','Замена оборудования дешевле на 3 млн ₽, но её совместимость не подтверждена. Экспертиза может быть завершена 22 декабря.','2026-12-19T12:00:00+03:00',[
 ['verify','Провести экспертизу до согласования замены','Сохранить требования к совместимости и документировать результат.'],
 ['saving','Согласовать экономию без заключения','Принять риск неподтверждённой совместимости.']
 ],{verify:outcome('Экспертиза заказана. До её результата замена не считается согласованной.',{compatibilityReviewOrdered:true}),saving:outcome('Замена согласована без технического подтверждения.',{unverifiedSubstitution:true})});
 // Conditional outcomes use ALL gate predicates where required. Engine must not treat requested actions as success.
 addEvent('2026-12-21',root('PR-03').id,'Резервный комплект доставлен; совместимость ранее подтверждена. Начались монтаж и испытания.',{status:'active',blocker:'',expediteDelivered:true},{whenAll:[{gateId:'automation-supplier',optionId:'reserve'},{gateId:'reserve-allocation',optionId:'protect'},{gateId:'power-expedite',optionId:'expedite'}]});
 addEvent('2026-12-22',root('PR-08').id,'Экспертиза подтвердила совместимость предложенной замены; заключение приложено к модельному результату.',{compatibilityVerified:true,status:'active',blocker:''},{when:{gateId:'equipment-substitution',optionId:'verify'}});
 addEvent('2026-12-23',root('PR-05').id,'Дефект устранён. Независимое повторное испытание пожарной автоматики пройдено, протокол получен.',{safetyGatePassed:true,status:'review',blocker:'',needsDecision:true},{when:{gateId:'fire-safety',optionId:'repair-test'},materializeResult:true,materializeChildren:true});
 addEvent('2026-12-24',root('PR-06').id,'Арендатор согласовал условный график: передача только готовых помещений после подтверждения допуска.',{conditionalAgreementSigned:true,status:'review',needsDecision:true},{when:{gateId:'tenant-commitment',optionId:'conditional'},materializeResult:true,materializeChildren:true});
 addEvent('2026-12-28',root('PR-03').id,'Пятидневный цикл испытаний после поставки 21 декабря завершён. Протокол подтверждает работоспособность.',{status:'review',blocker:'',needsDecision:true,powerTestsPassed:true},{whenAll:[{gateId:'automation-supplier',optionId:'reserve'},{gateId:'reserve-allocation',optionId:'protect'},{gateId:'power-expedite',optionId:'expedite'}],materializeResult:true,materializeChildren:true});
 addEvent('2026-12-30',root('PR-01').id,'После подтверждения электроснабжения завершена двухдневная комплексная проверка. Техническая готовность подтверждена 30 декабря, на день позже базового срока. Разрешение на ввод ещё не получено; закрывать весь проект нельзя.',{status:'review',blocker:'',needsDecision:true,technicalReady:true,actualTechnicalDate:'2026-12-30'},{whenAll:[{gateId:'automation-supplier',optionId:'reserve'},{gateId:'reserve-allocation',optionId:'protect'},{gateId:'power-expedite',optionId:'expedite'}],materializeResult:true,materializeChildren:true});
 addEvent('2026-12-31',root('PR-02').id,'Полная передача технопарка до конца года не подтверждена: после комплексной проверки остаётся юридическое оформление. Прогноз частичной передачи не равен закрытию проекта.',{status:'blocked',blocker:'Юридическое оформление передачи не завершено',needsDecision:true});
 // Planned low-risk packages receive ordinary completion evidence, not decisions that fabricate work.
 for(const id of ['PR-04','PR-13']){const t=root(id);addEvent(t.due,t.id,'Проверенный итоговый пакет проекта представлен. Требуется приёмка результата назначенным руководителем.',{status:'review',needsDecision:true},{materializeResult:true,materializeChildren:true});}

 // Final review gates only appear after their modeled evidence event, with the same causal conditions.
 const finalCases=[['PR-04','2026-12-23',null],['PR-13','2026-12-29',null],['PR-05','2026-12-23',[{gateId:'fire-safety',optionId:'repair-test'}]],['PR-06','2026-12-24',[{gateId:'tenant-commitment',optionId:'conditional'}]],['PR-03','2026-12-28',[{gateId:'automation-supplier',optionId:'reserve'},{gateId:'reserve-allocation',optionId:'protect'},{gateId:'power-expedite',optionId:'expedite'}]],['PR-01','2026-12-30',[{gateId:'automation-supplier',optionId:'reserve'},{gateId:'reserve-allocation',optionId:'protect'},{gateId:'power-expedite',optionId:'expedite'}]]];
 for(const [pid,date,whenAll] of finalCases){const t=root(pid);gate(date,t.id,'final-'+pid,'Проверить итоговый пакет «'+t.project+'»',date+'T18:00:00+03:00',[
 ['accept',pid==='PR-01'?'Принять проект целиком':'Принять подтверждённый объём',pid==='PR-01'?'Подписать итоговую приёмку корпуса. Представлен только технический протокол; разрешение на ввод пока не получено.':'Приёмка возможна только по раскрытым доказательствам и закрытым зависимостям.'],
 ['return','Оставить на доработке','Указать недостающее подтверждение; не объявлять проект закрытым.']
 ],{accept:outcome('Решение о приёмке подтверждённого результата зарегистрировано.',{status:'done',needsDecision:false}),return:outcome('Приёмка не состоялась. Результат оставлен на доработке.',{status:'active',needsDecision:false})},whenAll?{whenAll}:{});}
 addEvent('2026-12-26',root('PR-07').id,'Работы по уточнённому проекту завершены, локальное усиление проверено. Итоговый пакет представлен.',{status:'review',needsDecision:true,blocker:''},{when:{gateId:'survey-scope',optionId:'survey'},materializeResult:true,materializeChildren:true});
 gate('2026-12-26',root('PR-07').id,'final-PR-07','Проверить итог реконструкции по уточнённому проекту','2026-12-26T18:00:00+03:00',[
 ['accept','Принять проверенный результат','Заключение и проверка усиления представлены в модельном пакете.'],['return','Вернуть на уточнение','Не считать проект принятым до устранения замечаний.']
 ],{accept:outcome('Результат реконструкции принят по уточнённому проекту.',{status:'done',needsDecision:false}),return:outcome('Результат возвращён на уточнение.',{status:'active',needsDecision:false})},{when:{gateId:'survey-scope',optionId:'survey'}});
 for(const p of db.projects)p.expectedResult='Проверенный результат проекта «'+p.name+'» и комплект документов для приёмки.';
 for(const t of db.tasks.filter(t=>!t.parentId&&t.projectId?.startsWith('PR-'))){t.employeeId=t.divisionId+'-head';t.controlOwnerId='director';t.decisionOwnerId='director';}
 db.sources=[];db.events=[];db.reports=[];db.preferences={pins:[],seen:{},seenByActor:{},seenNotificationsByActor:{}};
 for(const t of db.tasks){for(const k of ['submittedResultSourceId','submittedResultAt','acceptedSourceId','acceptedAt','latestSourceId','reportedAt','lastReply','blocker','decisionDeadline','consequence','decisionOptions','minimumLeadDays','availableDeliveryDate','expediteDeliveryDate','expediteCostMillion','safetyGate','safetyGatePassed','commitmentRiskMillionPerDay','pauseReason','pausedAt'])delete t[k];Object.assign(t,{status:'planned',summary:'Поручение включено в план второго полугодия. Фактических обновлений ещё нет.',description:`${t.title}. Плановый срок ${t.due}. Куратор и принимающий руководитель назначены. План не подтверждает выполнение.`,needsDecision:false,nextAction:'',paused:false,version:'1'});for(const p of t.phases){Object.assign(p,{done:false,reviewStatus:'pending',submissions:[],reviews:[]});delete p.submittedResultId;delete p.acceptedResultId;}}
 // Report date headers and planned dependencies are public; future claims, risks and hidden causal rules are not.
 db.asOf='2026-07-01T06:00:00.000Z';db.scenario.asOf=db.asOf;db.scenario.description='Синтетическая девелоперская организация. Ускоренная имитация 184 дней: 1 июля — 31 декабря 2026. Факты раскрываются по дням, решения имеют модельные последствия.';
 db.simulation={start:'2026-07-01',end:'2026-12-31',day:'2026-07-01',dayIndex:0,dailyLog:[],decisions:[],eventPlan:eventPlan.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))};
 return db;
}
;return {createDepartmentCase};})();

return {createRun,advanceDay,decideGate,publicSnapshot,createDepartmentCase};})();
(()=>{
'use strict';
// Explicit server mode. Network errors never select the local demo adapter.
window.__PULSE_MODE='server';
const nativeFetch=window.fetch.bind(window), reads=new Set(), docs=new Map(), tasks=new Map(), drafts=new Map();
let actor=null,csrf='';
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
async function json(url,options={}){const r=await nativeFetch(url,{credentials:'same-origin',redirect:'error',...options});if(!r.ok)return {error:r};return {data:await r.json()};}
const endpoint=path=>new URL('/assistant/api/'+path,document.baseURI);
const post=(path,body)=>nativeFetch(endpoint(path),{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
async function receipt(promise,taskId){const r=await promise;if(!r.ok)return r;return response({...await r.json(),taskId});}
function projected(doc){
 const last=doc.reviews.filter(x=>x.version_id===doc.latestVersionId).at(-1),status=!doc.latestVersionId?'requested':last?.decision==='return'?'returned':last?.decision==='approve'?'curator_accepted':last?.decision==='accept'?'accepted':'submitted';
 const artifacts=doc.versions.map(v=>({id:v.id,requestId:doc.id,documentId:doc.id,taskId:doc.task_id,title:doc.title,version:v.number,createdAt:v.created_at,authorId:v.actor_id,sections:[{heading:'Содержание версии',body:v.text}],criteria:[],sourceIds:[],attachments:doc.attachments.filter(f=>f.version_id===v.id).map(f=>({...f,documentId:doc.id,blobKey:f.id,type:'application/octet-stream'}))}));
 return {request:{id:doc.id,documentId:doc.id,taskId:doc.task_id,text:doc.title,kind:'result',version:doc.revision,ownerId:doc.owner_id,curatorId:doc.curator_id,coexecutorIds:doc.coexecutorIds,status,artifactId:doc.latestVersionId,acceptedArtifactId:doc.acceptedVersionId,criteria:[],deliveredAt:doc.created_at,acknowledgedAt:doc.created_at,requiredRemarks:last?.decision==='return'?last.comment:'',reviews:doc.reviews.map(r=>({artifactId:r.version_id,action:{approve:'curator_accept',accept:'manager_accept',return:'return'}[r.decision],reason:r.comment,actorId:r.actor_id,at:r.created_at})),artifactReads:doc.versions.filter(v=>reads.has(actor?.id+':'+v.id)).map(v=>({actorId:actor.id,artifactId:v.id}))},artifacts};
}
function requestState(list){const mapped=list.map(projected),requests=mapped.map(x=>x.request);return {requests,artifacts:mapped.flatMap(x=>x.artifacts),pending:requests.filter(r=>r.status!=='accepted')};}
function stub(doc){return {id:doc.task_id,title:doc.title,employeeId:doc.owner_id,status:'active',version:String(doc.revision),project:'Только доступ к документу',summary:'Назначенный документ. Поручение и переписка не предоставлены.',canControl:false,documentOnly:true,priority:'normal',supervision:true};}
window.fetch=async(url,options={})=>{
 const u=new URL(url,document.baseURI);if(u.origin!==location.origin||!u.pathname.startsWith('/assistant/api/'))throw Error('Серверный режим разрешает только API этого сервера.');
 const path=u.pathname.slice('/assistant/api/'.length);
 if(path==='request-action'){
  const b=JSON.parse(options.body),x=b.input,doc=docs.get(x.documentId||x.requestId);
  if(x.action==='create')return receipt(post('documents',{requestId:b.requestId,taskId:b.taskId,title:x.text,curatorId:x.curatorId,coexecutorIds:[]}),b.taskId);
  if(!doc)return new Response(JSON.stringify({error:'Документ не найден. Обновите карточку.'}),{status:404});
  if(x.action==='open_artifact'){if(!doc.versions.some(v=>v.id===x.artifactId))return new Response('{}',{status:404});reads.add(actor.id+':'+x.artifactId);return response({ok:true,taskId:b.taskId});}
  if(x.action==='submit'){
   const files=[];for(const f of x.artifact.attachments||[]){if(f.base64)files.push({name:f.name,base64:f.base64});else{const r=await nativeFetch(endpoint('documents/'+doc.id+'/blobs/'+f.blobKey),{credentials:'same-origin',redirect:'error'});if(!r.ok)return r;files.push({name:f.name,base64:toBase64(await r.arrayBuffer())});}}
   const text=x.artifact.sections.map(s=>s.body).join('\n\n')+(x.response?'\n\nКак устранены замечания:\n'+x.response:'');
   return receipt(post('documents/'+doc.id+'/versions',{requestId:b.requestId,expectedRevision:x.expectedVersion,text,files}),b.taskId);
  }
  const decision={return:'return',curator_accept:'approve',manager_accept:'accept'}[x.action];
  if(decision)return receipt(post('documents/'+doc.id+'/reviews',{requestId:b.requestId,expectedRevision:x.expectedVersion,versionId:x.artifactId,decision,comment:x.reason||''}),b.taskId);
  return new Response(JSON.stringify({error:'Это действие доступно только в локальной модели.'}),{status:400});
 }
 if(path==='tasks'){
  const [a,b]=await Promise.all([json(u,options),json(endpoint('documents'))]);if(a.error)return a.error;if(b.error)return b.error;
  docs.clear();b.data.documents.forEach(d=>docs.set(d.id,d));tasks.clear();a.data.tasks.forEach(t=>tasks.set(t.id,t));for(const d of docs.values())if(!tasks.has(d.task_id))tasks.set(d.task_id,stub(d));
  return response({...a.data,tasks:[...tasks.values()]});
 }
 if(path==='memory'){
  const id=u.searchParams.get('taskId'),t=tasks.get(id),b=await json(endpoint('documents?taskId='+encodeURIComponent(id)));if(b.error)return b.error;b.data.documents.forEach(d=>docs.set(d.id,d));
  let data;if(t?.documentOnly){data={task:t,current:t,title:t.title,taskVersion:b.data.documents.map(d=>d.revision).join(':'),currentActor:actor,children:[],drafts:[],facts:[],timeline:[],sources:[],conversation:[],page:{nextBefore:null}};}else{const a=await json(u,options);if(a.error)return a.error;data=a.data;}
  const link=s=>s.documentReference?{...s,artifactId:s.documentReference.versionId,documentId:s.documentReference.documentId}:s;
  return response({...data,requestState:requestState(b.data.documents),conversation:(data.conversation||[]).map(link),sources:(data.sources||[]).map(link)});
 }
 const r=await nativeFetch(u,options);
 if(path==='session'&&r.ok){const s=await r.clone().json();actor=s.actor;csrf=s.csrf;}
 if(path==='logout'&&r.ok){actor=null;csrf='';reads.clear();docs.clear();tasks.clear();drafts.clear();}
 return r;
};
function toBase64(bytes){let s='';const a=new Uint8Array(bytes);for(let i=0;i<a.length;i+=16384)s+=String.fromCharCode(...a.subarray(i,i+16384));return btoa(s);}
const MAX_BYTES=2*1024*1024;
function validateFile(f){if(!f?.name||f.name.length>180||/[\x00-\x1f\x7f/\\]/.test(f.name)||! /\.(txt|md|csv|pdf|docx|xlsx)$/i.test(f.name))throw Error('Допустимы TXT, MD, CSV, PDF, DOCX и XLSX; обычное имя до 180 символов.');if(!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX_BYTES)throw Error('Файл должен быть непустым и не больше 2 МиБ.');return {name:f.name,size:f.size,type:f.type||'application/octet-stream'};}
function bytesOf(file){if(file.arrayBuffer)return file.arrayBuffer();return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Не удалось прочитать файл.'));r.readAsArrayBuffer(file);});}
__modules['document-storage.js']={MAX_BYTES,validateFile,async storeFile(file){return {...validateFile(file),base64:toBase64(await bytesOf(file)),blobKey:'pending:'+crypto.randomUUID()};},async readFile(f){const r=await nativeFetch(endpoint('documents/'+f.documentId+'/blobs/'+f.blobKey),{credentials:'same-origin',redirect:'error'});if(!r.ok)throw Error('Сервер не подтвердил доступ или целостность файла. Обновите карточку и повторите.');return r.blob();},loadDraft:key=>drafts.get(actor?.id+':'+key)||null,saveDraft(key,value){drafts.set(actor?.id+':'+key,value);return {persisted:false,error:'Черновик только в памяти этой вкладки. На сервер ещё не передан; перед закрытием скопируйте текст.'};},clearDraft(key){drafts.delete(actor?.id+':'+key);return {persisted:true};}};
window.__PULSE_SERVER={projected,requestState,validateFile};
})();
(()=>{const {installPrototype}=__modules["prototype-ui.js"];
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const labels = { planned:'Ожидает старта', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const fields = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const base = new URL('./api/', document.baseURI);
let identity = null, csrf = '', snapshot = null, filter = 'open', selected = null, memory = null, busy = false, refreshing = false, epoch = 0;
let pendingReport = null, pendingDecision = null;
let openGeneration=0, detailFlight=null, latestMemory=null, resumeDetail=false;
const draftText=new Map();
const draftKey=()=>JSON.stringify([identity?.id,selected]);
function saveText() {
  if(!identity||!selected||!document.querySelector('#report-text,#manager-message,#assistant-question'))return;
  const values={...draftText.get(draftKey())};
  for(const id of ['report-text','manager-message','assistant-question','manager-request-update']){const input=$('#'+id);if(input)values[id]=input.type==='checkbox'?input.checked:input.value;}
  draftText.set(draftKey(),values);
}
function restoreText() {
  for(const [id,value] of Object.entries(draftText.get(draftKey())||{}))if(value){
    const input=$('#'+id);
    if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}
    else if(typeof value==='string') {const label=document.createElement('label');label.textContent='Твой несохранённый текст';const field=document.createElement('textarea');field.readOnly=true;field.value=value;label.append(field);$('#task-content').append(label);}
  }
}
const detailContext=()=>JSON.stringify([epoch,openGeneration,selected,identity?.id,identity?.role]);
function invalidateDetail(message) {
  saveText();openGeneration++;latestMemory=null;memory=null;
  $('#task-content').replaceChildren();
  const notice=document.createElement('p');notice.setAttribute('role','status');notice.textContent=message;$('#task-content').append(notice);
  if($('#editor-dialog').open)$('#editor-dialog').close();
  restoreText();selected=null;
}
function validateActor(data) {
  if(data.currentActor && (data.currentActor.id!==identity?.id || data.currentActor.role!==identity?.role)){
    saveText();signOut();note('#login-message','Права изменились. Войди снова. Несохранённый текст останется в этом сеансе для прежнего автора.');return false;
  }
  return true;
}
function actionKey(data){return JSON.stringify([data.taskVersion,data.requestState?.requests.map(r=>[r.id,r.version]),data.drafts?.map(d=>[d.id,d.version]),data.children?.map(t=>[t.id,t.version])]);}
async function pollDetail() {
  if(detailFlight||!identity||!selected||!memory||busy||document.hidden||!$('#task-dialog').open)return;
  const context=detailContext(),id=selected;
  const flight={};detailFlight=flight;
  try {
    const fresh=await api('memory?taskId='+encodeURIComponent(id));
    if(context!==detailContext()||!$('#task-dialog').open||!validateActor(fresh))return;
    latestMemory=fresh;
    prototype.appendDetail(fresh);
    const changed=actionKey(fresh)!==actionKey(memory);
    $('#reload-detail').hidden=!changed;
    if(changed)note('#detail-updates','Данные для решения изменились. Обсуждение обновлено; перед действием просмотри актуальную карточку.');
  }catch(error){if(context===detailContext()){
    if([401,403,404].includes(error.status))invalidateDetail(error.message);
    else note('#detail-updates',error.message);
  }}finally{if(detailFlight===flight)detailFlight=null;if(resumeDetail&&!document.hidden){resumeDetail=false;pollDetail();}}
}

function date(value, time = false) {
  if (!value) return 'Не задан';
  const d = new Date(value.length === 10 ? value + 'T12:00:00+03:00' : value);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', day:'numeric', month:'short', ...(time ? { hour:'2-digit', minute:'2-digit' } : { year:'numeric' }) }).format(d) : 'Не указан';
}
function note(selector, text, success = false) { const el=$(selector); if (el) { el.textContent=text; el.classList.toggle('success',success); } }
function signOut() {
  saveText();openGeneration++;latestMemory=null;identity=null; csrf=''; snapshot=null; selected=null; memory=null; epoch++; pendingReport=null; pendingDecision=null;
  $('#workspace').hidden=true; $('#identity').hidden=true; $('#login-panel').hidden=false; $('#loading').hidden=true;
  prototype.reset(); $('#board').replaceChildren(); $('#task-content').replaceChildren(); if ($('#task-dialog').open) $('#task-dialog').close();
}
async function api(path, body) {
  const requestEpoch=epoch,requestContext=detailContext();
  let response;
  try { response=await fetch(new URL(path,base), { credentials:'same-origin', redirect:'error', ...(body === undefined ? {} : { method:'POST', headers:{ 'content-type':'application/json', 'x-csrf-token':csrf }, body:JSON.stringify(body) }) }); }
  catch { const error=new Error('Подтверждение не получено: связь прервалась.'); error.outcomeUnknown=body!==undefined; throw error; }
  let data;
  try { data=await response.json(); } catch { const error=new Error('Ответ сервера не удалось прочитать. Результат действия не подтверждён.'); error.outcomeUnknown=body!==undefined; throw error; }
  if (!response.ok) { const error=new Error(data.error || 'Не удалось выполнить действие.'); error.status=response.status; error.outcomeUnknown=body!==undefined&&response.status>=500; if (requestEpoch===epoch && response.status===401 && identity) signOut();
    else if([403,404].includes(response.status)&&requestContext===detailContext()&&selected&&(path.startsWith('memory?')||body?.taskId===selected||path.startsWith('assistant?')||path.startsWith('context?')||path.startsWith('source?')))invalidateDetail(error.message);
    throw error; }
  return data;
}
function setBusy(value) {
  busy=value;
  document.querySelectorAll('#task-dialog button,#editor-dialog button,#login-form button,#logout,#new-task,#team,#llm-settings,#open-chat').forEach(el=>{el.disabled=value||el.dataset.unavailable==='true';});
}
function renderBoard() {
  if (!snapshot || !identity) return;
  const metrics=window.__pulseMetrics?window.__pulseMetrics(snapshot.tasks):snapshot.brief.metrics;
  $('#metrics').innerHTML=[['Открытые задачи',metrics.open],['Нужно решение',metrics.decision],['Есть препятствие',metrics.blocked],['Нет ответа',metrics.noReply]].map(([title,count])=>`<div class="metric"><span>${title}</span><strong>${Number(count)}</strong></div>`).join('');
  const search=$('#search').value.trim().toLocaleLowerCase('ru');
  const tasks=snapshot.tasks.filter(t=>!window.__pulseScopeFilter||window.__pulseScopeFilter(t)).filter(t=>filter==='archived'?t.archived:!t.archived&&(filter==='done'?t.status==='done':t.status!=='done'&&(filter!=='attention'||prototype.isImportant(t))))
    .filter(t=>[t.id,t.title,t.project].join(' ').toLocaleLowerCase('ru').includes(search))
    .sort((a,b)=>Number(Boolean(b.needsDecision))-Number(Boolean(a.needsDecision))||Number(b.status==='blocked')-Number(a.status==='blocked')||(a.due||'9999').localeCompare(b.due||'9999'));
  $('#board').innerHTML=prototype.renderBoard(tasks);
  const feed=$('#activity-feed'),now=Date.now(),cutoff=now-24*3600000;if(feed)feed.innerHTML=snapshot.tasks.filter(t=>!t.archived&&t.lastUpdateAt&&Date.parse(t.lastUpdateAt)>=cutoff&&Date.parse(t.lastUpdateAt)<=now).sort((a,b)=>Date.parse(b.lastUpdateAt)-Date.parse(a.lastUpdateAt)).map(t=>`<button class="quiet" data-activity-task="${escape(t.id)}"><strong>${escape(t.title)}</strong> · ${escape(t.lastUpdateText||t.summary||'Обновление')} · ${escape(date(t.lastUpdateAt,true))}</button>`).join('')||'<p>За сутки обновлений нет.</p>';
  $('#freshness').textContent='Обновлено '+date(snapshot.asOf,true)+' · московское время';
}
async function refresh() {
  if (!identity || refreshing) return;
  refreshing=true; $('#refresh').disabled=true; const version=epoch;
  try { const data=await api('tasks'); if (version===epoch && identity) {snapshot=data;renderBoard();} }
  finally { refreshing=false; $('#refresh').disabled=false; }
}
async function enter() {
  const data=await api('session'); identity=data.actor; csrf=data.csrf; epoch++;
  $('#person').textContent=identity.name; $('#identity').hidden=false; $('#login-panel').hidden=true; $('#loading').hidden=true; $('#workspace').hidden=false;
  $('#page-title').textContent=identity.role==='manager'?'Всё, что требует внимания.':'Мои задачи. Общий результат.';
  $('#greeting').textContent=identity.role==='manager'?'Факты, препятствия и решения — с сохранёнными основаниями.':'Сообщай, что готово и где нужна помощь. История останется у задачи.';
  await refresh();
}
const sourceLink = id => { const index=memory?.sources.findIndex(s=>s.id===id)??-1; return index>=0?`<a href="#source-${index}">Сообщение-основание ↗</a>`:''; };
function sourcesMarkup() { return memory.sources.map((s,i)=>`<article class="source" id="source-${i}"><p>${escape(s.text)}</p><small>${escape(s.authorName||snapshot.employees.find(p=>p.id===s.employeeId)?.name||'Участник')} · ${date(s.occurredAt,true)}${s.simulated?' · пример':''}</small></article>`).join('')||'<p class="report-note" data-empty-sources>Исходных сообщений пока нет.</p>'; }
function eventMarkup(event) { return `<div class="history-item" data-event-key="${escape(event.key)}"><p>${escape(event.text)}</p>${sourceLink(event.sourceId)}<small>${date(event.at,true)}${event.kind==='late_report'?' · сохранено в истории без изменения текущего состояния':''}</small></div>`; }
function renderMemory() {
  if (!selected || !memory || !identity) return;
  $('#task-content').innerHTML=prototype.detailMarkup();
  setBusy(busy); prototype.detailMounted();
}
async function openTask(id) {
  saveText();selected=id; memory=null;latestMemory=null;openGeneration++;const context=detailContext();
  $('#task-content').innerHTML='<h2 id="task-title">Загружаем память задачи…</h2><p id="detail-message" class="message" role="status"></p>';
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
  try { const data=await api('memory?taskId='+encodeURIComponent(id)); if (context===detailContext() && $('#task-dialog').open && validateActor(data)) {memory=data;renderMemory();restoreText();} }
  catch(error) { if(context===detailContext()){if([401,403,404].includes(error.status))invalidateDetail(error.message);else note('#detail-message',error.message);} }
}
async function older() {
  if (!memory?.page.nextBefore) return;
  const id=selected, version=epoch, context=detailContext(), button=$('#older'); button.disabled=true;
  try { const data=await api('memory?taskId='+encodeURIComponent(id)+'&before='+encodeURIComponent(memory.page.nextBefore));
    if (version!==epoch || context!==detailContext() || id!==selected || !memory || !validateActor(data)) return;
    for (const source of data.sources) if (!memory.sources.some(s=>s.id===source.id)) memory.sources.push(source);
    $('#sources').innerHTML=sourcesMarkup();
    const keys=new Set([...$('#timeline').querySelectorAll('[data-event-key]')].map(el=>el.dataset.eventKey));
    $('#timeline').insertAdjacentHTML('beforeend',data.timeline.filter(e=>!keys.has(e.key)).map(eventMarkup).join('')); memory.page=data.page;
    if (!data.page.nextBefore) button.remove();
  } catch(error) {note('#detail-message',error.message);} finally {button.disabled=false;}
}
const prototype=installPrototype({api, pollDetail, detailContext, refresh, openTask, renderBoard, note, setBusy, date, sourcesMarkup, sourceLink, eventMarkup, busy:()=>busy, get:()=>({identity,snapshot,selected,memory,filter})});
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy)return; setBusy(true); note('#login-message','');
  try { await api('login',{code:$('#login-code').value.trim()}); $('#login-code').value=''; await enter(); }
  catch(error) {note('#login-message',error.message);} finally {setBusy(false);}
});
$('#logout').addEventListener('click',async()=>{if(busy)return;setBusy(true);try{await api('logout',{});signOut();}catch(error){note('#workspace-message',error.message);}finally{setBusy(false);}});
$('#refresh').addEventListener('click',()=>refresh().then(()=>note('#workspace-message','')).catch(error=>note('#workspace-message',error.message)));
$('#search').addEventListener('input',renderBoard);
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderBoard();}));
$('#pause-activity')?.addEventListener('click',event=>{const paused=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(paused));event.currentTarget.textContent=paused?'Продолжить':'Пауза';document.querySelector('.activity-strip').classList.toggle('paused',paused);});
$('#activity-feed')?.addEventListener('click',event=>{const button=event.target.closest('[data-activity-task]');if(button&&!busy)openTask(button.dataset.activityTask);});
$('#board').addEventListener('click',event=>{const button=event.target.closest('[data-task]');if(button&&!busy)openTask(button.dataset.task);});
$('#close-dialog').addEventListener('click',()=>{if(!busy)$('#task-dialog').close();});
$('#task-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('#task-dialog').addEventListener('close',()=>{saveText();openGeneration++;selected=null;memory=null;latestMemory=null;});
$('#task-dialog').addEventListener('click',async event=>{
  if(event.target.closest('#older')){if(!busy)await older();return;}
  const button=event.target.closest('[data-decision]');if(!button||busy||!memory||button.disabled)return;
  if(button.dataset.decision==='accept'&&!$('#result-reviewed')?.checked)return;
  const input={taskId:selected,action:button.dataset.decision,expectedVersion:memory.taskVersion};
  if(!pendingDecision||JSON.stringify(pendingDecision.input)!==JSON.stringify(input))pendingDecision={input,requestId:crypto.randomUUID()};
  setBusy(true);const id=selected;
  try {await api('decision',{...input,requestId:pendingDecision.requestId});pendingDecision=null;await refresh();await openTask(id);note('#detail-message','Решение сохранено в истории.',true);}
  catch(error){if(error.status===409){pendingDecision=null;$('#reload-detail').hidden=false;await refresh().catch(()=>{});}note('#detail-message',error.message);}
  finally{setBusy(false);}
});
$('#task-dialog').addEventListener('submit',async event=>{
  if(event.target.id!=='report-form')return;event.preventDefault();if(busy)return;
  const input={taskId:selected,text:$('#report-text').value.trim()};if(!input.text)return;
  if(!pendingReport||JSON.stringify(pendingReport.input)!==JSON.stringify(input))pendingReport={input,requestId:crypto.randomUUID()};
  setBusy(true);const id=selected,reportActor=identity?.id;
  try {const result=await api('report',{...input,requestId:pendingReport.requestId});pendingReport=null;$('#report-text').value='';await refresh();await openTask(id);note('#detail-message',result.reply||'Обновление сохранено.',true);}
  catch(error){note('#detail-message',error.message);}
  finally{setBusy(false);if(selected===id&&identity?.id===reportActor&&$('#task-dialog').open){const composer=$('#report-text'),disclosure=composer?.closest('details');if(disclosure)disclosure.open=true;composer?.focus({preventScroll:true});composer?.scrollIntoView?.({block:'nearest'});}}
});
const poll=setInterval(()=>{if(identity&&prototype.canRefresh())refresh().catch(error=>note('#workspace-message',error.message));},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(detailFlight)resumeDetail=true;else pollDetail();}});
window.addEventListener('pagehide',()=>{openGeneration++;clearInterval(poll);});
enter().catch(error=>{if(!identity)signOut();if(error.status!==401)note(identity?'#workspace-message':'#login-message',error.message);});

let demoRoleQueue=Promise.resolve(),demoRolePending=0;window.addEventListener('pulse-demo-role',()=>{demoRolePending++;window.dispatchEvent(new Event('pulse-demo-loading'));demoRoleQueue=demoRoleQueue.then(async()=>{while(refreshing)await new Promise(r=>setTimeout(r,0));for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();signOut();await enter();}).catch(e=>note('#workspace-message',e.message)).finally(()=>{if(--demoRolePending===0)window.dispatchEvent(new Event('pulse-demo-ready'));});});})();