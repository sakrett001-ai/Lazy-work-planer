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
