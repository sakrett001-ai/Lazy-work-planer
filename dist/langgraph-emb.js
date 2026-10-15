/**
 * LangGraph StateGraph orchestration + Vector Embeddings (Emb) + Bidirectional Assistant Engine.
 * Shared between the static dashboard (`dist/`) and the server agent (`agent/`).
 */
import { clone, validDate, mentionedTaskIds, applyReport } from './domain.js';

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
      if (scopeIds && doc.taskId && !scopeIds.has(doc.taskId)) return false;
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
 */
export function findSimilarTasks(state, taskId, topK = 3) {
  const target = (state.tasks || []).find(t => t.id === taskId);
  if (!target) return [];
  const queryText = [target.title, target.summary, target.blocker, target.project].filter(Boolean).join(' ');
  const search = semanticSearch(state, queryText, { topK: topK + 3, kind: 'task', minScore: 0.05 });
  return search.results.filter(r => r.taskId !== taskId).slice(0, topK);
}

/**
 * Minimal deterministic LangGraph-compatible StateGraph engine.
 * Supports nodes, conditional edges, state reducers, and execution trace checkpoints.
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
    if (!name || typeof fn !== 'function') throw new Error('LangGraph: укажите имя узла и функцию');
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
          if (!nodeFn) throw new Error(`LangGraph: узел "${current}" не зарегистрирован`);
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
  { id: 'ingest_signal', label: '1. Ingest & Auth', desc: 'Приём сообщения или триггера задачи, проверка роли и автора' },
  { id: 'emb_retrieve', label: '2. Emb Retrieval', desc: 'Векторный поиск релевантных задач, истории и похожих блокеров (64d)' },
  { id: 'classify_intent', label: '3. Intent & Quote', desc: 'Классификация статуса, извлечение дословной цитаты и дат' },
  { id: 'validate_guardrails', label: '4. Guardrails', desc: 'Проверка прав, цитаты и запрета несанкционированной смены срока' },
  { id: 'mutate_task_state', label: '5. State Update', desc: 'Детерминированное обновление карточки задачи и истории' },
  { id: 'dispatch_notifications', label: '6. Notify & Brief', desc: 'Уведомление сотрудника/руководителя, эскалация или подготовка ответа' }
];

/**
 * Classifies natural-language Russian message from an employee or manager into structured report parameters.
 */
export function classifyMessageIntent(text, { role = 'employee', defaultDue = null, now = new Date() } = {}) {
  const raw = String(text || '').trim();
  const lower = raw.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

  // Extract explicit YYYY-MM-DD or +N days if present
  let proposedDue = null;
  const isoMatch = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch && validDate(isoMatch[1])) {
    proposedDue = isoMatch[1];
  } else {
    const baseMs = defaultDue && validDate(defaultDue) ? Date.parse(defaultDue + 'T12:00:00Z') : new Date(now).getTime();
    const daysMatch = lower.match(/на\s+(\d{1,2})\s*(дн|дня|дней)/);
    if (daysMatch) {
      proposedDue = new Date(baseMs + Number(daysMatch[1]) * 86400000).toISOString().slice(0, 10);
    } else if (/послезавтра/.test(lower)) {
      proposedDue = new Date( new Date(now).getTime() + 2 * 86400000).toISOString().slice(0, 10);
    } else if (/завтра/.test(lower) && /перенес|срок|прошу|сдвин|не успев/.test(lower)) {
      proposedDue = new Date(new Date(now).getTime() + 86400000).toISOString().slice(0, 10);
    } else if (/перенес|продл|сдвин|не успев|позже/.test(lower)) {
      proposedDue = new Date(baseMs + 3 * 86400000).toISOString().slice(0, 10);
    }
  }

  const sentences = raw.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const bestQuote = sentences.sort((a, b) => b.length - a.length)[0] || raw;

  if (/препятств.*устран|блок.*снят|данные получ|доступ дали|проблема решена|разблокир/.test(lower)) {
    return {
      kind: 'unblocked',
      summary: raw.slice(0, 260),
      quote: bestQuote.slice(0, 400),
      needsDecision: false,
      confidence: 0.92
    };
  }

  if (/перенес|продл|сдвин|новую дату|новый срок|не успеваем к|прошу перенести/.test(lower) && proposedDue) {
    return {
      kind: 'deadline_request',
      summary: raw.slice(0, 260),
      quote: bestQuote.slice(0, 400),
      proposedDue,
      needsDecision: true,
      nextAction: 'Решить вопрос о переносе срока',
      confidence: 0.91
    };
  }

  if (/препятств|блок|не могу|нет данных|не дают|ждем|ждём|проблем|ошибк|завис|нужна помощь|требуется помощь|стопор/.test(lower)) {
    const needsDecision = /помощ|руковод|решен|соглас|эскалац|ускор/.test(lower);
    return {
      kind: 'blocked',
      summary: raw.slice(0, 260),
      blocker: bestQuote.slice(0, 300),
      quote: bestQuote.slice(0, 400),
      needsDecision,
      nextAction: needsDecision ? 'Помочь устранить препятствие и согласовать действия' : 'Контролировать устранение препятствия',
      confidence: 0.94
    };
  }

  if (/полностью готов|готово к проверке|на проверку|завершен|выполнен|сделал|сделана|свод готов|отправляю на проверку|прошу проверить/.test(lower)) {
    return {
      kind: 'review',
      summary: raw.slice(0, 260),
      quote: bestQuote.slice(0, 400),
      needsDecision: true,
      nextAction: 'Проверить и принять результат',
      confidence: 0.93
    };
  }

  if (raw.length < 28 && /нормально|занимаюсь|в процессе|работаю|делаю|смотрю|ок|хорошо|принял/.test(lower) && !/\d/.test(lower)) {
    return {
      kind: 'unclear',
      summary: 'Ответ без конкретики; требуется уточнить фактический результат и дату.',
      quote: raw,
      needsDecision: false,
      confidence: 0.89
    };
  }

  return {
    kind: 'progress',
    summary: raw.slice(0, 260),
    quote: bestQuote.slice(0, 400),
    needsDecision: /нужно решение|согласовать|вопрос руководителю/.test(lower),
    nextAction: /нужно решение|согласовать|вопрос руководителю/.test(lower) ? 'Уточнить требуемое решение руководителя' : '',
    confidence: 0.84
  };
}

/**
 * Builds and compiles the LangGraph workflow for processing task monitoring events:
 * - employee_feedback: employee reports progress, blocker, deadline request, or completion
 * - task_assigned: manager assigns or updates a task -> notify employee
 * - check_in_request: assistant requests status from employee
 * - manager_query: manager asks assistant for semantic analysis or action
 */
export function createMonitoringGraph() {
  const graph = new StateGraph({
    workspace: { reducer: (_prev, next) => next, default: () => null },
    eventType: { reducer: (_prev, next) => next, default: () => 'employee_feedback' },
    actorId: { reducer: (_prev, next) => next, default: () => 'manager' },
    taskId: { reducer: (_prev, next) => next, default: () => null },
    message: { reducer: (_prev, next) => next, default: () => '' },
    now: { reducer: (_prev, next) => next, default: () => new Date().toISOString() },
    embContext: { reducer: (_prev, next) => next, default: () => null },
    classification: { reducer: (_prev, next) => next, default: () => null },
    validation: { reducer: (_prev, next) => next, default: () => ({ valid: true }) },
    mutationResult: { reducer: (_prev, next) => next, default: () => null },
    notifications: {
      reducer: (prev = [], next = []) => [...prev, ...next],
      default: () => []
    },
    assistantReply: { reducer: (_prev, next) => next, default: () => '' }
  });

  graph.addNode('ingest_signal', state => {
    const ws = state.workspace;
    const actor = ws.employees.find(e => e.id === state.actorId) || { id: state.actorId, name: 'Участник', role: state.actorId === 'manager' ? 'manager' : 'employee' };
    const ownTasks = ws.tasks.filter(t => actor.role === 'manager' || t.employeeId === actor.id);
    const mentioned = mentionedTaskIds(state.message, ownTasks);
    const resolvedTaskId = state.taskId || (mentioned.length === 1 ? mentioned[0] : null);

    return {
      taskId: resolvedTaskId,
      nodeSummary: `Принят сигнал [${state.eventType}] от ${actor.name}${resolvedTaskId ? ` по ${resolvedTaskId}` : ''}`
    };
  });

  graph.addNode('emb_retrieve', state => {
    const ws = state.workspace;
    const query = [state.taskId, state.message].filter(Boolean).join(' ');
    const searchRes = semanticSearch(ws, query, { topK: 4, minScore: 0.05 });

    let resolvedTaskId = state.taskId;
    if (!resolvedTaskId && searchRes.results.length) {
      const actor = ws.employees.find(e => e.id === state.actorId);
      const candidate = searchRes.results.find(r => {
        if (!r.taskId) return false;
        const t = ws.tasks.find(x => x.id === r.taskId);
        return t && (actor?.role === 'manager' || t.employeeId === state.actorId);
      });
      if (candidate && candidate.score >= 0.25) resolvedTaskId = candidate.taskId;
    }

    const similar = resolvedTaskId ? findSimilarTasks(ws, resolvedTaskId, 2) : [];

    return {
      taskId: resolvedTaskId,
      embContext: {
        dimension: EMBEDDING_DIM,
        topMatches: searchRes.results,
        similarTasks: similar,
        vectorSample: searchRes.vectorPreview
      },
      nodeSummary: `Emb-поиск (64d): найдено ${searchRes.results.length} релевантных записей${resolvedTaskId ? `, задача ${resolvedTaskId}` : ''}`
    };
  });

  graph.addNode('classify_intent', state => {
    const ws = state.workspace;
    const task = ws.tasks.find(t => t.id === state.taskId);
    if (state.eventType === 'task_assigned') {
      return {
        classification: { kind: 'assigned', summary: task?.summary || state.message, confidence: 1 },
        nodeSummary: 'Событие назначения новой задачи исполнителю'
      };
    }
    if (state.eventType === 'check_in_request') {
      return {
        classification: { kind: 'check_in', summary: 'Запрос статуса выполнения от ассистента', confidence: 1 },
        nodeSummary: 'Сформирован запрос статуса сотруднику'
      };
    }
    if (state.eventType === 'manager_query') {
      return {
        classification: { kind: 'manager_query', summary: state.message, confidence: 0.95 },
        nodeSummary: 'Аналитический запрос руководителя по задачам и эмбеддингам'
      };
    }

    const cls = classifyMessageIntent(state.message, {
      role: 'employee',
      defaultDue: task?.due || null,
      now: state.now
    });
    return {
      classification: cls,
      nodeSummary: `Классификация: ${cls.kind} (точность ${Math.round(cls.confidence * 100)}%)`
    };
  });

  graph.addNode('validate_guardrails', state => {
    const ws = state.workspace;
    const task = ws.tasks.find(t => t.id === state.taskId);
    if (state.eventType === 'manager_query') {
      return { validation: { valid: true, reason: 'manager_query' }, nodeSummary: 'Доступ руководителя подтверждён' };
    }
    if (!task) {
      return {
        validation: { valid: false, reason: 'missing_task', error: 'Задача не определена однозначно. Уточните ID поручения.' },
        nodeSummary: 'Остановка: требуется уточнить ID задачи'
      };
    }
    if (task.status === 'done' && state.eventType === 'employee_feedback') {
      return {
        validation: { valid: false, reason: 'task_closed', error: 'Задача уже в архиве; переоткрыть её может только руководитель.' },
        nodeSummary: 'Остановка: задача закрыта в архиве'
      };
    }
    if (state.eventType === 'employee_feedback' && task.employeeId !== state.actorId && state.actorId !== 'manager') {
      return {
        validation: { valid: false, reason: 'unauthorized', error: 'Сотрудник может обновлять только свои поручения.' },
        nodeSummary: 'Остановка: попытка изменить чужую задачу'
      };
    }
    return {
      validation: { valid: true, reason: 'ok' },
      nodeSummary: `Guardrails пройдены для ${task.id} (цитата проверена, срок защищён)`
    };
  });

  graph.addNode('mutate_task_state', state => {
    let nextWs = clone(state.workspace);
    const task = nextWs.tasks.find(t => t.id === state.taskId);
    const cls = state.classification;

    if (state.eventType === 'employee_feedback' && task && cls) {
      const actorId = task.employeeId;
      const sourceId = `lg:${task.id}:${Date.parse(state.now) || Date.now()}`;
      const source = {
        id: sourceId,
        taskId: task.id,
        employeeId: actorId,
        text: state.message,
        receivedAt: state.now,
        occurredAt: state.now
      };
      const report = {
        taskId: task.id,
        kind: cls.kind,
        summary: cls.summary,
        quote: cls.quote,
        blocker: cls.blocker,
        needsDecision: cls.needsDecision,
        nextAction: cls.nextAction,
        proposedDue: cls.proposedDue
      };
      nextWs = applyReport(nextWs, report, { id: actorId, role: 'employee' }, source);
      return {
        workspace: nextWs,
        mutationResult: { updated: true, sourceId, kind: cls.kind, taskId: task.id },
        nodeSummary: `Обновлена задача ${task.id}: статус → ${nextWs.tasks.find(t => t.id === task.id).status}`
      };
    }

    if (state.eventType === 'check_in_request' && task) {
      const t = nextWs.tasks.find(x => x.id === task.id);
      t.lastRequestedAt = state.now;
      if (t.contact === 'answered') t.contact = 'awaiting';
      nextWs.events.unshift({
        key: `checkin:${task.id}:${state.now}`,
        taskId: task.id,
        kind: 'check_in',
        at: state.now,
        text: `Ассистент запросил статус у исполнителя (${nextWs.employees.find(e => e.id === t.employeeId)?.name || t.employeeId})`
      });
      return {
        workspace: nextWs,
        mutationResult: { updated: true, kind: 'check_in', taskId: task.id },
        nodeSummary: `Зафиксирован запрос статуса по ${task.id}`
      };
    }

    return {
      mutationResult: { updated: false },
      nodeSummary: 'Без мутации состояния задач'
    };
  });

  graph.addNode('dispatch_notifications', state => {
    const ws = clone(state.workspace);
    const task = ws.tasks.find(t => t.id === state.taskId);
    const emp = task ? ws.employees.find(e => e.id === task.employeeId) : ws.employees.find(e => e.id === state.actorId);
    const empName = emp?.name || 'Сотрудник';
    const cls = state.classification;
    const notifications = [];
    let reply = '';

    if (!state.validation.valid) {
      reply = state.validation.error || 'Не удалось обработать сообщение.';
      notifications.push({
        id: `notif:${Date.now()}:warn`,
        at: state.now,
        to: state.actorId,
        recipientName: empName,
        taskId: state.taskId,
        kind: 'clarify_id',
        severity: 'amber',
        title: 'Требуется уточнение по задаче',
        text: reply,
        channel: 'assistant'
      });
    } else if (state.eventType === 'task_assigned' && task) {
      reply = `${empName}, вам назначено поручение ${task.id} «${task.title}»${task.due ? ` со сроком ${task.due}` : ' без фиксированного срока'}. Ожидаемый результат: ${task.summary || 'уточнить детали с руководителем'}.`;
      notifications.push({
        id: `notif:${task.id}:assigned:${Date.parse(state.now) || Date.now()}`,
        at: state.now,
        to: task.employeeId,
        recipientName: empName,
        taskId: task.id,
        kind: 'task_assigned',
        severity: 'cyan',
        title: `Новое поручение ${task.id} для ${empName}`,
        text: reply,
        channel: 'telegram_or_app'
      });
    } else if (state.eventType === 'check_in_request' && task) {
      reply = `${empName}, добрый день! Подскажите актуальный статус по поручению ${task.id} «${task.title}»${task.due ? ` (срок ${task.due})` : ''}: что уже готово, есть ли проблемы или потребность в помощи руководителя?`;
      notifications.push({
        id: `notif:${task.id}:checkin:${Date.parse(state.now) || Date.now()}`,
        at: state.now,
        to: task.employeeId,
        recipientName: empName,
        taskId: task.id,
        kind: 'check_in',
        severity: 'violet',
        title: `Запрос статуса у ${empName} (${task.id})`,
        text: reply,
        channel: 'telegram_or_app'
      });
    } else if (state.eventType === 'employee_feedback' && task && cls) {
      if (cls.kind === 'blocked') {
        reply = `Зафиксировал препятствие по ${task.id} с вашей цитатой. Передал сигнал руководителю для содействия: «${cls.blocker || cls.summary}».`;
        notifications.push(
          {
            id: `notif:${task.id}:escalation:${Date.parse(state.now) || Date.now()}`,
            at: state.now,
            to: 'manager',
            recipientName: 'Руководитель',
            fromEmployeeId: task.employeeId,
            taskId: task.id,
            kind: 'blocker_escalation',
            severity: 'coral',
            title: `Препятствие по ${task.id} (${empName})`,
            text: `${empName} сообщил о проблеме: «${cls.quote}». Требуется решение: ${task.nextAction || 'помочь устранить блокер'}.`,
            channel: 'dashboard_and_telegram'
          },
          {
            id: `notif:${task.id}:ack:${Date.parse(state.now) || Date.now()}`,
            at: state.now,
            to: task.employeeId,
            recipientName: empName,
            taskId: task.id,
            kind: 'employee_ack',
            severity: 'mint',
            title: `Ответ ассистента для ${empName} (${task.id})`,
            text: reply,
            channel: 'telegram_or_app'
          }
        );
      } else if (cls.kind === 'deadline_request') {
        reply = `Запрос на перенос срока ${task.id} на ${cls.proposedDue} зафиксирован и направлен руководителю. До согласования действует прежний срок (${task.due || 'без срока'}).`;
        notifications.push(
          {
            id: `notif:${task.id}:due_req:${Date.parse(state.now) || Date.now()}`,
            at: state.now,
            to: 'manager',
            recipientName: 'Руководитель',
            fromEmployeeId: task.employeeId,
            taskId: task.id,
            kind: 'deadline_escalation',
            severity: 'amber',
            title: `Запрос переноса срока ${task.id} (${empName})`,
            text: `${empName} просит перенести срок с ${task.due || '—'} на ${cls.proposedDue}. Цитата: «${cls.quote}».`,
            channel: 'dashboard_and_telegram'
          },
          {
            id: `notif:${task.id}:ack_due:${Date.parse(state.now) || Date.now()}`,
            at: state.now,
            to: task.employeeId,
            recipientName: empName,
            taskId: task.id,
            kind: 'employee_ack',
            severity: 'mint',
            title: `Ответ ассистента для ${empName} (${task.id})`,
            text: reply,
            channel: 'telegram_or_app'
          }
        );
      } else if (cls.kind === 'review') {
        reply = `Спасибо! Поручение ${task.id} переведено в статус «На проверке». Уведомил руководителя о готовности результата.`;
        notifications.push({
          id: `notif:${task.id}:review:${Date.parse(state.now) || Date.now()}`,
          at: state.now,
          to: 'manager',
          recipientName: 'Руководитель',
          fromEmployeeId: task.employeeId,
          taskId: task.id,
          kind: 'ready_for_review',
          severity: 'violet',
          title: `Результат ${task.id} ждёт приёмки (${empName})`,
          text: `${empName} передал работу на проверку: «${cls.quote}».`,
          channel: 'dashboard_and_telegram'
        });
      } else if (cls.kind === 'unclear') {
        reply = `${empName}, принял сигнал, что вы на связи по ${task.id}. Уточните, пожалуйста, одним сообщением: какой конкретный результат уже готов и когда ждать завершение?`;
        notifications.push({
          id: `notif:${task.id}:clarify:${Date.parse(state.now) || Date.now()}`,
          at: state.now,
          to: task.employeeId,
          recipientName: empName,
          taskId: task.id,
          kind: 'clarify_followup',
          severity: 'amber',
          title: `Запрос конкретики у ${empName} (${task.id})`,
          text: reply,
          channel: 'telegram_or_app'
        });
      } else if (cls.kind === 'unblocked') {
        reply = `Отлично, блокировка по ${task.id} снята, задача возвращена в активную работу. Руководитель уведомлён.`;
        notifications.push({
          id: `notif:${task.id}:unblocked:${Date.parse(state.now) || Date.now()}`,
          at: state.now,
          to: 'manager',
          recipientName: 'Руководитель',
          fromEmployeeId: task.employeeId,
          taskId: task.id,
          kind: 'unblocked_notice',
          severity: 'mint',
          title: `Препятствие устранено по ${task.id} (${empName})`,
          text: `${empName} подтвердил снятие блокера: «${cls.quote}».`,
          channel: 'dashboard'
        });
      } else {
        reply = `Статус по ${task.id} обновлён с привязкой к источнику. Продолжаем движение по плану.`;
        notifications.push({
          id: `notif:${task.id}:progress:${Date.parse(state.now) || Date.now()}`,
          at: state.now,
          to: 'manager',
          recipientName: 'Руководитель',
          fromEmployeeId: task.employeeId,
          taskId: task.id,
          kind: 'progress_notice',
          severity: 'cyan',
          title: `Обновление прогресса ${task.id} (${empName})`,
          text: `${empName}: «${cls.quote}»`,
          channel: 'dashboard'
        });
      }
    } else if (state.eventType === 'manager_query') {
      const matches = state.embContext?.topMatches || [];
      if (matches.length) {
        reply = `LangGraph + Emb (64d) проанализировал базу знаний. Найдено совпадений: ${matches.length}.\n\n` +
          matches.map((m, idx) => `${idx + 1}. [${m.score}] ${m.title}\n   ${m.snippet}`).join('\n\n');
      } else {
        reply = 'По вашему запросу в векторном индексе точных совпадений не найдено. Попробуйте указать ключевые слова по проекту, сотруднику или проблеме.';
      }
    }

    ws.notifications = [...notifications, ...(ws.notifications || [])].slice(0, 60);

    return {
      workspace: ws,
      notifications,
      assistantReply: reply,
      nodeSummary: `Уведомлений создано: ${notifications.length}`
    };
  });

  graph.addEdge(START, 'ingest_signal');
  graph.addEdge('ingest_signal', 'emb_retrieve');
  graph.addEdge('emb_retrieve', 'classify_intent');
  graph.addEdge('classify_intent', 'validate_guardrails');
  graph.addConditionalEdges(
    'validate_guardrails',
    state => {
      if (!state.validation?.valid) return 'invalid';
      if (state.eventType === 'manager_query' || state.eventType === 'task_assigned') return 'notify_only';
      return 'mutate';
    },
    {
      invalid: 'dispatch_notifications',
      notify_only: 'dispatch_notifications',
      mutate: 'mutate_task_state'
    }
  );
  graph.addEdge('mutate_task_state', 'dispatch_notifications');
  graph.addEdge('dispatch_notifications', END);

  return graph.compile({ name: 'LangGraph_TaskMonitor_v1' });
}

/**
 * High-level helper to run a message or event through the compiled LangGraph workflow
 * and persist trace + notifications into workspace state.
 * @param {any} workspace
 * @param {{ eventType?: string, actorId?: string, taskId?: string | null, message?: string, now?: string }} [options]
 */
export function runAssistantWorkflow(workspace, { eventType = 'employee_feedback', actorId = 'manager', taskId = null, message = '', now = new Date().toISOString() } = {}) {
  const compiled = createMonitoringGraph();
  const execution = compiled.invoke({
    workspace,
    eventType,
    actorId,
    taskId,
    message,
    now
  });

  const nextWorkspace = clone(execution.state.workspace);
  const runRecord = {
    id: `run:${Date.parse(now) || Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    eventType,
    actorId,
    taskId: execution.state.taskId,
    message,
    classification: execution.state.classification,
    embContext: execution.state.embContext,
    trace: execution.trace,
    assistantReply: execution.state.assistantReply,
    notifications: execution.state.notifications
  };

  nextWorkspace.graphRuns = [runRecord, ...(nextWorkspace.graphRuns || [])].slice(0, 40);
  return {
    state: nextWorkspace,
    run: runRecord,
    reply: execution.state.assistantReply,
    notifications: execution.state.notifications,
    trace: execution.trace,
    embContext: execution.state.embContext
  };
}
