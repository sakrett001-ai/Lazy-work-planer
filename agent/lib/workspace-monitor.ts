import type { State } from './store.ts';
import { reconcileNoReplies, shouldCheckIn } from '../../dist/domain.js';

// In-app delivery means a durable message is available in the task discussion.
// It does not claim that the employee is online or has read the message.
export function monitorWorkspace(state: State, at = new Date().toISOString(), allowCheckins = true): State {
  const next: State = structuredClone(reconcileNoReplies(state, at));
  if (!allowCheckins || !(next.settings as any).prototypeAutoCheckins) return next;
  for (const task of next.tasks) {
    if (!next.employees.some(p => p.id === task.employeeId && p.enabled !== false) || !shouldCheckIn(task, at, next.settings)) continue;
    const id = `workspace-checkin:${task.id}:${at}`;
    const text = `Как продвигается «${task.title}»? Напиши, что готово, что мешает и когда ждать следующий результат.`;
    next.sources.push({ id, taskId: task.id, employeeId: null, authorName: 'Ассистент · запрос статуса', kind: 'assistant_check_in', text, occurredAt: at, receivedAt: at, channel: 'workspace' });
    next.events.unshift({ key: id, sourceId: id, taskId: task.id, kind: 'check_in', at, text: 'Ассистент запросил статус в обсуждении задачи. Прочтение не подтверждено.' });
    task.lastRequestedAt = at; task.contact = 'awaiting';
  }
  return next;
}
