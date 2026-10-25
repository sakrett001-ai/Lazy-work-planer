// Offline visual fixture using the actual workspace renderer. No server or credentials.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {JSDOM} from 'jsdom';
import {installPrototype} from '../dist/prototype-ui.js';
const out=resolve(process.argv[2]||'/tmp/pulse-card-preview');mkdirSync(out,{recursive:true});
const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{pretendToBeVisual:true});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.setInterval=()=>0;
const now=Date.parse('2026-10-25T15:00:00Z');Date.now=()=>now;
const rows=[['planned','Без назначенного срока',null],['planned','Срок приближается','2026-10-26','10:00'],['active','Работа идёт','2026-10-28'],['active','Срок через 12 часов','2026-10-26','06:00'],['active','Срок через час','2026-10-25','19:00'],['active','Нужен результат','2026-10-24'],['blocked','Ждём исходные данные','2026-10-28'],['blocked','Препятствие и просрочка','2026-10-24'],['review','Результат на проверке','2026-10-28'],['review','На проверке после срока','2026-10-24']];
const tasks=rows.map(([status,title,due,dueTime],i)=>({id:'Пример-'+(i+1),version:1,status,title,due,dueTime,employeeId:'sample',summary:'Вымышленная карточка для проверки отображения.',...(status==='blocked'?{blocker:'Ждём данные'}:{})}));
const state={identity:{id:'demo',role:'manager'},snapshot:{tasks,preferences:{pins:[],seen:{}},employees:[{id:'sample',name:'Участник команды'}],assistant:{available:false},brief:{text:'Локальный просмотр. Не рабочие данные.'}}};
const ctx={get:()=>state,busy:()=>false,note(){},date:x=>x,renderBoard(){}};
const ui=installPrototype(ctx),d=document;
d.querySelector('#board').innerHTML=ui.renderBoard(tasks);d.querySelector('#workspace').hidden=false;d.querySelector('#login-panel').hidden=true;d.querySelector('#loading')?.remove();
d.querySelector('#greeting').textContent='Локальный просмотр · вымышленные карточки · 25 октября, 18:00 мск';
d.querySelector('#freshness').textContent='Не подключено к серверу';
const accepted={...tasks[0],id:'Пример-9',status:'done',title:'Результат принят',due:null};state.filter='done';const acceptedHTML=ui.renderBoard([accepted]);

d.querySelector('#board').className='board kanban-board';
// Serialized markup has no installPrototype handlers. Keep enabled visual styling
// (disabled controls artificially dim card content), but attach no mutation API.
for(const el of d.querySelectorAll('script'))el.remove();
const notice=d.createElement('p');notice.id='preview-notice';notice.className='report-note';
notice.textContent='Демо для визуальной проверки. Все данные вымышлены. Действия не подключены; работает только переключатель «Пульс».';
d.querySelector('#workspace').prepend(notice);
const gallery=d.createElement('section');gallery.setAttribute('aria-label','Проверка размеров эмблемы');
gallery.style.cssText='background:#080d1b;padding:20px;margin:24px 0;border:1px solid #30415d;border-radius:12px';
gallery.innerHTML='<h2 style="font-size:14px;margin-bottom:16px">Эмблема · проверка малых размеров</h2><div style="display:flex;align-items:end;gap:28px">'+[16,24,32,48].map(size=>`<figure style="margin:0;text-align:center"><img src="./pulse-mark.svg" alt="" width="${size}" height="${size}" style="display:block;margin:0 auto 12px"><figcaption style="font-size:12px;color:#acbad3">${size} px</figcaption></figure>`).join('')+'</div>';
d.querySelector('#workspace').append(gallery);
const script=d.createElement('script');script.type='module';script.textContent="import {createCardPulseController} from './pulse-motion.js';const controller=createCardPulseController(document.querySelector('#board'));window.addEventListener('pagehide',()=>controller.destroy());document.addEventListener('click',e=>{if(e.target.closest('button,a')||(e.target.matches('input')&&e.target.id!=='pulse'))e.preventDefault();});document.addEventListener('submit',e=>e.preventDefault());document.querySelector('#pulse').addEventListener('change',e=>{document.body.classList.toggle('quiet-motion',!e.target.checked);controller.sync();});document.addEventListener('visibilitychange',()=>document.body.classList.toggle('page-hidden',document.hidden));";d.body.append(script);
d.querySelector('#board-guide').textContent='Визуальная проверка открытых карточек: состояния, сроки и препятствия. Действия не подключены.';
writeFileSync(join(out,'index.html'),dom.serialize());
d.querySelector('#board').className='board kanban-board kanban-archive';d.querySelector('#board').innerHTML=acceptedHTML;
d.querySelector('#board-guide').textContent='Визуальная проверка принятого результата: статичная линия. Действия не подключены.';
for(const tab of d.querySelectorAll('[data-filter]'))tab.setAttribute('aria-pressed',String(tab.dataset.filter==='done'));
writeFileSync(join(out,'archive.html'),dom.serialize());
for(const file of ['pilot.css','prototype.css','pilot-theme.css','pulse-mark.svg','pulse-motion.js','pulse-signal.js'])copyFileSync(new URL('../dist/'+file,import.meta.url),join(out,file));
console.log(out);dom.window.close();
