import { createHash,timingSafeEqual } from 'node:crypto';
import { database,getEmployee } from './store';
export function matchesSecret(actual:string|null,expected:string|undefined){if(!actual||!expected||expected.length<20)return false;return timingSafeEqual(createHash('sha256').update(actual).digest(),createHash('sha256').update(expected).digest());}
export async function sendToEmployee(employeeId:string,text:string,key:string){
  const p=getEmployee(employeeId);if(!p.telegramId||!/^\d+$/.test(p.telegramId))throw new Error('Проверенный Telegram-аккаунт не привязан');
  const db=database(),old=db.prepare('SELECT status,data,created_at FROM outbox WHERE id=?').get(key) as {status:string;data:string;created_at:string}|undefined;
  if(old)return {status:old.status,duplicate:true,sentAt:old.status==='sent'?(JSON.parse(old.data).sent_at||old.created_at):null};
  const enabled=process.env.ASSISTANT_DELIVERY_ENABLED==='true',token=process.env.TELEGRAM_BOT_TOKEN;
  const payload={chat_id:p.telegramId,text:text.slice(0,3900)};
  if(enabled&&!token)throw new Error('Токен Telegram не настроен');
  const inserted=db.prepare('INSERT OR IGNORE INTO outbox VALUES (?,?,?,?,?)').run(key,p.id,enabled?'sending':'draft',JSON.stringify(payload),new Date().toISOString());
  if(!inserted.changes)return {status:'already_claimed',duplicate:true};
  if(!enabled)return {status:'draft',duplicate:false};
  try{
    const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
    const data=await response.json() as {ok?:boolean;result?:{message_id:number}};
    if(!response.ok||!data.ok){db.prepare('UPDATE outbox SET status=? WHERE id=?').run('rejected',key);return {status:'rejected',duplicate:false};}
    const sentAt=new Date().toISOString();
    db.prepare('UPDATE outbox SET status=?,data=? WHERE id=?').run('sent',JSON.stringify({...payload,message_id:data.result?.message_id,sent_at:sentAt}),key);return {status:'sent',duplicate:false,sentAt};
  }catch{db.prepare('UPDATE outbox SET status=? WHERE id=?').run('uncertain',key);return {status:'uncertain',duplicate:false};}
}
