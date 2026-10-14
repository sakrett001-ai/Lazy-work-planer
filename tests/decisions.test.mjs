import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../dist/workspace-model.js';
import { decisionContext, saveDecisionDraft } from '../agent/lib/decisions.ts';
const NOW='2026-10-14T12:00:00+03:00';
const actor={id:'manager',role:'manager',name:'Руководитель'};
const input={taskId:'П-102',kind:'request',title:'Запрос сведений',body:'[Адресат], прошу уточнить исходные данные.',reason:'Не хватает данных',options:[{label:'Запросить сведения',consequence:'Потребуется ответ подразделений'}],references:[]};
test('Черновики решений доступны только руководителю и цитаты привязаны к задаче',()=>{
 const s=createWorkspace(NOW);assert.throws(()=>decisionContext(s,{id:'anna',role:'employee'},'П-102'),/руководителю/);
 assert.throws(()=>saveDecisionDraft(s,actor,{...input,references:[{sourceId:'seed-101',quote:s.sources[0].text}]},'call-1',NOW),/не относятся/);
 assert.throws(()=>saveDecisionDraft(s,actor,{...input,references:[{sourceId:'seed-102',quote:'Выдуманная цитата'}]},'call-1',NOW),/не относятся/);
});
test('Подготовка решения сохраняет черновик, не меняет сроки и не создаёт доставку',()=>{
 const s=createWorkspace(NOW), source=s.sources.find(x=>x.id==='seed-102'), request={...input,references:[{sourceId:source.id,quote:source.text}]};
 const result=saveDecisionDraft(s,actor,request,'call-1',NOW);
 assert.deepEqual(result.state.tasks,s.tasks);assert.equal(s.decisionDrafts,undefined);assert.equal(result.draft.status,'draft');assert.equal(result.draft.needsReview,true);
 const again=saveDecisionDraft(result.state,actor,request,'call-1',NOW);assert.equal(again.state.decisionDrafts.length,1);assert.equal(again.state.events.length,result.state.events.length);
});
