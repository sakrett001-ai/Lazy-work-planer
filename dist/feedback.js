import { localDateKey, validDate } from './domain.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const shift = (day, count) => new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);

/** Explicit dates only. A missing or ambiguous date must remain unknown. */
export function requestedDate(text, { defaultDue = null, now = new Date(), timezone = 'Europe/Moscow' } = {}) {
  if (/\d.{0,12}(?:или|либо).{0,12}\d|примерно|ориентировочно|в районе/.test(text)) return null;
  const today = localDateKey(now, timezone), dates = [];
  const add = date => dates.push(validDate(date) ? date : null);
  for (const match of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) add(match[1]);
  for (const match of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/g)) add(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  const monthPattern = new RegExp(`(?:^|\\s)(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(20\\d{2}))?`, 'g');
  for (const match of text.matchAll(monthPattern)) add(`${match[3] || today.slice(0, 4)}-${String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  if (/послезавтра/.test(text)) dates.push(shift(today, 2));
  else if (/завтра/.test(text)) dates.push(shift(today, 1));
  for (const match of text.matchAll(/на\s+(\d{1,2})\s*(?:дней|дня|дн(?:я|ь)?)(?![а-я])/g)) {
    dates.push(defaultDue && validDate(defaultDue) ? shift(defaultDue, Number(match[1])) : null);
  }
  const unique = [...new Set(dates)];
  return unique.length === 1 && unique[0] && unique[0] >= today ? unique[0] : null;
}

/** Conservative demo fallback, not an AI model or a measured confidence score. */
export function classifyMessageIntent(text, options = {}) {
  const raw = String(text || '').trim();
  const lower = raw.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const quote = (raw.split(/(?<=[.!?])\s+|\n+/).sort((a, b) => b.length - a.length)[0] || raw).slice(0, 400);
  const base = { summary: raw.slice(0, 260), quote, method: 'rules', needsDecision: false };
  const unclear = (reason, question) => ({ ...base, kind: 'unclear', reason, question });
  if (!raw) return unclear('empty', 'Что уже готово по задаче?');
  if (/\?$/.test(raw)) return unclear('question', 'Это вопрос или подтверждение состояния задачи? Уточните фактический результат.');

  const transfer = /(?:прошу|предлагаю|нужно|нужен|давайте|можно|придется|хочу)[^.!?\n]{0,45}(?:перенес|перенос|продл|сдвин)|перенесите|продлите|не успеваем к сроку/.test(lower);
  if (transfer && !/перенос[^.!?\n]{0,15}не нужен|не (?:перенос|перенес|продл|сдвин)|не (?:нужно|прошу|надо) (?:перенос|перенес|продл|сдвин)/.test(lower)) {
    const proposedDue = requestedDate(lower, options);
    if (!proposedDue) return unclear('missing_date', 'На какую конкретную дату предлагаете перенести срок?');
    return { ...base, kind: 'deadline_request', proposedDue, needsDecision: true, nextAction: 'Решить вопрос о переносе срока' };
  }

  const unresolved = /(?:препятств|блок|проблем)[^.!?\n]{0,35}не (?:устран|снят|решен)|данные не получ|доступ не (?:дали|получен)|пока не разблокир/.test(lower);
  const notReady = /не\s+(?:полностью\s+)?(?:готов|выполн|заверш|сдела)|не все[^.!?\n]{0,35}(?:готов|выполн|заверш)/.test(lower);
  const cleaned = lower.replace(/(?:проблем|ошибок|препятствий|блокировок) (?:больше )?нет|нет (?:проблем|ошибок|препятствий|блокировок)|без (?:проблем|ошибок|препятствий)|проблема решена|препятствие устранено|блокировка снята/g, '');
  const blocker = unresolved || /нет данных|данных нет|не дают|не могу|ждем|задерж|нужна помощь|требуется помощь|стопор|блок|препятств|проблем|ошибк/.test(cleaned);
  const resolved = !unresolved && /препятств[^.!?\n]{0,20}устран|блок[^.!?\n]{0,20}снят|данные (?:получены|получили)|доступ дали|проблема решена|разблокирован/.test(lower);
  if (resolved && (blocker || /частичн|не все|не полностью/.test(lower))) return unclear('conflicting_status', 'Препятствие полностью устранено или ещё что-то мешает завершению?');
  if (blocker) {
    const needsDecision = /помощ|руковод|соглас|эскалац|ускор/.test(lower);
    return { ...base, kind: 'blocked', blocker: quote.slice(0, 300), needsDecision, nextAction: needsDecision ? 'Помочь устранить препятствие' : 'Уточнить, что требуется для устранения препятствия' };
  }
  if (notReady) return unclear('not_ready', 'Что уже сделано и что осталось до готовности?');
  if (/полностью готов|готово к проверке|на проверку|завершен|выполнен|сделал|сделана|свод готов|прошу проверить/.test(lower)) return { ...base, kind: 'review', needsDecision: true, nextAction: 'Проверить и принять результат' };
  if (resolved) return { ...base, kind: 'unblocked' };
  if (raw.length >= 28 && /собрал|подготовил|сверил|получил|согласовал|передал|собран|подготовлен|сверен|получены/.test(lower)) return { ...base, kind: 'progress' };
  return unclear('insufficient_facts', 'Какой конкретный результат уже готов и когда ждать завершение?');
}

/** Additional checks for model-proposed facts; still not a guarantee of language understanding. */
export function assertReportEvidence(report, source, task, timezone = 'Europe/Moscow') {
  const options = { defaultDue: task.due, now: source.occurredAt || source.receivedAt, timezone };
  const assessment = classifyMessageIntent(source.text, options);
  if (report.kind === 'deadline_request' && (assessment.kind !== 'deadline_request' || assessment.proposedDue !== report.proposedDue)) {
    throw new Error('Предлагаемая дата не подтверждается однозначным запросом. Уточните дату у сотрудника.');
  }
  if (['review', 'unblocked'].includes(report.kind) && (assessment.kind === 'blocked' || ['not_ready', 'conflicting_status', 'question'].includes(assessment.reason))) {
    throw new Error('В исходном сообщении есть отрицание или противоречие. Уточните состояние задачи.');
  }
}
