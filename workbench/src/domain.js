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
