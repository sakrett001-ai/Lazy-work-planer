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
