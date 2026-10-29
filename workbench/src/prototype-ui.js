__modules["prototype-ui.js"]=(()=>{
const {stageAccepted, stageAssignee}=__modules['stage-workflow.js'];
const {createCardPulseController}=__modules['pulse-motion.js'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const labels = { planned:'Ожидает старта', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const boardColumns = [['planned','Ожидает старта'],['active','В работе'],['blocked','Препятствие'],['review','На проверке']];
const draftNames = { extension:'Письмо о переносе', request:'Запрос данных', clarify:'Уточнение статуса', plan:'План действий', review:'Проверка результата' };
const fieldNames = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const shift = (day, n) => new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow' }).format(new Date());

function decisionEvidenceMarkup(job) {
  if (job.status !== 'completed') return '';
  return (job.decisionReferences || []).map(ref => `<blockquote>По записи платформы результат принят.<small>${esc(ref.actorName || 'Руководитель')} · ${esc(ref.at || '')}</small></blockquote>`).join('');
}

// Host-recorded state, never inferred from model prose or presence of a route.
function assistantReviewLabel(job) {
  if (!job.execution) return 'Независимая проверка не подтверждена.';
  if (job.execution.reviewStatus === 'passed' && job.status === 'completed') return 'Ответ прошёл проверку моделью; решение остаётся за тобой.';
  if (job.execution.reviewStatus === 'rejected') return 'Проверяющий отклонил ответ; черновик не опубликован.';
  if (job.execution.reviewStatus === 'not_run' && job.status === 'completed') return 'Независимая проверка не выполнялась.';
  return 'Независимая проверка не подтверждена.';
}

// Derived presentation only: approved deadline, never creation/start or proposedDue.
function deadlineState(task, now = Date.now()) {
  if (task.status === 'done') return { text:'Завершено', kind:'done' };
  if (!task.due) return { text:'Без срока', kind:'none' };
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  if (!Number.isFinite(remaining)) return { text:'Без срока', kind:'none' };
  const hours = Math.max(1, Math.ceil(Math.abs(remaining) / 3600000));
  const span = hours >= 24 ? `${Math.ceil(hours / 24)} дн.` : `${hours} ч.`;
  return { text:remaining === 0 ? 'Срок наступил' : remaining < 0 ? `Просрочено на ${span}` : remaining < 3600000 ? 'Срок меньше часа' : `Осталось ${span}`,
    kind:remaining <= 0 ? 'overdue' : remaining < 86400000 ? 'soon' : 'normal' };
}
function cardPulseProgress(task, now = Date.now()) {
  if (!task.due || task.status === 'review' || task.status === 'done') return 0;
  const remaining = Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) - now;
  return Number.isFinite(remaining) ? Math.max(0, Math.min(1, 1 - remaining / 86400000)) : 0;
}
function cardPulseState(task, now = Date.now()) {
  const due = deadlineState(task, now);
  if (task.paused || (task.status==='planned'&&task.startAt&&Date.parse(task.startAt)>now)) return { mode:'planned', tone:'planned' };
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
  "review": "M0 26H52 C60 26 61 22 67 22 S74 29 79 29 L86 12 L93 36 L100 23 C107 19 111 26 122 26 H205 C213 26 214 22 220 22 S227 29 232 29 L239 12 L246 36 L253 23 C260 19 264 26 275 26 H300",
  "done": "M0 26H300"
};
function cardPulsePath(mode) { return pulsePaths[mode] || pulsePaths.planned; }
function pulseMarkup(mode) {
  const path = cardPulsePath(mode);
  return `<div class="card-pulse" aria-hidden="true"><canvas aria-hidden="true"></canvas><svg viewBox="0 0 300 52" preserveAspectRatio="none" focusable="false" aria-hidden="true"><path class="pulse-track" pathLength="740" d="${path}"/><path class="pulse-wave" pathLength="740" d="${path}"/></svg></div>`;
}

// Explicit board ordering only; no unread/attention inputs and no clock-based ranking.
// Pins remain first in every mode. Invalid/missing approved deadlines sort last.
function sortBoardTasks(tasks, pins = [], mode = 'priority') {
  const priority = {urgent:2, high:1, normal:0};
  const status = {planned:0, active:1, blocked:2, review:3, done:4};
  const due = task => {
    const value = task.due ? Date.parse(`${task.due}T${task.dueTime || '18:00'}:00+03:00`) : NaN;
    return Number.isFinite(value) ? value : Infinity;
  };
  const compareDue = (a,b) => due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1;
  const comparePriority = (a,b) => (priority[b.priority] || 0) - (priority[a.priority] || 0);
  const compareStatus = (a,b) => (status[a.status] ?? 5) - (status[b.status] ?? 5);
  return tasks.map((task,index)=>({task,index})).sort((a,b)=>
    Number(pins.includes(b.task.id))-Number(pins.includes(a.task.id)) ||
    (mode === 'deadline' ? compareDue(a.task,b.task) : mode === 'status' ? compareStatus(a.task,b.task) : comparePriority(a.task,b.task)) ||
    (mode === 'priority' ? compareDue(a.task,b.task) : 0) ||
    String(a.task.id).localeCompare(String(b.task.id), 'en') || a.index-b.index
  ).map(item=>item.task);
}

function installPrototype(ctx) {
  const $ = s => document.querySelector(s);
  let sortMode='priority';
  let view='board', month=today().slice(0,7)+'-01', lastInteraction=Date.now(), auto=false, draft=null, editingTask=null, editingPhase=null, jobsFor=null, lastSignal='', llmSettings=null;
  const pending=new Map();
  // Actor-scoped, in-memory only. Never persist cookies, CSRF or a generic mutation queue.
  // Keep the original JSON immutable until its create receipt is known, even after sign-out.
  const pendingCreates=new Map();
  function uncertainCreate() { const item=pendingCreates.get(state().identity?.id);return item?.uncertain?item:null; }
  function protectCreateForm() {
    const item=uncertainCreate(),form=$('#task-editor');if(!item||!form||editingTask)return;
    const input=JSON.parse(item.input);
    $('#editor-title').textContent='Подтвердить сохранение поручения';
    creatingChild=input.parentId?{parentId:input.parentId,expectedParentVersion:input.expectedParentVersion}:null;
    for(const [name,value] of Object.entries(input.fields)) {
      const field=form.elements.namedItem(name);if(field){field.value=value;field.disabled=true;}
    }
    form.querySelector('[type="submit"]').hidden=true;
    if(form.querySelector('[data-create-recovery]'))return;
    const box=document.createElement('div');box.className='report-note';box.dataset.createRecovery='';
    const text=document.createElement('p');text.textContent='Поручение могло сохраниться. Повторим только исходный запрос с прежним номером: сервер вернёт сохранённую карточку или создаст её, если запрос не дошёл. Данные пока нельзя менять.';
    const retry=document.createElement('button');retry.type='button';retry.className='primary';retry.dataset.retryCreate='';retry.textContent='Повторить исходный запрос';
    const limit=document.createElement('p');limit.textContent='Запрос хранится только в памяти этой вкладки. Не обновляй страницу и не закрывай вкладку до подтверждения. После перезагрузки сначала проверь доску — не создавай поручение заново вслепую.';
    box.append(text,retry,limit);
    if(input.parentId){const parent=document.createElement('p');parent.textContent='Исходное родительское поручение: '+input.parentId;box.prepend(parent);}
    form.append(box);retry.focus();
  }
  window.addEventListener('beforeunload',event=>{if(pendingCreates.size){event.preventDefault();event.returnValue='';}});
  let creatingChild=null, reportEpoch=0, displayedReport=null, detailView='workspace', boardHovered=false;
  const jobViews=new WeakMap();
  const state=()=>ctx.get();
  const pulseController=createCardPulseController($('#board'));
  const manager=()=>state().identity?.role==='manager';
  const selectedTask=()=>state().memory?.task || state().snapshot?.tasks.find(t=>t.id===state().selected);
  const recursive=__modules["recursive-ui.js"].installRecursiveUI({ctx,state,selectedTask,mutate,openEditor,changeView:changeDetailView});
  const modalOpen=()=>Boolean(document.querySelector('dialog[open]'));
  const message=(selector,text,success=false)=>ctx.note(selector,text,success);
  const inputValue=(form,name)=>form.elements.namedItem(name)?.value || '';
  const interval = task => deadlineState(task);
  function unread(task) { return typeof task.unread==='boolean'?task.unread:Boolean(task.lastMessageSourceId&&task.lastMessageAuthorId!==state().identity?.id&&state().snapshot.preferences.seen[task.id]!==task.version); }
  function stageAttention(task) {
    if(task.archived||task.paused||task.status==='done')return '';
    const actorId=state().identity?.id, phases=(task.phases||[]).filter(p=>!p.archived);
    const pending=task.employeeId===actorId?phases.filter(p=>p.reviewStatus==='submitted').length:0;
    if(pending)return `Проверить этапы · ${pending}`;
    const returned=phases.filter(p=>stageAssignee(task,p)===actorId&&p.reviewStatus==='returned').length;
    return returned?`Доработать этапы · ${returned}`:'';
  }
  function important(task) { return Boolean(stageAttention(task)) || unread(task) || task.needsDecision || task.needsClarification || ['blocked','review'].includes(task.status) || ['no_reply','awaiting'].includes(task.contact) || ['overdue','soon'].includes(interval(task).kind); }
  function person(id) { return state().snapshot?.employees.find(p=>p.id===id)?.name || 'Участник'; }
  function smallButton(action,label,attrs='') { return `<button type="button" class="secondary" ${action} ${attrs}>${label}</button>`; }
  function attention(task) {
    if(task.archived)return 'В архиве';
    if(task.needsClarification)return 'Нужно уточнение';
    if(task.status==='review')return 'Результат на проверку';
    if(stageAttention(task))return stageAttention(task);
    if(task.proposedDue)return 'Согласовать новый срок';
    if(task.needsDecision)return 'Нужно решение';
    if(task.blocker)return 'Есть препятствие';
    if(unread(task))return 'Новое сообщение';
    if(task.contact==='no_reply')return 'Нет ответа на запрос';
    if(task.needsClarification)return 'Нужно уточнение';
    return '';
  }
  function orderTasks(tasks) { return sortBoardTasks(tasks,state().snapshot.preferences.pins,sortMode); }
  function taskLabel(task) { if(task.paused)return 'На паузе';return task.status==='planned'&&task.startAt&&Date.parse(task.startAt)>Date.now()?'Отложенный старт':labels[task.status]||labels.planned; }
  function card(task) {
    const {snapshot}=state(), status=Object.hasOwn(labels,task.status)?task.status:'planned';
    const pin=snapshot.preferences.pins.includes(task.id), signal=unread(task);
    const due=interval(task), pulse=cardPulseState(task), need=attention(task);
    return `<article data-card-id="${esc(task.id)}" data-pulse="${pulse.mode}" data-pulse-tone="${pulse.tone}" data-pulse-progress="${cardPulseProgress(task)}" class="task compact-task ${status} ${pin?'pinned':''} ${task.paused?'is-paused':''} ${signal?'has-signal':''}" tabindex="0" aria-label="${esc(task.title)}. Один клик — прочитано, двойной — открыть">
      <div class="task-top"><div class="card-badges"><span class="status">${task.archived?'В архиве':taskLabel(task)}</span><span class="status priority-badge priority-${['high','urgent'].includes(task.priority)?task.priority:'normal'}" aria-label="Приоритет: ${task.priority==='urgent'?'срочный':task.priority==='high'?'высокий':'обычный'}" title="Приоритет">${task.priority==='urgent'?'Срочный':task.priority==='high'?'Высокий':'Обычный'}</span></div><button type="button" class="pin-button ${pin?'is-pinned':''}" data-pin="${esc(task.id)}" aria-pressed="${pin}" aria-label="${pin?'Открепить':'Закрепить'} ${esc(task.title)}" title="${pin?'Убрать из поля зрения':'Держать в поле зрения'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/></svg></button></div>
      <div class="card-body"><small class="card-id">${esc(task.id)}</small><h2>${esc(task.title)}</h2>
      ${need&&task.status!=='review'?`<p class="card-attention">${esc(need)}</p>`:''}<div class="task-meta">${esc(person(task.employeeId))}</div>
      <div class="card-status"><strong>Статус</strong><p>${esc(task.lastUpdateText||task.summary||'Обновлений пока нет.')}</p>${task.lastUpdateAt?`<time datetime="${esc(task.lastUpdateAt)}">${esc(ctx.date(task.lastUpdateAt,true))} мск</time>`:'<small>Дата обновления не указана</small>'}</div>
      ${task.status==='planned'&&task.startAt?`<small class="scheduled-start">Старт: ${esc(ctx.date(task.startAt,true))} мск</small>`:''}
      <div class="card-deadline">${task.due?`<time datetime="${esc(task.due)}T${esc(task.dueTime||'18:00')}:00+03:00">${esc(ctx.date(task.due))} · ${esc(task.dueTime||'18:00')} мск</time>`:'<span>Срок не задан</span>'}</div>
      <div class="task-bottom"><span data-deadline-state class="${due.kind}">${esc(due.text)}</span><button class="card-open-arrow" type="button" data-task="${esc(task.id)}" aria-label="Открыть ${esc(task.title)}" title="Открыть рабочую область"><svg width="16" height="16" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 10 10 2M3 2h7v7"/></svg></button></div></div>
      ${pulseMarkup(pulse.mode)}
      <svg class="card-unread-outline" aria-hidden="true" focusable="false"><rect class="unread-glow" x="1" y="1" rx="12" pathLength="100"/><rect class="unread-core" x="1" y="1" rx="12" pathLength="100"/></svg>
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
    const rows=tasks.flatMap(t=>(t.phases?.filter(p=>!p.archived).length?t.phases.filter(p=>!p.archived).map(p=>({task:t,...p,done:stageAccepted(p)})): [{ task:t, title:t.title, start:t.start||today(), end:t.due, done:t.status==='done' }]));
    return `<p class="report-note">28 дней с ${ctx.date(month)}. Этапы раскрыты под задачами; общий срок меняется отдельным решением.</p><div class="gantt-scroll"><div class="gantt"><div class="gantt-header"><span>Задача / этап</span><div class="timeline-track">${days.map(day=>`<span>${Number(day.slice(-2))}</span>`).join('')}</div></div>${rows.map(p=>`<div class="gantt-row"><button data-task="${esc(p.task.id)}"><small>${esc(p.task.id)}${p.dependsOn?' · есть предшествующий этап':''}</small>${esc(p.title)}<small>${p.end?`${ctx.date(p.start)} — ${ctx.date(p.end)}`:'Срок не задан'}</small></button><div class="timeline-track">${days.map(day=>`<span class="phase-cell ${p.end&&day>=p.start&&day<=p.end?'filled':''} ${p.done?'complete':''} ${day===today()?'today':''}"></span>`).join('')}</div></div>`).join('')}</div></div>`;
  }
  function renderBoard(tasks) {
    recursive.renderQueues();
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
    const archive=['done','archived'].includes(state().filter);
    $('#board').className=view==='board'?`board focus-board${archive?' focus-archive':''}`:'alternate-view';
    $('#board-order').hidden=view!=='board';
    $('#board-sort').value=sortMode;
    $('#board-guide').textContent=archive?'История сохранена. Закреплённые — первыми.':({priority:'Закреплённые → срочный → высокий → обычный → ближайший срок.',status:'Закреплённые → ожидает старта → в работе → препятствие → на проверке → принято.',deadline:'Закреплённые → ближайший срок. Без срока — в конце каждой группы.'}[sortMode]);
    if(!tasks.length)return '<div class="empty"><span class="empty-mark">✦</span>Здесь пока нет задач.<br><small>Измени фильтр или создай первое поручение.</small></div>';
    if(view==='calendar')return calendar(tasks);
    if(view==='gantt')return gantt(tasks);
    return orderTasks(tasks).map(card).join('');
  }

  function delegationMarkup(task) {
    if(!manager())return '';
    const children=state().memory.children||[], done=children.filter(t=>t.status==='done').length;
    const original=Object.hasOwn(task,'originalDue')?(task.originalDue?`${ctx.date(task.originalDue)} · ${esc(task.originalDueTime||'18:00')} мск`:'При постановке срок не задан'):'Первоначальный срок не зафиксирован';
    return `<section class="detail-section delegation"><div class="section-heading"><h3>Дочерние поручения · ${done}/${children.length} принято</h3>${task.status!=='done'&&!task.archived?smallButton('data-new-child','+ Поручение исполнителю'):''}</div><p class="report-note">Ответственность за результат остаётся у исполнителя родительского поручения. Дочерние поручения — не последовательные этапы и не закрывают родителя автоматически.</p><p class="report-note">Первоначальный срок: ${original}. Текущий: ${task.due?ctx.date(task.due)+' · '+esc(task.dueTime||'18:00')+' мск':'не задан'}. ${esc(interval(task).text)}</p>${task.parentId?`<p class="report-note">Родительское поручение: ${smallButton(`data-child-open="${esc(task.parentId)}"`,esc(task.parentId))}</p>`:''}${children.map(child=>`<article class="child-task"><button type="button" class="quiet" data-child-open="${esc(child.id)}"><strong>${esc(child.title)}</strong><small>${esc(child.id)} · ${esc(person(child.employeeId))}</small></button><p>${esc(labels[child.status]||child.status)} · ${child.due?ctx.date(child.due)+' · '+esc(child.dueTime||'18:00')+' мск':'Без срока'} · ${esc(interval(child).text)}</p><p>${esc(child.blocker||child.summary||'Ожидаем обновление')}</p></article>`).join('')||'<p class="report-note">Можно распределить части работы между исполнителями, сохранив общий срок и ответственность.</p>'}</section>`;
  }
  function conversationMarkup(source) {
    return `<article data-conversation-source="${esc(source.id)}" class="bubble ${['manager_message','rework_feedback'].includes(source.kind)?'from-manager':''}"><small>${esc(source.authorName)} · ${ctx.date(source.occurredAt||source.receivedAt,true)}</small><p>${esc(source.text)}</p>${source.artifactId&&state().memory.requestState?.artifacts.some(a=>a.id===source.artifactId)?`<p>${smallButton(`data-artifact-open="${esc(source.artifactId)}"`,'Документ · v'+(state().memory.requestState.artifacts.find(a=>a.id===source.artifactId)?.version||'—'))}</p>`:''}${source.kind==='rework_feedback'&&source.resultSourceId?`<small>Замечания к переданному результату</small>${sourceReader(source.resultSourceId,source.resultVersion)}`:''}</article>`;
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
  function stageMarkup(task,phase,active) {
    const identity=state().identity, accepted=stageAccepted(phase), result=(phase.submissions||[]).find(r=>r.id===phase.submittedResultId), reviews=phase.reviews||[];
    const latestReview=reviews.filter(r=>r.resultId===phase.submittedResultId).at(-1), canWork=active&&!phase.archived&&!task.paused;
    const status=accepted?'Принят куратором':phase.reviewStatus==='submitted'?'На проверке у куратора':phase.reviewStatus==='returned'?'На доработке':phase.done?'Ранее отмечен готовым · приёмка не подтверждена':'Ожидает результата';
    return `<article class="workspace-section" data-stage-id="${esc(phase.id)}"><div class="section-heading"><h3>${esc(phase.title)}</h3>${manager()&&canWork?`<details class="task-options"><summary aria-label="Опции этапа">⋯</summary><div class="task-options-panel">${smallButton(`data-edit-phase="${esc(phase.id)}"`,'Изменить этап')}${smallButton(`data-archive-phase="${esc(phase.id)}"`,'Убрать в архив')}<small>Результаты и история сохраняются.</small></div></details>`:''}</div><p class="report-note">${esc(status)} · Ответственный: ${esc(person(stageAssignee(task,phase)))} · ${ctx.date(phase.start)} — ${ctx.date(phase.end)}</p>${result?`<article class="submitted-result"><small>Версия ${esc(result.version)} · ${esc(person(result.employeeId))} · ${ctx.date(result.at,true)}</small><p>${esc(result.text)}</p></article>`:''}${latestReview?.action==='return'?`<p class="pause-note">Замечания к версии ${esc(result?.version)}: ${esc(latestReview.reason)}</p>`:''}<div class="actions">${canWork&&stageAssignee(task,phase)===identity.id&&!accepted&&phase.reviewStatus!=='submitted'?smallButton(`data-stage-action="submit" data-phase-id="${esc(phase.id)}"`,phase.reviewStatus==='returned'?'Передать исправленный результат':'Передать результат этапа'):''}${canWork&&task.employeeId===identity.id&&phase.reviewStatus==='submitted'&&result?smallButton(`data-stage-action="accept" data-phase-id="${esc(phase.id)}" data-result-id="${esc(result.id)}"`,'Принять этап')+smallButton(`data-stage-action="return" data-phase-id="${esc(phase.id)}" data-result-id="${esc(result.id)}"`,'Вернуть с замечаниями'):''}</div>${(phase.submissions||[]).length?`<details><summary>История результатов · ${phase.submissions.length}</summary>${phase.submissions.map(r=>`<article class="submitted-result"><small>Версия ${esc(r.version)} · ${esc(person(r.employeeId))} · ${ctx.date(r.at,true)}</small><p>${esc(r.text)}</p>${reviews.filter(v=>v.resultId===r.id).map(v=>`<p class="report-note">${v.action==='accept'?'Принято':'Возвращено'} · ${esc(person(v.actorId))} · ${ctx.date(v.at,true)}${v.reason?' · '+esc(v.reason):''}</p>`).join('')}</article>`).join('')}</details>`:''}</article>`;
  }
  function stageResultEditor(task,phase,action,resultId='') {
    const submit=action==='submit';
    openEditor(submit?'Результат этапа':'Вернуть этап с замечаниями',`<form id="stage-result-editor" data-task-id="${esc(task.id)}" data-phase-id="${esc(phase.id)}" data-version="${esc(state().memory.taskVersion)}" data-action="${action}" data-result-id="${esc(resultId)}"><p>${esc(phase.title)}</p><label>${submit?'Содержание результата':'Что нужно исправить'}<textarea name="${submit?'text':'reason'}" required maxlength="${submit?4000:1000}"></textarea></label><p class="report-note">${submit?'Будет сохранена новая неизменяемая версия. Проверяет куратор.':'Замечания сохранятся со ссылкой на проверенную версию.'}</p><button class="primary" type="submit">${submit?'Передать куратору':'Вернуть с замечаниями'}</button></form>`);
  }
  function detailMarkup() {
    const {memory,identity,selected}=state(),task=selectedTask(),current=memory.current;
    if(task.documentOnly)return `<header class="detail-header"><h2 id="task-title">${esc(memory.title)}</h2><p>Только назначенный документ. Поручение и переписка вне вашего доступа.</p></header><p id="detail-message" class="message" role="status"></p><p id="detail-updates" class="report-note" role="status"></p><button type="button" id="reload-detail" class="secondary" hidden>Документ изменился · обновить</button>${recursive.detailMarkup(task,memory)}`;
    const own=task.employeeId===identity.id&&current.status!=='done'&&!task.archived;
    const controls=manager()&&task.canControl!==false&&!task.simulationGates?.length;
    const active=!(task.archived||current.status==='done'), phases=(task.phases||[]).filter(p=>!p.archived), archivedPhases=(task.phases||[]).filter(p=>p.archived);
    const reportId=current.status==='done'?task.acceptedSourceId:task.submittedResultSourceId;
    const report=[...(memory.conversation||[]),...(memory.sources||[])].find(s=>s.id===reportId&&s.employeeId===task.employeeId&&s.kind!=='manager_message'&&s.text?.trim());
    const pendingParts=phases.some(p=>!stageAccepted(p))||(memory.children||[]).some(t=>!t.archived&&t.status!=='done');
    const decisions=controls&&active&&current.proposedDue?[['approve_due','Согласовать срок'],['reject_due','Сохранить прежний срок']]:[];
    const extras=task.archived||task.paused?[]:controls?({planned:[['start','Начать работу']],blocked:[['unblock','Препятствие устранено']],review:[['rework','Вернуть на доработку']],done:[['reopen','Вернуть в работу']]}[current.status]||[]):own&&current.status==='planned'?[['start','Начать работу']]:[];
    return `<header class="detail-header"><span class="eyebrow">${esc(selected)} · ${task.archived?'В архиве':esc(taskLabel(task))}</span><div class="workspace-title-row"><h2 id="task-title">${esc(memory.title)}</h2>${controls?`<details class="task-options"><summary aria-label="Опции поручения" title="Опции поручения">⋯</summary><div class="task-options-panel">${active?smallButton('data-edit-task','Изменить поручение')+smallButton('data-pause-task',task.paused?'Возобновить работу':'Поставить на паузу'):''}${smallButton('data-archive-task',task.archived?'Восстановить из архива':'Убрать в архив')}<small>Архив сохраняет историю, но не принимает работу.</small></div></details>`:''}</div><p class="workspace-meta">Куратор: ${esc(person(task.employeeId))} · ${esc(task.project||'Без проекта')} · ${ctx.date(current.due)}${current.due?' · '+esc(task.dueTime||'18:00')+' мск':''}</p>${task.protocol?`<p class="workspace-provenance">Протокол ${esc(task.protocol.number||'без номера')}${task.protocol.point?' · п. '+esc(task.protocol.point):''}${task.protocol.date?' · '+esc(ctx.date(task.protocol.date)):''}</p>`:''}<nav class="workspace-tabs" aria-label="Работа с поручением"><button type="button" data-detail-view="workspace" aria-pressed="${detailView==='workspace'}">Рабочая область</button><button type="button" data-detail-view="chat" aria-pressed="${detailView==='chat'}">Чат</button></nav></header>
    <p id="detail-message" class="message" role="status" aria-live="polite"></p><p id="detail-updates" class="report-note" role="status" aria-live="polite"></p><button type="button" id="reload-detail" class="secondary" hidden>В задаче есть обновления · показать</button>
    <div class="workspace-content" ${detailView==='chat'?'hidden':''}>
    ${task.controlOwnerName?`<p class="report-note">Итог принимает: ${esc(task.controlOwnerName)}${task.canControl===false?' · у вас просмотр и участие, не приёмка':''}</p>`:''}
${task.dependencyDetails?.length?`<details class="workspace-section" open><summary>Связанные результаты · ${task.dependencyDetails.length}</summary>${task.dependencyDetails.map(d=>`<p>${d.status==='restricted'?esc(d.id)+' · '+esc(d.title):smallButton(`data-task="${esc(d.id)}"`,esc(d.id)+' · '+esc(d.title))} · ${esc(labels[d.status]||d.status)}${d.archived?' · в архиве':''}</p>`).join('')}<p class="report-note">Подготовку можно вести параллельно. Итог нельзя принять до обязательных связанных результатов.</p></details>`:''}
${(task.simulationGates||[]).map(g=>`<section class="decision-box"><h3>Контрольная точка · ${esc(g.id)}</h3><p>${esc(g.prompt)}</p><p>Решение до ${esc(g.deadline)}. Ответственный: ${esc(person(g.ownerId))}</p>${g.ownerId===state().identity.id?`<form data-simulation-gate="${esc(g.id)}"><label>Вариант<select name="optionId" required><option value="">Выберите после проверки данных</option>${g.options.map(o=>`<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label>${g.options.map(o=>`<p class="report-note">${esc(o.label)}: ${esc(o.description||'')}</p>`).join('')}<label>Основание и проверенные сведения<textarea name="reason" required maxlength="4000"></textarea></label><button class="primary" type="submit">Зафиксировать решение в модели</button></form>`:''}</section>`).join('')}
${task.paused?`<p class="pause-note">На паузе · ${esc(task.pauseReason||'Причина не указана')}</p>`:''}
    ${attention(task)&&active&&(current.status!=='review'||current.proposedDue||task.needsClarification)?`<section class="decision-box"><h3>${esc(attention(task))}</h3><p>${current.proposedDue?`Предложено: ${ctx.date(current.proposedDue)}. Действующий срок: ${ctx.date(current.due)}.`:esc(task.needsClarification?task.clarificationQuestion||'Уточни последнее сообщение с куратором.':task.blocker||task.summary||'Посмотри актуальное обновление.')}</p><div class="actions">${decisions.map(([action,label])=>smallButton(`data-decision="${action}"`,label)).join('')}${current.status==='review'?smallButton('data-show-result','Посмотреть результат'):stageAttention(task)?smallButton('data-show-stages','Посмотреть этапы'):smallButton('data-detail-view="chat"','Обсудить с куратором')}</div></section>`:''}
    <section class="workspace-section"><div class="section-heading"><h3>Поручение</h3></div><p class="task-description">${esc(task.description||'Ожидаемый результат пока не описан.')}</p><div class="actions">${extras.filter(([action])=>action!=='rework'||!memory.requestState?.pending.some(r=>r.kind==='result')).map(([action,label])=>smallButton(`data-task-action="${action}"`,label)).join('')}</div></section>
    ${own?`<div id="workspace-status-slot" class="workspace-status-slot"><details class="inline-status" ${memory.requestState?.artifacts?.length?'':'open'}><summary>Обновить статус или задать вопрос</summary><form id="report-form"><label for="report-text">Сообщение и обновление статуса</label><textarea id="report-text" maxlength="4000" required placeholder="Что готово? Приведи результат или вопрос…"></textarea><button class="primary" type="submit">Отправить</button><small class="report-note">Статус обновляется по правилам. Приёмка и перенос срока требуют решения.</small></form></details></div>`:''}
    ${recursive.detailMarkup(task,memory)}
    <details class="workspace-section" id="result-section" ${memory.requestState?.requests.some(r=>r.kind!=='status')?'hidden':'open'}><summary>Результат ${current.status==='review'?'· ожидает проверки':''}</summary>${report?`<article class="submitted-result"><small>${esc(report.authorName||person(report.employeeId))} · ${ctx.date(report.occurredAt||report.receivedAt,true)}</small><p>${esc(report.text)}</p><small>Сообщение исполнителя. Приложенные файлы в этом этапе не поддерживаются.</small></article>`:current.status==='review'?'<p class="report-note">Ранее отмечено «готово», но результат не привязан для приёмки. История сохранена. Куратору нужно повторно передать итог руководителю.</p>':'<p class="report-note">Итоговый результат ещё не представлен. Куратор передаёт итог после проверки этапов; для простого поручения — сразу.</p>'}${controls&&!memory.requestState?.pending.some(r=>r.kind==='result')&&current.status==='review'&&!task.archived&&report&&!task.needsClarification&&!pendingParts&&!task.paused&&!task.dependencyDetails?.some(d=>d.status!=='done'||d.archived)?`<label class="check-label"><input id="result-reviewed" type="checkbox"> Ознакомился с представленным результатом</label><button class="primary" type="button" data-decision="accept" disabled data-unavailable="true">Принять результат</button>`:''}${own&&!memory.requestState?.pending.some(r=>r.kind==='result')&&!task.paused&&!pendingParts&&current.status!=='review'?smallButton('data-final-result','Передать итог руководителю'):''}${current.status==='review'&&task.needsClarification?'<p class="report-note">Перед приёмкой нужно уточнить последнее сообщение с куратором в чате.</p>':''}${current.status==='review'&&pendingParts?'<p class="report-note">До итоговой приёмки куратор должен принять результаты действующих этапов; дочерние поручения также должны быть приняты.</p>':''}</details>
    <details class="workspace-section ${phases.length?'':'workspace-empty'}" id="stages-section" open><summary>Этапы · ${phases.filter(stageAccepted).length}/${phases.length} принято куратором</summary>${controls&&active?smallButton('data-new-phase','+ Этап'):''}${phases.length?`<progress max="${phases.length}" value="${phases.filter(stageAccepted).length}"></progress><div class="phase-list">${phases.map(p=>stageMarkup(task,p,active)).join('')}</div><small class="report-note">Исполнитель передаёт результат этапа куратору. Руководитель принимает итог поручения. Файлы пока не поддерживаются.</small>`:'<p class="report-note">Этапов пока нет. Для простого поручения они не обязательны.</p>'}${archivedPhases.length?`<details><summary>Убранные этапы · ${archivedPhases.length}</summary>${archivedPhases.map(p=>stageMarkup(task,p,false)+`<p>${controls&&active?smallButton(`data-restore-phase="${esc(p.id)}"`,'Восстановить этап'):''}</p>`).join('')}</details>`:''}</details>
    <details class="workspace-section ${(memory.children||[]).length?'':'workspace-empty'}" open><summary>Поручения соисполнителям · ${(memory.children||[]).length}</summary>${delegationMarkup(task)}</details>
    ${controls?`<details class="workspace-section" open><summary>Черновики шаблонов · ${(memory.drafts||[]).length}</summary><p class="report-note">Рабочие черновики, не переданные версии результата. Документ с приёмкой хранится выше, в блоке «Документ и проверка».</p>${(memory.drafts||[]).map(d=>`<article class="draft"><small>${d.status==='approved'?'Текст согласован':'Черновик'} · ${d.generator==='template'?'шаблон':'ассистент'}</small><h3>${esc(d.title)}</h3>${smallButton(`data-edit-draft="${esc(d.id)}"`,'Открыть и редактировать')}</article>`).join('')||'<p class="report-note">Подготовленные здесь документы появятся в этом разделе.</p>'}<details><summary>Подготовить документ</summary><div class="actions">${active?Object.entries(draftNames).map(([kind,label])=>smallButton(`data-template="${kind}"`,label)).join(''):''}</div></details></details>`:''}
    <details class="workspace-section"><summary>История статусов и основания</summary><div class="facts">${memory.facts.map(f=>`<article class="fact"><span>${esc(fieldNames[f.field]||f.label||f.field)}</span><p>${esc(typeof f.value==='boolean'?(f.value?'Да':'Нет'):f.value??'Не задано')}</p>${f.origin?.sourceId?ctx.sourceLink(f.origin.sourceId):'<small>Запись карточки / решение</small>'}</article>`).join('')}</div><h3>Исходные сообщения</h3><div id="sources">${ctx.sourcesMarkup()}</div><h3>История</h3><div id="timeline">${memory.timeline.map(ctx.eventMarkup).join('')}</div>${memory.page.nextBefore?smallButton('id="older"','Более ранние записи'):''}</details>

    </div>
    <section class="workspace-chat" ${detailView==='workspace'?'hidden':''} aria-label="Единый вход в обсуждения">
    <aside class="chat-index"><label for="chat-task-search">Задача или проект</label><input id="chat-task-search" type="search" placeholder="/П-001 или название проекта" autocomplete="off"><div id="chat-task-list">${state().snapshot.tasks.filter(t=>!t.archived).map(t=>`<button type="button" data-chat-task="${esc(t.id)}" aria-current="${t.id===selected?'true':'false'}"><strong>${esc(t.id)}</strong><span>${esc(t.title)}</span><small>${esc(t.project||'Без проекта')}</small></button>`).join('')}</div></aside>
    <div class="chat-main"><p class="chat-context">Обсуждение ${esc(selected)} · ${smallButton('data-detail-view="workspace"','Открыть задачу')}</p><p id="conversation-updates" class="report-note" role="status" aria-live="polite"></p><p id="conversation-gap" class="report-note" ${(memory.conversation||[]).length===50?'':'hidden'}>Показаны последние 50 сообщений. Более ранние записи доступны в истории задачи.</p><div class="conversation">${(memory.conversation||[]).map(conversationMarkup).join('')||'<p class="report-note" data-empty-conversation>Сообщений пока нет.</p>'}${memory.timeline.filter(e=>e.kind==='no_reply').slice().reverse().map(systemEventMarkup).join('')}</div>
    <div id="chat-status-slot"></div>${controls&&active?`<form id="message-form"><label for="manager-message">Сообщение куратору</label><textarea id="manager-message" name="text" maxlength="4000" required placeholder="Напиши вопрос или решение…"></textarea><label>Связать с точной версией<select name="documentVersion"><option value="">Без ссылки</option>${(memory.requestState?.artifacts||[]).map(a=>`<option value="${esc(a.id)}">${esc(a.title)} · v${a.version}</option>`).join('')}</select></label><label class="check-label"><input type="checkbox" id="manager-request-update" name="requestUpdate"> Запросить обновление статуса</label><button class="primary" type="submit">Отправить</button></form>`:''}
    ${controls?`<details class="assistant-section"><summary>Маркус · помочь с этой задачей</summary>${state().snapshot.assistant.available?`<form id="assistant-form"><label for="assistant-question">Что подготовить?</label><textarea id="assistant-question" name="question" maxlength="2000" required placeholder="Изучи переписку и подготовь проект ответа…"></textarea><button type="submit" class="secondary">Поручить Маркусу</button></form>`:'<p class="report-note">ИИ сейчас не подключён. Можно запросить статус у куратора или подготовить документ по шаблону в рабочей области.</p>'}<div id="assistant-jobs"></div><details class="context-preview"><summary>Контекст и источники</summary>${smallButton('id="preview-context"','Показать контекст')}<div id="context-preview-content"></div></details></details>`:''}</div></section>`;
  }
  function changeDetailView(next) {
    if(selectedTask()?.documentOnly){detailView='workspace';$('#task-dialog').classList.remove('chat-view');return;}
    detailView=next==='chat'?'chat':'workspace';
    $('.workspace-content').hidden=detailView==='chat';$('.workspace-chat').hidden=detailView!=='chat';
    document.querySelectorAll('.workspace-tabs [data-detail-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.detailView===detailView)));
    $('#task-dialog').classList.toggle('chat-view',detailView==='chat');
    const reportForm=$('#report-form'),slot=detailView==='chat'?$('#chat-status-slot'):$('#workspace-status-slot .inline-status');if(reportForm&&slot)slot.append(reportForm);
    if(detailView==='chat')($('#report-text')||$('#manager-message')||$('#chat-task-search'))?.focus({preventScroll:true});
  }
  async function mutate(path,input,{dialog,taskId,after,recoverCreate=false}={}) {
    if(ctx.busy())return;
    const actorId=state().identity?.id;
    if(path==='task-create'&&uncertainCreate()&&!recoverCreate){protectCreateForm();message('#editor-message','Сначала подтверди исходный запрос. Новое поручение не отправлено.');return;}
    ctx.setBusy(true);
    const messageTarget=dialog?'#editor-message':$('#task-dialog').open?'#detail-message':'#workspace-message';
    const taskForm=dialog&&['task-create','task-edit'].includes(path)?$('#task-editor'):null;
    if(taskForm)taskForm.setAttribute('aria-busy','true');
    message(messageTarget,taskForm?'Сохраняем…':'');
    if(taskForm)$(messageTarget).classList.add('pending');
    const key=JSON.stringify({path,input});
    let create;
    if(path==='task-create') {
      create=pendingCreates.get(actorId);
      if(!create){create={input:JSON.stringify(input),key,requestId:crypto.randomUUID(),uncertain:false};pendingCreates.set(actorId,create);}
    }else if(!pending.has(key))pending.set(key,crypto.randomUUID());
    let saved=false;
    try {
      const result=await ctx.api(path,create?{...JSON.parse(create.input),requestId:create.requestId}:{...input,requestId:pending.get(key)});
      if(create&&!(result?.ok===true&&typeof result.taskId==='string'&&result.taskId.trim()&&result.taskId.length<=150&&typeof result.duplicate==='boolean')){
        const error=new Error('Подтверждение сохранения поручения повреждено. Результат пока неизвестен.');error.outcomeUnknown=true;throw error;
      }
      saved=true;
      if(create)pendingCreates.delete(actorId);else pending.delete(key);
      if(state().identity?.id!==actorId)return result;
      if(dialog)$(dialog).close();
      if(after)after(result);
      await ctx.refresh();
      const task=['pin','notice'].includes(path)?null:result.taskId||taskId;
      if(task) {if(path==='message'&&$('#manager-message'))$('#manager-message').value='';await ctx.openTask(task);message('#detail-message',result.alreadyPending?'Запрос уже ожидает ответа. Новое сообщение не добавлено.':'Сохранено.',true);}
      else message('#workspace-message','Сохранено.',true);
      return result;
    } catch(error) {
      if(create&&!saved) {
        if(create.uncertain||error.outcomeUnknown!==false){create.uncertain=true;protectCreateForm();}
        else pendingCreates.delete(actorId);
      }
      const target=error.status===401?'#login-message':saved?'#workspace-message':messageTarget;
      message(target,saved?'Изменение сохранено. Обнови данные, когда связь восстановится.':error.message,saved);
    }
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
    if(!task&&uncertainCreate())parent=null; // Recovery belongs to the original parent, not a newly opened card.
    creatingChild=parent?{parentId:parent.id,expectedParentVersion:state().memory.taskVersion}:null;
    editingTask=task?{id:task.id,version:state().memory.taskVersion}:null;
    openEditor(task?'Изменить поручение':parent?'Дочернее поручение':'Новое поручение',`${parent?`<p class="report-note">Часть поручения «${esc(parent.title)}». Назначь отдельного исполнителя и срок. Срок и ответственность родителя не меняются.</p>`:''}<form id="task-editor"><label>Что нужно сделать?<input name="title" required maxlength="160" value="${esc(task?.title||'')}" placeholder="Например: подготовить свод предложений"></label><label>Ожидаемый результат<textarea name="description" maxlength="2000" placeholder="Что должно получиться и как понять, что задача выполнена">${esc(task?.description||'')}</textarea></label><div class="form-grid"><label>Куратор<select name="employeeId">${state().snapshot.employees.map(p=>`<option value="${esc(p.id)}" ${p.enabled===false?'disabled':''} ${p.id===(task?.employeeId||state().identity.id)?'selected':''}>${esc(p.name)}${p.enabled===false?' — доступ отключён':''}</option>`).join('')}</select></label>${input('project','Проект',task?.project||'','text','maxlength="120"')}<label>Приоритет<select name="priority">${[['normal','Обычный'],['high','Высокий'],['urgent','Срочный']].map(([value,label])=>`<option value="${value}" ${task?.priority===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Контроль статуса<select name="supervision"><option value="true" ${task?.supervision!==false?'selected':''}>Включён</option><option value="false" ${task?.supervision===false?'selected':''}>Выключен</option></select></label>${input('startAt','Отложенный старт (Москва)',task?.startAt?new Date(Date.parse(task.startAt)+10800000).toISOString().slice(0,16):'','datetime-local')}${input('due','Срок (необязательно)',task?.due||'','date')}${input('dueTime','Время, Москва',task?.dueTime||'18:00','time','required')}</div><details ${task?.protocol?'open':''}><summary>Реквизиты протокола — если есть</summary><div class="form-grid">${input('protocolNumber','Номер',task?.protocol?.number||'','text','maxlength="100"')}${input('protocolPoint','Пункт',task?.protocol?.point||'','text','maxlength="100"')}${input('protocolDate','Дата',task?.protocol?.date||'','date')}</div></details><button type="submit" class="primary">${task?'Сохранить изменения':'Поставить задачу'} ↗</button></form>`);
    if(!task)protectCreateForm();
  }
  function phaseEditor(phase=null) {
    const task=selectedTask();editingPhase={id:phase?.id||null,taskId:task.id,version:state().memory.taskVersion};
    openEditor(phase?'Изменить этап':'Новый этап',`<form id="phase-editor"><label class="check-label"><input type="checkbox" name="preparation" ${phase?.kind==='preparation'?'checked':''}> Обязательная подготовка перед основным стартом</label>${input('title','Название этапа',phase?.title||'','text','required maxlength="120"')}<div class="form-grid">${input('start','Начало',phase?.start||today(),'date','required')}${input('end','Завершение',phase?.end||task.due||today(),'date','required')}</div><label>Ответственный за этап<select name="assigneeId"><option value="">Куратор поручения</option>${state().snapshot.employees.filter(p=>p.enabled!==false).map(p=>`<option value="${esc(p.id)}" ${p.id===phase?.assigneeId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Начать после<select name="dependsOn"><option value="">Без зависимости</option>${(task.phases||[]).filter(p=>!p.archived&&p.id!==phase?.id).map(p=>`<option value="${esc(p.id)}" ${p.id===phase?.dependsOn?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><p class="report-note">Зависимости проверяются на циклы. Даты этапов не переносят общий срок задачи.</p><button type="submit" class="primary">Сохранить этап</button></form>`);
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
  function canRefresh() {return !boardHovered&&!$('#board details[open]')&&!$('#board')?.contains(document.activeElement)&&!modalOpen()&&!ctx.busy()&&!document.hidden&&Date.now()-lastInteraction>8000&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);}
  $('#board').addEventListener('pointerenter',()=>{boardHovered=true;});$('#board').addEventListener('pointerleave',()=>{boardHovered=false;lastInteraction=Date.now();});
  const interact=()=>{lastInteraction=Date.now();};document.addEventListener('pointerdown',interact);document.addEventListener('keydown',interact);
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;ctx.renderBoard();}));
  $('#prev-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#next-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#today-month').addEventListener('click',()=>{month=today().slice(0,7)+'-01';ctx.renderBoard();});
  $('#murmuration').addEventListener('change',event=>{auto=event.target.checked;lastInteraction=Date.now();$('#motion-note').textContent=auto?'Смена видов каждые 30 секунд; пауза при взаимодействии.':'Ты управляешь доской.';});
  $('#board-sort').addEventListener('change',event=>{sortMode=['priority','status','deadline'].includes(event.target.value)?event.target.value:'priority';lastInteraction=Date.now();ctx.renderBoard();});
  $('#pulse').addEventListener('change',event=>{document.body.classList.toggle('quiet-motion',!event.target.checked);pulseController.sync();});
  $('#open-chat')?.addEventListener('click',()=>{const task=state().snapshot?.tasks.find(t=>!t.archived);if(task){detailView='chat';ctx.openTask(task.id);}else message('#workspace-message','Пока нет доступных задач для обсуждения.');});
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
    if(['final-result-editor','stage-result-editor','rework-editor'].includes(event.target.form?.id))event.target.setCustomValidity('');
    if(event.target.form?.id==='task-editor'&&event.target.name==='title')event.target.setCustomValidity('');
    if(event.target.form?.id==='connection-editor')event.target.form.dataset.requestId=crypto.randomUUID();
  });
  const acknowledging=new Map();
  async function acknowledgeCard(node) {
    const id=node?.dataset.cardId,task=state().snapshot?.tasks.find(t=>t.id===id);if(!task||!node.classList.contains('has-signal')||acknowledging.has(id))return;
    const version=task.version,cursor=task.notificationCursor,actor=state().identity.id;acknowledging.set(id,version);
    try {await ctx.api('notice',{taskId:id,expectedVersion:version,...(cursor!==undefined?{expectedNotificationCursor:cursor}:{}),requestId:crypto.randomUUID()});const current=state().snapshot.tasks.find(t=>t.id===id);if(state().identity?.id===actor&&current?.version===version&&current.notificationCursor===cursor){state().snapshot.preferences.seen[id]=version;current.unread=false;node.classList.remove('has-signal');const label=node.querySelector('.card-attention'),need=attention(current);if(label){if(need)label.textContent=need;else label.remove();}}}
    catch(error){message('#workspace-message',error.message);}finally{acknowledging.delete(id);}
  }
  $('#board').addEventListener('click',event=>{
    if(event.target.closest('[data-task]')){detailView='workspace';return;}
    const pin=event.target.closest('[data-pin]');if(pin){const id=pin.dataset.pin;mutate('pin',{taskId:id,pinned:!state().snapshot.preferences.pins.includes(id)});return;}
    if(event.target.closest('button,a,input,select,textarea,summary'))return;
    acknowledgeCard(event.target.closest('[data-card-id]'));
  });
  $('#board').addEventListener('dblclick',event=>{if(event.target.closest('button,a,input,select,textarea,summary'))return;const card=event.target.closest('[data-card-id]');if(card&&!ctx.busy()){detailView='workspace';ctx.openTask(card.dataset.cardId);}});
  $('#board').addEventListener('keydown',event=>{if(event.target.matches('[data-card-id]')&&(event.key===' '||event.key==='Enter')){event.preventDefault();acknowledgeCard(event.target);}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=document.querySelector('.task-options[open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}}},true);
  document.addEventListener('click',event=>{document.querySelectorAll('.task-options[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
  $('#task-dialog').addEventListener('click',event=>{
    if(ctx.busy())return;const button=event.target.closest('button');if(!button)return;const task=selectedTask();if(!task)return;
    if(button.dataset.detailView){changeDetailView(button.dataset.detailView);return;}
    if(button.dataset.chatTask){detailView='chat';ctx.openTask(button.dataset.chatTask);return;}
    if(button.hasAttribute('data-show-stages')){const stages=$('#stages-section');stages.open=true;stages.scrollIntoView?.({behavior:'smooth',block:'start'});return;}
    if(button.hasAttribute('data-show-result')){const result=$('#result-section')?.hidden?$('#document-workbench'):$('#result-section');if(result){result.open=true;result.scrollIntoView?.({block:'start'});}return;}
    if(button.hasAttribute('data-pause-task')){if(task.paused){mutate('task-action',{taskId:task.id,expectedVersion:state().memory.taskVersion,action:'resume'});}else{openEditor('Поставить поручение на паузу',`<form id="pause-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}"><label>Причина паузы<textarea name="reason" required maxlength="1000" placeholder="Почему работа временно остановлена?"></textarea></label><p class="report-note">Срок, ответственный и история сохранятся. Обсуждение останется доступно.</p><button class="primary" type="submit">Поставить на паузу</button></form>`);}return;}
    if(button.hasAttribute('data-archive-task')){mutate('task-archive',{taskId:task.id,expectedVersion:state().memory.taskVersion,archived:!task.archived});return;}
    if(button.dataset.archivePhase||button.dataset.restorePhase){mutate('phase-archive',{taskId:task.id,expectedVersion:state().memory.taskVersion,phaseId:button.dataset.archivePhase||button.dataset.restorePhase,archived:Boolean(button.dataset.archivePhase)});return;}
    if(button.hasAttribute('data-final-result')){openEditor('Передать итог руководителю',`<form id="final-result-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}"><label>Итоговый результат<textarea name="text" required maxlength="4000" placeholder="Что получено по поручению?"></textarea></label><p class="report-note">Итог сохраняется отдельной версией. Принять его может руководитель.</p><button class="primary" type="submit">Передать руководителю</button></form>`);return;}
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
    if(button.dataset.taskAction==='rework'){openEditor('Вернуть результат на доработку',`<form id="rework-editor" data-task-id="${esc(task.id)}" data-version="${esc(state().memory.taskVersion)}" data-result-id="${esc(task.submittedResultSourceId)}"><label>Что нужно исправить<textarea name="reason" required maxlength="1000" placeholder="Укажи конкретные замечания к переданному результату"></textarea></label><p class="report-note">Замечания сохранятся в истории и переписке по задаче вместе со ссылкой на этот результат. Утверждённый срок не изменится.</p><button class="primary" type="submit">Вернуть с замечаниями</button></form>`);return;}
    if(button.dataset.taskAction)mutate('task-action',{...target,action:button.dataset.taskAction});
    if(button.dataset.stageAction){const phase=task.phases.find(p=>p.id===button.dataset.phaseId);if(!phase)return;if(button.dataset.stageAction==='accept')mutate('stage-result',{...target,phaseId:phase.id,action:'accept',resultId:button.dataset.resultId});else stageResultEditor(task,phase,button.dataset.stageAction,button.dataset.resultId);return;}
    if(button.dataset.template)mutate('draft-create',{...target,kind:button.dataset.template});
  });
  $('#task-dialog').addEventListener('change',event=>{
    if(event.target.id==='result-reviewed'){const accept=$('[data-decision="accept"]');if(accept){accept.disabled=!event.target.checked;accept.dataset.unavailable=String(!event.target.checked);}}
  });
  $('#task-dialog').addEventListener('input',event=>{
    if(event.target.id==='chat-task-search'){const term=event.target.value.trim().replace(/^\//,'').toLocaleLowerCase('ru');document.querySelectorAll('[data-chat-task]').forEach(button=>button.hidden=!button.textContent.toLocaleLowerCase('ru').includes(term));}
  });
  $('#task-dialog').addEventListener('submit',event=>{
    if(event.target.id==='message-form'){event.preventDefault();mutate('message',{taskId:state().selected,text:inputValue(event.target,'text').trim(),requestUpdate:event.target.elements.requestUpdate.checked,...(event.target.elements.documentVersion?.value?{documentReference:{documentId:state().memory.requestState.artifacts.find(a=>a.id===event.target.elements.documentVersion.value).documentId,versionId:event.target.elements.documentVersion.value}}:{})});}
    if(event.target.id==='assistant-form'){event.preventDefault();mutate('assistant',{taskId:state().selected,expectedVersion:state().memory.taskVersion,question:inputValue(event.target,'question').trim()},{taskId:state().selected});}
  });
  $('#editor-dialog').addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,dialog='#editor-dialog';
    if(form.id==='snapshot-report-form'){saveReportForm(form);return;}
    if(form.id==='task-editor'){
      if(ctx.busy())return;
      if(!editingTask&&uncertainCreate()){protectCreateForm();message('#editor-message','Сначала подтверди исходный запрос. Новое поручение не отправлено.');return;}
      const title=form.elements.namedItem('title');
      title.setCustomValidity(title.value.trim()?'':'Напиши, что нужно сделать — не только пробелы.');
      if(!title.reportValidity()){title.focus();return;}
      const fields=Object.fromEntries(['title','description','employeeId','project','due','dueTime','protocolNumber','protocolPoint','protocolDate','priority','supervision','startAt'].map(k=>[k,k==='supervision'?inputValue(form,k)==='true':k==='startAt'?(inputValue(form,k)?inputValue(form,k)+':00+03:00':null):inputValue(form,k)]));mutate(editingTask?'task-edit':'task-create',{fields,...(editingTask?{taskId:editingTask.id,expectedVersion:editingTask.version}:creatingChild||{})},{dialog});}
    if(form.id==='rework-editor'){const reason=form.elements.namedItem('reason');reason.setCustomValidity(reason.value.trim()?'':'Укажи, что именно нужно исправить.');if(!reason.reportValidity()){reason.focus();return;}mutate('task-action',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,submittedResultSourceId:form.dataset.resultId,action:'rework',reason:reason.value.trim()},{dialog});}
    if(form.id==='pause-editor')mutate('task-action',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,action:'pause',reason:inputValue(form,'reason').trim()},{dialog});
    if(form.id==='final-result-editor'){const field=form.elements.namedItem('text');field.setCustomValidity(field.value.trim()?'':'Опиши итоговый результат.');if(!field.reportValidity())return;mutate('final-result',{taskId:form.dataset.taskId,expectedVersion:form.dataset.version,text:field.value.trim()},{dialog});}
    if(form.id==='stage-result-editor'){const field=form.elements.namedItem(form.dataset.action==='submit'?'text':'reason');field.setCustomValidity(field.value.trim()?'':'Заполни содержательно, не только пробелами.');if(!field.reportValidity())return;mutate('stage-result',{taskId:form.dataset.taskId,phaseId:form.dataset.phaseId,expectedVersion:form.dataset.version,action:form.dataset.action,...(form.dataset.action==='submit'?{text:field.value.trim()}:{reason:field.value.trim(),resultId:form.dataset.resultId})},{dialog});}
    if(form.id==='phase-editor')mutate('phase-save',{taskId:editingPhase.taskId,expectedVersion:editingPhase.version,phaseId:editingPhase.id,phase:{preparation:form.elements.preparation.checked,title:inputValue(form,'title'),start:inputValue(form,'start'),end:inputValue(form,'end'),dependsOn:inputValue(form,'dependsOn')||null,assigneeId:inputValue(form,'assigneeId')||null}},{dialog});
    if(form.id==='draft-editor')mutate('draft-save',{draftId:draft.id,expectedVersion:draft.version,expectedTaskVersion:draft.taskVersion,title:inputValue(form,'title'),body:inputValue(form,'body'),status:inputValue(form,'status')},{dialog});
    if(form.id==='automation-form')mutate('automation',{enabled:form.elements.enabled.checked},{dialog});
    if(form.id==='person-disable-form')mutate('person-disable',{employeeId:form.dataset.employeeId},{dialog}).then(result=>{if(result)teamEditor();});
    if(form.id==='person-editor')mutate('person-create',{name:inputValue(form,'name')},{dialog});
    if(form.id==='connection-editor')saveConnectionForm(form);
    if(form.id==='llm-editor'&&llmSettings)mutate('llm-settings',{expectedVersion:llmSettings.version,roles:Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}]))},{dialog});
  });
  $('#editor-dialog').addEventListener('click',async event=>{
    if(!ctx.busy()){
      if(event.target.closest('[data-retry-create]')){
        const item=uncertainCreate();if(item)mutate('task-create',JSON.parse(item.input),{dialog:'#editor-dialog',recoverCreate:true});return;
      }
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
  return {renderBoard,detailMarkup,appendDetail,detailMounted(){changeDetailView(detailView);recursive.mounted();loadJobs();},canRefresh,isImportant:important,reset(){recursive.reset();pending.clear();jobsFor=null;auto=false;view='board';sortMode='priority';lastSignal='';$('#murmuration').checked=false;if($('#editor-dialog').open)$('#editor-dialog').close();$('#brief-text').textContent='';}};
}

return {sortBoardTasks,decisionEvidenceMarkup,assistantReviewLabel,deadlineState,cardPulseProgress,cardPulseState,cardPulsePath,installPrototype};})();
