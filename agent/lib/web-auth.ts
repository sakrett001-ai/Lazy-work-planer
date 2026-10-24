import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { database, readState } from './store.ts';

export class WebError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
// Select from trusted server configuration, never request/proxy headers.
// HTTP is permitted by serverOrigin() only for loopback development.
const cookieName = () => serverOrigin().startsWith('https:') ? '__Secure-lazy_work_session' : 'lazy_work_session';
const SESSION_SECONDS = 8 * 60 * 60;

export function webTables() {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS web_invites (hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS web_sessions (hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS web_operations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL);`);
  return db;
}

export function serverOrigin() {
  let url: URL;
  try { url = new URL(process.env.ASSISTANT_SERVER_ORIGIN || ''); }
  catch { throw new WebError(503, 'Адрес рабочего сервера ещё не настроен.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new WebError(503, 'Для рабочего сервера нужен HTTPS; HTTP допустим только на этом компьютере.');
  }
  return url.origin;
}

export function requireOrigin(request: Request) {
  if (request.headers.get('origin') !== serverOrigin()) throw new WebError(403, 'Запрос должен быть отправлен из рабочего пространства.');
}

export function issueInvite(employeeId: string, at = Date.now()) {
  if (!readState().employees.some(p => p.id === employeeId)) throw new Error('Участник не зарегистрирован. Сначала импортируйте состав пилота.');
  const value = token(), db = webTables();
  db.prepare('DELETE FROM web_invites WHERE expires_at <= ? OR employee_id = ?').run(at, employeeId);
  db.prepare('INSERT INTO web_invites VALUES (?,?,?)').run(digest(value), employeeId, at + 30 * 60 * 1000);
  return value;
}

export function login(code: string, at = Date.now()) {
  const db = webTables();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('DELETE FROM web_invites WHERE hash = ? AND expires_at > ? RETURNING employee_id').get(digest(code), at) as { employee_id: string } | undefined;
    if (!row || !readState().employees.some(p => p.id === row.employee_id)) throw new WebError(401, 'Код недействителен или уже использован.');
    const value = token(), csrf = token();
    db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(at);
    db.prepare('INSERT INTO web_sessions VALUES (?,?,?,?)').run(digest(value), row.employee_id, csrf, at + SESSION_SECONDS * 1000);
    db.exec('COMMIT');
    return { value, csrf };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function session(request: Request, at = Date.now()) {
  const name = cookieName();
  const values = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new WebError(401, 'Войдите в рабочее пространство.');
  const hash = digest(value);
  const row = webTables().prepare('SELECT employee_id, csrf FROM web_sessions WHERE hash = ? AND expires_at > ?').get(hash, at) as { employee_id: string; csrf: string } | undefined;
  const actor = row && readState().employees.find(p => p.id === row.employee_id);
  if (!row || !actor) throw new WebError(401, 'Сеанс завершён. Войдите снова.');
  return { actor, csrf: row.csrf, hash };
}

export function requireCsrf(request: Request, expected: string) {
  const value = request.headers.get('x-csrf-token') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) throw new WebError(403, 'Обновите страницу перед сохранением.');
}

export function sessionCookie(value = '') {
  return `${cookieName()}=${value}; Path=/assistant; HttpOnly; SameSite=Strict; Max-Age=${value ? SESSION_SECONDS : 0}${serverOrigin().startsWith('https:') ? '; Secure' : ''}`;
}

export function logout(hash: string) { webTables().prepare('DELETE FROM web_sessions WHERE hash = ?').run(hash); }
export { digest };
