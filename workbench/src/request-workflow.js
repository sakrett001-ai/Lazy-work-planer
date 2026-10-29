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
