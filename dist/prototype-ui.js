import {createCardPulseController} from './pulse-motion.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const labels = { planned:'Запланировано', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const boardColumns = [['planned','Запланировано'],['active','В работе'],['blocked','Препятствие'],['review','На проверке']];
const draftNames = { extension:'Письмо о переносе', request:'Запрос данных', clarify:'Уточнение статуса', plan:'План действий', review:'Проверка результата' };
const fieldNames = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const shift = (day, n) => new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow' }).format(new Date());

export function decisionEvidenceMarkup(job) {
  if (job.status !== 'completed') return '';
  return (job.decisionReferences || []).map(ref => `<blockquote>По записи платформы результат принят.<small>${esc(ref.actorName || 'Руководитель')} · ${esc(ref.at || '')}</small></blockquote>`).join('');
}

// Host-recorded state, never inferred from model prose or presence of a route.
export function assistantReviewLabel(job) {
  if (!job.execution) return 'Независимая проверка не подтверждена.';
  if (job.execution.reviewStatus === 'passed' && job.status === 'completed') return 'Ответ прошёл проверку моделью; решение остаётся за тобой.';
  if (job.execution.reviewStatus === 'rejected') return 'Проверяющий отклонил ответ; черновик не опубликован.';
  if (job.execution.reviewStatus === 'not_run' && job.status === 'completed') return 'Независимая проверка не выполнялась.';
  return 'Независимая проверка не подтверждена.';
}

// Derived presentation only: approved deadline, never creation/start or proposedDue.
export function deadlineState(task, now = Date.now()) {
  if (task.status === 'done') return { text:'Завершено', kind:'done' };
  if (!task.due) return { text:'Без срока', kind:'none' };
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  if (!Number.isFinite(remaining)) return { text:'Без срока', kind:'none' };
  const hours = Math.max(1, Math.ceil(Math.abs(remaining) / 3600000));
  const span = hours >= 24 ? `${Math.ceil(hours / 24)} дн.` : `${hours} ч.`;
  return { text:remaining === 0 ? 'Срок наступил' : remaining < 0 ? `Просрочено на ${span}` : remaining < 3600000 ? 'Срок меньше часа' : `Осталось ${span}`,
    kind:remaining <= 0 ? 'overdue' : remaining < 86400000 ? 'soon' : 'normal' };
}
export function cardPulseProgress(task, now = Date.now()) {
  if (!task.due || task.status === 'review' || task.status === 'done') return 0;
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  return Number.isFinite(remaining) ? Math.max(0, Math.min(1, 1 - remaining / 86400000)) : 0;
}
export function cardPulseState(task, now = Date.now()) {
  const due = deadlineState(task, now);
  if (task.status === 'done') return { mode:'done', tone:'accepted' };
  if (task.status === 'review') return { mode:'review', tone:'review' };
  const urgency = due.kind === 'overdue' ? 'overdue' : due.kind === 'soon' ? 'soon' : null;
  if (task.status === 'blocked' || task.blocker?.trim()) return { mode:'blocked', tone:urgency || 'blocked' };
  if (urgency) return { mode:urgency, tone:urgency };
  return task.status === 'active' ? { mode:'active', tone:'active' } : { mode:'planned', tone:'planned' };
}
// Exact approved demo waveforms; only presentation, never a medical measurement.
const pulsePaths = {
  "planned": "M0 26H65 C80 26 85 23 95 23 S115 29 125 29 S145 26 160 26 H300",
  "active": "M0 26H15 C23 26 23 20 28 20 S35 32 40 32 S48 8 54 8 S61 43 68 43 S77 18 84 18 S93 26 102 26 H127 C135 26 135 20 140 20 S147 32 152 32 S160 8 166 8 S173 43 180 43 S189 18 196 18 S205 26 214 26 H239 C247 26 247 20 252 20 S259 32 264 32 S272 8 278 8 S285 26 292 26 H300",
  "soon": "M0 26H7 C12 26 12 20 17 20 S23 33 28 33 S35 8 40 8 S47 43 52 43 S59 19 64 19 S71 26 78 26 H83 C88 26 88 20 93 20 S99 33 104 33 S111 8 116 8 S123 43 128 43 S135 19 140 19 S147 26 154 26 H159 C164 26 164 20 169 20 S175 33 180 33 S187 8 192 8 S199 43 204 43 S211 19 216 19 S223 26 230 26 H235 C240 26 240 20 245 20 S251 33 256 33 S263 8 268 8 S275 43 280 43 S287 26 294 26 H300",
  "overdue": "M0 26H5 C9 26 9 31 13 31 S20 6 25 6 S31 45 36 45 S42 19 47 19 S53 26 58 26 H63 C67 26 67 31 71 31 S78 6 83 6 S89 45 94 45 S100 19 105 19 S111 26 116 26 H121 C125 26 125 31 129 31 S136 6 141 6 S147 45 152 45 S158 19 163 19 S169 26 174 26 H179 C183 26 183 31 187 31 S194 6 199 6 S205 45 210 45 S216 19 221 19 S227 26 232 26 H237 C241 26 241 31 245 31 S252 6 257 6 S263 45 268 45 S274 19 279 19 S285 26 290 26 H300",
  "blocked": "M0 26H55 C64 26 66 24 71 24 S79 29 84 29 S92 22 97 22 S105 29 110 29 S119 26 128 26 H205 C214 26 216 24 221 24 S229 29 234 29 S242 22 247 22 S255 29 260 29 S269 26 278 26 H300",
  "review": "M0 26H300",
  "done": "M0 26H300"
};
export function cardPulsePath(mode) { return pulsePaths[mode] || pulsePaths.planned; }
function pulseMarkup(mode) {
  const path = cardPulsePath(mode);
  return `<div class="card-pulse" aria-hidden="true"><canvas aria-hidden="true"></canvas><svg viewBox="0 0 300 52" preserveAspectRatio="none" focusable="false" aria-hidden="true"><path class="pulse-track" pathLength="740" d="${path}"/><path class="pulse-wave" pathLength="740" d="${path}"/></svg></div>`;
}

export function installPrototype(ctx) {
  const $ = s => document.querySelector(s);
  let view='board', month=today().slice(0,7)+'-01', lastInteraction=Date.now(), auto=false, draft=null, editingTask=null, editingPhase=null, jobsFor=null, lastSignal='', llmSettings=null;
  const pending=new Map();
  let creatingChild=null, reportEpoch=0, displayedReport=null;
  const jobViews=new WeakMap();
  const state=()=>ctx.get();
  const pulseController=createCardPulseController($('#board'));
  const manager=()=>state().identity?.role==='manager';
  const selectedTask=()=>state().memory?.task || state().snapshot?.tasks.find(t=>t.id===state().selected);
  const modalOpen=()=>Boolean(document.querySelector('dialog[open]'));
  const message=(selector,text,success=false)=>ctx.note(selector,text,success);
  const inputValue=(form,name)=>form.elements.namedItem(name)?.value || '';
  const interval = task => deadlineState(task);
  function important(task) { return task.needsDecision || task.needsClarification || task.status==='blocked' || ['no_reply','awaiting'].includes(task.contact) || ['overdue','soon'].includes(interval(task).kind); }
  function person(id) { return state().snapshot?.employees.find(p=>p.id===id)?.name || 'Участник'; }
  function smallButton(action,label,attrs='') { return `<button type="button" class="secondary" ${action} ${attrs}>${label}</button>`; }
  function card(task) {
    const {snapshot}=state(), status=Object.hasOwn(labels,task.status)?task.status:'planned';
    const pin=snapshot.preferences.pins.includes(task.id), signal=important(task)&&snapshot.preferences.seen[task.id]!==task.version;
    const due=interval(task), pulse=cardPulseState(task);
    return `<article data-card-id="${esc(task.id)}" data-pulse="${pulse.mode}" data-pulse-tone="${pulse.tone}" data-pulse-progress="${cardPulseProgress(task)}" class="task ${status} ${pin?'pinned':''} ${signal?'has-signal':''}">
      <div class="task-top"><span>${esc(task.id)}</span><button type="button" class="pin-button ${pin?'is-pinned':''}" data-pin="${esc(task.id)}" aria-pressed="${pin}" aria-label="${pin?'Открепить':'Закрепить'} ${esc(task.title)}" title="${pin?'Открепить':'Закрепить'}">⌖</button></div>
      <button class="card-open" data-task="${esc(task.id)}"><span class="status">${labels[status]}</span><h2>${esc(task.title)}</h2><p class="summary">${esc(task.summary||task.description||'Ожидаем первое обновление.')}</p>
      <div class="task-meta">${esc(person(task.employeeId))}${task.project?' · '+esc(task.project):''}${task.protocol?`<div>Протокол ${esc(task.protocol.number||'без номера')}${task.protocol.point?' · п. '+esc(task.protocol.point):''}${task.protocol.date?' · '+ctx.date(task.protocol.date):''}</div>`:''}</div>
      <div class="card-deadline">${task.due?`<span>Срок</span><time datetime="${esc(task.due)}T${esc(task.dueTime||'18:00')}:00+03:00">${esc(ctx.date(task.due))} · ${esc(task.dueTime||'18:00')} мск</time>`:'<span>Срок не задан</span>'}</div>
      <div class="task-bottom"><span data-deadline-state class="${due.kind}">${esc(due.text)}</span><svg class="card-open-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><path d="M2 10 10 2M3 2h7v7"/></svg></div></button>
      ${signal?`<button class="notice-button" data-notice="${esc(task.id)}">${task.proposedDue?'Запрошен перенос':task.status==='blocked'?'Нужна помощь':task.contact==='awaiting'?'Запрошен статус':'Есть событие'} · заметил ✓</button>`:''}
      ${pulseMarkup(pulse.mode)}
    </article>`;
  }
  // Update only presentation nodes: do not rebuild cards, inputs, focus, or filters.
  function refreshCardTime() {
    if (document.hidden || !state().snapshot) return;
    const tasks = new Map(state().snapshot.tasks.map(task => [task.id, task]));
    const now = Date.now();
    document.querySelectorAll('[data-card-id]').forEach(node => {
      const task = tasks.get(node.dataset.cardId);
      if (!task) return;
      const pulse = cardPulseState(task, now), due = deadlineState(task, now);
      node.dataset.pulse = pulse.mode;
      node.dataset.pulseTone = pulse.tone;
      node.dataset.pulseProgress = String(cardPulseProgress(task, now));
      const path = cardPulsePath(pulse.mode);
      node.querySelectorAll('.card-pulse path').forEach(trace => { if (trace.getAttribute('d') !== path) trace.setAttribute('d', path); });
      const label = node.querySelector('[data-deadline-state]');
      if (label) { label.textContent = due.text; label.className = due.kind; }
    });
    pulseController.refresh();
  }
  function syncVisibility() {
    document.body.classList.toggle('page-hidden', document.hidden);
    if (!document.hidden) refreshCardTime();
  }
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
  function calendar(tasks) {
    const first=new Date(month+'T12:00:00Z'), offset=(first.getUTCDay()+6)%7, start=shift(month,-offset);
    const days=Array.from({length:42},(_,i)=>shift(start,i));
    return `<div class="calendar-scroll"><div class="calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<div class="weekday">${d}</div>`).join('')}${days.map(day=>`<section class="calendar-day ${day.slice(0,7)!==month.slice(0,7)?'outside':''} ${day===today()?'today':''}"><span class="day-number">${Number(day.slice(-2))}</span>${tasks.filter(t=>t.due===day).map(t=>`<button class="calendar-task ${esc(t.status)}" data-task="${esc(t.id)}"><span>${esc(t.title)}</span><small>${esc(person(t.employeeId))}</small></button>`).join('')}</section>`).join('')}</div></div>${tasks.some(t=>!t.due)?`<section class="undated"><h3>Без срока</h3>${tasks.filter(t=>!t.due).map(t=>smallButton(`data-task="${esc(t.id)}"`,esc(t.title))).join('')}</section>`:''}`;
  }
  function gantt(tasks) {
    const days=Array.from({length:28},(_,i)=>shift(month,i));
    const rows=tasks.flatMap(t=>(t.phases?.length?t.phases.map(p=>({task:t,...p})): [{ task:t, title:t.title, start:t.start||today(), end:t.due, done:t.status==='done' }]));
    return `<p class="report-note">28 дней с ${ctx.date(month)}. Этапы раскрыты под задачами; общий срок меняется отдельным решением.</p><div class="gantt-scroll"><div class="gantt"><div class="gantt-header"><span>Задача / этап</span><div class="timeline-track">${days.map(day=>`<span>${Number(day.slice(-2))}</span>`).join('')}</div></div>${rows.map(p=>`<div class="gantt-row"><button data-task="${esc(p.task.id)}"><small>${esc(p.task.id)}${p.dependsOn?' · есть предшествующий этап':''}</small>${esc(p.title)}<small>${p.end?`${ctx.date(p.start)} — ${ctx.date(p.end)}`:'Срок не задан'}</small></button><div class="timeline-track">${days.map(day=>`<span class="phase-cell ${p.end&&day>=p.start&&day<=p.end?'filled':''} ${p.done?'complete':''} ${day===today()?'today':''}"></span>`).join('')}</div></div>`).join('')}</div></div>`;
  }
  function renderBoard(tasks) {
    const {snapshot}=state();
    $('#new-task').hidden=!manager(); $('#team').hidden=!manager(); $('#llm-settings').hidden=!manager(); $('#reports').hidden=!manager();
    $('#mode-label').textContent=snapshot.assistant.available?'ИИ: консультации по задачам':'Сводка и шаблоны · ИИ не подключён';
    $('#example-banner').hidden=!snapshot.examples;
    $('#brief-text').textContent=snapshot.brief.text;
    const signals=tasks.filter(important).map(t=>t.id+':'+t.version).join('|');
    if(auto&&lastSignal&&signals!==lastSignal&&canRefresh())view='board';
    lastSignal=signals;
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
    $('#month-tools').hidden=view==='board';
    $('#month-label').textContent=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'T12:00:00Z'));
    const archive=state().filter==='done';
    $('#board').className=view==='board'?`board kanban-board${archive?' kanban-archive':''}`:'alternate-view';
    $('#board-guide').hidden=view!=='board';
    $('#board-guide').textContent=archive?'Принятые результаты. Вернуть задачу в работу можно из карточки.':'Открой карточку, чтобы начать работу, сообщить статус или принять результат. Закреплённые — первыми в своей колонке.';
    if(!tasks.length)return '<div class="empty"><span class="empty-mark">✦</span>Здесь пока нет задач.<br><small>Измени фильтр или создай первое поручение.</small></div>';
    if(view==='calendar')return calendar(tasks);
    if(view==='gantt')return gantt(tasks);
    const columns=archive?[['done','Принято']]:boardColumns;
    return columns.map(([status,title])=>{
      const items=tasks.filter(task=>task.status===status).sort((a,b)=>Number(snapshot.preferences.pins.includes(b.id))-Number(snapshot.preferences.pins.includes(a.id)));
      return `<section class="kanban-column ${status}" data-column="${status}" aria-labelledby="column-${status}"><header class="kanban-heading"><h2 id="column-${status}">${title}</h2><span class="kanban-count" aria-label="Задач: ${items.length}">${items.length}</span></header><div class="kanban-cards">${items.length?items.map(card).join(''):'<p class="column-empty">Нет задач в этой колонке</p>'}</div></section>`;
    }).join('');
  }
  function delegationMarkup(task) {
    if(!manager())return '';
    const children=state().memory.children||[], done=children.filter(t=>t.status==='done').length;
    const original=Object.hasOwn(task,'originalDue')?(task.originalDue?`${ctx.date(task.originalDue)} · ${esc(task.originalDueTime||'18:00')} мск`:'При постановке срок не задан'):'Первоначальный срок не зафиксирован';
    return `<section class="detail-section delegation"><div class="section-heading"><h3>Дочерние поручения · ${done}/${children.length} принято</h3>${task.status!=='done'?smallButton('data-new-child','+ Поручение исполнителю'):''}</div><p class="report-note">Ответственность за результат остаётся у исполнителя родительского поручения. Дочерние поручения — не последовательные этапы и не закрывают родителя автоматически.</p><p class="report-note">Первоначальный срок: ${original}. Текущий: ${task.due?ctx.date(task.due)+' · '+esc(task.dueTime||'18:00')+' мск':'не задан'}. ${esc(interval(task).text)}</p>${task.parentId?`<p class="report-note">Родительское поручение: ${smallButton(`data-child-open="${esc(task.parentId)}"`,esc(task.parentId))}</p>`:''}${children.map(child=>`<article class="child-task"><button type="button" class="quiet" data-child-open="${esc(child.id)}"><strong>${esc(child.title)}</strong><small>${esc(child.id)} · ${esc(person(child.employeeId))}</small></button><p>${esc(labels[child.status]||child.status)} · ${child.due?ctx.date(child.due)+' · '+esc(child.dueTime||'18:00')+' мск':'Без срока'} · ${esc(interval(child).text)}</p><p>${esc(child.blocker||child.summary||'Ожидаем обновление')}</p></article>`).join('')||'<p class="report-note">Можно распределить части работы между исполнителями, сохранив общий срок и ответственность.</p>'}</section>`;
  }
  function conversationMarkup(source) {
    return `<article data-conversation-source="${esc(source.id)}" class="bubble ${source.kind==='manager_message'?'from-manager':''}"><small>${esc(source.authorName)} · ${ctx.date(source.occurredAt||source.receivedAt,true)}</small><p>${esc(source.text)}</p></article>`;
  }
  function systemEventMarkup(event) {
    return `<article data-conversation-event="${esc(event.key)}" class="report-note"><small>Событие системы · ${ctx.date(event.at,true)}</small><p>${esc(event.text)}</p><small>Это не ответ сотрудника и не подтверждение прогресса.</small></article>`;
  }
  function appendDetail(fresh) {
    const box=$('.conversation');if(!box)return;
    const dialog=$('#task-dialog'),top=dialog.scrollTop,conversationTop=box.scrollTop;
    const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    const tail=box.scrollHeight-box.clientHeight-conversationTop<32;
    const anchor=[...dialog.querySelectorAll('.conversation,textarea,summary,.detail-header,.history-item,.source')].find(el=>el.getBoundingClientRect().bottom>dialog.getBoundingClientRect().top);
    const anchorTop=anchor?.getBoundingClientRect().top;
    const sourceIds=new Set([...box.querySelectorAll('[data-conversation-source]')].map(el=>el.dataset.conversationSource));
    const incoming=fresh.conversation||[];
    if(incoming.length===50 && (!sourceIds.size || !incoming.some(s=>sourceIds.has(s.id)))){
      $('#conversation-gap').hidden=false;
    }
    const added=incoming.filter(s=>!sourceIds.has(s.id));
    if(added.length){box.querySelector('[data-empty-conversation]')?.remove();box.insertAdjacentHTML('beforeend',added.map(conversationMarkup).join(''));}
    const eventIds=new Set([...box.querySelectorAll('[data-conversation-event]')].map(el=>el.dataset.conversationEvent));
    const events=fresh.timeline.filter(e=>e.kind==='no_reply'&&!eventIds.has(e.key));
    box.insertAdjacentHTML('beforeend',events.slice().reverse().map(systemEventMarkup).join(''));
    // Add source references without changing the action snapshot/version or existing nodes.
    let addedSources=0;
    for(const source of fresh.sources)if(!state().memory.sources.some(s=>s.id===source.id)){
      addedSources++;$('#sources [data-empty-sources]')?.remove();state().memory.sources.push(source);
      const template=document.createElement('template');template.innerHTML=ctx.sourcesMarkup();
      const node=template.content.lastElementChild;if(node)$('#sources').append(node);
    }
    const keys=new Set([...$('#timeline').querySelectorAll('[data-event-key]')].map(el=>el.dataset.eventKey));
    const newEvents=fresh.timeline.filter(e=>!keys.has(e.key));
    $('#timeline').insertAdjacentHTML('afterbegin',newEvents.map(ctx.eventMarkup).join(''));
    if(added.length||events.length){
      message('#conversation-updates',`Новых сообщений: ${added.length}. Событий системы: ${events.length}.`);
    }
    if(added.length||newEvents.length||addedSources){
      box.scrollTop=tail&&!typing?box.scrollHeight:conversationTop;
      if(anchor?.isConnected)dialog.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
      else dialog.scrollTop=top;
    }
  }
  function detailMarkup() {
    const {memory,identity,selected}=state(), task=selectedTask(), current=memory.current, own=task.employeeId===identity.id&&current.status!=='done';
    const actions=manager()?[...(current.proposedDue?[['approve_due','Согласовать срок'],['reject_due','Сохранить прежний срок']]:[]),...(current.status==='review'?[['accept','Принять результат']]:[]),...(task.needsDecision&&current.status!=='review'&&!current.proposedDue?[['take_control','Взять вопрос в работу']]:[])]:[];
    const extras=manager()?({planned:[['start','Начать работу']],blocked:[['unblock','Препятствие устранено']],review:[['rework','Вернуть на доработку']],done:[['reopen','Вернуть в работу']]}[current.status]||[]):[];
    const phases=task.phases||[], suggested=memory.suggestion;
    return `<header class="detail-header"><span class="eyebrow">${esc(selected)} · ${esc(labels[current.status]||current.status)}</span><h2 id="task-title">${esc(memory.title)}</h2><p>${esc(person(task.employeeId))} · ${esc(task.project||'Мои поручения')} · ${ctx.date(current.due)}${current.due?' · '+esc(task.dueTime||'18:00')+' мск':''}</p>${task.description?`<p class="task-description">${esc(task.description)}</p>`:''}<div class="actions">${manager()&&current.status!=='done'?smallButton('data-edit-task','Изменить поручение'):''}${extras.map(([action,label])=>smallButton(`data-task-action="${action}"`,label)).join('')}</div></header>
      <p id="detail-message" class="message" role="status" aria-live="polite"></p><p id="detail-updates" class="report-note" role="status" aria-live="polite"></p><button type="button" id="reload-detail" class="secondary" hidden>В задаче есть обновления · показать</button>
      ${delegationMarkup(task)}
      ${actions.length?`<section class="decision-box"><h3>Нужно твоё решение</h3><p>${current.proposedDue?`Предложено: ${ctx.date(current.proposedDue)}. Действующий срок: ${ctx.date(current.due)}.`:esc(task.blocker||task.summary||'Проверь результат и основания.')}</p><div class="actions">${actions.map(([action,label])=>smallButton(`data-decision="${action}"`,label)).join('')}</div><small>Решение изменит задачу и останется в истории.</small></section>`:''}
      <section class="detail-section"><h3>Обсуждение задачи</h3><p id="conversation-updates" class="report-note" role="status" aria-live="polite"></p><p id="conversation-gap" class="report-note" ${(memory.conversation||[]).length===50?'':'hidden'}>Сервер показывает последние 50 сообщений. Более ранние сообщения или промежуток между обновлениями могут отсутствовать здесь. Более ранние события доступны в разделе истории; это не полная история обсуждения.</p><div class="conversation">${(memory.conversation||[]).map(conversationMarkup).join('')||'<p class="report-note" data-empty-conversation>Обсуждение начнётся с первого сообщения.</p>'}${memory.timeline.filter(e=>e.kind==='no_reply').slice().reverse().map(systemEventMarkup).join('')}</div>
      ${own?`<form id="report-form"><label for="report-text">Что готово и где нужна помощь?</label><textarea id="report-text" maxlength="4000" required placeholder="Например: ожидаем исходные данные, нужна помощь…"></textarea><p class="report-note">Ответ сохраняется вместе с источником. Разбор статуса сейчас выполняется по правилам; приёмку и перенос подтверждает руководитель.</p><button class="primary" type="submit">Сообщить статус ↗</button></form>`:manager()&&current.status!=='done'?`<form id="message-form"><label for="manager-message">Сообщение исполнителю</label><textarea id="manager-message" name="text" maxlength="4000" required placeholder="Уточни готовый результат или предложи следующий шаг…"></textarea><label class="check-label"><input type="checkbox" id="manager-request-update" name="requestUpdate"> Запросить обновление статуса</label><button class="primary" type="submit">Добавить в обсуждение ↗</button><small class="report-note">Сообщение появится у исполнителя в этой задаче.</small></form>`:''}</section>
      ${manager()?`<section class="detail-section assistant-section"><span class="eyebrow">Ассистент · следующий шаг</span><h3>${esc(suggested?.title||'Подготовить решение')}</h3><p>${esc(suggested?.detail||'')}</p><div class="actions">${Object.entries(draftNames).map(([kind,label])=>smallButton(`data-template="${kind}"`,label)).join('')}</div><p class="report-note">Эти кнопки создают редактируемые шаблоны на основе карточки. Сроки и отправки остаются отдельными действиями.</p>
      <details class="context-preview"><summary>Что получит ассистент</summary><p class="report-note">Текущие факты, открытые вопросы и фрагменты сообщений. Полные источники доступны для дочитывания.</p>${smallButton('id="preview-context"','Показать контекст')}<div id="context-preview-content"></div></details>
      <details class="ai-consultation" ${state().snapshot.assistant.available?'open':''}><summary>Обсудить с ИИ</summary>${state().snapshot.assistant.available?`<form id="assistant-form"><label for="assistant-question">Какое решение нужно подготовить?</label><textarea id="assistant-question" name="question" maxlength="2000" required placeholder="Предложи варианты снятия препятствия и подготовь письмо…"></textarea><button type="submit" class="secondary">Получить варианты ✦</button></form>`:'<p class="report-note">Чтобы включить консультации, настрой подключение в разделе «Модели и роли». Пока доступны сводка, обсуждение и шаблоны.</p>'}<div id="assistant-jobs"></div></details></section>`:''}
      <section class="detail-section"><div class="section-heading"><h3>Этапы <span class="muted">${phases.filter(p=>p.done).length}/${phases.length}</span></h3>${manager()&&current.status!=='done'?smallButton('data-new-phase','+ Этап'):''}</div>${phases.length?`<progress max="${phases.length}" value="${phases.filter(p=>p.done).length}"></progress><div class="phase-list">${phases.map(p=>`<div class="phase-item"><button class="phase-check" data-phase-toggle="${esc(p.id)}" aria-label="${p.done?'Открыть':'Завершить'} этап ${esc(p.title)}" ${current.status==='done'?'disabled data-unavailable="true"':''}>${p.done?'✓':'○'}</button><div><strong>${esc(p.title)}</strong><small>${ctx.date(p.start)} — ${ctx.date(p.end)}${p.dependsOn?' · после «'+esc(phases.find(x=>x.id===p.dependsOn)?.title||'этапа')+'»':''}</small></div>${manager()&&current.status!=='done'?`<button class="quiet" data-edit-phase="${esc(p.id)}" aria-label="Изменить этап ${esc(p.title)}">Изменить</button>`:''}</div>`).join('')}</div>`:'<p class="report-note">Для составной задачи добавь этапы и зависимости. Они появятся в диаграмме Ганта.</p>'}</section>
      ${manager()?`<section class="detail-section"><h3>Подготовленные документы</h3>${(memory.drafts||[]).map(d=>`<article class="draft"><small>${d.status==='approved'?'Текст согласован · отправка не выполнялась':'Черновик · нужно проверить'} · ${d.generator==='template'?'шаблон':'подготовлен ассистентом'}</small><h3>${esc(d.title)}</h3><p>${esc(d.reason||'')}</p><div class="actions">${smallButton(`data-edit-draft="${esc(d.id)}"`,'Открыть и редактировать')}</div></article>`).join('')||'<p class="report-note">Здесь будут письма, планы и варианты решения.</p>'}</section>`:''}
      <section class="detail-section"><details><summary>Память, основания и история</summary><div class="facts">${memory.facts.map(f=>`<article class="fact"><span>${esc(fieldNames[f.field]||f.label||f.field)}</span><p>${esc(typeof f.value==='boolean'?(f.value?'Да':'Нет'):f.value??'Не задано')}</p>${f.origin?.sourceId?ctx.sourceLink(f.origin.sourceId):'<small>Запись карточки / решение</small>'}</article>`).join('')}</div><h3 class="memory-title">Исходные сообщения</h3><div id="sources">${ctx.sourcesMarkup()}</div><h3 class="memory-title">История</h3><div id="timeline">${memory.timeline.map(ctx.eventMarkup).join('')}</div>${memory.page.nextBefore?smallButton('id="older"','Более ранние записи'):''}<details><summary>Связи памяти: ${memory.graph.edges.length}</summary><ul>${memory.graph.nodes.map(n=>`<li>${esc(n.title||n.name||n.text?.slice(0,100)||n.id)}</li>`).join('')}</ul></details></details></section>`;
  }
  async function mutate(path,input,{dialog,taskId,after}={}) {
    if(ctx.busy())return; ctx.setBusy(true);
    const messageTarget=dialog?'#editor-message':$('#task-dialog').open?'#detail-message':'#workspace-message';
    const taskForm=dialog&&['task-create','task-edit'].includes(path)?$('#task-editor'):null;
    if(taskForm)taskForm.setAttribute('aria-busy','true');
    message(messageTarget,taskForm?'Сохраняем…':'');
    if(taskForm)$(messageTarget).classList.add('pending');
    const key=JSON.stringify({path,input}); if(!pending.has(key))pending.set(key,crypto.randomUUID());
    let saved=false;
    try {
      const result=await ctx.api(path,{...input,requestId:pending.get(key)});saved=true;pending.delete(key);
      if(dialog)$(dialog).close();
      if(after)after(result);
      await ctx.refresh();
      const task=['pin','notice'].includes(path)?null:result.taskId||taskId;
      if(task) {if(path==='message'&&$('#manager-message'))$('#manager-message').value='';await ctx.openTask(task);message('#detail-message',result.alreadyPending?'Запрос уже ожидает ответа. Новое сообщение не добавлено.':'Сохранено.',true);}
      else message('#workspace-message','Сохранено.',true);
      return result;
    } catch(error) { message(saved?'#workspace-message':messageTarget,saved?'Изменение сохранено. Обнови данные, когда связь восстановится.':error.message,saved); }
    finally {
      if(taskForm){taskForm.removeAttribute('aria-busy');$(messageTarget).classList.remove('pending');if($(messageTarget).textContent==='Сохраняем…')message(messageTarget,'');}
      ctx.setBusy(false);
    }
  }
  function openEditor(title,markup) {
    $('#editor-title').textContent=title;$('#editor-content').innerHTML=markup;message('#editor-message','');if(!$('#editor-dialog').open)$('#editor-dialog').showModal();
  }
  function input(name,label,value='',type='text',extra='') { return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
  function showSnapshot(report) {
    displayedReport=report;
    openEditor('Сохранённый отчёт',`<p class="report-note">Снимок на ${esc(ctx.date(report.createdAt,true))}. Последующие изменения карточек не меняют этот отчёт.</p><pre id="snapshot-report-text" class="snapshot-report-text"></pre><div class="actions">${smallButton('id="download-report"','Скачать текст')}${smallButton('id="new-report-selection"','К списку и новому отчёту')}</div>`);
    $('#snapshot-report-text').textContent=report.text;
  }
  async function reportsEditor() {
    if(ctx.busy()||!manager())return;
    const epoch=++reportEpoch,actor=state().identity.id;
    openEditor('Отчёты по поручениям','<p role="status" class="report-note">Загружаем текущие поручения…</p>');
    ctx.setBusy(true);
    try {
      await ctx.refresh();const data=await ctx.api('reports');
      if(epoch!==reportEpoch||state().identity?.id!==actor||!$('#editor-dialog').open)return;
      const tasks=state().snapshot.tasks;
      $('#editor-content').innerHTML=`<form id="snapshot-report-form"><p class="report-note">Выбери до 50 поручений. При выборе родителя дочерние отмечаются автоматически, пока включена опция ниже. Любую галочку можно снять; в отчёт попадут только отмеченные поручения. Отчёт сохранит факты и сроки на момент формирования, без ответа модели.</p><label class="check-label"><input id="include-report-children" type="checkbox" checked> При выборе поручения включать дочерние</label><fieldset class="report-selection"><legend>Поручения в отчёте</legend>${tasks.map(task=>`<label class="report-choice"><input type="checkbox" name="taskIds" value="${esc(task.id)}" data-version="${esc(task.version)}"><span><strong>${esc(task.title)}</strong><small>${esc(task.id)} · ${esc(person(task.employeeId))} · ${esc(labels[task.status]||task.status)}${task.parentId?' · часть '+esc(task.parentId):''}</small></span></label>`).join('')||'<p>Поручений пока нет.</p>'}</fieldset><button class="primary" type="submit" ${tasks.length?'':'disabled'}>Сохранить датированный отчёт</button></form><section class="detail-section"><h3>Сохранённые отчёты</h3><div class="saved-reports">${data.reports.map(report=>smallButton(`data-saved-report="${esc(report.id)}"`,`${ctx.date(report.createdAt,true)} · ${report.taskCount} поручений`)).join('')||'<p class="report-note">Отчётов пока нет.</p>'}</div></section>`;
    }catch(error){if(epoch===reportEpoch)message('#editor-message',error.message);}
    finally{ctx.setBusy(false);}
  }
  async function loadSavedReport(id) {
    if(ctx.busy()||!manager())return;
    const epoch=++reportEpoch,actor=state().identity.id;ctx.setBusy(true);
    try{const data=await ctx.api('reports?id='+encodeURIComponent(id));if(epoch===reportEpoch&&state().identity?.id===actor&&$('#editor-dialog').open)showSnapshot(data.report);}
    catch(error){if(epoch===reportEpoch)message('#editor-message',error.message);}
    finally{ctx.setBusy(false);}
  }
  function includeReportChildren(form, roots) {
    const tasks=state().snapshot.tasks, selected=new Set(roots), visited=new Set();
    let frontier=[...roots];
    for(let depth=0;depth<20&&frontier.length;depth++) {
      const next=[];
      for(const id of frontier){if(visited.has(id))continue;visited.add(id);for(const task of tasks)if(task.parentId===id&&!visited.has(task.id)){selected.add(task.id);next.push(task.id);}}
      frontier=next;
    }
    for(const box of form.querySelectorAll('input[name="taskIds"]'))if(selected.has(box.value))box.checked=true;
  }
  async function saveReportForm(form) {
    if(ctx.busy()||!manager())return;
    const selection=[...form.querySelectorAll('input[name="taskIds"]:checked')].map(el=>({taskId:el.value,expectedVersion:el.dataset.version}));
    if(!selection.length||selection.length>50){message('#editor-message','Выбери от 1 до 50 поручений.');return;}
    const key=JSON.stringify({path:'report-create',selection});if(!pending.has(key))pending.set(key,crypto.randomUUID());
    const epoch=reportEpoch,actor=state().identity.id;ctx.setBusy(true);message('#editor-message','');
    try{const data=await ctx.api('report-create',{requestId:pending.get(key),selection});pending.delete(key);if(epoch===reportEpoch&&state().identity?.id===actor&&$('#editor-dialog').open)showSnapshot(data.report);}
    catch(error){if(epoch===reportEpoch)message('#editor-message',error.status===409?'Поручения изменились. Закрой окно и открой «Отчёты» заново, затем проверь выбор.':error.message);}
    finally{ctx.setBusy(false);}
  }
  function taskEditor(task=null,parent=null) {
    creatingChild=parent?{parentId:parent.id,expectedParentVersion:state().memory.taskVersion}:null;
    editingTask=task?{id:task.id,version:state().memory.taskVersion}:null;
    openEditor(task?'Изменить поручение':parent?'Дочернее поручение':'Новое поручение',`${parent?`<p class="report-note">Часть поручения «${esc(parent.title)}». Назначь отдельного исполнителя и срок. Срок и ответственность родителя не меняются.</p>`:''}<form id="task-editor"><label>Что нужно сделать?<input name="title" required maxlength="160" value="${esc(task?.title||'')}" placeholder="Например: подготовить свод предложений"></label><label>Ожидаемый результат<textarea name="description" maxlength="2000" placeholder="Что должно получиться и как понять, что задача выполнена">${esc(task?.description||'')}</textarea></label><div class="form-grid"><label>Исполнитель<select name="employeeId">${state().snapshot.employees.map(p=>`<option value="${esc(p.id)}" ${p.enabled===false?'disabled':''} ${p.id===(task?.employeeId||state().identity.id)?'selected':''}>${esc(p.name)}${p.enabled===false?' — доступ отключён':''}</option>`).join('')}</select></label>${input('project','Проект',task?.project||'','text','maxlength="120"')}${input('due','Срок (необязательно)',task?.due||'','date')}${input('dueTime','Время, Москва',task?.dueTime||'18:00','time','required')}</div><details ${task?.protocol?'open':''}><summary>Реквизиты протокола — если есть</summary><div class="form-grid">${input('protocolNumber','Номер',task?.protocol?.number||'','text','maxlength="100"')}${input('protocolPoint','Пункт',task?.protocol?.point||'','text','maxlength="100"')}${input('protocolDate','Дата',task?.protocol?.date||'','date')}</div></details><button type="submit" class="primary">${task?'Сохранить изменения':'Поставить задачу'} ↗</button></form>`);
  }
  function phaseEditor(phase=null) {
    const task=selectedTask();editingPhase={id:phase?.id||null,taskId:task.id,version:state().memory.taskVersion};
    openEditor(phase?'Изменить этап':'Новый этап',`<form id="phase-editor">${input('title','Название этапа',phase?.title||'','text','required maxlength="120"')}<div class="form-grid">${input('start','Начало',phase?.start||today(),'date','required')}${input('end','Завершение',phase?.end||task.due||today(),'date','required')}</div><label>Начать после<select name="dependsOn"><option value="">Без зависимости</option>${(task.phases||[]).filter(p=>p.id!==phase?.id).map(p=>`<option value="${esc(p.id)}" ${p.id===phase?.dependsOn?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><p class="report-note">Зависимости проверяются на циклы. Даты этапов не переносят общий срок задачи.</p><button type="submit" class="primary">Сохранить этап</button></form>`);
  }
  function draftEditor(id) {
    const stored=state().memory.drafts.find(d=>d.id===id);if(!stored)return;draft={...stored,taskVersion:state().memory.taskVersion};
    const evidence=`<details><summary>Варианты и основания</summary><p>${esc(draft.reason||'Основание отдельно не указано.')}</p><ul>${(draft.options||[]).map(option=>`<li><strong>${esc(option.label)}</strong> — ${esc(option.consequence)}</li>`).join('')}</ul>${(draft.references||[]).map(ref=>`<blockquote>${esc(ref.quote)}<small>Источник: ${esc(ref.sourceId)} · исходные сообщения доступны в памяти задачи</small></blockquote>`).join('')}</details>`;
    openEditor('Документ к решению',`${evidence}<form id="draft-editor">${input('title','Заголовок',draft.title,'text','required maxlength="200"')}<label>Текст<textarea class="document-body" name="body" required maxlength="6000">${esc(draft.body)}</textarea></label><label>Состояние<select name="status"><option value="draft">Черновик</option><option value="approved" ${draft.status==='approved'?'selected':''}>Текст согласован</option></select></label><p class="report-note">Согласование текста не меняет срок задачи и не отправляет письмо. Поля в квадратных скобках требуют заполнения.</p><div class="actions"><button class="primary" type="submit">Сохранить документ</button>${smallButton('id="download-draft"','Скачать .txt')}</div></form>`);
  }
  function sourceReader(sourceId,version='') {
    return `<div class="source-reader"><div class="source-pages"></div>${smallButton(`data-source-open="${esc(sourceId)}" data-source-version="${esc(version)}" data-source-offset="0"`,'Читать исходное сообщение')}</div>`;
  }
  async function previewContext(button) {
    const {selected,identity}=state(),box=$('#context-preview-content');button.disabled=true;
    try {
      const pack=await ctx.api('context?taskId='+encodeURIComponent(selected));
      if(state().selected!==selected||state().identity?.id!==identity.id||!box.isConnected)return;
      box.innerHTML=`<p><strong>${esc(labels[pack.current.status]||pack.current.status)}</strong> · Срок: ${ctx.date(pack.current.due)}${pack.current.proposedDue?' · Предложено: '+ctx.date(pack.current.proposedDue):''}</p><p>${esc(pack.current.summary)}</p>${pack.current.blocker?`<p>Препятствие: ${esc(pack.current.blocker)}</p>`:''}<ul>${pack.openQuestions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul><p class="report-note">Фрагментов: ${pack.sources.length} из ${pack.coverage.totalSources}. ${pack.coverage.omittedSources||pack.coverage.truncatedFields.length?'Часть сведений сокращена; ассистент может дочитать память и оригиналы.':'Для дополнительной проверки можно открыть оригиналы.'}</p>${pack.sources.map(s=>`<article class="context-source"><small>${esc(s.author)} · ${ctx.date(s.occurredAt,true)}</small><p>${esc(s.preview)}${s.nextOffset!==null?'…':''}</p>${sourceReader(s.sourceId,s.version)}</article>`).join('')}`;
      button.textContent='Обновить контекст';
    }catch(error){if(box.isConnected&&state().selected===selected&&state().identity?.id===identity.id)box.textContent=error.message;}
    finally{button.disabled=false;}
  }
  async function readSource(button) {
    if(button.disabled)return;
    const {selected,identity}=state(),reader=button.closest('.source-reader'),pages=reader.querySelector('.source-pages');button.disabled=true;
    reader.querySelector('.source-error')?.remove();
    const query=new URLSearchParams({taskId:selected,sourceId:button.dataset.sourceOpen,offset:button.dataset.sourceOffset,limit:'1600'});
    if(button.dataset.sourceVersion)query.set('version',button.dataset.sourceVersion);
    try {
      const page=await ctx.api('source?'+query);
      if(state().selected!==selected||state().identity?.id!==identity.id||!reader.isConnected)return;
      pages.insertAdjacentHTML('beforeend',`<article class="source-page"><small>${esc(page.authorName)} · ${ctx.date(page.occurredAt,true)} · ${page.offset+1}–${page.end} из ${page.totalCharacters}</small><p>${esc(page.text)}</p></article>`);
      if(page.nextOffset===null)button.remove();
      else{button.dataset.sourceVersion=page.version;button.dataset.sourceOffset=String(page.nextOffset);button.textContent='Читать дальше';}
    }catch(error){if(reader.isConnected&&state().selected===selected&&state().identity?.id===identity.id)reader.insertAdjacentHTML('beforeend',`<p class="message source-error">${esc(error.message)}</p>`);}
    finally{button.disabled=false;}
  }
  async function loadJobs() {
    const {selected,identity}=state();if(!selected||!identity||!manager()||!$('#assistant-jobs'))return;
    const id=selected, actorId=identity.id, context=ctx.detailContext(); jobsFor=id;
    try { const data=await ctx.api('assistant?taskId='+encodeURIComponent(id));if(context!==ctx.detailContext()||state().selected!==id||state().identity?.id!==actorId||!$('#assistant-jobs'))return;
      const box=$('#assistant-jobs'),signature=JSON.stringify(data.jobs);if(jobViews.get(box)===signature)return;
      box.innerHTML=data.jobs.map(job=>`<article class="ai-result"><small>${ctx.date(job.createdAt,true)} · ${({pending:'В очереди',running:'Ассистент работает',completed:'Ответ подготовлен',failed:'Ответ не опубликован'})[job.status]}</small><h4>${esc(job.question)}</h4>${executionMarkup(job)}<p class="report-note">${esc(assistantReviewLabel(job))}</p>${job.stale?'<p class="message">В задаче появились новые сведения. Сверь ответ с актуальной памятью или задай новый вопрос.</p>':''}<p>${esc(job.text||job.error||'Можно продолжать работать с доской.')}</p>${decisionEvidenceMarkup(job)}${(job.references||[]).map(ref=>`<blockquote>${esc(ref.quote)}<small>Цитата из сообщения по задаче</small>${sourceReader(ref.sourceId,ref.version)}</blockquote>`).join('')}</article>`).join('');
      jobViews.set(box,signature);
    } catch(error) {if(context===ctx.detailContext()&&state().selected===id&&state().identity?.id===actorId&&$('#assistant-jobs')){jobViews.delete($('#assistant-jobs'));$('#assistant-jobs').textContent=error.message;}}
  }
  async function checkDetail() { return ctx.pollDetail?.(); }
  async function reloadDetail() {
    if(ctx.busy())return;
    const id=state().selected;
    ctx.setBusy(true);
    try {await ctx.refresh();await ctx.openTask(id);}
    catch(error){message('#detail-message',error.message);}finally{ctx.setBusy(false);}
  }
  function teamEditor() {
    openEditor('Участники прототипа',`<form id="automation-form"><label class="check-label"><input name="enabled" type="checkbox" ${state().snapshot.autoCheckins?'checked':''}> Ассистент запрашивает статусы в приложении</label><p class="report-note">По будням, 09:00–18:00 по Москве; не чаще раза в 6 часов. Свежий ответ откладывает следующий запрос. Это сообщения внутри задач.</p><button type="submit" class="secondary">Сохранить режим</button></form><div id="team-list">${state().snapshot.employees.map(p=>`<div class="person-row"><div><strong>${esc(p.name)}</strong><small>${p.role==='manager'?'Руководитель':'Сотрудник'}${p.enabled===false?' · Доступ отключён':''}</small></div>${p.enabled!==false&&(p.role!=='manager'||p.id===state().identity.id)?smallButton(`data-invite="${esc(p.id)}"`,'Код входа'):''}${p.enabled!==false&&p.role!=='manager'&&p.id!==state().identity.id?smallButton(`data-disable-person="${esc(p.id)}"`,'Отключить доступ'):''}</div>`).join('')}</div><div id="invite-result" role="status"></div><form id="person-editor"><h3>Добавить сотрудника</h3>${input('name','Имя','','text','required maxlength="120"')}<button class="primary" type="submit">Добавить</button></form>`);
  }
  function disablePersonEditor(employeeId) {
    const employee=state().snapshot.employees.find(p=>p.id===employeeId);
    if(!manager()||!employee||employee.role==='manager'||employee.id===state().identity.id||employee.enabled===false)return;
    openEditor('Отключить доступ сотрудника?',`<form id="person-disable-form" data-employee-id="${esc(employee.id)}"><p><strong>${esc(employee.name)}</strong> больше не сможет войти в рабочее пространство. Все его сеансы и неиспользованные коды входа будут отозваны.</p><p>Поручения, сообщения и история с именем автора сохранятся. Включение доступа обратно здесь недоступно.</p><div class="actions"><button type="button" class="secondary" id="cancel-person-disable">Отмена</button><button type="submit" class="primary">Отключить доступ</button></div></form>`);
  }
  const roleNames={coordinator:'Координатор',analyst:'Аналитик',reviewer:'Проверяющий'};
  const roleDescriptions={coordinator:'Выделяет вопросы и планирует разбор.',analyst:'Готовит сводку, варианты действий и тексты.',reviewer:'Сверяет выводы с источниками и отмечает ошибки.'};
  function modelOptions(connectionId,selected) {
    const connection=llmSettings.connections.find(c=>c.id===connectionId);
    return '<option value="">Выбери модель</option>'+(connection?.models||[]).map(model=>`<option value="${esc(model)}" ${model===selected?'selected':''}>${esc(model)}</option>`).join('');
  }
  async function modelsEditor() {
    if(ctx.busy()||!manager())return;
    const actorId=state().identity.id;ctx.setBusy(true);
    try {
      const settings=await ctx.api('llm-settings');
      if(state().identity?.id!==actorId||!manager())return;
      renderModels(settings);
    }catch(error){message('#workspace-message',error.message);}finally{ctx.setBusy(false);}
  }
  function renderModels(settings) {
      llmSettings=settings;
      openEditor('Модели и роли',`<p class="report-note">Сначала добавь подключение с ключом, затем выбери его для нужных ролей. Для начала достаточно аналитика.</p>
        <div class="section-heading"><h3>Подключения</h3>${smallButton('id="add-connection"','+ Добавить подключение')}</div>
        <div class="connections-list">${settings.connections.map(c=>`<div class="connection-chip ${c.ready?'ready':''}"><strong>${esc(c.label)}</strong> · ${esc(c.providerLabel)} · ${c.ready?'ключ сохранён':'ключ недоступен'}${c.editable?`<button class="quiet" type="button" data-edit-connection="${esc(c.id)}">Изменить / заменить ключ</button>`:'<small>Задано на сервере</small>'}</div>`).join('')||'<p class="message">Подключений пока нет. Нажми «Добавить подключение» и вставь свой API-ключ.</p>'}</div><div id="connection-editor-host"></div>
        ${settings.enabledOnServer?'':'<p class="message">Вызовы ИИ выключены на сервере. Назначения можно сохранить заранее.</p>'}
        <form id="llm-editor">${Object.entries(roleNames).map(([id,label])=>{const role=settings.roles[id];return `<fieldset class="role-settings" data-role="${id}"><legend>${label}</legend><p class="report-note">${roleDescriptions[id]}</p><label class="check-label"><input name="${id}-enabled" type="checkbox" ${role.enabled?'checked':''}> Включена</label><div class="form-grid"><label>Подключение<select name="${id}-connection" data-llm-connection="${id}"><option value="">Выбери подключение</option>${settings.connections.map(c=>`<option value="${esc(c.id)}" ${c.id===role.connectionId?'selected':''}>${esc(c.label)} · ${esc(c.providerLabel)}${c.ready?'':' · нет ключа'}</option>`).join('')}</select></label><label>Модель<select name="${id}-model">${modelOptions(role.connectionId,role.model)}</select></label></div></fieldset>`;}).join('')}
        <p class="report-note">Изменения применятся к новым вопросам. Если подключение недоступно, ответ остановится с ошибкой. Настроенный ключ ещё не означает, что соединение проверено.</p><button type="submit" class="primary">Сохранить назначения</button></form>`);
  }
  function connectionEditor(id=null) {
    if(!llmSettings||ctx.busy())return;
    const c=llmSettings.connections.find(item=>item.id===id);if(id&&!c?.editable)return;
    $('#connection-editor-host').innerHTML=`<form id="connection-editor" class="role-settings" data-connection-id="${esc(c?.id||'')}" data-version="${esc(llmSettings.version)}" data-request-id="${crypto.randomUUID()}" autocomplete="off">
      <h3>${c?'Изменить подключение':'Новое подключение'}</h3><div class="form-grid">${input('label','Название подключения',c?.label||'','text','required maxlength="100" placeholder="Например: VseGPT · рабочий"')}<label>Провайдер<select name="provider" required ${c?'disabled':''}><option value="">Выбери провайдера</option>${Object.entries(llmSettings.providerLabels).map(([value,label])=>`<option value="${value}" ${value===c?.provider?'selected':''}>${esc(label)}</option>`).join('')}</select></label></div>
      <label>API-ключ ${c?'· оставь пустым, чтобы сохранить текущий':''}<input name="apiKey" type="password" ${c?'':'required'} maxlength="8192" autocomplete="new-password" spellcheck="false" autocapitalize="none" placeholder="${c?'Сохранённый ключ скрыт':'Вставь существующий ключ выбранного провайдера'}"></label>
      <label>ID моделей<textarea name="models" required maxlength="8000" rows="3" placeholder="ID из кабинета провайдера, по одному на строку">${esc(c?.models.join('\n')||'')}</textarea></label><p class="report-note">Можно указать несколько моделей через запятую или с новой строки. Они появятся в выборе для ролей.</p>
      <label id="giga-scope-field" ${c?.provider==='gigachat'?'':'hidden'}>Тип доступа GigaChat<select name="scope"><option value="GIGACHAT_API_PERS">Физическое лицо</option><option value="GIGACHAT_API_B2B" ${c?.scope==='GIGACHAT_API_B2B'?'selected':''}>ИП / организация · пакеты</option><option value="GIGACHAT_API_CORP" ${c?.scope==='GIGACHAT_API_CORP'?'selected':''}>ИП / организация · по использованию</option></select></label>
      <p class="report-note">Ключ будет сохранён на сервере в зашифрованном виде. Сохранение не отправляет запрос к модели. Для GigaChat нужен ключ авторизации.</p><p id="connection-message" class="message" role="status"></p><div class="actions"><button type="submit" class="primary">Сохранить подключение</button>${smallButton('id="cancel-connection"','Отмена')}</div></form>`;
    $('#connection-editor input').focus();
  }
  function readRoleForm() {
    const form=$('#llm-editor');return form?Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}])):null;
  }
  async function saveConnectionForm(form) {
    if(ctx.busy()||!manager()||!llmSettings)return;
    const actorId=state().identity.id,roleDraft=readRoleForm(),provider=inputValue(form,'provider');
    const input={requestId:form.dataset.requestId,expectedVersion:form.dataset.version,connectionId:form.dataset.connectionId||null,label:inputValue(form,'label').trim(),provider,
      apiKey:inputValue(form,'apiKey').trim(),models:[...new Set(inputValue(form,'models').split(/[,\n\r]+/).map(s=>s.trim()).filter(Boolean))],...(provider==='gigachat'?{scope:inputValue(form,'scope')}:{})};
    const fields=[...form.querySelectorAll('input,textarea,select')].map(el=>[el,el.disabled]);fields.forEach(([el])=>el.disabled=true);
    ctx.setBusy(true);message('#connection-message','');let saved=false;
    try {
      await ctx.api('llm-connection',input);saved=true;form.elements.namedItem('apiKey').value='';
      const settings=await ctx.api('llm-settings');
      if(state().identity?.id!==actorId||!manager())return;
      renderModels(settings);
      // Adding a connection must not discard role choices still being edited.
      const roles=$('#llm-editor');for(const [id,choice] of Object.entries(roleDraft||{})){
        roles.elements.namedItem(id+'-enabled').checked=choice.enabled;
        roles.elements.namedItem(id+'-connection').value=choice.connectionId||'';
        const model=roles.elements.namedItem(id+'-model');model.innerHTML=modelOptions(choice.connectionId,choice.model);model.value=choice.model||'';
      }
      message('#editor-message','Подключение сохранено. Выбери его для аналитика и сохрани назначения.',true);
      await ctx.refresh();
    }catch(error){message(saved?'#editor-message':'#connection-message',saved?'Подключение сохранено. Открой «Модели и роли» снова, чтобы обновить список.':error.message,saved);}
    finally{input.apiKey='';fields.forEach(([el,disabled])=>el.disabled=disabled);ctx.setBusy(false);}
  }
  function executionMarkup(job) {
    if(!job.execution)return '';
    const errors={auth:'Провайдер отклонил ключ или доступ к модели.',rate_limit:'Достигнут лимит провайдера.',timeout:'Истекло время ожидания модели.',network:'Не удалось связаться с провайдером.',context_changed:'Данные задачи изменились во время разбора. Задай вопрос заново.',review_rejected:'Проверяющий не подтвердил ответ.',disabled:'ИИ выключен на сервере.',configuration:'Подключение требует настройки.',evidence:'Не удалось подтвердить основания ответа.',step_limit:'Достигнут лимит чтения источников.',incomplete:'Модель не завершила ответ.',provider:'Провайдер вернул ошибку.',protocol:'Формат ответа не прошёл проверку.',validation:'Ответ или доступ к задаче не прошёл проверку.',context_size:'Контекст превысил лимит консультации.',response_size:'Ответ превысил допустимый размер.'};
    return `<details class="role-trace"><summary>Кто подготовил ответ</summary><ul>${job.execution.routes.map(r=>`<li><strong>${esc(roleNames[r.roleId]||r.roleId)}</strong> · ${esc(r.connectionLabel)} · ${esc(r.provider)} · ${esc(r.model)}</li>`).join('')}</ul>${job.execution.errorCode?`<p class="message">${esc(errors[job.execution.errorCode]||'Ответ не подтверждён.')}</p>`:''}</details>`;
  }
  function canRefresh() {return !modalOpen()&&!ctx.busy()&&!document.hidden&&Date.now()-lastInteraction>8000&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);}
  const interact=()=>{lastInteraction=Date.now();};document.addEventListener('pointerdown',interact);document.addEventListener('keydown',interact);
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;ctx.renderBoard();}));
  $('#prev-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#next-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#today-month').addEventListener('click',()=>{month=today().slice(0,7)+'-01';ctx.renderBoard();});
  $('#murmuration').addEventListener('change',event=>{auto=event.target.checked;lastInteraction=Date.now();$('#motion-note').textContent=auto?'Смена видов каждые 30 секунд; пауза при взаимодействии.':'Ты управляешь доской.';});
  $('#pulse').addEventListener('change',event=>{document.body.classList.toggle('quiet-motion',!event.target.checked);pulseController.sync();});
  $('#new-task').addEventListener('click',()=>taskEditor());$('#team').addEventListener('click',teamEditor);$('#llm-settings').addEventListener('click',modelsEditor);$('#reports').addEventListener('click',reportsEditor);
  $('#close-editor').addEventListener('click',()=>{if(!ctx.busy())$('#editor-dialog').close();});
  $('#editor-dialog').addEventListener('cancel',event=>{if(ctx.busy())event.preventDefault();});
  $('#editor-dialog').addEventListener('close',()=>{$('#editor-content').replaceChildren();draft=null;editingTask=null;editingPhase=null;llmSettings=null;creatingChild=null;displayedReport=null;reportEpoch++;});
  $('#editor-dialog').addEventListener('change',event=>{
    if(event.target.form?.id==='snapshot-report-form'&&$('#include-report-children')?.checked){const form=event.target.form;if(event.target.name==='taskIds'&&event.target.checked)includeReportChildren(form,[event.target.value]);if(event.target.id==='include-report-children')includeReportChildren(form,[...form.querySelectorAll('input[name="taskIds"]:checked')].map(box=>box.value));}

    if(event.target.form?.id==='connection-editor'){
      event.target.form.dataset.requestId=crypto.randomUUID();
      if(event.target.name==='provider')$('#giga-scope-field').hidden=event.target.value!=='gigachat';
    }
    const role=event.target.dataset.llmConnection;if(!role||!llmSettings)return;
    const model=event.target.form.elements.namedItem(role+'-model');model.innerHTML=modelOptions(event.target.value,null);
  });
  $('#editor-dialog').addEventListener('input',event=>{
    if(event.target.form?.id==='task-editor'&&event.target.name==='title')event.target.setCustomValidity('');
    if(event.target.form?.id==='connection-editor')event.target.form.dataset.requestId=crypto.randomUUID();
  });
  $('#board').addEventListener('click',event=>{const pin=event.target.closest('[data-pin]'),notice=event.target.closest('[data-notice]');if(!pin&&!notice)return;
    const id=(pin||notice).dataset[pin?'pin':'notice'],task=state().snapshot.tasks.find(t=>t.id===id);if(!task)return;
    mutate(pin?'pin':'notice',pin?{taskId:id,pinned:!state().snapshot.preferences.pins.includes(id)}:{taskId:id,expectedVersion:task.version});
  });
  $('#task-dialog').addEventListener('click',event=>{
    if(ctx.busy())return;const button=event.target.closest('button');if(!button)return;const task=selectedTask();if(!task)return;
    if(button.hasAttribute('data-edit-task'))taskEditor(task);
    if(button.hasAttribute('data-new-child'))taskEditor(null,task);
    if(button.dataset.childOpen)ctx.openTask(button.dataset.childOpen).catch(error=>message('#detail-message',error.message));
    if(button.id==='preview-context')previewContext(button);
    if(button.dataset.sourceOpen)readSource(button);
    if(button.id==='reload-detail')reloadDetail();
    if(button.hasAttribute('data-new-phase'))phaseEditor();
    if(button.dataset.editPhase)phaseEditor(task.phases.find(p=>p.id===button.dataset.editPhase));
    if(button.dataset.editDraft)draftEditor(button.dataset.editDraft);
    const target={taskId:task.id,expectedVersion:state().memory.taskVersion};
    if(button.dataset.taskAction)mutate('task-action',{...target,action:button.dataset.taskAction});
    if(button.dataset.phaseToggle){const phase=task.phases.find(p=>p.id===button.dataset.phaseToggle);mutate('phase-toggle',{...target,phaseId:phase.id,done:!phase.done});}
    if(button.dataset.template)mutate('draft-create',{...target,kind:button.dataset.template});
  });
  $('#task-dialog').addEventListener('submit',event=>{
    if(event.target.id==='message-form'){event.preventDefault();mutate('message',{taskId:state().selected,text:inputValue(event.target,'text').trim(),requestUpdate:event.target.elements.requestUpdate.checked});}
    if(event.target.id==='assistant-form'){event.preventDefault();mutate('assistant',{taskId:state().selected,expectedVersion:state().memory.taskVersion,question:inputValue(event.target,'question').trim()},{taskId:state().selected});}
  });
  $('#editor-dialog').addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,dialog='#editor-dialog';
    if(form.id==='snapshot-report-form'){saveReportForm(form);return;}
    if(form.id==='task-editor'){
      if(ctx.busy())return;
      const title=form.elements.namedItem('title');
      title.setCustomValidity(title.value.trim()?'':'Напиши, что нужно сделать — не только пробелы.');
      if(!title.reportValidity()){title.focus();return;}
      const fields=Object.fromEntries(['title','description','employeeId','project','due','dueTime','protocolNumber','protocolPoint','protocolDate'].map(k=>[k,inputValue(form,k)]));mutate(editingTask?'task-edit':'task-create',{fields,...(editingTask?{taskId:editingTask.id,expectedVersion:editingTask.version}:creatingChild||{})},{dialog});}
    if(form.id==='phase-editor')mutate('phase-save',{taskId:editingPhase.taskId,expectedVersion:editingPhase.version,phaseId:editingPhase.id,phase:{title:inputValue(form,'title'),start:inputValue(form,'start'),end:inputValue(form,'end'),dependsOn:inputValue(form,'dependsOn')||null}},{dialog});
    if(form.id==='draft-editor')mutate('draft-save',{draftId:draft.id,expectedVersion:draft.version,expectedTaskVersion:draft.taskVersion,title:inputValue(form,'title'),body:inputValue(form,'body'),status:inputValue(form,'status')},{dialog});
    if(form.id==='automation-form')mutate('automation',{enabled:form.elements.enabled.checked},{dialog});
    if(form.id==='person-disable-form')mutate('person-disable',{employeeId:form.dataset.employeeId},{dialog}).then(result=>{if(result)teamEditor();});
    if(form.id==='person-editor')mutate('person-create',{name:inputValue(form,'name')},{dialog});
    if(form.id==='connection-editor')saveConnectionForm(form);
    if(form.id==='llm-editor'&&llmSettings)mutate('llm-settings',{expectedVersion:llmSettings.version,roles:Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}]))},{dialog});
  });
  $('#editor-dialog').addEventListener('click',async event=>{
    if(!ctx.busy()){
      if(event.target.closest('#cancel-person-disable'))teamEditor();
      const disable=event.target.closest('[data-disable-person]');if(disable)disablePersonEditor(disable.dataset.disablePerson);
      if(event.target.closest('#new-report-selection'))reportsEditor();
      const reportButton=event.target.closest('[data-saved-report]');if(reportButton)loadSavedReport(reportButton.dataset.savedReport);
      if(event.target.closest('#download-report')&&displayedReport){const blob=new Blob([displayedReport.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='report-'+displayedReport.id+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      if(event.target.closest('#add-connection'))connectionEditor();
      const edit=event.target.closest('[data-edit-connection]');if(edit)connectionEditor(edit.dataset.editConnection);
      if(event.target.closest('#cancel-connection'))$('#connection-editor-host').replaceChildren();
    }
    const invite=event.target.closest('[data-invite]');
    if(invite&&!ctx.busy()){ctx.setBusy(true);try{const data=await ctx.api('invite',{employeeId:invite.dataset.invite});$('#invite-result').innerHTML=`<p>Код для ${esc(person(data.employeeId))}. Действует 30 минут, одноразовый.</p><label>Передай код этому участнику<input readonly type="text" value="${esc(data.code)}" autocomplete="off"></label>`;}catch(error){message('#editor-message',error.message);}finally{ctx.setBusy(false);}}
    if(event.target.closest('#download-draft')){const form=$('#draft-editor'),blob=new Blob([inputValue(form,'title')+'\n\n'+inputValue(form,'body')],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='document.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  });
  const rotation=setInterval(()=>{if(auto&&state().identity&&canRefresh()){view=({board:'calendar',calendar:'gantt',gantt:'board'})[view];ctx.renderBoard();}},30000);
  const jobsTimer=setInterval(()=>{if(jobsFor&&state().identity&&!document.hidden&&$('#task-dialog').open&&!ctx.busy())loadJobs();},6000);
  const detailTimer=setInterval(()=>{refreshCardTime();return checkDetail();},15000);
  window.addEventListener('pagehide',()=>{pulseController.destroy();document.removeEventListener('visibilitychange',syncVisibility);clearInterval(rotation);clearInterval(jobsTimer);clearInterval(detailTimer);const field=$('#connection-editor input[name="apiKey"]');if(field){field.value='';field.form.dataset.requestId=crypto.randomUUID();}});
  return {renderBoard,detailMarkup,appendDetail,detailMounted:loadJobs,canRefresh,isImportant:important,reset(){pending.clear();jobsFor=null;auto=false;view='board';lastSignal='';$('#murmuration').checked=false;if($('#editor-dialog').open)$('#editor-dialog').close();$('#brief-text').textContent='';}};
}
