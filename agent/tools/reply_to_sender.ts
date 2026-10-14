import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee,getSource } from '../lib/store';
import { sendToEmployee } from '../lib/telegram';
export default defineTool({description:'Ответить только проверенному автору исходного сообщения. В режиме без отправки сохраняет черновик. Для каждого исходного сообщения разрешён один ответ.',inputSchema:z.object({sourceId:z.string().max(150),text:z.string().min(1).max(3500)}),async execute({sourceId,text},ctx){const p=currentEmployee(ctx),s=getSource(sourceId);if(s.employeeId!==p.id)throw new Error('Нет доступа к адресату');return sendToEmployee(p.id,text,`reply:${s.id}`);},endsTurn:true});
