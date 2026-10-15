const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const labels = { planned:'Запланировано', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const fields = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const base = new URL('./api/', document.baseURI);
let identity = null, csrf = '', snapshot = null, filter = 'open', selected = null, memory = null, busy = false, refreshing = false, epoch = 0;
let pendingReport = null, pendingDecision = null;

function date(value, time = false) {
  if (!value) return 'Не задан';
  const d = new Date(value.length === 10 ? value + 'T12:00:00+03:00' : value);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', day:'numeric', month:'short', ...(time ? { hour:'2-digit', minute:'2-digit' } : { year:'numeric' }) }).format(d) : 'Не указан';
}
function note(selector, text, success = false) { const el=$(selector); if (el) { el.textContent=text; el.classList.toggle('success',success); } }
function signOut() {
  identity=null; csrf=''; snapshot=null; selected=null; memory=null; epoch++; pendingReport=null; pendingDecision=null;
  $('#workspace').hidden=true; $('#identity').hidden=true; $('#login-panel').hidden=false; $('#loading').hidden=true;
  $('#board').replaceChildren(); $('#task-content').replaceChildren(); if ($('#task-dialog').open) $('#task-dialog').close();
}
async function api(path, body) {
  let response;
  try { response=await fetch(new URL(path,base), { credentials:'same-origin', redirect:'error', ...(body === undefined ? {} : { method:'POST', headers:{ 'content-type':'application/json', 'x-csrf-token':csrf }, body:JSON.stringify(body) }) }); }
  catch { throw new Error('Подтверждение не получено: связь прервалась. Повтори действие после восстановления связи.'); }
  let data;
  try { data=await response.json(); } catch { throw new Error('Рабочее подключение недоступно. Открой адрес сервера, который выдал организатор пилота.'); }
  if (!response.ok) { const error=new Error(data.error || 'Не удалось выполнить действие.'); error.status=response.status; if (response.status===401 && identity) signOut(); throw error; }
  return data;
}
function setBusy(value) {
  busy=value;
  document.querySelectorAll('#task-dialog [data-decision],#report-form button,#login-form button,#logout').forEach(el=>{el.disabled=value;});
}
function renderBoard() {
  if (!snapshot || !identity) return;
  const metrics=snapshot.brief.metrics;
  $('#metrics').innerHTML=[['Открытые задачи',metrics.open],['Нужно решение',metrics.decision],['Есть препятствие',metrics.blocked],['Нет ответа',metrics.noReply]].map(([title,count])=>`<div class="metric"><span>${title}</span><strong>${Number(count)}</strong></div>`).join('');
  const search=$('#search').value.trim().toLocaleLowerCase('ru');
  const tasks=snapshot.tasks.filter(t=>filter==='done'?t.status==='done':t.status!=='done'&&(filter!=='attention'||t.needsDecision||t.needsClarification||t.status==='blocked'||t.contact==='no_reply'))
    .filter(t=>[t.id,t.title,t.project].join(' ').toLocaleLowerCase('ru').includes(search))
    .sort((a,b)=>Number(Boolean(b.needsDecision))-Number(Boolean(a.needsDecision))||Number(b.status==='blocked')-Number(a.status==='blocked')||(a.due||'9999').localeCompare(b.due||'9999'));
  $('#board').innerHTML=tasks.length?tasks.map(t=>{
    const status=Object.hasOwn(labels,t.status)?t.status:'planned', person=snapshot.employees.find(p=>p.id===t.employeeId)?.name||'Исполнитель';
    const protocol=t.protocol?`<div>Протокол ${escape(t.protocol.number||'без номера')}${t.protocol.point?' · п. '+escape(t.protocol.point):''}</div>`:'';
    return `<button class="task ${status} ${t.needsDecision?'needs-decision':''}" data-task="${escape(t.id)}"><span class="task-top"><span>${escape(t.id)}</span><span class="status">${labels[status]}</span></span><h2>${escape(t.title)}</h2><p class="summary">${escape(t.summary||'Ждём первое обновление.')}</p><div class="task-meta">${escape(person)}${t.project?' · '+escape(t.project):''}${protocol}<div>${t.due?'Срок: '+date(t.due):'Без установленного срока'}</div></div><span class="task-bottom"><span>${t.proposedDue?'Запрошен перенос':t.needsDecision?'Требуется решение':t.needsClarification?'Нужно уточнение':'Открыть задачу и память'}</span><span aria-hidden="true">↗</span></span></button>`;
  }).join(''):'<div class="empty">Задач по выбранным условиям пока нет.</div>';
  $('#freshness').textContent='Обновлено '+date(snapshot.asOf,true)+' · московское время';
}
async function refresh() {
  if (!identity || refreshing) return;
  refreshing=true; $('#refresh').disabled=true; const version=epoch;
  try { const data=await api('tasks'); if (version===epoch && identity) {snapshot=data;renderBoard();} }
  finally { refreshing=false; $('#refresh').disabled=false; }
}
async function enter() {
  const data=await api('session'); identity=data.actor; csrf=data.csrf; epoch++;
  $('#person').textContent=identity.name; $('#identity').hidden=false; $('#login-panel').hidden=true; $('#loading').hidden=true; $('#workspace').hidden=false;
  $('#page-title').textContent=identity.role==='manager'?'Всё, что требует внимания.':'Мои задачи. Общий результат.';
  $('#greeting').textContent=identity.role==='manager'?'Факты, препятствия и решения — с сохранёнными основаниями.':'Сообщай, что готово и где нужна помощь. История останется у задачи.';
  await refresh();
}
const sourceLink = id => { const index=memory?.sources.findIndex(s=>s.id===id)??-1; return index>=0?`<a href="#source-${index}">Сообщение-основание ↗</a>`:''; };
function sourcesMarkup() { return memory.sources.map((s,i)=>`<article class="source" id="source-${i}"><p>${escape(s.text)}</p><small>${escape(snapshot.employees.find(p=>p.id===s.employeeId)?.name||'Сотрудник')} · ${date(s.occurredAt,true)}${s.simulated?' · пример':''}</small></article>`).join('')||'<p class="report-note">Исходных сообщений пока нет.</p>'; }
function eventMarkup(event) { return `<div class="history-item"><p>${escape(event.text)}</p>${sourceLink(event.sourceId)}<small>${date(event.at,true)}${event.kind==='late_report'?' · сохранено в истории без изменения текущего состояния':''}</small></div>`; }
function renderMemory() {
  if (!selected || !memory || !identity) return;
  const task=snapshot.tasks.find(t=>t.id===selected), current=memory.current;
  const needDecision=memory.facts.find(f=>f.field==='needsDecision')?.value;
  const actions=identity.role==='manager'?[...(current.proposedDue?[['approve_due','Согласовать срок'],['reject_due','Сохранить прежний срок']]:[]),...(current.status==='review'?[['accept','Принять результат']]:[]),...(needDecision&&current.status!=='review'&&!current.proposedDue?[['take_control','Взять вопрос в работу']]:[])]:[];
  const own=task?.employeeId===identity.id && current.status!=='done';
  $('#task-content').innerHTML=`<header class="detail-header"><span class="eyebrow">${escape(selected)} · ${escape(labels[current.status]||current.status)}</span><h2 id="task-title">${escape(memory.title)}</h2><p>Память и связи задачи · Источники сохраняются вместе с историей</p></header><p id="detail-message" class="message" role="status" aria-live="polite"></p>
    ${actions.length?`<section class="detail-section"><h3>Решение руководителя</h3><p class="report-note">${current.proposedDue?`Предложено: ${date(current.proposedDue)}. Действующий срок: ${date(current.due)}.`:'Проверь результат и основания перед решением.'} Нажатие изменит задачу и сохранится в истории.</p><div class="actions">${actions.map(([action,label])=>`<button class="${action==='reject_due'?'secondary':'primary'}" data-decision="${action}">${label}</button>`).join('')}</div></section>`:''}
    ${own?`<section class="detail-section"><h3>Твоё обновление</h3><form id="report-form"><label for="report-text">Что уже готово, что мешает и какой следующий шаг?</label><textarea id="report-text" name="text" required maxlength="4000" placeholder="Например: данные ещё не получены, нужна помощь с согласованием."></textarea><p class="report-note">Сообщение станет источником в памяти задачи. Перенос срока и приёмку подтверждает руководитель.</p><button type="submit" class="primary">Сохранить обновление ↗</button></form></section>`:''}
    <section class="detail-section"><h3>Что известно сейчас</h3><div class="facts">${memory.facts.map(f=>{const value=f.field==='status'?labels[f.value]||f.value:typeof f.value==='boolean'?(f.value?'Да':'Нет'):f.value||'Не указано';const event=memory.timeline.find(e=>e.key===f.origin.eventId)||memory.recentDecisions.find(e=>e.key===f.origin.eventId);return `<div class="fact"><span>${fields[f.field]||escape(f.field)}</span><p>${escape(value)}</p>${sourceLink(f.origin.sourceId)||`<span>${event?'Изменение в истории: '+date(event.at,true):f.origin.eventId?'Сохранённое изменение карточки':'Данные карточки; сообщение-основание не задано'}</span>`}</div>`;}).join('')}</div></section>
    ${memory.openQuestions.length?`<section class="detail-section"><h3>Осталось решить</h3><ul>${memory.openQuestions.map(q=>`<li>${escape(q)}</li>`).join('')}</ul></section>`:''}
    <section class="detail-section"><h3>Сообщения-основания</h3><div id="sources">${sourcesMarkup()}</div></section>
    ${memory.recentDecisions.length?`<section class="detail-section"><h3>Решения руководителя</h3>${memory.recentDecisions.map(eventMarkup).join('')}</section>`:''}
    ${memory.drafts.length?`<section class="detail-section"><h3>Предложения для рассмотрения</h3>${memory.drafts.map(d=>`<article class="draft"><p>${escape(d.title)} · черновик</p><pre>${escape(d.body)}</pre><small>Не отправлено. Решение не принято.</small></article>`).join('')}</section>`:''}
    <section class="detail-section"><h3>История</h3><div id="timeline">${memory.timeline.map(eventMarkup).join('')||'<p class="report-note">Первое обновление начнёт историю этой задачи.</p>'}</div>${memory.page.nextBefore?'<button id="older" class="secondary">Более ранние события</button>':''}</section>
    <section class="detail-section"><details><summary>Связи в памяти · ${memory.graph.edges.length}</summary><ul>${memory.graph.edges.map(edge=>{const from=memory.graph.nodes.find(n=>n.id===edge.from),to=memory.graph.nodes.find(n=>n.id===edge.to);const relations={assigned_to:'назначено',required_by:'основание',part_of:'входит в проект',step_of:'этап задачи',depends_on:'зависит от',reports_on:'сообщение о задаче',recorded_for:'событие задачи',history_only:'более раннее сообщение',supported_by:'подтверждается источником',proposes:'предложение по задаче',context_from:'контекст из сообщения'};return `<li>${escape(from?.title||from?.name||from?.text?.slice(0,90)||'Запись')} → ${escape(relations[edge.relation]||edge.relation)} → ${escape(to?.title||to?.name||to?.text?.slice(0,90)||'Запись')}</li>`;}).join('')}</ul></details></section>`;
  setBusy(busy);
}
async function openTask(id) {
  selected=id; memory=null; const version=epoch;
  $('#task-content').innerHTML='<h2 id="task-title">Загружаем память задачи…</h2><p id="detail-message" class="message" role="status"></p>';
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
  try { const data=await api('memory?taskId='+encodeURIComponent(id)); if (version===epoch && selected===id) {memory=data;renderMemory();} }
  catch(error) { note('#detail-message',error.message); }
}
async function older() {
  if (!memory?.page.nextBefore) return;
  const id=selected, version=epoch, button=$('#older'); button.disabled=true;
  try { const data=await api('memory?taskId='+encodeURIComponent(id)+'&before='+encodeURIComponent(memory.page.nextBefore));
    if (version!==epoch || id!==selected || !memory) return;
    for (const source of data.sources) if (!memory.sources.some(s=>s.id===source.id)) memory.sources.push(source);
    $('#sources').innerHTML=sourcesMarkup();
    $('#timeline').insertAdjacentHTML('beforeend',data.timeline.map(eventMarkup).join('')); memory.page=data.page;
    if (!data.page.nextBefore) button.remove();
  } catch(error) {note('#detail-message',error.message);} finally {button.disabled=false;}
}
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy)return; setBusy(true); note('#login-message','');
  try { await api('login',{code:$('#login-code').value.trim()}); $('#login-code').value=''; await enter(); }
  catch(error) {note('#login-message',error.message);} finally {setBusy(false);}
});
$('#logout').addEventListener('click',async()=>{if(busy)return;setBusy(true);try{await api('logout',{});signOut();}catch(error){note('#workspace-message',error.message);}finally{setBusy(false);}});
$('#refresh').addEventListener('click',()=>refresh().then(()=>note('#workspace-message','')).catch(error=>note('#workspace-message',error.message)));
$('#search').addEventListener('input',renderBoard);
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderBoard();}));
$('#board').addEventListener('click',event=>{const button=event.target.closest('[data-task]');if(button)openTask(button.dataset.task);});
$('#close-dialog').addEventListener('click',()=>{if(!busy)$('#task-dialog').close();});
$('#task-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('#task-dialog').addEventListener('close',()=>{selected=null;memory=null;});
$('#task-dialog').addEventListener('click',async event=>{
  if(event.target.closest('#older')){if(!busy)await older();return;}
  const button=event.target.closest('[data-decision]');if(!button||busy||!memory)return;
  const input={taskId:selected,action:button.dataset.decision,expectedVersion:memory.taskVersion};
  if(!pendingDecision||JSON.stringify(pendingDecision.input)!==JSON.stringify(input))pendingDecision={input,requestId:crypto.randomUUID()};
  setBusy(true);const id=selected;
  try {await api('decision',{...input,requestId:pendingDecision.requestId});pendingDecision=null;await refresh();await openTask(id);note('#detail-message','Решение сохранено в истории.',true);}
  catch(error){if(error.status===409){pendingDecision=null;await refresh().catch(()=>{});await openTask(id);}note('#detail-message',error.message);}
  finally{setBusy(false);}
});
$('#task-dialog').addEventListener('submit',async event=>{
  if(event.target.id!=='report-form')return;event.preventDefault();if(busy)return;
  const input={taskId:selected,text:$('#report-text').value.trim()};if(!input.text)return;
  if(!pendingReport||JSON.stringify(pendingReport.input)!==JSON.stringify(input))pendingReport={input,requestId:crypto.randomUUID()};
  setBusy(true);const id=selected;
  try {const result=await api('report',{...input,requestId:pendingReport.requestId});pendingReport=null;await refresh();await openTask(id);note('#detail-message',result.reply||'Обновление сохранено.',true);}
  catch(error){note('#detail-message',error.message);}
  finally{setBusy(false);}
});
const poll=setInterval(()=>{if(identity&&!document.hidden&&!$('#task-dialog').open&&!busy)refresh().catch(error=>note('#workspace-message',error.message));},15000);
window.addEventListener('pagehide',()=>clearInterval(poll));
enter().catch(error=>{if(!identity)signOut();if(error.status!==401)note(identity?'#workspace-message':'#login-message',error.message);});
