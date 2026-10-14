import { mentionedTaskIds, validDate } from './domain.js';
import { scenarios } from './fixtures.js';
import { icon } from './icons.js';
import { TIMEZONE, DAY, dayKey, shiftDay, shortDate, deadline, appearance, rankTask, scopeTasks, selectTasks, progress, createWorkspace, migrateWorkspace, proposal, makeDraft, addTask, editTask, changeTask, setPhase, savePhase, calendarDays, achievements, scenarioFor, applyScenario } from './workspace-model.js';

const KEY = 'rut-assistant-demo-v02';
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const $ = selector => document.querySelector(selector);
const now = () => new Date();
let state, loadNotice = '';
try { state = migrateWorkspace(JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('rut-assistant-demo-v01') || 'null')); }
catch { state = createWorkspace(); loadNotice = 'Не удалось прочитать прошлое состояние. Загружена новая демонстрация.'; }
const views = { board:['Доска','board','Задачи в движении','Всё, что важно. И понятный следующий шаг.'], calendar:['Календарь','calendar','Время на твоей стороне','Сроки и загрузка — на одном календаре. Время московское.'], timeline:['Этапы и Гант','timeline','Большие задачи. Ясные шаги','Этапы, сроки и зависимости без потери общей картины.'], archive:['Архив','archive','Сделано. Можно выдохнуть','Принятые результаты, их основания и история.'], chat:['Ассистент','spark','Давай двигаться дальше','Сводка, варианты действий и черновики в одном разговоре.'], settings:['Настройки','sliders','Твой рабочий ритм','Движение, достижения и будущие правила взаимодействия.'] };
const initialHash = location.hash.slice(1);
let view = views[initialHash] ? initialHash : ({ overview:'board', tasks:'board', dialogs:'chat' }[initialHash] || 'board');
let scope = 'management', filter = 'all', search = '', sort = 'priority', month = dayKey().slice(0, 7), timelineId = 'П-102';
let activeTaskId = null, draftType = null, draftDirty = false, simKey = 'complete', simStep = 0, simApplied = false, toastTimer;
const main = $('#main'), modal = $('#modal');
const person = id => state.employees.find(p => p.id === id) || { name:'Не назначен', initials:'?', color:'muted' };
const avatar = id => { const p = person(id); return `<span class="avatar ${e(p.color)}" aria-hidden="true">${e(p.initials)}</span>`; };
const displayTime = at => at ? new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:TIMEZONE }).format(new Date(at)) : 'Дата не указана';
const activeTasks = () => selectTasks(state, { scope, filter, search, sort }, now());
const allScoped = () => scopeTasks(state, scope);
const openScoped = () => allScoped().filter(t => t.status !== 'done');
const findTask = id => state.tasks.find(t => t.id === id);
const sourceFor = task => state.sources.find(s => s.id === task.latestSourceId);
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute('data-icon'); }); }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4200); }
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('Сохранение в браузере недоступно. Изменения останутся до закрытия вкладки.'); } }
function motionAllowed() { return state.settings.motion !== false && !window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function applyPreferences() { document.body.classList.toggle('reduce-motion', !motionAllowed()); $('#motion-toggle').setAttribute('aria-pressed', String(!motionAllowed())); $('#motion-toggle').title = motionAllowed() ? 'Уменьшить движение' : 'Включить движение'; $('#motion-toggle').setAttribute('aria-label', $('#motion-toggle').title); }
function nav() {
  $('#navigation').innerHTML = Object.entries(views).filter(([id]) => id !== 'settings').map(([id, v]) => `<button class="nav-item ${view === id ? 'active' : ''}" data-action="view" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(v[1])}${v[0]}${id === 'board' ? `<span class="nav-number">${openScoped().length}</span>` : id === 'archive' ? `<span class="nav-number">${allScoped().filter(t=>t.status==='done').length}</span>` : ''}</button>`).join('');
  $('#mobile-navigation').innerHTML = ['board','calendar','timeline','chat','archive'].map(id => `<button data-action="view" data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}>${icon(views[id][1])}<span>${id === 'timeline' ? 'Этапы' : views[id][0]}</span></button>`).join('');
  document.querySelectorAll('[data-action="scope"]').forEach(b => { b.classList.toggle('selected', b.dataset.scope === scope); b.setAttribute('aria-pressed', String(b.dataset.scope === scope)); });
  $('#achievement-count').textContent = achievements(state).filter(a => a.value >= a.target).length;
  $('#breadcrumb-view').textContent = views[view][0]; $('#page-title').innerHTML = e(views[view][2]) + '<span>.</span>'; $('#page-subtitle').textContent = views[view][3];
  $('#today-label').textContent = new Intl.DateTimeFormat('ru-RU', { weekday:'short', day:'numeric', month:'long', timeZone:TIMEZONE }).format(now());
  document.querySelector('.control-bar').hidden = view === 'settings';
  $('#search').disabled = view === 'chat';
  $('#search').placeholder = view === 'chat' ? 'Область задач задаётся слева' : 'Найти задачу, человека, протокол…';
  const settingsNav = document.querySelector('.sidebar [data-view="settings"]'); settingsNav?.classList.toggle('active', view === 'settings');
}
function empty(title, text, action = 'new-task', label = 'Создать задачу') { return `<div class="empty-state">${icon('spark')}<h2>${e(title)}</h2><p>${e(text)}</p><button class="button primary" data-action="${action}">${e(label)}</button></div>`; }
function statistics() {
  const tasks = openScoped(), values = [
    ['all', 'На контроле', tasks.length, 'открытых задач', 'cyan', 'board'],
    ['attention', 'Нужно внимание', tasks.filter(t=>rankTask(t)<=5).length, 'следующих действий', 'coral', 'spark'],
    ['week', 'Ближайшие сроки', tasks.filter(t=>t.due && t.due>=dayKey() && t.due<=shiftDay(dayKey(),6)).length, 'ближайших сроков', 'violet', 'calendar'],
    ['archive', 'В архиве', allScoped().filter(t=>t.status==='done').length, 'принятых результатов', 'mint', 'check']
  ];
  return `<section class="metrics" aria-label="Сводка по выбранной области">${values.map(([key,label,note,sub,color,glyph])=>`<button class="metric ${color}" data-action="metric" data-filter="${key}"><span class="metric-label"><i class="small-dot"></i>${label}</span><span class="metric-bottom"><span><strong>${note}</strong> <small>${sub}</small></span><span class="metric-icon">${icon(glyph)}</span></span></button>`).join('')}</section>`;
}
function protocolLine(task) {
  if (!task.protocol) return `<span>${task.employeeId === 'manager' ? 'Личное поручение' : e(task.project || 'Поручение')} · без протокола</span>`;
  return `${icon('document')}<span>${task.protocol.number ? `Протокол № ${e(task.protocol.number)}` : 'Протокол'}${task.protocol.point ? ` · п. ${e(task.protocol.point)}` : ''}${task.protocol.date ? ` · ${shortDate(task.protocol.date)}` : ''}</span>`;
}
function card(task, index = 0) {
  const a = appearance(task), timer = deadline(task), p = progress(task), plan = proposal(task);
  const action = task.status === 'done' ? 'Посмотреть результат' : task.status === 'review' ? 'Проверить и принять' : task.proposedDue ? 'Решить вопрос о сроке' : task.status === 'blocked' ? 'Найти следующий шаг' : p.total ? 'Открыть этапы' : 'Открыть задачу';
  return `<article class="task-card ${a.color}" data-card-id="${e(task.id)}" style="--index:${Math.min(index,8)}"><button class="card-body" data-action="task" data-id="${e(task.id)}" aria-label="${e(task.title)}. ${a.label}"><span class="card-head"><span class="status-pill">${icon(a.icon)}${a.label}</span><span class="card-id">${e(task.id)}</span></span><h3>${e(task.title)}</h3><p class="summary">${e(task.summary || 'Добавь описание результата в карточке задачи.')}</p><span class="protocol">${protocolLine(task)}</span>${p.total ? `<span class="phase-progress" aria-hidden="true">${task.phases.map(x=>`<span class="${x.done?'done':''}"></span>`).join('')}</span><span class="phase-caption"><span>Этапы</span><span>${p.done} из ${p.total}</span></span>` : ''}<span class="card-bottom"><span class="card-owner">${avatar(task.employeeId)}<span>${e(person(task.employeeId).name)}</span><span class="due-date">${task.due ? shortDate(task.due) : 'Без срока'}</span></span><span class="card-countdown ${timer.kind}" data-countdown="${e(task.id)}" title="${task.due ? e(shortDate(task.due,true)+' в '+(task.dueTime||'18:00')+' МСК') : 'Срок не задан'}">${icon(timer.kind==='done'?'check':'clock')}<span>${timer.text}</span></span></span></button><button class="card-action" data-action="${task.phases?.length && !['done','review','blocked'].includes(task.status) && !task.proposedDue?'timeline-task':'task'}" data-id="${e(task.id)}"><span>${action}</span>${icon(task.status==='done'?'check':'upRight')}</button></article>`;
}
function board() {
  const tasks = activeTasks(), attention = openScoped().filter(t=>rankTask(t)<=5), top = [...attention].sort((a,b)=>rankTask(a)-rankTask(b))[0];
  return statistics() + `<div class="focus-banner"><span class="focus-spark">${icon('spark')}</span><div><h2>${top ? 'Начнём с того, где нужна твоя помощь' : 'Есть пространство для спокойной работы'}</h2><p>${top ? `${e(top.title)}. ${e(proposal(top).title)}.` : 'Сейчас нет критичных вопросов. Можно продвинуть плановые задачи.'}</p></div><button class="text-button" data-action="${top?'task':'view'}" ${top?`data-id="${e(top.id)}"`:'data-view="chat"'}>Посмотреть ${icon('arrow')}</button></div><div class="board-toolbar"><div class="filter-tabs" role="group" aria-label="Фильтры задач">${[['all','Все'],['attention','Внимание'],['week','7 дней'],['undated','Без срока']].map(([id,label])=>`<button class="filter-tab ${filter===id?'selected':''}" data-action="filter" data-filter="${id}" aria-pressed="${filter===id}">${label}${id==='all'?`<span>${openScoped().length}</span>`:''}</button>`).join('')}</div><label class="sr-only" for="sort-select">Сортировка карточек</label><select class="sort-select" id="sort-select"><option value="priority" ${sort==='priority'?'selected':''}>По приоритету</option><option value="deadline" ${sort==='deadline'?'selected':''}>По сроку</option></select></div>${tasks.length ? `<div class="board-grid">${tasks.map(card).join('')}<button class="new-card" data-action="new-task"><span class="add-circle">${icon('plus')}</span><strong>Есть ещё одна задача?</strong><p>Просто добавь её сюда</p></button></div>` : empty('Здесь пока спокойно',search || filter!=='all'?'По выбранным условиям ничего не найдено. Сбрось фильтры или добавь задачу.':'Добавь первое поручение в выбранную область.',search || filter!=='all'?'clear-filters':'new-task',search || filter!=='all'?'Сбросить фильтры':'Создать задачу')}<div class="board-legend"><span class="coral"><i class="small-dot"></i>Препятствие</span><span class="amber"><i class="small-dot"></i>Срок / перенос</span><span class="violet"><i class="small-dot"></i>На проверке</span><span class="cyan"><i class="small-dot"></i>В работе</span><span class="legend-note">Карточки поднимаются по срочности</span></div>`;
}
function agendaRows(tasks) { return tasks.map(t=>{const a=appearance(t);return `<button class="agenda-row ${a.color}" data-action="task" data-id="${e(t.id)}"><span class="agenda-date mono">${t.due?shortDate(t.due):'Без срока'}</span><span><h3>${e(t.title)}</h3><p>${e(person(t.employeeId).name)} · ${a.label}${t.due?' · '+e(t.dueTime||'18:00')+' МСК':''}</p></span></button>`;}).join(''); }
function calendar() {
  const tasks = selectTasks(state,{scope,search,sort:'deadline'}), days = calendarDays(month), title = new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:TIMEZONE}).format(new Date(month+'-15T12:00:00Z'));
  return `<div class="calendar-header"><h2>${e(title)}</h2><div class="calendar-controls"><button class="button small ghost" data-action="month-today">Сегодня</button><button class="icon-button" data-action="month" data-dir="-1" aria-label="Предыдущий месяц">${icon('left')}</button><button class="icon-button" data-action="month" data-dir="1" aria-label="Следующий месяц">${icon('right')}</button></div></div><div class="calendar-shell"><div class="calendar-weekdays">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(d=>`<div>${d}</div>`).join('')}</div><div class="calendar-grid">${days.map(d=>{const list=tasks.filter(t=>t.due===d);return `<div class="calendar-cell ${d.startsWith(month)?'':'outside'} ${d===dayKey()?'today':''}"><button class="day-number" data-action="day" data-date="${d}" aria-label="${shortDate(d,true)}: ${list.length} задач. Открыть день">${Number(d.slice(-2))}</button>${list.slice(0,2).map(t=>`<button class="calendar-task ${appearance(t).color}" data-action="task" data-id="${e(t.id)}" title="${e(t.title)} · ${e(t.dueTime||'18:00')} МСК" aria-label="${e(t.title)}"><span>${e(t.title)}</span></button>`).join('')}${list.length>2?`<button class="calendar-more" data-action="day" data-date="${d}">Ещё ${list.length-2}</button>`:''}</div>`;}).join('')}</div></div><div class="calendar-mobile-agenda"><div class="section-heading"><h2>Задачи месяца</h2></div><div class="agenda-list">${agendaRows(tasks.filter(t=>t.due?.startsWith(month))) || '<p class="view-note">На этот месяц задач нет.</p>'}</div></div><div class="unscheduled"><h3>Без срока · ${tasks.filter(t=>!t.due).length}</h3><div class="unscheduled-list">${tasks.filter(t=>!t.due).map(t=>`<button data-action="task" data-id="${e(t.id)}">${e(t.title)} ${icon('upRight')}</button>`).join('')||'<p class="view-note">У всех задач в этой области задан срок.</p>'}</div></div><p class="view-note">Задачи размещены по утверждённому сроку. Запрошенный перенос не перемещает их до согласования. Выбери день, чтобы посмотреть список или добавить задачу.</p>`;
}
function gantt(task, compact = false) {
  const phases = task.phases || []; if(!phases.length) return '<p class="view-note">У этой задачи пока нет этапов.</p>';
  const dates = phases.flatMap(p=>[p.start,p.end]).filter(validDate).sort(), first=shiftDay(dates[0],-1), last=shiftDay(dates.at(-1),1), total=Math.round((Date.parse(last)-Date.parse(first))/DAY)+1;
  if(total>120) return '<p class="view-note">Длинный проект показан списком этапов ниже. Для шкалы выбери диапазон до 120 дней.</p>';
  const days=Array.from({length:total},(_,i)=>shiftDay(first,i)), todayPosition=(Date.parse(dayKey())-Date.parse(first))/DAY;
  return `<div class="timeline-scroll" tabindex="0" aria-label="Диаграмма Ганта. Для длинной шкалы прокручивай по горизонтали."><div class="timeline-inner" style="--days:${total};min-width:${Math.max(650,200+total*31)}px"><div class="timeline-top"><div class="timeline-top-label">Этап / зависимость</div><div class="timeline-days">${days.map(d=>`<div class="timeline-day ${d===dayKey()?'today':''}">${d.slice(-2)}<small>${new Intl.DateTimeFormat('ru-RU',{weekday:'short',timeZone:TIMEZONE}).format(new Date(d+'T12:00:00Z'))}</small></div>`).join('')}</div></div>${phases.map((p,i)=>{const start=Math.round((Date.parse(p.start)-Date.parse(first))/DAY)+1,length=Math.round((Date.parse(p.end)-Date.parse(p.start))/DAY)+1;return `<div class="timeline-row"><div class="phase-label"><button class="${p.done?'checked':''}" data-action="phase-toggle" data-id="${e(task.id)}" data-phase="${e(p.id)}" aria-label="${p.done?'Открыть снова':'Завершить'} этап ${e(p.title)}" aria-pressed="${p.done}" ${task.status==='done'?'disabled':''}>${p.done?icon('check'):''}</button><span>${e(p.title)}<small>${p.dependsOn?'После этапа '+(phases.findIndex(x=>x.id===p.dependsOn)+1):'Начало цепочки'}</small></span></div><div class="timeline-track">${todayPosition>=0&&todayPosition<total?`<span class="timeline-now" style="--today:${(todayPosition+.5)/total*100}%"></span>`:''}<button class="timeline-bar ${p.blocked?'coral':p.done?'mint':'violet'}" style="--start:${start};--length:${length}" data-action="phase-edit" data-id="${e(task.id)}" data-phase="${e(p.id)}" title="${e(p.title)}: ${shortDate(p.start)} — ${shortDate(p.end)}">${p.done?'✓ ':p.blocked?'! ':''}${length>2?e(p.title):i+1}</button></div></div>`;}).join('')}</div></div>`;
}
function phaseList(task) { return `<div class="phase-list">${(task.phases||[]).map((p,i)=>`<div class="phase-list-row"><button class="phase-check ${p.done?'checked':''}" data-action="phase-toggle" data-id="${e(task.id)}" data-phase="${e(p.id)}" aria-label="${p.done?'Открыть снова':'Завершить'} этап ${e(p.title)}" aria-pressed="${p.done}" ${task.status==='done'?'disabled':''}>${p.done?icon('check'):''}</button><span class="phase-title">${i+1}. ${e(p.title)}<small>${shortDate(p.start)} — ${shortDate(p.end)}${p.blocked?' · есть препятствие':''}${p.dependsOn?' · после этапа '+((task.phases||[]).findIndex(x=>x.id===p.dependsOn)+1):''}</small></span><button class="icon-button" data-action="phase-edit" data-id="${e(task.id)}" data-phase="${e(p.id)}" aria-label="Изменить этап ${e(p.title)}">${icon('pen')}</button></div>`).join('')}</div>`; }
function timeline() {
  const active=selectTasks(state,{scope,search}).filter(t=>t.phases?.length);
  const selectedArchive=scopeTasks(state,scope).find(t=>t.id===timelineId&&t.status==='done'&&t.phases?.length);
  const tasks=selectedArchive?[selectedArchive,...active]:active;
  let task=tasks.find(t=>t.id===timelineId)||tasks[0]; if(task)timelineId=task.id;
  if(!task)return empty('Разложим большую задачу на шаги','Открой любую карточку и добавь этапы с датами. Они появятся на этой шкале.','view-board','К задачам');
  const p=progress(task);
  return `<label class="sr-only" for="timeline-task">Проект для диаграммы Ганта</label><select class="timeline-select" id="timeline-task">${tasks.map(t=>`<option value="${e(t.id)}" ${t.id===task.id?'selected':''}>${e(t.id)} · ${e(t.title)}</option>`).join('')}</select><div class="timeline-summary"><div><h2>${e(task.title)}</h2><p>${e(person(task.employeeId).name)} · ${p.done} из ${p.total} этапов завершено · срок ${shortDate(task.due)}</p></div><button class="button small violet-button" data-action="task" data-id="${e(task.id)}">Открыть задачу ${icon('upRight')}</button></div>${gantt(task)}${phaseList(task)}<div class="detail-actions">${task.status!=='done'?`<button class="button ghost" data-action="phase-add" data-id="${e(task.id)}">${icon('plus')}Добавить этап</button>`:''}<button class="button ghost" data-action="draft" data-id="${e(task.id)}" data-type="plan">${icon('spark')}Подготовить план</button></div><p class="view-note">Линия отмечает сегодняшний день. Этапы идут по указанным зависимостям; изменение дат не переносит общий срок автоматически. Если открыть ранний этап снова, зависимые этапы тоже вернутся в работу.</p>`;
}
function archive() {
 const tasks=selectTasks(state,{scope,search,archive:true});
 return `<div class="archive-info">${icon('check')}Завершённые задачи сохраняют переписку, реквизиты и решения. При необходимости их можно вернуть в работу.</div>${tasks.length?`<div class="board-grid">${tasks.map(card).join('')}</div>`:empty('Здесь будут твои финиши','Прими результат на проверке — карточка перейдёт в архив.','view-board','Вернуться к доске')}`;
}
function renderRail() {
  const tasks=selectTasks(state,{scope}), suggestions=tasks.filter(t=>rankTask(t)<=5).slice(0,3), ids=new Set(allScoped().map(t=>t.id));
  const events=state.events.filter(x=>ids.has(x.taskId)).slice(0,3), rewards=achievements(state), unlocked=rewards.filter(a=>a.value>=a.target).length;
  $('#assistant-rail').innerHTML=`<div class="assistant-heading"><span class="assistant-orb">${icon('spark')}</span><div><h2>Твой ассистент</h2><p>Сценарная демонстрация · без ИИ</p></div></div><div class="rail-presence"><i class="small-dot"></i><span>${document.visibilityState==='visible'?'Ты в приложении · эта вкладка активна':'Вкладка в фоне'}</span></div><div class="rail-label">СЛЕДУЮЩИЙ ШАГ <span>${suggestions.length}</span></div>${suggestions.length?suggestions.map(t=>{const p=proposal(t);return `<article class="suggestion"><div class="suggestion-task"><span>${e(t.id)} · ${e(person(t.employeeId).name)}</span>${icon('spark')}</div><h3>${e(p.title)}</h3><p>${e(p.detail)}</p><button class="button violet-button" data-action="draft" data-id="${e(t.id)}">${icon('pen')}Подготовить черновик</button><button class="source-link" data-action="task" data-id="${e(t.id)}">Посмотреть задачу и основание ↗</button></article>`;}).join(''):`<div class="suggestion"><h3>Можно заняться плановой работой</h3><p>По выбранным задачам сейчас нет срочных сигналов.</p><button class="button violet-button" data-action="view" data-view="chat">Обсудить следующий шаг</button></div>`}<div class="rail-separator"></div><button class="rail-chat" data-action="view" data-view="chat">${icon('message')}Открыть диалог ${icon('arrow')}</button><p class="rail-note">Черновики можно редактировать. Сообщения из демонстрации не отправляются.</p><div class="rail-separator"></div><div class="rail-label">ПОСЛЕДНИЕ СОБЫТИЯ</div>${events.map(ev=>`<div class="rail-activity">${e(ev.text)}<small>${e(ev.taskId)} · ${e(displayTime(ev.at))}</small></div>`).join('')||'<p class="rail-note">Обновления появятся после действий с задачами.</p>'}${state.settings.achievements?`<div class="rail-separator"></div><button class="mini-achievement" data-action="achievements">${icon('trophy')}<span>${unlocked?'Есть чем гордиться':'Каждый финиш имеет значение'}<small>Открыто ${unlocked} из ${rewards.length} достижений</small></span></button>`:''}<button class="rail-simulation" data-action="simulate">${icon('play')}Проверить ответ сотрудника</button>`;
}
function chat() {
  const ids=new Set(allScoped().map(t=>t.id)), messages=(state.chat||[]).filter(m=>m.scope===scope).slice(-30), drafts=Object.entries(state.drafts||{}).filter(([,d])=>ids.has(d.taskId));
  return `<section class="chat-panel"><div class="chat-header"><span class="assistant-orb">${icon('spark')}</span><div><h2>Мозг и совесть твоей доски</h2><p>Демо-ответы по задачам · свободный ИИ-диалог ещё не подключён</p></div></div><div class="chat-messages" id="chat-messages" aria-live="polite"><div class="chat-bubble">Помогу выбрать следующий шаг. Можем посмотреть, где нужно твоё решение, разобрать сроки или подготовить черновик по конкретной задаче.<small>Область: ${scope==='mine'?'мои задачи':scope==='department'?'плановый отдел':'управление'}. Все данные в этой версии — демонстрационные.</small></div>${messages.map(m=>`<div class="chat-bubble ${m.role==='user'?'user':''}">${e(m.text)}${m.tasks?.length?`<div class="chat-task-links">${m.tasks.filter(id=>ids.has(id)).map(id=>`<button data-action="task" data-id="${e(id)}">${e(id)} · открыть</button>`).join('')}</div>`:''}${m.role==='assistant'?'<small>Сценарный ответ по текущим данным доски</small>':''}</div>`).join('')}</div><div class="chat-prompts">${['Что требует моего решения?','Какие сроки горят?','Подготовь следующий шаг'].map(t=>`<button data-action="prompt" data-text="${e(t)}">${e(t)}</button>`).join('')}</div><form class="chat-form" id="chat-form"><label class="sr-only" for="chat-input">Сообщение ассистенту</label><input id="chat-input" name="message" autocomplete="off" maxlength="1000" placeholder="Например: что делать по П-102?" required><button class="button primary" type="submit" aria-label="Отправить в демонстрационный чат">${icon('send')}</button></form></section><p class="chat-note">Демонстрация распознаёт запросы о статусах, сроках и задачах по ID. Реальный ассистент сможет вести свободный диалог после подключения модели. Активность этой вкладки определяется локально; доставки в мессенджеры сейчас нет.</p><div class="chat-saved-drafts"><div class="section-heading"><h2>Черновики решений</h2><span class="muted">${drafts.length}</span></div>${drafts.map(([key,d])=>`<button class="draft-list-item" data-action="draft" data-id="${e(d.taskId)}" data-type="${e(d.type)}"><span>${icon('document')} ${e(d.title)}<small class="muted"> · ${e(d.taskId)}</small></span>${icon('upRight')}</button>`).join('')||'<p class="view-note">Подготовь и сохрани черновик из карточки — он появится здесь.</p>'}</div><div class="detail-actions"><button class="button ghost" data-action="simulate">${icon('play')}Проверить сценарий ответа сотрудника</button></div>`;
}
function settings() {
  return `<div class="settings-grid"><section class="panel"><h2>Чтобы было приятно работать</h2><div style="margin-top:20px"><div class="setting-row"><div><h3>Движение интерфейса</h3><p>Плавное появление и перестановка карточек. Системная настройка уменьшения движения всегда учитывается.</p></div><button class="toggle ${state.settings.motion?'on':''}" role="switch" aria-checked="${!!state.settings.motion}" data-action="motion" aria-label="Движение интерфейса"></button></div><div class="setting-row"><div><h3>Личные достижения</h3><p>Небольшие отметки за принятые результаты и полезные действия. Без рейтинга сотрудников.</p></div><button class="toggle ${state.settings.achievements?'on':''}" role="switch" aria-checked="${!!state.settings.achievements}" data-action="toggle-achievements" aria-label="Личные достижения"></button></div><div class="setting-row"><div><h3>Архив после принятия</h3><p>Принятая задача уходит с доски, сохраняя историю. Возврат в работу доступен из архива.</p></div><span class="status-pill mint">${icon('check')}Включён</span></div></div></section><section class="panel"><h2>Разговор продолжается там, где удобно</h2><p class="view-note">Предлагаемый маршрут: если человек активен в приложении — писать в чат; если недоступен — в выбранный мессенджер. Одно сообщение должно иметь одну историю доставки.</p><div class="connection-grid"><div class="connection-card">${icon('message')}Чат приложения<small>Локальная демонстрация</small></div><div class="connection-card">${icon('send')}Telegram<small>Не подключён</small></div><div class="connection-card">${icon('message')}MAX<small>Не подключён</small></div></div><p class="settings-footnote">Сейчас определяется только активность этой вкладки. Присутствие сотрудников, общая переписка и уведомления появятся при подключении рабочего сервера.</p></section><section class="panel"><h2>Личное, отдел, управление</h2><table class="permission-table"><thead><tr><th>Область</th><th>Задуманное представление</th></tr></thead><tbody><tr><td>Мои задачи</td><td>Назначенные конкретному сотруднику</td></tr><tr><td>Отдел</td><td>Задачи сотрудников своего отдела</td></tr><tr><td>Управление</td><td>Общая картина и вопросы руководителю</td></tr></tbody></table><p class="settings-footnote">Переключатель в демонстрации фильтрует карточки. Реальные права доступа ещё не подключены; их нужно назначать участникам на сервере.</p></section><section class="panel"><h2>Примеры и состояние</h2><p class="view-note">Данные хранятся в этом браузере. Это демонстрация, поэтому не используй её как единственное хранилище реальных поручений.</p><div class="detail-actions"><button class="button ghost" data-action="simulate">${icon('play')}Проверить сценарий</button><button class="button ghost" data-action="achievements">${icon('trophy')}Достижения</button><button class="button danger" data-action="reset-confirm">${icon('refresh')}Начать демо заново</button></div></section></div>`;
}
function render(animate = false) {
  const old = new Map();
  if(animate && motionAllowed())document.querySelectorAll('[data-card-id]').forEach(el=>old.set(el.dataset.cardId,el.getBoundingClientRect()));
  nav(); applyPreferences();
  main.innerHTML = ({board,calendar,timeline,archive,chat,settings})[view]();
  renderRail(); fillIcons();
  if(animate && motionAllowed())document.querySelectorAll('[data-card-id]').forEach(el=>{const previous=old.get(el.dataset.cardId);if(previous){el.style.animation='none';const next=el.getBoundingClientRect();if(previous.left!==next.left||previous.top!==next.top)el.animate([{transform:`translate(${previous.left-next.left}px,${previous.top-next.top}px)`},{transform:'translate(0,0)'}],{duration:500,easing:'cubic-bezier(.2,.8,.2,1)'});}});
  if(view==='chat')$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;
}
function go(next) {
  if(!views[next])return;
  if(view!==next){filter='all';search='';$('#search').value='';}
  view=next;if(location.hash.slice(1)!==next)history.replaceState(null,'','#'+next);render();window.scrollTo({top:0,behavior:motionAllowed()?'smooth':'auto'});
}
function showModal(content, className = '') { $('#modal-content').innerHTML=content;modal.className=className;fillIcons(modal);if(!modal.open)modal.showModal();modal.scrollTop=0;const target=modal.querySelector('[autofocus]')||modal.querySelector('#modal-title');if(target){if(target.tagName==='H2')target.tabIndex=-1;target.focus({preventScroll:true});} }
function closeModal() { modal.close();draftType=null;activeTaskId=null;renderRail();if(view==='chat')render(); }
function taskDetail(id) {
  const task=findTask(id);if(!task)return;activeTaskId=id;draftType=null;
  const a=appearance(task), timer=deadline(task), source=sourceFor(task), p=proposal(task), phase=progress(task), events=state.events.filter(ev=>ev.taskId===id).slice(0,12);
  const actions=[];
  if(task.status==='planned')actions.push(['start','Начать работу','primary']);
  if(task.status==='active')actions.push(['review','Передать на проверку','primary']);
  if(task.status==='review')actions.push(['accept','Принять и архивировать','primary'],['rework','Вернуть на доработку','ghost']);
  if(task.status==='blocked')actions.push(['unblock','Препятствие устранено','ghost']);
  if(task.proposedDue)actions.push(['approve_due','Согласовать '+shortDate(task.proposedDue),'primary'],['reject_due','Сохранить текущий срок','ghost']);
  if(task.needsDecision&&task.status==='blocked'&&!task.proposedDue)actions.push(['take_control','Взять вопрос в работу','ghost']);
  if(task.status==='done')actions.push(['reopen','Вернуть в работу','ghost']);
  showModal(`<div class="modal-body"><div class="modal-kicker">${e(task.id)} / ${e(task.project||'Поручение')}</div><h2 id="modal-title">${e(task.title)}</h2><div class="detail-meta"><span class="status-pill ${a.color}">${icon(a.icon)}${a.label}</span><span class="owner">${avatar(task.employeeId)}${e(person(task.employeeId).name)}</span>${task.needsDecision?'<span class="status-pill amber">Нужно твоё решение</span>':''}</div><p class="detail-summary">${e(task.summary||'Описание результата пока не добавлено.')}</p>${task.protocol?`<div class="detail-protocol">${protocolLine(task)}</div>`:''}<div class="detail-due"><span>Утверждённый срок<strong>${task.due?shortDate(task.due,true)+' · '+e(task.dueTime||'18:00')+' МСК':'Не задан'}</strong>${task.proposedDue?`<span class="muted">Предложен: ${shortDate(task.proposedDue,true)}</span>`:''}</span><span class="countdown ${timer.kind}" data-detail-countdown="${e(task.id)}">${timer.text}</span></div><div class="proposal-box"><h3>${icon('spark')}${e(p.title)}</h3><p>${e(p.detail)}</p>${p.alternatives.length?`<div class="proposal-options">${p.alternatives.map(x=>`<span>${e(x)}</span>`).join('')}</div>`:''}<button class="button violet-button" data-action="draft" data-id="${e(id)}">${icon('pen')}Подготовить черновик</button><p style="font-size:9px;margin-bottom:0">Предложение по правилам демонстрации. Модель ещё не подключена.</p></div><div class="detail-actions">${actions.map(([act,label,style])=>`<button class="button ${style}" data-action="task-change" data-change="${act}" data-id="${e(id)}">${act==='accept'?icon('check'):''}${e(label)}</button>`).join('')}${task.status!=='done'?`<button class="button ghost" data-action="edit-task" data-id="${e(id)}">${icon('pen')}Изменить</button>`:''}</div><div class="detail-section"><h3>Этапы ${phase.total?`· ${phase.done} / ${phase.total}`:''}</h3>${phase.total?phaseList(task):'<p class="view-note">Простую задачу можно вести без этапов.</p>'}<div class="detail-actions">${phase.total?`<button class="button small ghost" data-action="timeline-task" data-id="${e(id)}">${icon('timeline')}Открыть Гант</button>`:''}${task.status!=='done'?`<button class="button small ghost" data-action="phase-add" data-id="${e(id)}">${icon('plus')}Добавить этап</button>`:''}</div>${task.due&&task.phases?.some(ph=>ph.end>task.due)?'<p class="view-note" style="color:var(--amber)">Некоторые этапы выходят за общий срок. Согласуй даты отдельно.</p>':''}</div><div class="detail-section"><h3>Последнее исходное сообщение</h3>${source?`<div class="source-quote">${e(source.text)}</div><div class="source-meta">${e(person(source.employeeId).name)} · ${e(displayTime(source.receivedAt))} · демонстрационный источник</div>`:'<p class="view-note">Сообщения сотрудника пока нет. Описание задачи задано в демонстрации или руководителем.</p>'}</div><div class="detail-section"><h3>История</h3><div class="history-list">${events.map(ev=>`<div class="history-item">${e(ev.text)}<small>${e(displayTime(ev.at))}</small></div>`).join('')||'<p class="view-note">Новых событий пока нет.</p>'}</div></div></div>`);
}
function draftDialog(id, type) {
  const task=findTask(id);if(!task)return;activeTaskId=id;draftType=type||proposal(task).type;
  const saved=state.drafts?.[`${id}:${draftType}`], draft=saved||makeDraft(state,task,draftType);
  showModal(`<div class="modal-body"><button class="draft-back" data-action="task" data-id="${e(id)}">${icon('left')}К задаче ${e(id)}</button><div class="modal-kicker">МАСТЕРСКАЯ РЕШЕНИЙ</div><h2 id="modal-title">Черновик готов к твоим правкам</h2><div class="draft-disclosure">${icon('spark')} Это редактируемая заготовка по текущим данным. Поля в квадратных скобках нужно уточнить. Письмо не отправляется, утверждённый срок не меняется.</div><div class="draft-fields"><label class="field">Вид документа<select id="draft-type">${[['extension','Письмо о переносе срока'],['request','Запрос недостающих данных'],['clarify','Уточнение статуса'],['plan','План действий'],['review','Проверка результата'],['summary','Итог задачи']].map(([key,label])=>`<option value="${key}" ${draftType===key?'selected':''}>${label}</option>`).join('')}</select></label><label class="field">Тема<input id="draft-title" maxlength="200" value="${e(draft.title)}"></label><label class="field">Текст<textarea id="draft-body" class="draft-area">${e(draft.body)}</textarea></label></div><div class="draft-tools"><button class="text-button" data-action="task" data-id="${e(id)}">Посмотреть исходные данные ${icon('upRight')}</button><div><button class="button ghost" data-action="copy-draft">${icon('copy')}Копировать</button><button class="button primary" data-action="save-draft">${icon('check')}Сохранить</button></div></div><p class="draft-status" id="draft-status">${saved?'Сохранённый черновик. Правки сохраняются автоматически.':'Пока не сохранён. Начни редактировать или нажми «Сохранить».'}</p></div>`);
}
function saveDraft(silent = false) {
  if(!activeTaskId||!draftType||!$('#draft-body'))return;
  const key=`${activeTaskId}:${draftType}`, sourceId=state.drafts[key]?.sourceId ?? findTask(activeTaskId)?.latestSourceId ?? null;
  state.drafts[key]={taskId:activeTaskId,type:draftType,title:$('#draft-title').value,body:$('#draft-body').value,sourceId,updatedAt:now().toISOString()};persist();$('#draft-status').textContent='Черновик сохранён в этом браузере. Ничего не отправлено.';
  if(!silent){renderRail();toast('Черновик сохранён. Он доступен в разделе «Ассистент».');}
}
function taskForm(id=null, selectedDate='') {
  const task=id?findTask(id):null;if(task?.status==='done'){toast('Сначала верни задачу из архива');return;}activeTaskId=id;draftType=null;
  showModal(`<div class="modal-body"><div class="modal-kicker">${task?'КАРТОЧКА ЗАДАЧИ':'НОВОЕ ПОРУЧЕНИЕ'}</div><h2 id="modal-title">${task?'Уточним детали':'Освободи место в голове'}</h2><p class="modal-intro">Название и исполнитель — достаточно для старта. Срок и реквизиты добавляй, если они нужны.</p><form id="task-form" data-id="${e(id||'')}"><div class="form-grid"><label class="field wide">Что нужно сделать *<input name="title" maxlength="160" required value="${e(task?.title||'')}" placeholder="Например, подготовить материалы к встрече" autofocus></label><label class="field wide">Ожидаемый результат<textarea name="summary" rows="3" maxlength="2000" placeholder="Что должно получиться и что уже известно">${e(task?.summary||'')}</textarea></label><label class="field">Исполнитель *<select name="employeeId">${state.employees.map(p=>`<option value="${e(p.id)}" ${p.id===(task?.employeeId||'manager')?'selected':''}>${e(p.name)} · ${e(p.team||'ПФУ')}</option>`).join('')}</select></label><label class="field">Проект / направление<input name="project" value="${e(task?.project||'')}" maxlength="80" placeholder="Мои поручения"></label><label class="field">Срок · необязательно<input name="due" type="date" value="${e(task?.due||selectedDate)}"></label><label class="field">Время · Москва<input name="dueTime" type="time" value="${e(task?.dueTime||'18:00')}"></label><details class="form-details" ${task?.protocol?'open':''}><summary>Протокол, пункт и дата · необязательно</summary><div class="form-grid"><label class="field">Номер протокола<input name="protocolNumber" maxlength="60" value="${e(task?.protocol?.number||'')}" placeholder="12-БК"></label><label class="field">Пункт<input name="protocolPoint" maxlength="40" value="${e(task?.protocol?.point||'')}" placeholder="3.2"></label><label class="field wide">Дата протокола<input name="protocolDate" type="date" value="${e(task?.protocol?.date||'')}"></label></div></details></div><p class="form-note">${task?'Изменения будут записаны в историю.':'Новая карточка появится на доске. Личное поручение может быть без протокола и срока.'}</p><p class="form-error" id="form-error" role="alert"></p><div class="form-footer"><button class="button ghost" type="button" data-action="close">Отмена</button><button class="button primary" type="submit">${icon(task?'check':'plus')}${task?'Сохранить изменения':'Добавить на доску'}</button></div></form></div>`);
}
function phaseForm(id, phaseId=null) {
  const task=findTask(id);if(!task)return;if(task.status==='done'){toast('Архивные этапы доступны только для чтения');return;}
  activeTaskId=id;draftType=null;const phase=task.phases?.find(p=>p.id===phaseId), last=task.phases?.at(-1);
  showModal(`<div class="modal-body"><button class="draft-back" data-action="task" data-id="${e(id)}">${icon('left')}К задаче</button><div class="modal-kicker">${e(id)} / ЭТАПЫ</div><h2 id="modal-title">${phase?'Настроить этап':'Ещё один шаг к результату'}</h2><form id="phase-form" data-id="${e(id)}" data-phase="${e(phaseId||'')}"><div class="form-grid"><label class="field wide">Название этапа<input name="title" required maxlength="120" value="${e(phase?.title||'')}" placeholder="Например, проверить исходные данные"></label><label class="field">Начало<input type="date" name="start" required value="${e(phase?.start||last?.end||dayKey())}"></label><label class="field">Завершение<input type="date" name="end" required value="${e(phase?.end||last?.end||task.due||dayKey())}"></label><label class="field wide">После какого этапа<select name="dependsOn"><option value="">Без зависимости</option>${(task.phases||[]).filter(p=>p.id!==phaseId).map(p=>`<option value="${e(p.id)}" ${p.id===(phase?.dependsOn||(!phase?last?.id:null))?'selected':''}>${e(p.title)}</option>`).join('')}</select></label></div><p class="form-note">Срок всей задачи остаётся прежним. Завершение этапа не означает приёмку результата.</p><p class="form-error" id="form-error" role="alert"></p><div class="form-footer"><button class="button ghost" type="button" data-action="task" data-id="${e(id)}">Назад</button><button class="button primary" type="submit">${icon('check')}Сохранить этап</button></div></form></div>`);
}
function rewardsDialog() {
 const list=achievements(state);
 showModal(`<div class="modal-body"><div class="modal-kicker">МАЛЕНЬКИЕ ПОВОДЫ ПОРАДОВАТЬСЯ</div><h2 id="modal-title">Движение имеет значение</h2><p class="modal-intro">Достижения за твои действия в этой демонстрации. Считаются разные принятые задачи; повторная приёмка той же задачи не добавляет финиш.</p><div class="achievement-grid">${list.map(a=>`<div class="achievement ${a.value>=a.target?'unlocked':''}"><div class="reward-icon">${icon(a.icon)}</div><h3>${a.name}</h3><p>${a.hint}</p><div class="reward-meter"><span style="width:${Math.min(100,a.value/a.target*100)}%"></span></div><small>${a.value>=a.target?'✓ Открыто':Math.min(a.value,a.target)+' / '+a.target}</small></div>`).join('')}</div><p class="form-note">${state.settings.achievements?'Эффекты и напоминания можно отключить в настройках.':'Эффекты достижений выключены. Прогресс сохраняется.'}</p></div>`);
}
function aboutDialog() {
 showModal(`<div class="modal-body"><div class="modal-kicker">ПИЛОТ / 0.2</div><h2 id="modal-title">Живая доска. Твои решения.</h2><p class="modal-intro">Интерактивный прототип личного ассистента. Можно менять задачи, проходить сценарии и готовить черновики.</p><div class="about-list"><div><strong>Что работает сейчас</strong>Карточки и их приоритет, обратный отсчёт, календарь, зависимости этапов, архив, локальные черновики и достижения.</div><div><strong>Что показано на примерах</strong>Сотрудники, протоколы, сообщения и статусы вымышлены. Ответы чата и предложения строятся по правилам демонстрации.</div><div><strong>Следующий шаг — подключение команды</strong>Модель, мессенджеры, общая база, присутствие сотрудников и реальные права доступа пока не подключены. Закрытая публикация доступна владельцу сайта.</div></div><div class="detail-actions"><button class="button primary" data-action="simulate">${icon('play')}Попробовать сценарий</button><button class="button ghost" data-action="close">К задачам</button></div></div>`);
}
function dayDialog(date) {
 const tasks=selectTasks(state,{scope,search,sort:'deadline'}).filter(t=>t.due===date);
 showModal(`<div class="modal-body"><div class="modal-kicker">КАЛЕНДАРЬ / МОСКВА</div><h2 id="modal-title">${shortDate(date,true)}</h2><p class="modal-intro">${tasks.length?'Поручения с утверждённым сроком на этот день.':'На этот день пока нет поручений в выбранной области.'}</p><div class="day-modal-tasks">${agendaRows(tasks)}</div><div class="detail-actions"><button class="button primary" data-action="new-task" data-date="${date}">${icon('plus')}Добавить задачу на этот день</button></div></div>`);
}
function simulationDialog() {
 const sc=scenarioFor(simKey,state), messages=sc.messages.slice(0,simStep);
 showModal(`<div class="modal-body"><div class="modal-kicker">ЛАБОРАТОРИЯ / ПРИМЕР ОТВЕТА</div><h2 id="modal-title">Посмотри, как доска оживает</h2><p class="modal-intro">Выбери ситуацию и пройди диалог. После последнего шага сообщение изменит карточку на доске. Это сценарий без вызова ИИ.</p><label class="sr-only" for="scenario-select">Ситуация</label><select id="scenario-select" class="scenario-select">${Object.entries(scenarios).map(([key,s])=>`<option value="${key}" ${key===simKey?'selected':''}>${s.label}</option>`).join('')}</select><div class="scenario-chat">${messages.map(([role,text])=>`<div class="chat-bubble ${role==='employee'?'user':role==='system'?'system':''}">${e(text)}<small>${role==='employee'?e(person(sc.employeeId).name):role==='assistant'?'Ассистент · пример':'Сценарий'}</small></div>`).join('')||'<p class="view-note">Нажми «Начать диалог», чтобы увидеть сообщения.</p>'}</div><div class="scenario-progress">${simStep} / ${sc.messages.length} сообщений · ${e(sc.taskId)}${simApplied?' · карточка обновлена':''}</div><div class="scenario-footer"><button class="button ghost" data-action="simulate-reset">${icon('refresh')}Сначала</button><button class="button primary" data-action="${simApplied?'simulation-board':'simulate-next'}" data-id="${e(sc.taskId)}">${simApplied?'Посмотреть на доске':simStep?'Следующее сообщение':'Начать диалог'}${icon('arrow')}</button></div></div>`);
}
function celebrate() {
 if(!state.settings.achievements||!motionAllowed())return;
 const box=$('#celebration');box.innerHTML=Array.from({length:22},(_,i)=>`<i style="--dx:${Math.round(Math.sin(i*2.4)*(100+Math.random()*210))}px;--dy:${Math.round(-100+Math.random()*360)}px;--particle:${['#b8a0ff','#c2f887','#73dbdf','#ffaba9'][i%4]};animation-delay:${Math.random()*.15}s"></i>`).join('');setTimeout(()=>box.replaceChildren(),1500);
}
function mutateTask(id, action) {
 const previous=achievements(state).filter(a=>a.value>=a.target).length;
 state=changeTask(state,id,action);persist();modal.close();activeTaskId=null;draftType=null;render(true);
 if(action==='accept'){celebrate();toast('Результат принят. Карточка перешла в архив.');}
 else if(action==='approve_due')toast('Новый срок согласован. Календарь и отсчёт обновлены.');
 else if(action==='unblock')toast('Препятствие снято. Карточка вернулась в работу.');
 else if(action==='reopen')toast('Задача возвращена на доску. История сохранена.');
 else toast('Состояние задачи обновлено.');
 if(state.settings.achievements&&achievements(state).filter(a=>a.value>=a.target).length>previous&&action!=='accept')celebrate();
}
function chatReply(text) {
 const tasks=selectTasks(state,{scope}), normalized=text.toLocaleLowerCase('ru-RU'), matches=mentionedTaskIds(text.toUpperCase(),allScoped());
 let reply, ids=[];
 if(matches.length){const task=findTask(matches[0]),p=proposal(task);reply=`${task.id} · ${task.title}\n\nЗафиксировано: ${task.summary||'Описание результата пока не задано.'}\n\nСледующий шаг: ${p.title.toLocaleLowerCase('ru-RU')}. ${p.detail}\n\nВ карточке можно открыть исходное сообщение и подготовить редактируемый черновик.`;ids=[task.id];}
 else if(/срок|горят|просроч|календар/.test(normalized)){const urgent=tasks.filter(t=>['overdue','soon'].includes(deadline(t).kind));ids=urgent.map(t=>t.id);reply=urgent.length?`По текущим срокам требуют внимания:\n\n${urgent.map(t=>`${t.id}: ${t.title}. ${deadline(t).text}.`).join('\n\n')}\n\nПеренос срока нужно согласовать отдельно.`:'В выбранной области нет просроченных задач и сроков в ближайшие 24 часа. Остальные даты видны в календаре.';}
 else if(/решени|вниман|сводк|статус|что делать|следующ|помо/.test(normalized)){const attention=tasks.filter(t=>rankTask(t)<=5).slice(0,5);ids=attention.map(t=>t.id);reply=attention.length?`Вот где можно продвинуть работу:\n\n${attention.map(t=>`${t.id} · ${proposal(t).title}.\n${t.summary||'Статус нужно уточнить.'}`).join('\n\n')}\n\nОткрой задачу, чтобы проверить основание и подготовить действие.`:'Сейчас нет сигналов, требующих срочного вмешательства. Можно продолжить плановые задачи или уточнить ближайшие этапы.';}
 else {reply='В этой демонстрации я могу собрать сводку, показать срочные задачи и предложить следующий шаг по ID поручения. Например: «Что требует моего решения?» или «Что делать по П-102?». Свободный разговор и самостоятельная подготовка решений моделью появятся после подключения ИИ.';}
 state.chat ||= [];state.chat.push({role:'user',scope,text,at:now().toISOString()},{role:'assistant',scope,text:reply,tasks:ids,at:now().toISOString()});state.chat=state.chat.slice(-100);persist();render();$('#chat-input')?.focus();
}
async function copyDraft() {
 saveDraft(true);const text=$('#draft-title').value+'\n\n'+$('#draft-body').value;
 try{await navigator.clipboard.writeText(text);toast('Тема и текст скопированы. Ничего не отправлено.');}
 catch{$('#draft-body').focus();$('#draft-body').select();toast('Буфер недоступен. Текст выделен — скопируй его вручную.');}
}

// Event delegation keeps all views and modal controls on the same state.
document.addEventListener('click', async event => {
 const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
 const {action,id}=button.dataset;
 try {
 switch(action){
  case 'view':if(modal.open)modal.close();go(button.dataset.view);break;
  case 'view-board':if(modal.open)modal.close();go('board');break;
  case 'scope':scope=button.dataset.scope;filter='all';render(true);break;
  case 'filter':filter=button.dataset.filter;render(true);break;
  case 'metric':if(button.dataset.filter==='archive')go('archive');else{view='board';filter=button.dataset.filter;history.replaceState(null,'','#board');render(true);}break;
  case 'clear-filters':filter='all';search='';$('#search').value='';render(true);break;
  case 'task':taskDetail(id);break;
  case 'new-task':taskForm(null,button.dataset.date||'');break;
  case 'edit-task':taskForm(id);break;
  case 'close':closeModal();break;
  case 'task-change':mutateTask(id,button.dataset.change);break;
  case 'draft':draftDialog(id,button.dataset.type);break;
  case 'save-draft':saveDraft();break;
  case 'copy-draft':await copyDraft();break;
  case 'timeline-task':timelineId=id;modal.close();go('timeline');break;
  case 'phase-add':phaseForm(id);break;
  case 'phase-edit':phaseForm(id,button.dataset.phase);break;
  case 'phase-toggle':{const task=findTask(id),p=task.phases.find(ph=>ph.id===button.dataset.phase);state=setPhase(state,id,p.id,!p.done);persist();render(true);if(modal.open)taskDetail(id);toast('Состояние этапов обновлено.');break;}
  case 'month':{const date=new Date(month+'-15T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+Number(button.dataset.dir));month=date.toISOString().slice(0,7);render();break;}
  case 'month-today':month=dayKey().slice(0,7);render();break;
  case 'day':dayDialog(button.dataset.date);break;
  case 'motion':state.settings.motion=!state.settings.motion;persist();render();toast(motionAllowed()?'Плавное движение включено':'Движение уменьшено');break;
  case 'toggle-achievements':state.settings.achievements=!state.settings.achievements;persist();render();break;
  case 'achievements':rewardsDialog();break;
  case 'about':aboutDialog();break;
  case 'simulate':simStep=0;simApplied=false;simulationDialog();break;
  case 'simulate-reset':simStep=0;simApplied=false;simulationDialog();break;
  case 'simulate-next':{const sc=scenarioFor(simKey,state);if(simStep<sc.messages.length){if(simStep+1===sc.messages.length){state=applyScenario(state,simKey);persist();simApplied=true;render(true);}simStep++;}simulationDialog();break;}
  case 'simulation-board':modal.close();scope='management';filter='all';search='';$('#search').value='';go('board');requestAnimationFrame(()=>{const el=[...document.querySelectorAll('[data-card-id]')].find(x=>x.dataset.cardId===id);el?.scrollIntoView({block:'center',behavior:motionAllowed()?'smooth':'auto'});if(el&&motionAllowed())el.animate([{boxShadow:'0 0 0 2px #d7c5ff'},{boxShadow:'0 0 0 8px transparent'}],{duration:1400});});break;
  case 'prompt':chatReply(button.dataset.text);break;
  case 'reset-confirm':showModal(`<div class="modal-body reset-panel">${icon('refresh')}<h2 id="modal-title">Начать демонстрацию заново?</h2><p>Локальные задачи, изменения, диалоги и черновики этой демонстрации будут заменены исходными примерами с актуальными датами.</p><div class="detail-actions" style="justify-content:center"><button class="button ghost" data-action="close">Сохранить мою работу</button><button class="button danger" data-action="reset">Начать заново</button></div></div>`);break;
  case 'reset':state=createWorkspace();persist();modal.close();scope='management';search='';$('#search').value='';filter='all';month=dayKey().slice(0,7);go('board');toast('Демонстрация начата заново. Сроки привязаны к сегодняшнему дню.');break;
 }
 }catch(error){toast(error.message||'Не удалось выполнить действие');}
});
document.addEventListener('submit', event => {
 if(!['task-form','phase-form','chat-form'].includes(event.target.id))return;
 event.preventDefault();const form=event.target, data=Object.fromEntries(new FormData(form));
 try{
 if(form.id==='task-form'){
  const id=form.dataset.id;
  if(id){state=editTask(state,id,data);persist();modal.close();render(true);taskDetail(id);toast('Изменения сохранены в истории задачи.');}
  else{const result=addTask(state,data);state=result.state;persist();modal.close();if(!scopeTasks(state,scope).some(t=>t.id===result.task.id))scope='management';search='';$('#search').value='';filter='all';go('board');toast('Новая задача на доске.');}
 }else if(form.id==='phase-form'){
  const id=form.dataset.id;state=savePhase(state,id,form.dataset.phase||null,data);persist();render(true);taskDetail(id);toast('Этап сохранён. Общий срок задачи остался прежним.');
 }else if(form.id==='chat-form'&&data.message.trim())chatReply(data.message.trim());
 }catch(error){const errorBox=$('#form-error');if(errorBox)errorBox.textContent=error.message;else toast(error.message);}
});
document.addEventListener('change',event=>{
 const input=event.target;
 if(input.id==='sort-select'){sort=input.value;render(true);}
 if(input.id==='timeline-task'){timelineId=input.value;render();}
 if(input.id==='scenario-select'){simKey=input.value;simStep=0;simApplied=false;simulationDialog();}
 if(input.id==='draft-type'){draftDialog(activeTaskId,input.value);}
});
document.addEventListener('input',event=>{
 if(event.target.id==='search'){search=event.target.value;render();}
 if(['draft-body','draft-title'].includes(event.target.id))saveDraft(true);
});
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
modal.addEventListener('close',()=>{activeTaskId=null;draftType=null;});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(views[next]&&next!==view)go(next);});
document.addEventListener('visibilitychange',()=>{renderRail();if(document.visibilityState==='visible')updateClocks();});
let lastPrioritySignature='';
function updateClocks(){
 document.querySelectorAll('[data-countdown]').forEach(el=>{const task=findTask(el.dataset.countdown);if(!task)return;const timer=deadline(task);el.className='card-countdown '+timer.kind;el.querySelector('span').textContent=timer.text;});
 document.querySelectorAll('[data-detail-countdown]').forEach(el=>{const task=findTask(el.dataset.detailCountdown);if(task){const timer=deadline(task);el.textContent=timer.text;el.className='countdown '+timer.kind;}});
 const signature=openScoped().map(t=>t.id+':'+rankTask(t)+':'+deadline(t).kind).join('|');
 if(lastPrioritySignature&&lastPrioritySignature!==signature&&!modal.open&&view==='board'&&document.activeElement?.tagName!=='INPUT')render(true);
 lastPrioritySignature=signature;
}
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',applyPreferences);
fillIcons();render();updateClocks();setInterval(updateClocks,15000);persist();if(loadNotice)toast(loadNotice);
