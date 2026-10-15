import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, readState } from '../lib/store';
import { semanticSearch, findSimilarTasks } from '../../dist/langgraph-emb.js';
import { scopedWorkspace } from '../../dist/access.js';

export default defineTool({
  description: 'Поиск кандидатов по текстовому сходству в доступных задачах и сообщениях. Сотруднику доступны только свои задачи; черновики решений доступны руководителю. Сходство не является достоверностью факта. Для истории используй get_task_memory.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(15).optional(),
    kind: z.enum(['all', 'task', 'source', 'draft']).optional(),
    similarToTaskId: z.string().max(80).optional(),
  }),
  execute({ query, topK = 5, kind = 'all', similarToTaskId }, ctx) {
    const actor = currentEmployee(ctx);
    const state = scopedWorkspace(readState(), actor);
    const allowedTaskIds = new Set<string>(state.tasks.map((t: { id: string }) => t.id));

    const searchResult = semanticSearch(state, query, {
      topK,
      kind,
    });

    const similar = similarToTaskId && allowedTaskIds.has(similarToTaskId)
      ? findSimilarTasks(state, similarToTaskId, 3, allowedTaskIds)
      : [];

    return {
      ...searchResult,
      similarTasks: similar,
    };
  },
});
