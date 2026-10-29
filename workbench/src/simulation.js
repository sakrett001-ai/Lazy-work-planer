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
