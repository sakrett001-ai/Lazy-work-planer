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
