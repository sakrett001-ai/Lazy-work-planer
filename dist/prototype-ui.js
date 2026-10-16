const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const labels = { planned:'Запланировано', active:'В работе', blocked:'Есть препятствие', review:'На проверке', done:'Принято' };
const draftNames = { extension:'Письмо о переносе', request:'Запрос данных', clarify:'Уточнение статуса', plan:'План действий', review:'Проверка результата' };
const fieldNames = { status:'Состояние', summary:'Что известно', blocker:'Препятствие', due:'Утверждённый срок', proposedDue:'Предложенный срок', needsDecision:'Нужно решение', nextAction:'Следующий шаг' };
const shift = (day, n) => new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow' }).format(new Date());

export function installPrototype(ctx) {
  const $ = s => document.querySelector(s);
  let view='board', month=today().slice(0,7)+'-01', lastInteraction=Date.now(), auto=false, draft=null, editingTask=null, editingPhase=null, jobsFor=null, lastSignal='', llmSettings=null;
  const pending=new Map();
  const jobViews=new WeakMap();
  const state=()=>ctx.get();
  const manager=()=>state().identity?.role==='manager';
  const selectedTask=()=>state().memory?.task || state().snapshot?.tasks.find(t=>t.id===state().selected);
  const modalOpen=()=>Boolean(document.querySelector('dialog[open]'));
  const message=(selector,text,success=false)=>ctx.note(selector,text,success);
  const inputValue=(form,name)=>form.elements.namedItem(name)?.value || '';
  function interval(task) {
    if (!task.due) return { text:'Без срока', kind:'none' };
    const time=Date.parse(`${task.due}T${task.dueTime||'18:00'}:00+03:00`)-Date.now();
    if (task.status==='done') return {text:'Завершено',kind:'done'};
    const hours=Math.ceil(Math.abs(time)/3600000), span=hours>=24?`${Math.ceil(hours/24)} дн.`:`${hours} ч.`;
    return {text:time<0?`Просрочено на ${span}`:time<3600000?'Срок меньше часа':`Осталось ${span}`,kind:time<0?'overdue':time<86400000?'soon':'normal'};
  }
  function important(task) { return task.needsDecision || task.needsClarification || task.status==='blocked' || ['no_reply','awaiting'].includes(task.contact) || ['overdue','soon'].includes(interval(task).kind); }
  function person(id) { return state().snapshot?.employees.find(p=>p.id===id)?.name || 'Участник'; }
  function smallButton(action,label,attrs='') { return `<button type="button" class="secondary" ${action} ${attrs}>${label}</button>`; }
  function card(task) {
    const {snapshot}=state(), status=Object.hasOwn(labels,task.status)?task.status:'planned';
    const pin=snapshot.preferences.pins.includes(task.id), signal=important(task)&&snapshot.preferences.seen[task.id]!==task.version;
    const due=interval(task);
    return `<article class="task ${status} ${pin?'pinned':''} ${signal?'has-signal':''}">
      <div class="task-top"><span>${esc(task.id)}</span><button type="button" class="pin-button ${pin?'is-pinned':''}" data-pin="${esc(task.id)}" aria-pressed="${pin}" aria-label="${pin?'Открепить':'Закрепить'} ${esc(task.title)}" title="${pin?'Открепить':'Закрепить'}">⌖</button></div>
      <button class="card-open" data-task="${esc(task.id)}"><span class="status">${labels[status]}</span><h2>${esc(task.title)}</h2><p class="summary">${esc(task.summary||task.description||'Ожидаем первое обновление.')}</p>
      <div class="task-meta">${esc(person(task.employeeId))}${task.project?' · '+esc(task.project):''}${task.protocol?`<div>Протокол ${esc(task.protocol.number||'без номера')}${task.protocol.point?' · п. '+esc(task.protocol.point):''}${task.protocol.date?' · '+ctx.date(task.protocol.date):''}</div>`:''}</div>
      <div class="task-bottom"><span class="${due.kind}">${esc(due.text)}</span><span aria-hidden="true">↗</span></div></button>
      ${signal?`<button class="notice-button" data-notice="${esc(task.id)}">${task.proposedDue?'Запрошен перенос':task.status==='blocked'?'Нужна помощь':task.contact==='awaiting'?'Запрошен статус':'Есть событие'} · заметил ✓</button>`:''}
    </article>`;
  }
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
    $('#new-task').hidden=!manager(); $('#team').hidden=!manager(); $('#llm-settings').hidden=!manager();
    $('#mode-label').textContent=snapshot.assistant.available?'ИИ: консультации по задачам':'Сводка и шаблоны · ИИ не подключён';
    $('#example-banner').hidden=!snapshot.examples;
    $('#brief-text').textContent=snapshot.brief.text;
    const signals=tasks.filter(important).map(t=>t.id+':'+t.version).join('|');
    if(auto&&lastSignal&&signals!==lastSignal&&canRefresh())view='board';
    lastSignal=signals;
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
    $('#month-tools').hidden=view==='board';
    $('#month-label').textContent=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'T12:00:00Z'));
    $('#board').className=view==='board'?'board':'alternate-view';
    if(!tasks.length)return '<div class="empty"><span class="empty-mark">✦</span>Здесь пока нет задач.<br><small>Измени фильтр или создай первое поручение.</small></div>';
    if(view==='calendar')return calendar(tasks);
    if(view==='gantt')return gantt(tasks);
    const pins=tasks.filter(t=>snapshot.preferences.pins.includes(t.id)&&t.status!=='done'), rest=tasks.filter(t=>!pins.includes(t));
    return `${pins.length?'<div class="board-label">⌖ Закреплено</div>'+pins.map(card).join('')+'<div class="board-label">Остальные задачи</div>':''}${rest.map(card).join('')}`;
  }
  function detailMarkup() {
    const {memory,identity,selected}=state(), task=selectedTask(), current=memory.current, own=task.employeeId===identity.id&&current.status!=='done';
    const actions=manager()?[...(current.proposedDue?[['approve_due','Согласовать срок'],['reject_due','Сохранить прежний срок']]:[]),...(current.status==='review'?[['accept','Принять результат']]:[]),...(task.needsDecision&&current.status!=='review'&&!current.proposedDue?[['take_control','Взять вопрос в работу']]:[])]:[];
    const extras=manager()?({planned:[['start','Начать работу']],blocked:[['unblock','Препятствие устранено']],review:[['rework','Вернуть на доработку']],done:[['reopen','Вернуть в работу']]}[current.status]||[]):[];
    const phases=task.phases||[], suggested=memory.suggestion;
    return `<header class="detail-header"><span class="eyebrow">${esc(selected)} · ${esc(labels[current.status]||current.status)}</span><h2 id="task-title">${esc(memory.title)}</h2><p>${esc(person(task.employeeId))} · ${esc(task.project||'Мои поручения')} · ${ctx.date(current.due)}</p>${task.description?`<p class="task-description">${esc(task.description)}</p>`:''}<div class="actions">${manager()&&current.status!=='done'?smallButton('data-edit-task','Изменить поручение'):''}${extras.map(([action,label])=>smallButton(`data-task-action="${action}"`,label)).join('')}</div></header>
      <p id="detail-message" class="message" role="status" aria-live="polite"></p><button type="button" id="reload-detail" class="secondary" hidden>В задаче есть обновления · показать</button>
      ${actions.length?`<section class="decision-box"><h3>Нужно твоё решение</h3><p>${current.proposedDue?`Предложено: ${ctx.date(current.proposedDue)}. Действующий срок: ${ctx.date(current.due)}.`:esc(task.blocker||task.summary||'Проверь результат и основания.')}</p><div class="actions">${actions.map(([action,label])=>smallButton(`data-decision="${action}"`,label)).join('')}</div><small>Решение изменит задачу и останется в истории.</small></section>`:''}
      <section class="detail-section"><h3>Обсуждение задачи</h3><div class="conversation">${(memory.conversation||[]).map(s=>`<article class="bubble ${s.kind==='manager_message'?'from-manager':''}"><small>${esc(s.authorName)} · ${ctx.date(s.occurredAt||s.receivedAt,true)}</small><p>${esc(s.text)}</p></article>`).join('')||'<p class="report-note">Обсуждение начнётся с первого сообщения.</p>'}</div>
      ${own?`<form id="report-form"><label for="report-text">Что готово и где нужна помощь?</label><textarea id="report-text" maxlength="4000" required placeholder="Например: ожидаем исходные данные, нужна помощь…"></textarea><p class="report-note">Ответ сохраняется вместе с источником. Разбор статуса сейчас выполняется по правилам; приёмку и перенос подтверждает руководитель.</p><button class="primary" type="submit">Сообщить статус ↗</button></form>`:manager()&&current.status!=='done'?`<form id="message-form"><label for="manager-message">Сообщение исполнителю</label><textarea id="manager-message" name="text" maxlength="4000" required placeholder="Уточни готовый результат или предложи следующий шаг…"></textarea><label class="check-label"><input type="checkbox" name="requestUpdate"> Запросить обновление статуса</label><button class="primary" type="submit">Добавить в обсуждение ↗</button><small class="report-note">Сообщение появится у исполнителя в этой задаче.</small></form>`:''}</section>
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
    message(messageTarget,'');
    const key=JSON.stringify({path,input}); if(!pending.has(key))pending.set(key,crypto.randomUUID());
    let saved=false;
    try {
      const result=await ctx.api(path,{...input,requestId:pending.get(key)});saved=true;pending.delete(key);
      if(dialog)$(dialog).close();
      if(after)after(result);
      await ctx.refresh();
      const task=['pin','notice'].includes(path)?null:result.taskId||taskId;
      if(task) {await ctx.openTask(task);message('#detail-message','Сохранено.',true);}
      else message('#workspace-message','Сохранено.',true);
      return result;
    } catch(error) { message(saved?'#workspace-message':messageTarget,saved?'Изменение сохранено. Обнови данные, когда связь восстановится.':error.message,saved); }
    finally {ctx.setBusy(false);}
  }
  function openEditor(title,markup) {
    $('#editor-title').textContent=title;$('#editor-content').innerHTML=markup;message('#editor-message','');if(!$('#editor-dialog').open)$('#editor-dialog').showModal();
  }
  function input(name,label,value='',type='text',extra='') { return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
  function taskEditor(task=null) {
    editingTask=task?{id:task.id,version:state().memory.taskVersion}:null;
    openEditor(task?'Изменить поручение':'Новое поручение',`<form id="task-editor"><label>Что нужно сделать?<input name="title" required maxlength="160" value="${esc(task?.title||'')}" placeholder="Например: подготовить свод предложений"></label><label>Ожидаемый результат<textarea name="description" maxlength="2000" placeholder="Что должно получиться и как понять, что задача выполнена">${esc(task?.description||'')}</textarea></label><div class="form-grid"><label>Исполнитель<select name="employeeId">${state().snapshot.employees.map(p=>`<option value="${esc(p.id)}" ${p.id===(task?.employeeId||state().identity.id)?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>${input('project','Проект',task?.project||'','text','maxlength="120"')}${input('due','Срок (необязательно)',task?.due||'','date')}${input('dueTime','Время, Москва',task?.dueTime||'18:00','time','required')}</div><details ${task?.protocol?'open':''}><summary>Реквизиты протокола — если есть</summary><div class="form-grid">${input('protocolNumber','Номер',task?.protocol?.number||'','text','maxlength="100"')}${input('protocolPoint','Пункт',task?.protocol?.point||'','text','maxlength="100"')}${input('protocolDate','Дата',task?.protocol?.date||'','date')}</div></details><button type="submit" class="primary">${task?'Сохранить изменения':'Поставить задачу'} ↗</button></form>`);
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
    const id=selected, actorId=identity.id; jobsFor=id;
    try { const data=await ctx.api('assistant?taskId='+encodeURIComponent(id));if(state().selected!==id||state().identity?.id!==actorId||!$('#assistant-jobs'))return;
      const box=$('#assistant-jobs'),signature=JSON.stringify(data.jobs);if(jobViews.get(box)===signature)return;
      box.innerHTML=data.jobs.map(job=>`<article class="ai-result"><small>${ctx.date(job.createdAt,true)} · ${({pending:'В очереди',running:'Ассистент работает',completed:'Ответ подготовлен',failed:'Требуется повторный запрос'})[job.status]}</small><h4>${esc(job.question)}</h4>${executionMarkup(job)}${job.stale?'<p class="message">В задаче появились новые сведения. Сверь ответ с актуальной памятью или задай новый вопрос.</p>':''}<p>${esc(job.text||job.error||'Можно продолжать работать с доской.')}</p>${(job.references||[]).map(ref=>`<blockquote>${esc(ref.quote)}<small>Цитата из сообщения по задаче</small>${sourceReader(ref.sourceId,ref.version)}</blockquote>`).join('')}</article>`).join('');
      jobViews.set(box,signature);
    } catch(error) {if(state().selected===id&&state().identity?.id===actorId&&$('#assistant-jobs')){jobViews.delete($('#assistant-jobs'));$('#assistant-jobs').textContent=error.message;}}
  }
  async function checkDetail() {
    const {selected,identity,memory}=state();if(!selected||!identity||!memory||ctx.busy()||document.hidden||!$('#task-dialog').open)return;
    const id=selected,actorId=identity.id;
    try {
      const fresh=await ctx.api('memory?taskId='+encodeURIComponent(id));
      if(state().selected!==id||state().identity?.id!==actorId||!$('#reload-detail'))return;
      const key=data=>JSON.stringify([data.taskVersion,data.conversation?.at(-1)?.id,data.drafts?.map(d=>d.version),data.timeline?.[0]?.key]);
      $('#reload-detail').hidden=key(fresh)===key(state().memory);
    }catch(error){if(state().selected===id)message('#detail-message',error.message);}
  }
  async function reloadDetail() {
    if(ctx.busy())return;
    const id=state().selected,values=Object.fromEntries(['report-text','manager-message','assistant-question'].map(key=>[key,$('#'+key)?.value||'']));
    ctx.setBusy(true);
    try {await ctx.refresh();await ctx.openTask(id);
      for(const [key,value] of Object.entries(values)){if(!value)continue;if($('#'+key))$('#'+key).value=value;else $('#task-content').insertAdjacentHTML('beforeend',`<section class="detail-section"><h3>Твой несохранённый текст</h3><p class="report-note">Состояние задачи изменилось. Скопируй текст, если он ещё нужен.</p><textarea readonly>${esc(value)}</textarea></section>`);}
    }catch(error){message('#detail-message',error.message);}finally{ctx.setBusy(false);}
  }
  function teamEditor() {
    openEditor('Участники прототипа',`<form id="automation-form"><label class="check-label"><input name="enabled" type="checkbox" ${state().snapshot.autoCheckins?'checked':''}> Ассистент запрашивает статусы в приложении</label><p class="report-note">По будням, 09:00–18:00 по Москве; не чаще раза в 6 часов. Свежий ответ откладывает следующий запрос. Это сообщения внутри задач.</p><button type="submit" class="secondary">Сохранить режим</button></form><div id="team-list">${state().snapshot.employees.map(p=>`<div class="person-row"><div><strong>${esc(p.name)}</strong><small>${p.role==='manager'?'Руководитель':'Сотрудник'}</small></div>${p.role!=='manager'||p.id===state().identity.id?smallButton(`data-invite="${esc(p.id)}"`,'Код входа'):''}</div>`).join('')}</div><div id="invite-result" role="status"></div><form id="person-editor"><h3>Добавить сотрудника</h3>${input('name','Имя','','text','required maxlength="120"')}<button class="primary" type="submit">Добавить</button></form>`);
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
    return `<details class="role-trace"><summary>Кто подготовил ответ</summary><ul>${job.execution.routes.map(r=>`<li><strong>${esc(roleNames[r.roleId]||r.roleId)}</strong> · ${esc(r.connectionLabel)} · ${esc(r.provider)} · ${esc(r.model)}</li>`).join('')}</ul>${job.execution.review?`<p>Проверка: ${esc(job.execution.review)}</p>`:''}${job.execution.errorCode?`<p class="message">${esc(errors[job.execution.errorCode]||'Ответ не подтверждён.')}</p>`:''}</details>`;
  }
  function canRefresh() {return !modalOpen()&&!ctx.busy()&&!document.hidden&&Date.now()-lastInteraction>8000&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);}
  const interact=()=>{lastInteraction=Date.now();};document.addEventListener('pointerdown',interact);document.addEventListener('keydown',interact);
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;ctx.renderBoard();}));
  $('#prev-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#next-month').addEventListener('click',()=>{const d=new Date(month+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,10);ctx.renderBoard();});
  $('#today-month').addEventListener('click',()=>{month=today().slice(0,7)+'-01';ctx.renderBoard();});
  $('#murmuration').addEventListener('change',event=>{auto=event.target.checked;lastInteraction=Date.now();$('#motion-note').textContent=auto?'Смена видов каждые 30 секунд; пауза при взаимодействии.':'Ты управляешь доской.';});
  $('#pulse').addEventListener('change',event=>document.body.classList.toggle('quiet-motion',!event.target.checked));
  $('#new-task').addEventListener('click',()=>taskEditor());$('#team').addEventListener('click',teamEditor);$('#llm-settings').addEventListener('click',modelsEditor);
  $('#close-editor').addEventListener('click',()=>{if(!ctx.busy())$('#editor-dialog').close();});
  $('#editor-dialog').addEventListener('cancel',event=>{if(ctx.busy())event.preventDefault();});
  $('#editor-dialog').addEventListener('close',()=>{$('#editor-content').replaceChildren();draft=null;editingTask=null;editingPhase=null;llmSettings=null;});
  $('#editor-dialog').addEventListener('change',event=>{
    if(event.target.form?.id==='connection-editor'){
      event.target.form.dataset.requestId=crypto.randomUUID();
      if(event.target.name==='provider')$('#giga-scope-field').hidden=event.target.value!=='gigachat';
    }
    const role=event.target.dataset.llmConnection;if(!role||!llmSettings)return;
    const model=event.target.form.elements.namedItem(role+'-model');model.innerHTML=modelOptions(event.target.value,null);
  });
  $('#editor-dialog').addEventListener('input',event=>{if(event.target.form?.id==='connection-editor')event.target.form.dataset.requestId=crypto.randomUUID();});
  $('#board').addEventListener('click',event=>{const pin=event.target.closest('[data-pin]'),notice=event.target.closest('[data-notice]');if(!pin&&!notice)return;
    const id=(pin||notice).dataset[pin?'pin':'notice'],task=state().snapshot.tasks.find(t=>t.id===id);if(!task)return;
    mutate(pin?'pin':'notice',pin?{taskId:id,pinned:!state().snapshot.preferences.pins.includes(id)}:{taskId:id,expectedVersion:task.version});
  });
  $('#task-dialog').addEventListener('click',event=>{
    if(ctx.busy())return;const button=event.target.closest('button');if(!button)return;const task=selectedTask();if(!task)return;
    if(button.hasAttribute('data-edit-task'))taskEditor(task);
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
    if(form.id==='task-editor'){const fields=Object.fromEntries(['title','description','employeeId','project','due','dueTime','protocolNumber','protocolPoint','protocolDate'].map(k=>[k,inputValue(form,k)]));mutate(editingTask?'task-edit':'task-create',{fields,...(editingTask?{taskId:editingTask.id,expectedVersion:editingTask.version}:{})},{dialog});}
    if(form.id==='phase-editor')mutate('phase-save',{taskId:editingPhase.taskId,expectedVersion:editingPhase.version,phaseId:editingPhase.id,phase:{title:inputValue(form,'title'),start:inputValue(form,'start'),end:inputValue(form,'end'),dependsOn:inputValue(form,'dependsOn')||null}},{dialog});
    if(form.id==='draft-editor')mutate('draft-save',{draftId:draft.id,expectedVersion:draft.version,expectedTaskVersion:draft.taskVersion,title:inputValue(form,'title'),body:inputValue(form,'body'),status:inputValue(form,'status')},{dialog});
    if(form.id==='automation-form')mutate('automation',{enabled:form.elements.enabled.checked},{dialog});
    if(form.id==='person-editor')mutate('person-create',{name:inputValue(form,'name')},{dialog});
    if(form.id==='connection-editor')saveConnectionForm(form);
    if(form.id==='llm-editor'&&llmSettings)mutate('llm-settings',{expectedVersion:llmSettings.version,roles:Object.fromEntries(Object.keys(roleNames).map(id=>[id,{enabled:form.elements.namedItem(id+'-enabled').checked,connectionId:inputValue(form,id+'-connection')||null,model:inputValue(form,id+'-model')||null}]))},{dialog});
  });
  $('#editor-dialog').addEventListener('click',async event=>{
    if(!ctx.busy()){
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
  const detailTimer=setInterval(checkDetail,15000);
  window.addEventListener('pagehide',()=>{clearInterval(rotation);clearInterval(jobsTimer);clearInterval(detailTimer);const field=$('#connection-editor input[name="apiKey"]');if(field){field.value='';field.form.dataset.requestId=crypto.randomUUID();}});
  return {renderBoard,detailMarkup,detailMounted:loadJobs,canRefresh,isImportant:important,reset(){pending.clear();jobsFor=null;auto=false;view='board';lastSignal='';$('#murmuration').checked=false;if($('#editor-dialog').open)$('#editor-dialog').close();$('#brief-text').textContent='';}};
}
