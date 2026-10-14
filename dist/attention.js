import { deadline } from './workspace-model.js';

export const DASHBOARDS = [
  { id: 'board', label: 'Доска' },
  { id: 'calendar', label: 'Календарь' },
  { id: 'timeline', label: 'Этапы и Гант' },
];
export const INTERVALS = [15, 30, 60, 120];

export function presentationPreferences(state) {
  const saved = state.settings?.presentation || {};
  const selected = Array.isArray(saved.views) ? saved.views : [];
  const views = DASHBOARDS.map(x => x.id).filter(id => selected.includes(id));
  return {
    interval: INTERVALS.includes(saved.interval) ? saved.interval : 30,
    events: ['important', 'all', 'off'].includes(saved.events) ? saved.events : 'important',
    views: views.length ? views : DASHBOARDS.map(x => x.id),
  };
}

export function pinnedIds(state) {
  const ids = state.settings?.pinnedTaskIds;
  return Array.isArray(ids) ? [...new Set(ids)].filter(id => state.tasks.some(t => t.id === id && t.status !== 'done')) : [];
}

export function togglePin(state, id) {
  if (!state.tasks.some(t => t.id === id && t.status !== 'done')) return state;
  const pins = pinnedIds(state);
  return { ...state, settings: { ...state.settings, pinnedTaskIds: pins.includes(id) ? pins.filter(x => x !== id) : [...pins, id] } };
}

// An acknowledgement belongs to a specific issue, not to the task forever.
export function attentionSignal(task, now = new Date()) {
  if (task.status === 'done') return null;
  const timing = deadline(task, now).kind;
  let kind, label, priority, view = 'board';
  if (task.status === 'blocked') {
    kind = 'blocked'; label = 'Есть препятствие'; priority = 0;
    if (task.phases?.some(p => p.blocked)) view = 'timeline';
  } else if (task.proposedDue) {
    kind = 'extension'; label = 'Запрошен перенос'; priority = 1; view = 'calendar';
  } else if (timing === 'overdue') {
    kind = 'overdue'; label = 'Срок истёк'; priority = 2; view = 'calendar';
  } else if (task.needsDecision || task.status === 'review') {
    kind = 'decision'; label = task.status === 'review' ? 'Результат ждёт проверки' : 'Нужно решение'; priority = 3;
  } else if (timing === 'soon') {
    kind = 'soon'; label = 'До срока меньше суток'; priority = 4; view = 'calendar';
  } else if (task.contact === 'no_reply' || task.needsClarification) {
    kind = 'reply'; label = task.contact === 'no_reply' ? 'Нет ответа' : 'Нужно уточнение'; priority = 5;
  } else return null;
  const key = JSON.stringify([kind, task.status, task.due, task.dueTime, task.proposedDue,
    task.blocker, task.needsDecision, task.needsClarification, task.contact, task.latestSourceId,
    (task.phases || []).map(p => [p.id, p.blocked])]);
  return { key, kind, label, priority, view };
}

export function isUnseen(state, task, now = new Date()) {
  const signal = attentionSignal(task, now);
  return !!signal && state.settings?.seenSignals?.[task.id] !== signal.key;
}

export function acknowledgeSignal(state, id, now = new Date()) {
  const task = state.tasks.find(t => t.id === id), signal = task && attentionSignal(task, now);
  if (!signal) return state;
  return { ...state, settings: { ...state.settings, seenSignals: { ...state.settings?.seenSignals, [id]: signal.key } } };
}

function taskSignature(task) {
  return JSON.stringify([task.title, task.summary, task.status, task.due, task.dueTime,
    task.proposedDue, task.blocker, task.needsDecision, task.contact, task.needsClarification,
    task.latestSourceId, task.lastReply, task.employeeId, task.department, task.phases]);
}

export function snapshotTasks(tasks, now = new Date()) {
  return new Map(tasks.map(t => [t.id, { signature: taskSignature(t), signal: attentionSignal(t, now)?.key || '' }]));
}

export function taskUpdates(previous, tasks, now = new Date()) {
  const next = snapshotTasks(tasks, now), events = [];
  for (const task of tasks) {
    const old = previous.get(task.id), current = next.get(task.id);
    if (old?.signature === current.signature && old?.signal === current.signal) continue;
    const signal = attentionSignal(task, now);
    events.push({ taskId: task.id, signature: current.signature, signal: current.signal,
      important: !!signal, priority: signal?.priority ?? 9,
      label: signal?.label || (task.status === 'done' ? 'Результат принят' : old ? 'Задача обновилась' : 'Новая задача'),
      view: signal?.view || (task.status === 'done' ? 'archive' : task.phases?.length ? 'timeline' : 'board') });
  }
  return { snapshot: next, events };
}

// No server or background automation: this player runs only in the open tab.
export class DashboardPlayer {
  running = false;
  nextAt = 0;
  holdUntil = 0;
  pending = [];
  spotlight = null;
  autoView = null;

  resetClock(now, interval) { this.nextAt = now + interval * 1000; }
  start(now, interval) { this.running = true; this.holdUntil = 0; this.resetClock(now, interval); }
  stop() { this.running = false; this.autoView = null; }
  clear() { this.pending = []; this.spotlight = null; }
  dismiss(taskId) {
    this.pending = this.pending.filter(e => e.taskId !== taskId);
    if (this.spotlight?.taskId === taskId) this.spotlight = null;
  }
  enqueue(event) {
    this.pending = this.pending.filter(e => e.taskId !== event.taskId);
    this.pending.push(event);
    this.pending = this.pending.slice(-30).sort((a, b) => a.priority - b.priority);
  }
  step({ now, view, busy, preferences }) {
    if (!this.running || busy) { this.resetClock(now, preferences.interval); return null; }
    if (now < this.holdUntil) return null;
    if (this.pending.length && preferences.events !== 'off') {
      const event = this.pending.shift();
      this.spotlight = event; this.autoView = event.view;
      this.resetClock(now, preferences.interval);
      this.holdUntil = this.nextAt;
      return { type: 'event', view: event.view, event };
    }
    if (now < this.nextAt) return null;
    this.resetClock(now, preferences.interval);
    const index = preferences.views.indexOf(view);
    const next = preferences.views[(index + 1) % preferences.views.length];
    this.autoView = null;
    return next === view ? null : { type: 'rotate', view: next };
  }
}
