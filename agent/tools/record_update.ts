import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee,getSource,updateState } from '../lib/store';
import { applyReport } from '../../dist/domain.js';
export default defineTool({description:'Зафиксировать фактический ответ по собственной задаче с дословной цитатой. Не меняет утверждённый срок и не принимает результат работы.',inputSchema:z.object({sourceId:z.string().max(150),taskId:z.string().max(80),kind:z.enum(['progress','blocked','unblocked','review','deadline_request','unclear']),summary:z.string().min(1).max(500),quote:z.string().min(1).max(1500),blocker:z.string().max(500).optional(),needsDecision:z.boolean().optional(),nextAction:z.string().max(300).optional(),proposedDue:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}),execute(input,ctx){const actor=currentEmployee(ctx),source=getSource(input.sourceId);const state=updateState(s=>applyReport(s,input,actor,source));return {saved:true,task:state.tasks.find(t=>t.id===input.taskId)};}});
