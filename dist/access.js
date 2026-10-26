/** Shared read policy. UI scopes are filters; server callers supply a verified actor. */
export function registeredActor(state, actorId) {
  const actor = state.employees.find(person => person.id === actorId);
  if (!actor || actor.enabled === false) throw new Error('Участник не зарегистрирован');
  return actor;
}

export function canReadTask(actor, task) {
  return Boolean(actor.enabled !== false && task && (actor.role === 'manager' || task.employeeId === actor.id));
}

export function scopedWorkspace(state, actor) {
  const tasks = state.tasks.filter(task => canReadTask(actor, task));
  const ids = new Set(tasks.map(task => task.id));
  const manager = actor.role === 'manager';
  return {
    tasks,
    employees: state.employees.filter(p => manager || p.id === actor.id).map(p => ({ id: p.id, name: p.name, role: p.role, enabled: p.enabled !== false })),
    sources: (state.sources || []).filter(s => s.taskId ? ids.has(s.taskId) : manager || s.employeeId === actor.id),
    events: (state.events || []).filter(e => ids.has(e.taskId) && (manager || e.kind !== 'decision_draft')),
    decisionDrafts: manager ? (state.decisionDrafts || []).filter(d => ids.has(d.taskId)) : [],
    drafts: manager ? Object.fromEntries(Object.entries(state.drafts || {}).filter(([, d]) => ids.has(d.taskId))) : {},
    notifications: (state.notifications || []).filter(n => ids.has(n.taskId) && (manager || n.to === actor.id)),
    settings: state.settings,
  };
}

/** Parent linkage never grants read access or exposes an unreadable parent. */
export function visibleTask(state, actor, task) {
  const result = { ...task };
  if (result.parentId && !canReadTask(actor, state.tasks.find(t => t.id === result.parentId))) delete result.parentId;
  return result;
}
