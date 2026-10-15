import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { finishAssistantJob } from '../lib/prototype';

export default defineTool({
  description: 'Сохранить итог консультации в рабочем пространстве для проверенного WEB_JOB_ID. Сначала прочитай память задачи. Раздели факты, неизвестное и предлагаемые действия; приложи дословные цитаты. Не меняет задачу и не отправляет сообщения. Доступно только в веб-консультации.',
  inputSchema: z.object({ text: z.string().trim().min(1).max(8000), references: z.array(z.object({ sourceId: z.string().min(1).max(150), quote: z.string().trim().min(1).max(1200) })).max(8) }),
  execute(input, ctx) { return finishAssistantJob(ctx, input); },
  endsTurn: true,
});
