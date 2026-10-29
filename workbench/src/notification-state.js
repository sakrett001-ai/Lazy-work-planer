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
