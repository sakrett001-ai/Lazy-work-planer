import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, updateState } from '../lib/store';
import { saveDecisionDraft } from '../lib/decisions';

export default defineTool({
  description:'Сохранить подготовленные моделью варианты решения и редактируемый черновик письма, плана или проверки. Только руководителю. Не отправляет сообщения и не меняет задачу или утверждённый срок.',
  inputSchema:z.object({
    taskId:z.string().min(1),
    kind:z.enum(['extension','request','clarify','plan','review']),
    title:z.string().trim().min(1).max(200),
    body:z.string().trim().min(1).max(12000),
    reason:z.string().trim().min(1).max(1500),
    options:z.array(z.object({label:z.string().trim().min(1).max(200),consequence:z.string().trim().min(1).max(800)})).min(1).max(3),
    references:z.array(z.object({sourceId:z.string().min(1),quote:z.string().trim().min(1).max(1200)})).max(8),
  }),
  execute(input, ctx) {
    const actor=currentEmployee(ctx), callId=`${actor.id}:${ctx.callId}`;
    let draft:ReturnType<typeof saveDecisionDraft>['draft']|undefined;
    updateState(state => { const result=saveDecisionDraft(state, actor, input, callId, new Date().toISOString()); draft=result.draft; return result.state; });
    return { status:'draft', delivered:false, taskChanged:false, draft };
  },
});
