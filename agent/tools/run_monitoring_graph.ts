import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, updateState } from '../lib/store';
import { runAssistantWorkflow } from '../../dist/langgraph-emb.js';

export default defineTool({
  description: 'Запустить конвейер LangGraph + Emb (64d) для обработки входящего фидбека сотрудника, уведомления о новой задаче или аналитического запроса руководителя с записью трассировки узлов.',
  inputSchema: z.object({
    eventType: z.enum(['employee_feedback', 'task_assigned', 'check_in_request', 'manager_query']),
    taskId: z.string().max(80).optional(),
    message: z.string().trim().min(1).max(2000),
  }),
  execute({ eventType, taskId, message }, ctx) {
    const actor = currentEmployee(ctx);
    if ((eventType === 'task_assigned' || eventType === 'check_in_request' || eventType === 'manager_query') && actor.role !== 'manager') {
      throw new Error('Этот тип запуска графа доступен только руководителю');
    }

    const now = new Date().toISOString();
    let workflowOutput: ReturnType<typeof runAssistantWorkflow> | undefined;

    updateState(state => {
      workflowOutput = runAssistantWorkflow(state, {
        eventType,
        actorId: actor.id,
        taskId: taskId || null,
        message,
        now,
      });
      return workflowOutput.state;
    });

    return {
      graph: 'LangGraph_TaskMonitor_v1',
      taskId: workflowOutput?.run.taskId || null,
      classification: workflowOutput?.run.classification || null,
      reply: workflowOutput?.reply || '',
      notifications: workflowOutput?.notifications || [],
      trace: workflowOutput?.trace || [],
      embTopMatches: workflowOutput?.embContext?.topMatches || [],
    };
  },
});
