/**
 * Local state graph and lightweight hashed text search. No LangGraph library or embedding model.
 * Shared between the static dashboard (`dist/`) and the server agent (`agent/`).
 */
import { clone, validDate, mentionedTaskIds, applyReport } from './domain.js';
import { classifyMessageIntent } from './feedback.js';
import { canReadTask, registeredActor, scopedWorkspace } from './access.js';
import { memoryBrief } from './task-memory.js';

export const EMBEDDING_DIM = 64;

const STOP_WORDS = new Set([
  'и', 'в', 'на', 'по', 'с', 'к', 'о', 'от', 'до', 'за', 'из', 'у', 'для', 'не', 'но', 'а', 'что',
  'как', 'это', 'все', 'всё', 'или', 'же', 'бы', 'то', 'мы', 'вы', 'он', 'она', 'они', 'я', 'ты',
  'так', 'уже', 'ещё', 'еще', 'при', 'без', 'над', 'под', 'про', 'через', 'после', 'перед'
]);

const CONCEPT_SYNONYMS = [
  ['бюджет', 'смет', 'финанс', 'фот', 'расчет', 'расчёт', 'резерв', 'план', 'поступлен', 'прогноз', 'затрат', 'деньг', 'оплат', 'стоимост'],
  ['закупк', 'тз', 'тендер', 'договор', 'поставщ', 'контракт', 'согласован', 'спецификац', 'требован'],
  ['препятств', 'блок', 'проблем', 'задержк', 'риск', 'стоп', 'невозможн', 'ждём', 'ждем', 'нехват', 'нет_данн', 'трудн', 'сложн', 'меша', 'тормоз'],
  ['перенос', 'срок', 'дедлайн', 'дата', 'опозда', 'просроч', 'успева', 'продл', 'сдвиг', 'перенест', 'позже'],
  ['готов', 'выполн', 'сделан', 'заверш', 'проверк', 'приня', 'итог', 'результат', 'свод', 'сдан', 'финал'],
  ['отчет', 'отчёт', 'реестр', 'протокол', 'комисс', 'материал', 'документ', 'таблиц', 'справк', 'выгрузк'],
  ['помощ', 'решен', 'эскалац', 'руковод', 'вопрос', 'уточн', 'согласуй', 'поддержк', 'вмешат'],
  ['календар', 'этап', 'гант', 'расписан', 'шаг', 'зависимост', 'контрол', 'мониторинг', 'статус']
];

export function stemRussian(word) {
  let w = String(word || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^а-яa-z0-9-]/g, '');
  if (w.length <= 3) return w;
  w = w.replace(/(иями|ями|ами|его|ого|ему|ому|ими|ыми|ую|юю|ая|яя|ое|ее|ие|ые|ий|ый|ой|ей|ем|им|ым|ом|их|ых|ам|ям|ах|ях|ью|ию|ия|ии|ев|ов|ей|ть|ти|чь|ться|лся|лась|лись|ать|ять|еть|ить|уть|ють|ешь|ет|ем|ете|ут|ют|ишь|ит|им|ите|ат|ят|ал|ял|ел|ил|ла|ло|ли|েন)$/u, '');
  return w.length >= 2 ? w : word.toLocaleLowerCase('ru-RU');
}

export function tokenize(text) {
  return String(text || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .split(/[^а-яa-z0-9-]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Computes a normalized float vector embedding of length EMBEDDING_DIM (64).
 * Uses character 3-grams, word stems, bigrams, and domain concept projections
 * so morphologically varied Russian queries and task records map into a shared semantic space.
 */
export function computeEmbedding(text, dim = EMBEDDING_DIM) {
  const vec = new Array(dim).fill(0);
  const rawTokens = tokenize(text);
  if (!rawTokens.length) return vec;

  const stems = rawTokens.map(stemRussian);

  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i];
    const stem = stems[i];
    const h1 = fnv1a(stem);
    const h2 = fnv1a(token, 1337);
    vec[h1 % dim] += 1.6 * ((h1 & 1) ? 1 : -1);
    vec[h2 % dim] += 0.9 * ((h2 & 1) ? 1 : -1);

    // Character n-grams (3-grams) for sub-word & typo resilience
    const padded = `^${stem}$`;
    for (let j = 0; j <= padded.length - 3; j++) {
      const trigram = padded.slice(j, j + 3);
      const ht = fnv1a(trigram, 9973);
      vec[ht % dim] += 0.45 * ((ht & 2) ? 1 : -1);
    }

    // Word bigrams
    if (i + 1 < stems.length) {
      const bg = `${stem}_${stems[i + 1]}`;
      const hb = fnv1a(bg, 7919);
      vec[hb % dim] += 0.8 * ((hb & 1) ? 1 : -1);
    }

    // Domain semantic anchor dimensions (0..7)
    for (let c = 0; c < CONCEPT_SYNONYMS.length; c++) {
      if (CONCEPT_SYNONYMS[c].some(prefix => token.startsWith(prefix) || stem.startsWith(prefix))) {
        vec[c % dim] += 2.4;
        vec[(c * 7 + 3) % dim] += 1.4;
      }
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = Number((vec[i] / norm).toFixed(6));
  }
  return vec;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Number((dot / (Math.sqrt(na) * Math.sqrt(nb))).toFixed(4));
}

function lexicalOverlapBoost(query, docText) {
  const qStems = new Set(tokenize(query).map(stemRussian));
  if (!qStems.size) return 0;
  const dStems = new Set(tokenize(docText).map(stemRussian));
  let hits = 0;
  for (const s of qStems) {
    if (dStems.has(s) || [...dStems].some(d => d.startsWith(s) || s.startsWith(d))) hits++;
  }
  return (hits / qStems.size) * 0.25;
}

/**
 * Builds an in-memory & serializable Embedding Index over tasks, employee messages (sources),
 * events, and decision drafts.
 */
export function buildKnowledgeIndex(state) {
  const documents = [];
  const empName = id => state.employees?.find(e => e.id === id)?.name || id || 'Сотрудник';

  for (const task of state.tasks || []) {
    const phaseText = (task.phases || []).map(p => p.title).join(', ');
    const protoText = task.protocol ? `Протокол ${task.protocol.number || ''} п.${task.protocol.point || ''}` : '';
    const text = [
      task.id,
      task.title,
      task.project || '',
      empName(task.employeeId),
      task.summary || '',
      task.blocker ? `Препятствие: ${task.blocker}` : '',
      task.nextAction ? `Следующий шаг: ${task.nextAction}` : '',
      phaseText,
      protoText
    ].filter(Boolean).join('. ');
    documents.push({
      id: `task:${task.id}`,
      kind: 'task',
      taskId: task.id,
      employeeId: task.employeeId,
      status: task.status,
      title: `${task.id} · ${task.title}`,
      text,
      vector: computeEmbedding(text)
    });
  }

  for (const source of state.sources || []) {
    const task = (state.tasks || []).find(t => t.id === source.taskId);
    const text = `${source.taskId || ''} ${task?.title || ''} ${empName(source.employeeId)}: ${source.text}`;
    documents.push({
      id: `source:${source.id}`,
      kind: 'source',
      sourceId: source.id,
      taskId: source.taskId || null,
      employeeId: source.employeeId,
      receivedAt: source.receivedAt,
      title: `Сообщение от ${empName(source.employeeId)}${source.taskId ? ` (${source.taskId})` : ''}`,
      text: source.text,
      fullText: text,
      vector: computeEmbedding(text)
    });
  }

  for (const draft of state.decisionDrafts || []) {
    const text = `${draft.taskId} ${draft.title} ${draft.reason || ''} ${draft.body || ''}`;
    documents.push({
      id: `draft:${draft.id}`,
      kind: 'draft',
      taskId: draft.taskId,
      title: `Черновик: ${draft.title} (${draft.taskId})`,
      text: draft.body,
      fullText: text,
      vector: computeEmbedding(text)
    });
  }

  return {
    dimension: EMBEDDING_DIM,
    count: documents.length,
    documents
  };
}

/**
 * Performs hybrid semantic vector search (Cosine Similarity + stem overlap + concept matching).
 * @param {any} state
 * @param {string} query
 * @param {{ topK?: number, kind?: string, scopeIds?: Set<string> | null, minScore?: number }} [options]
 */
export function semanticSearch(state, query, { topK = 5, kind = 'all', scopeIds = null, minScore = 0.08 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { query: '', vectorPreview: [], results: [] };
  const queryVec = computeEmbedding(cleanQuery);
  const index = buildKnowledgeIndex(state);
  const queryUpper = cleanQuery.toUpperCase();

  const scored = index.documents
    .filter(doc => {
      if (kind !== 'all' && doc.kind !== kind) return false;
      if (scopeIds && (!doc.taskId || !scopeIds.has(doc.taskId))) return false;
      return true;
    })
    .map(doc => {
      const cos = cosineSimilarity(queryVec, doc.vector);
      const boost = lexicalOverlapBoost(cleanQuery, doc.fullText || doc.text);
      const idExact = doc.taskId && queryUpper.includes(doc.taskId.toUpperCase()) ? 0.35 : 0;
      const score = Number(Math.min(0.99, Math.max(0, cos + boost + idExact)).toFixed(3));
      return {
        id: doc.id,
        kind: doc.kind,
        taskId: doc.taskId,
        employeeId: doc.employeeId,
        title: doc.title,
        snippet: doc.text.slice(0, 220),
        cosine: cos,
        score
      };
    })
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    query: cleanQuery,
    dimension: EMBEDDING_DIM,
    totalIndexed: index.count,
    vectorPreview: queryVec.slice(0, 8),
    results: scored
  };
}

/**
 * Finds semantically similar tasks or recurring blockers across the workspace.
 * @param {any} state
 * @param {string} taskId
 * @param {number} topK
 * @param {Set<string> | null} scopeIds
 */
export function findSimilarTasks(state, taskId, topK = 3, scopeIds = null) {
  if (scopeIds && !scopeIds.has(taskId)) return [];
  const target = (state.tasks || []).find(t => t.id === taskId);
  if (!target) return [];
  const queryText = [target.title, target.summary, target.blocker, target.project].filter(Boolean).join(' ');
  const search = semanticSearch(state, queryText, { topK: topK + 3, kind: 'task', minScore: 0.05, scopeIds });
  return search.results.filter(r => r.taskId !== taskId).slice(0, topK);
}

/**
 * Local deterministic state graph. The trace is diagnostic, not durable memory.
 * Supports nodes, conditional edges and state reducers; no LangGraph compatibility claim.
 */
export const START = '__start__';
export const END = '__end__';

export class StateGraph {
  constructor(channels = {}) {
    this.channels = channels;
    this.nodes = new Map();
    this.edges = new Map();
    this.conditionalEdges = new Map();
  }

  addNode(name, fn) {
    if (!name || typeof fn !== 'function') throw new Error('Граф: укажите имя узла и функцию');
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from, to) {
    if (!this.edges.has(from)) this.edges.set(from, []);
    this.edges.get(from).push(to);
    return this;
  }

  addConditionalEdges(from, routerFn, pathMap = null) {
    this.conditionalEdges.set(from, { routerFn, pathMap });
    return this;
  }

  compile({ name = 'task_monitoring_graph' } = {}) {
    const nodes = this.nodes;
    const edges = this.edges;
    const conditionalEdges = this.conditionalEdges;
    const channels = this.channels;

    const mergeState = (current, patch) => {
      if (!patch || typeof patch !== 'object') return current;
      const next = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (channels[k]?.reducer) {
          next[k] = channels[k].reducer(current[k], v);
        } else {
          next[k] = v;
        }
      }
      return next;
    };

    return {
      name,
      nodes: [...nodes.keys()],
      invoke(initialState = {}) {
        let graphState = {};
        for (const [k, cfg] of Object.entries(channels)) {
          graphState[k] = cfg.default ? cfg.default() : undefined;
        }
        graphState = mergeState(graphState, initialState);

        const trace = [];
        let current = (edges.get(START) || [])[0];
        let steps = 0;

        while (current && current !== END && steps < 25) {
          steps++;
          const nodeFn = nodes.get(current);
          if (!nodeFn) throw new Error(`Граф: узел "${current}" не зарегистрирован`);
          const startedAt = Date.now();
          const patch = nodeFn(graphState) || {};
          graphState = mergeState(graphState, patch);

          let nextNode = END;
          let routeReason = 'direct';
          if (conditionalEdges.has(current)) {
            const { routerFn, pathMap } = conditionalEdges.get(current);
            const routeKey = routerFn(graphState);
            routeReason = `condition:${routeKey}`;
            nextNode = pathMap ? (pathMap[routeKey] || routeKey) : routeKey;
          } else if (edges.has(current)) {
            nextNode = edges.get(current)[0] || END;
          }

          trace.push({
            step: steps,
            node: current,
            next: nextNode,
            route: routeReason,
            durationMs: Math.max(1, Date.now() - startedAt),
            outputSummary: patch.nodeSummary || patch.intent || patch.classification?.kind || 'ok'
          });

          current = nextNode;
        }

        return {
          graph: name,
          state: graphState,
          trace
        };
      }
    };
  }
}

export const GRAPH_NODE_META = [
  { id: 'ingest_signal', label: '1. Сообщение и автор', desc: 'Приём сообщения или триггера задачи, проверка роли и автора' },
  { id: 'emb_retrieve', label: '2. Память задачи', desc: 'Векторный поиск релевантных задач, истории и похожих блокеров (64d)' },
  { id: 'classify_intent', label: '3. Смысл и цитата', desc: 'Классификация статуса, извлечение дословной цитаты и дат' },
  { id: 'validate_guardrails', label: '4. Проверка', desc: 'Проверка прав, цитаты и запрета несанкционированной смены срока' },
  { id: 'mutate_task_state', label: '5. Запись факта', desc: 'Детерминированное обновление карточки задачи и истории' },
  { id: 'dispatch_notifications', label: '6. Подготовка ответа', desc: 'Уведомление сотрудника/руководителя, эскалация или подготовка ответа' }
];

/**
 * Classifies natural-language Russian message from an employee or manager into structured report parameters.
 */
export { classifyMessageIntent } from './feedback.js';

/** Six explicit steps; durable task memory lives in records, not in this trace. */
export function createMonitoringGraph() {
  const graph = new StateGraph();
  graph.addNode('ingest_signal', state => {
    const actor = registeredActor(state.workspace, state.actorId);
    const own = state.workspace.tasks.filter(t => canReadTask(actor, t));
    const mentioned = mentionedTaskIds(state.message, own);
    let taskId = state.source?.taskId || state.taskId || (mentioned.length === 1 ? mentioned[0] : null);
    if (state.eventType === 'employee_feedback' && (mentioned.length > 1 || (mentioned.length === 1 && taskId && mentioned[0] !== taskId))) taskId = null;
    // Only a trusted server binding can attach a real employee message to a task.
    if (state.mode === 'server' && state.eventType === 'employee_feedback') taskId = state.source?.taskId || null;
    return { actor, taskId, nodeSummary: 'Принят сигнал от ' + actor.name };
  });
  graph.addNode('emb_retrieve', state => {
    const visible = scopedWorkspace(state.workspace, state.actor);
    if (state.readScopeIds) {
      visible.tasks = visible.tasks.filter(t => state.readScopeIds.has(t.id));
      visible.sources = visible.sources.filter(s => s.taskId && state.readScopeIds.has(s.taskId));
      visible.decisionDrafts = visible.decisionDrafts.filter(d => state.readScopeIds.has(d.taskId));
    }
    const task = visible.tasks.find(t => t.id === state.taskId);
    const search = semanticSearch(visible, state.message, { topK: 4, minScore: 0.05 });
    return { embContext: {
      dimension: EMBEDDING_DIM, topMatches: search.results, vectorSample: search.vectorPreview,
      similarTasks: task ? findSimilarTasks(visible, task.id, 2) : [],
      memory: task ? memoryBrief(state.workspace, state.actor, task.id) : null,
    }, nodeSummary: 'Контекст получен из доступных задач и сохранённых источников' };
  });
  graph.addNode('classify_intent', state => {
    const task = state.workspace.tasks.find(t => t.id === state.taskId && canReadTask(state.actor, t));
    const classification = state.eventType === 'employee_feedback'
      ? state.report || classifyMessageIntent(state.message, { defaultDue: task?.due, now: state.source?.occurredAt || state.source?.receivedAt || state.now, timezone: state.workspace.settings?.timezone })
      : { kind: state.eventType, method: 'event' };
    return { classification, nodeSummary: 'Разбор: ' + classification.kind + (state.report ? ' · предложение модели, проверяется по источнику' : ' · правила демонстрации') };
  });
  graph.addNode('validate_guardrails', state => {
    const task = state.workspace.tasks.find(t => t.id === state.taskId);
    let error = null;
    if (state.eventType !== 'employee_feedback' && state.actor.role !== 'manager') error = 'Действие доступно только руководителю.';
    else if (state.eventType !== 'manager_query' && !task) error = 'Задача не определена однозначно. Уточните ID поручения.';
    else if (task && !canReadTask(state.actor, task)) error = 'Сотрудник может обновлять только свои поручения.';
    else if (state.eventType === 'employee_feedback') {
      if (task.employeeId !== state.actorId) error = 'Ответ должен принадлежать исполнителю задачи.';
      else if (task.status === 'done') error = 'Задача уже в архиве; переоткрыть её может только руководитель.';
      else if (state.mode === 'server' && (!state.source || state.source.employeeId !== state.actorId || state.source.taskId !== task.id)) error = 'Нет проверенного исходного сообщения этой задачи.';
      else if (!state.classification.quote?.trim() || !state.message.includes(state.classification.quote)) error = 'Цитата отсутствует в исходном сообщении.';
      else if (state.classification.kind === 'deadline_request' && !validDate(state.classification.proposedDue)) error = 'Уточните конкретную дату переноса.';
    }
    return { validation: { valid: !error, error }, nodeSummary: error || 'Права, источник и цитата проверены; утверждённый срок защищён' };
  });
  graph.addNode('mutate_task_state', state => {
    const source = state.source || {
      id: 'demo:' + state.operationId, taskId: state.taskId, employeeId: state.actorId,
      text: state.message, receivedAt: state.now, occurredAt: state.now, simulated: true,
    };
    const workspace = applyReport(state.workspace, { ...state.classification, taskId: state.taskId }, state.actor, source);
    const event = workspace.events.find(e => e.key === source.id);
    return { workspace, mutationResult: { updated: event?.kind !== 'late_report', late: event?.kind === 'late_report', sourceId: source.id },
      nodeSummary: event?.kind === 'late_report' ? 'Позднее сообщение сохранено только в истории' : 'Сохранены факт, источник и история изменения' };
  });
  graph.addNode('dispatch_notifications', state => {
    const ws = clone(state.workspace), task = ws.tasks.find(t => t.id === state.taskId);
    const employee = task && ws.employees.find(e => e.id === task.employeeId);
    const cls = state.classification, notifications = [];
    const add = (to, kind, title, text, severity = 'cyan') => notifications.push({
      id: 'prepared:' + state.operationId + ':' + to.id + ':' + kind,
      at: state.now, to: to.id, recipientName: to.name, taskId: task?.id || null,
      kind, title, text, severity, delivery: 'prepared', channel: 'dashboard',
    });
    let reply;
    if (!state.validation.valid) reply = state.validation.error;
    else if (state.mutationResult?.late) reply = 'Сохранено более раннее сообщение. Текущий статус не изменён.';
    else if (state.eventType === 'manager_query') {
      const matches = state.embContext.topMatches;
      reply = matches.length ? 'В доступных записях найдены кандидаты. Сходство не подтверждает факты:\n\n' + matches.map(m => m.title + '\n' + m.snippet).join('\n\n') : 'Подходящих записей не найдено. Уточните задачу или тему.';
    } else if (state.eventType === 'task_assigned' || state.eventType === 'check_in_request') {
      const checkin = state.eventType === 'check_in_request';
      const text = employee.name + ', ' + (checkin ? 'подскажите, что готово, что мешает и нужна ли помощь по ' : 'вам назначено поручение ') + task.id + ' «' + task.title + '»' + (task.due ? '. Срок: ' + task.due : '. Срок не задан') + '.';
      add(employee, checkin ? 'check_in' : 'task_assigned', checkin ? 'Запрос статуса ' + task.id : 'Новое поручение ' + task.id, text, 'violet');
      reply = 'Уведомление по ' + task.id + ' подготовлено. Отправка не выполнялась.';
    } else if (cls.kind === 'unclear') {
      reply = employee.name + ', ' + (cls.question || 'уточните, какой результат уже готов и что осталось сделать.');
      add(employee, 'clarify_followup', 'Нужно уточнение по ' + task.id, reply, 'amber');
    } else {
      const labels = {
        blocked: ['blocker_escalation', 'Препятствие', 'coral'],
        deadline_request: ['deadline_escalation', 'Запрос переноса', 'amber'],
        review: ['ready_for_review', 'Готовность к проверке', 'mint'],
        unblocked: ['unblocked_notice', 'Препятствие устранено', 'mint'],
        progress: ['progress_notice', 'Обновление', 'cyan'],
      };
      const [kind, label, severity] = labels[cls.kind];
      reply = cls.kind === 'deadline_request'
        ? 'Запрос на ' + cls.proposedDue + ' сохранён. До решения действует прежний срок: ' + (task.due || 'не задан') + '.'
        : cls.kind === 'review' ? 'Результат отмечен как готовый к проверке руководителем.'
        : cls.kind === 'blocked' ? 'Препятствие сохранено с исходным сообщением.'
        : cls.kind === 'unblocked' ? 'Подтверждение устранения препятствия сохранено.'
        : 'Обновление сохранено с исходным сообщением.';
      for (const manager of ws.employees.filter(p => p.role === 'manager' && p.id !== state.actorId)) {
        add(manager, kind, label + ' · ' + task.id, employee.name + ': «' + cls.quote + '»' + (cls.proposedDue ? ' Предлагаемая дата: ' + cls.proposedDue + '.' : ''), severity);
      }
      if (cls.kind === 'blocked') add(employee, 'employee_ack', 'Ответ по ' + task.id, reply);
    }
    ws.notifications = [...notifications, ...(ws.notifications || [])];
    return { workspace: ws, notifications, assistantReply: reply, nodeSummary: 'Подготовлено уведомлений: ' + notifications.length + '. Доставка выполняется отдельно.' };
  });
  graph.addEdge(START, 'ingest_signal');
  graph.addEdge('ingest_signal', 'emb_retrieve');
  graph.addEdge('emb_retrieve', 'classify_intent');
  graph.addEdge('classify_intent', 'validate_guardrails');
  graph.addConditionalEdges('validate_guardrails', state => state.validation.valid && state.eventType === 'employee_feedback' ? 'mutate' : 'prepare', { mutate: 'mutate_task_state', prepare: 'dispatch_notifications' });
  graph.addEdge('mutate_task_state', 'dispatch_notifications');
  graph.addEdge('dispatch_notifications', END);
  return graph.compile({ name: 'TaskMonitor_v2' });
}

/** @param {any} workspace @param {any} options */
export function runAssistantWorkflow(workspace, options = {}) {
  const { eventType = 'employee_feedback', actorId = 'manager', taskId = null, source = null,
    mode = 'demo', report = null, now = new Date().toISOString() } = options;
  const actor = registeredActor(workspace, actorId);
  if (!['employee_feedback', 'manager_query', 'task_assigned', 'check_in_request'].includes(eventType)) throw new Error('Неизвестное событие');
  if (mode === 'server' && eventType === 'employee_feedback' && (!source || source.employeeId !== actorId)) throw new Error('Требуется проверенный источник автора');
  if (source && taskId && source.taskId !== taskId) throw new Error('Нельзя менять привязку исходного сообщения');
  if (source?.taskId && !canReadTask(actor, workspace.tasks.find(t => t.id === source.taskId))) throw new Error('Нет доступа к источнику');
  const message = source ? source.text : options.message || '';
  if (source && eventType === 'employee_feedback' && workspace.events.some(e => e.key === source.id)) {
    return { state: workspace, duplicate: true, run: null, reply: 'Это сообщение уже учтено.', notifications: [], trace: [], embContext: { topMatches: [] } };
  }
  const operationId = source?.id || options.operationId || globalThis.crypto.randomUUID();
  const execution = createMonitoringGraph().invoke({ workspace, eventType, actorId, taskId, message, source, mode, report, now, operationId, readScopeIds: options.readScopeIds });
  const state = clone(execution.state.workspace);
  const run = {
    version: 2,
    id: 'run:' + operationId, sourceId: source?.id || execution.state.mutationResult?.sourceId || null,
    at: now, eventType, actorId, taskId: execution.state.taskId, message,
    classification: execution.state.classification, embContext: execution.state.embContext,
    trace: execution.trace, assistantReply: execution.state.assistantReply, notifications: execution.state.notifications,
  };
  state.graphRuns = [run, ...(state.graphRuns || [])].slice(0, 40);
  return { state, run, duplicate: false, reply: run.assistantReply, notifications: run.notifications, trace: run.trace, embContext: run.embContext };
}
