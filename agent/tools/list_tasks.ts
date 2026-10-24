import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { visibleTask } from '../../dist/access.js';
import { currentEmployee,readState } from '../lib/store';
export default defineTool({description:'Прочитать доступные текущему проверенному сотруднику задачи. Руководитель видит все задачи.',inputSchema:z.object({}),execute(_input,ctx){const p=currentEmployee(ctx),s=readState();return {employee:{id:p.id,name:p.name,role:p.role||'employee'},tasks:s.tasks.filter(t=>p.role==='manager'||t.employeeId===p.id).map(t=>visibleTask(s,p,t))};}});
