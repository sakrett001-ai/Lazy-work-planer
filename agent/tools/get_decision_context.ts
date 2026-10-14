import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, readState } from '../lib/store';
import { decisionContext } from '../lib/decisions';

export default defineTool({
  description:'Получить проверенные факты, последние ответы и историю одной задачи для подготовки вариантов решения. Только руководителю.',
  inputSchema:z.object({ taskId:z.string().min(1) }),
  execute({ taskId }, ctx) { return decisionContext(readState(), currentEmployee(ctx), taskId); },
});
