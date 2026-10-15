import { assertWebReadOnly } from '../lib/prototype';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, getSource, updateState } from '../lib/store';
import { runAssistantWorkflow } from '../../dist/langgraph-emb.js';
import { assertReportEvidence } from '../../dist/feedback.js';

export default defineTool({
  description: 'Обработать проверенный ответ сотрудника по SOURCE_ID с памятью задачи, проверкой цитаты и записью истории. Передай структурированный report после разбора исходного сообщения; без report используется консервативный разбор по правилам. manager_query ищет доступный контекст. Уведомления только подготавливаются; для отправки руководитель использует notify_employee.',
  inputSchema: z.object({
    eventType: z.enum(['employee_feedback', 'task_assigned', 'check_in_request', 'manager_query']),
    sourceId: z.string().min(1).max(150).optional(),
    taskId: z.string().min(1).max(80).optional(),
    message: z.string().trim().min(1).max(2000).optional(),
    report: z.object({
      kind: z.enum(['progress', 'blocked', 'unblocked', 'review', 'deadline_request', 'unclear']),
      summary: z.string().trim().min(1).max(500),
      quote: z.string().trim().min(1).max(1500),
      blocker: z.string().max(500).optional(),
      needsDecision: z.boolean().optional(),
      nextAction: z.string().max(300).optional(),
      proposedDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      question: z.string().max(300).optional(),
    }).optional(),
  }),
  execute(input, ctx) {
    assertWebReadOnly(ctx);
    const actor = currentEmployee(ctx);
    if (input.eventType !== 'employee_feedback' && actor.role !== 'manager') throw new Error('Действие доступно только руководителю');
    if (input.eventType === 'employee_feedback' && !input.sourceId) throw new Error('Требуется SOURCE_ID исходного сообщения');
    const source = input.eventType === 'employee_feedback' ? getSource(input.sourceId!) : null;
    if (source && source.employeeId !== actor.id) throw new Error('Нет доступа к исходному сообщению');
    if (source && input.message && input.message !== source.text) throw new Error('Нельзя подменять текст исходного сообщения');
    if (input.eventType === 'manager_query' && !input.message) throw new Error('Нужен поисковый запрос');
    let output: ReturnType<typeof runAssistantWorkflow> | undefined;
    updateState(state => {
      if (source?.taskId && input.report && !state.events.some(e => e.key === source.id)) {
        const task = state.tasks.find(t => t.id === source.taskId && t.employeeId === actor.id);
        if (!task) throw new Error('Нет доступа к задаче');
        assertReportEvidence(input.report, source, task, state.settings.timezone);
      }
      output = runAssistantWorkflow(state, { ...input, source, actorId: actor.id, mode: 'server', operationId: ctx.callId, now: new Date().toISOString() });
      return output.state;
    });
    return {
      graph: 'TaskMonitor_v2', duplicate: output?.duplicate,
      taskId: output?.run?.taskId || source?.taskId || null,
      classification: output?.run?.classification || null,
      reply: output?.reply, notifications: output?.notifications, delivery: 'not_sent',
      trace: output?.trace, embTopMatches: output?.embContext?.topMatches || [],
    };
  },
});
