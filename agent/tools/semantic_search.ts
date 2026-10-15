import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, readState } from '../lib/store';
import { semanticSearch, findSimilarTasks } from '../../dist/langgraph-emb.js';

export default defineTool({
  description: 'Семантический векторный поиск (Emb 64d + cosine similarity) по задачам, сообщениям сотрудников и черновикам решений. Для сотрудника фильтрует только его задачи; руководитель видит всё пространство.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(15).optional(),
    kind: z.enum(['all', 'task', 'source', 'draft']).optional(),
    similarToTaskId: z.string().max(80).optional(),
  }),
  execute({ query, topK = 5, kind = 'all', similarToTaskId }, ctx) {
    const actor = currentEmployee(ctx);
    const state = readState();
    const allowedTaskIds = actor.role === 'manager'
      ? null
      : new Set(state.tasks.filter(t => t.employeeId === actor.id).map(t => t.id));

    const searchResult = semanticSearch(state, query, {
      topK,
      kind,
      scopeIds: allowedTaskIds,
    });

    const similar = similarToTaskId && (actor.role === 'manager' || allowedTaskIds?.has(similarToTaskId))
      ? findSimilarTasks(state, similarToTaskId, 3)
      : [];

    return {
      ...searchResult,
      similarTasks: similar,
    };
  },
});
