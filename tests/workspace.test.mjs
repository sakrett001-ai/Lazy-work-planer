import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../dist/fixtures.js';
import { createWorkspace, migrateWorkspace, addTask, editTask, deadline, dueInstant, selectTasks, changeTask, setPhase, savePhase, makeDraft, proposal, calendarDays, achievements, applyScenario, dayKey } from '../dist/workspace-model.js';
const NOW='2026-10-14T12:00:00+03:00';
const seed=()=>createWorkspace(NOW);
const task=(s,id)=>s.tasks.find(t=>t.id===id);
test('Поручение без протокола и срока не получает выдуманные реквизиты',()=>{
 const {state:s,task:t}=addTask(seed(),{title:'Моя задача',employeeId:'manager'},NOW);
 assert.equal(t.protocol,undefined);assert.equal(t.due,null);assert.equal(deadline(t,NOW).kind,'none');
 assert.ok(selectTasks(s,{scope:'mine',filter:'undated'},NOW).some(x=>x.id===t.id));
 assert.equal(proposal(t,NOW).type,'plan');assert.doesNotMatch(makeDraft(s,t).body,/протокол/i);
});
test('Срок считается по Москве, на точной границе начинается просрочка',()=>{
 const t=task(seed(),'П-103');assert.equal(dueInstant(t),Date.parse('2026-10-14T15:00:00Z'));
 assert.equal(deadline(t,'2026-10-14T14:59:00Z').kind,'soon');assert.equal(deadline(t,'2026-10-14T15:00:00Z').kind,'overdue');
 assert.equal(dayKey('2026-10-14T22:00:00Z'),'2026-10-15');
});
test('Перенос изменяет календарную дату только после решения, черновик ничего не меняет',()=>{
 const s=seed(), before=JSON.stringify(s), t=task(s,'П-103');const draft=makeDraft(s,t,'extension');
 assert.equal(t.due,'2026-10-14');assert.equal(JSON.stringify(s),before);assert.match(draft.body,/17 окт/);
 const updated=changeTask(s,t.id,'approve_due',NOW);assert.equal(task(updated,t.id).due,'2026-10-17');assert.equal(task(updated,t.id).proposedDue,null);
 assert.equal(deadline(task(updated,t.id),NOW).kind,'normal');
});
test('Приоритет отражает блокировку и состояние срока, без срока — в конце при равном статусе',()=>{
 const s=seed(), list=selectTasks(s,{},NOW);assert.equal(list[0].id,'П-102');
 assert.ok(list.findIndex(t=>t.id==='П-107')<list.findIndex(t=>t.id==='П-108'));
 assert.ok(selectTasks(s,{sort:'deadline'},NOW).at(-1).due===null);
 assert.ok(!list.some(t=>t.status==='done'));
});
test('Отклонённый срок остаётся прежним',()=>{
 const s=changeTask(seed(),'П-103','reject_due',NOW);assert.equal(task(s,'П-103').due,'2026-10-14');assert.equal(task(s,'П-103').proposedDue,null);
});
test('Приёмка, архив, возврат и повторная приёмка не размножают достижения',()=>{
 let s=changeTask(seed(),'П-104','accept',NOW);
 assert.ok(!selectTasks(s,{},NOW).some(t=>t.id==='П-104'));assert.ok(selectTasks(s,{archive:true},NOW).some(t=>t.id==='П-104'));
 assert.equal(achievements(s)[0].value,1);
 s=changeTask(s,'П-104','reopen',NOW);assert.ok(selectTasks(s,{},NOW).some(t=>t.id==='П-104'));
 s=changeTask(s,'П-104','review',NOW);s=changeTask(s,'П-104','accept','2026-10-14T13:00:00+03:00');assert.equal(achievements(s)[0].value,1);
});
test('Нельзя завершить зависимый или заблокированный этап; открытие раннего сбрасывает потомков',()=>{
 let s=seed();assert.throws(()=>setPhase(s,'П-102','data',true,NOW),/препятствия/);assert.throws(()=>setPhase(s,'П-108','final',true,NOW),/предшествующий/);
 s=setPhase(s,'П-108','forecast',true,NOW);s=setPhase(s,'П-108','review',true,NOW);s=setPhase(s,'П-108','final',true,NOW);
 s=changeTask(s,'П-108','review',NOW);s=setPhase(s,'П-108','collect',false,NOW);
 assert.ok(task(s,'П-108').phases.every(p=>!p.done));assert.equal(task(s,'П-108').status,'active');
 assert.throws(()=>changeTask(s,'П-108','review',NOW),/заверши этапы/);
});
test('Зависимости этапов не допускают циклы, пересечение и неверные даты',()=>{
 const s=seed();assert.throws(()=>savePhase(s,'П-108','collect',{title:'Сбор',start:'2026-10-12',end:'2026-10-13',dependsOn:'final'},NOW),/круг/);
 assert.throws(()=>savePhase(s,'П-108',null,{title:'Новый',start:'2026-02-30',end:'2026-03-02'},NOW),/корректные/);
 assert.throws(()=>savePhase(s,'П-108',null,{title:'Новый',start:'2026-10-20',end:'2026-10-15'},NOW),/раньше/);
 assert.throws(()=>savePhase(s,'П-108',null,{title:'Новый',start:'2026-10-14',end:'2026-10-16',dependsOn:'final'},NOW),/предшествующего/);
 const after=savePhase(s,'П-108',null,{title:'Оформление',start:'2026-10-23',end:'2026-10-24',dependsOn:'final'},NOW);
 assert.equal(task(after,'П-108').due,'2026-10-22');assert.equal(task(after,'П-108').phases.length,5);
});
test('Демо-фильтры отделяют собственные задачи и отдел',()=>{
 const s=seed();assert.ok(selectTasks(s,{scope:'mine'},NOW).every(t=>t.employeeId==='manager'));
 assert.ok(selectTasks(s,{scope:'department'},NOW).every(t=>t.department==='planning'));
 assert.ok(!selectTasks(s,{scope:'department'},NOW).some(t=>t.id==='П-103'));
 assert.equal(selectTasks(s,{search:'12-БК'},NOW).length,2);
});
test('Календарь имеет 42 ячейки с понедельника и корректно включает границу года',()=>{
 const days=calendarDays('2027-01');assert.equal(days.length,42);assert.equal(new Date(days[0]+'T12:00:00Z').getUTCDay(),1);
 assert.ok(days.some(d=>d==='2026-12-31'));assert.ok(days.some(d=>d==='2027-01-31'));
});
test('Миграция сохраняет старые статусы, даты, источники и данные новой версии',()=>{
 const old=initialState();old.tasks[0].summary='Моя правка';old.tasks[0].due='2026-11-17';
 const migrated=migrateWorkspace(old,NOW);assert.equal(task(migrated,'П-101').summary,'Моя правка');assert.equal(task(migrated,'П-101').due,'2026-11-17');assert.deepEqual(migrated.sources,old.sources);
 const next=migrateWorkspace(migrated,NOW);assert.deepEqual(next.tasks,migrated.tasks);
});
test('Редактирование не создаёт новую задачу и фиксирует изменение срока',()=>{
 const s=seed(), t=task(s,'Л-201'), after=editTask(s,t.id,{title:t.title,employeeId:'manager',due:'2026-10-20',dueTime:'11:00',protocolNumber:'7',protocolPoint:'1.2',protocolDate:'2026-10-10'},NOW);
 assert.equal(after.tasks.length,s.tasks.length);assert.equal(task(after,t.id).due,'2026-10-20');assert.equal(task(after,t.id).protocol.number,'7');assert.match(after.events[0].text,/не задан → 2026-10-20/);
 assert.equal(t.due,null);
});
test('Сценарий обновляет факт с источником, завершение не равно приёмке',()=>{
 const s=applyScenario(seed(),'complete',NOW);assert.equal(task(s,'П-101').status,'review');assert.equal(s.sources.at(-1).taskId,'П-101');
 const delayed=applyScenario(seed(),'deadline',NOW);assert.equal(task(delayed,'П-103').due,'2026-10-14');assert.equal(task(delayed,'П-103').proposedDue,'2026-10-17');
});
