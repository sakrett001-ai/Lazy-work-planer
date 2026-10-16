import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { readAssistantContext } from '../lib/prototype';

export default defineTool({
  description: 'Начни консультацию с компактной памяти задачи: текущие факты, утверждённый и предложенный срок, вопросы, происхождение фактов и короткие фрагменты источников. Полные оригиналы сохраняются; пропуски явно отмечены. Для точного дочитывания используй read_task_source, для истории — get_task_memory.',
  inputSchema: z.object({ taskId: z.string().min(1).max(150) }),
  execute({ taskId }, ctx) { return readAssistantContext(ctx, taskId); },
});
