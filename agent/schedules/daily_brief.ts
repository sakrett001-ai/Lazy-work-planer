import { defineSchedule } from 'eve/schedules';
import { updateState } from '../lib/store';
import { sendToEmployee } from '../lib/telegram';
import { buildBrief,reconcileNoReplies,localDateKey } from '../../dist/domain.js';
export default defineSchedule({cron:'30 14 * * 1-5',async run(){
  if(process.env.ASSISTANT_DELIVERY_ENABLED!=='true')return;
  const now=new Date().toISOString(),s=updateState(s=>reconcileNoReplies(s,now));if(s.settings.excludedDates.includes(localDateKey(now)))return;
  const brief=buildBrief(s,now);for(const p of s.employees.filter(p=>p.role==='manager'&&p.telegramId))await sendToEmployee(p.id,brief.text,`brief:${p.id}:${now.slice(0,10)}`);
}});
