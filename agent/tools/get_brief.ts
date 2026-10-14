import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee,readState } from '../lib/store';
import { buildBrief } from '../../dist/domain.js';
export default defineTool({description:'Получить сводку по вопросам, препятствиям и отсутствующим ответам. Только руководителю.',inputSchema:z.object({}),execute(_input,ctx){if(currentEmployee(ctx).role!=='manager')throw new Error('Сводка доступна только руководителю');return buildBrief(readState(),new Date().toISOString());}});
