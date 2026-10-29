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
