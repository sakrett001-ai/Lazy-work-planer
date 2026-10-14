import { defineSchedule } from 'eve/schedules';
import { readState,updateState } from '../lib/store';
import { sendToEmployee } from '../lib/telegram';
import { shouldCheckIn,reconcileNoReplies } from '../../dist/domain.js';
export default defineSchedule({cron:'0 7,13 * * 1-5',async run(){
  if(process.env.ASSISTANT_DELIVERY_ENABLED!=='true')return;
  const now=new Date().toISOString(),state=updateState(s=>reconcileNoReplies(s,now)),slot=now.slice(0,13);
  for(const employee of state.employees){if(!employee.telegramId||employee.role==='manager')continue;
    const tasks=state.tasks.filter(t=>t.employeeId===employee.id&&shouldCheckIn(t,now,state.settings));if(!tasks.length)continue;
    const text=`${employee.name}, добрый день. Подскажите статус поручений:\n\n${tasks.map(t=>`${t.id} · ${t.title}\nСрок: ${t.due}`).join('\n\n')}\n\nУкажите ID задачи и коротко: что готово, что осталось, есть ли препятствие и нужна ли помощь.`;
    const result=await sendToEmployee(employee.id,text,`check-in:${employee.id}:${slot}`);
    if(result.status==='sent')updateState(s=>({...s,tasks:s.tasks.map(t=>tasks.some(x=>x.id===t.id)?{...t,lastRequestedAt:now,contact:t.contact==='answered'?'awaiting':t.contact}:t)}));
  }
}});
