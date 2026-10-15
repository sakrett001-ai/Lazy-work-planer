import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, readState } from '../lib/store';
import { taskMemory } from '../../dist/task-memory.js';

export default defineTool({
  description: 'Восстановить память задачи из постоянного хранилища: актуальные факты и их основания, сообщения, решения, нерешённые вопросы и граф связей. Работает после новой сессии или сокращения контекста. Сотрудник видит только свои задачи; управленческие черновики доступны руководителю. Для старой истории передай nextBefore в before.',
  inputSchema: z.object({ taskId: z.string().min(1).max(80), before: z.string().max(300).optional(), limit: z.number().int().min(1).max(50).optional() }),
  execute({ taskId, before, limit }, ctx) {
    return taskMemory(readState(), currentEmployee(ctx), taskId, { before, limit });
  },
});
