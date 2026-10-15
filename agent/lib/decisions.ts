import type { State, Employee } from './store.ts';
import { taskMemory } from '../../dist/task-memory.js';

export type DecisionInput = {
  taskId: string;
  kind: 'extension' | 'request' | 'clarify' | 'plan' | 'review';
  title: string;
  body: string;
  reason: string;
  options: { label: string; consequence: string }[];
  references: { sourceId: string; quote: string }[];
};

export function decisionContext(state: State, actor: Employee, taskId: string) {
  if (actor.role !== 'manager') throw new Error('Подготовка управленческого решения доступна руководителю');
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw new Error('Задача не найдена');
  return {
    task,
    employee: state.employees.filter(e => e.id === task.employeeId).map(e => ({ id:e.id, name:e.name }))[0] || null,
    sources: state.sources.filter(s => s.taskId === taskId).slice(-8).map(s => ({ id:s.id, text:s.text, receivedAt:s.receivedAt, employeeId:s.employeeId })),
    recentEvents: state.events.filter(e => e.taskId === taskId).slice(0, 10),
    memory: taskMemory(state, actor, taskId, { limit: 12 }),
    delivery: 'draft_only' as const,
  };
}

export function saveDecisionDraft(state: State, actor: Employee, input: DecisionInput, callId: string, at: string) {
  const context = decisionContext(state, actor, input.taskId);
  const previous = state.decisionDrafts?.find(d => d.id === callId && d.authorId === actor.id);
  if (previous) return { state, draft: previous };
  for (const ref of input.references) {
    const source = state.sources.find(s => s.id === ref.sourceId && s.taskId === input.taskId);
    if (!ref.quote.trim() || !source?.text.includes(ref.quote)) throw new Error('Источник или цитата не относятся к этой задаче');
  }
  const draft = {
    ...input, id:callId, authorId:actor.id, createdAt:at, status:'draft', needsReview:true,
    taskSnapshot: { title:context.task.title, due:context.task.due || null, status:context.task.status, latestSourceId:context.task.latestSourceId || null },
  };
  const next = structuredClone(state);
  next.decisionDrafts = [...(next.decisionDrafts || []), draft];
  next.events.unshift({ key:`decision-draft:${callId}`, taskId:input.taskId, kind:'decision_draft', at, text:`Подготовлен черновик: ${input.title}` });
  return { state:next, draft };
}
