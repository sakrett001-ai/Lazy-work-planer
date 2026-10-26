import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database, updateState } from './store.ts';

const role = z.enum(['coordinator', 'analyst', 'reviewer']);
const provider = z.enum(['openai', 'vsegpt', 'anthropic', 'gigachat', 'openrouter', 'yandex-broker']);
const input = z.object({ jobId: z.string().min(1).max(300), roleId: role, call: z.number().int().min(1).max(4), provider }).strict();
export type ProviderAttempt = z.infer<typeof input> & {
  state: 'started'|'response_received'|'unknown'; startedAt: string; finishedAt?: string;
  observedAt?: string; inputTokens?: number; outputTokens?: number; errorCode?: string;
};
export type AttemptHandle = { id: string; token: string };
function table() {
  const db = database();
  db.exec('CREATE TABLE IF NOT EXISTS provider_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, token TEXT NOT NULL, data TEXT NOT NULL);');
  return db;
}
export function readAttempts(jobId: string): ProviderAttempt[] {
  return (table().prepare('SELECT data FROM provider_attempts WHERE job_id=? ORDER BY rowid').all(jobId) as {data:string}[]).map(row => JSON.parse(row.data));
}
/** Internal only. Caller holds the active-job/current-context write transaction. */
export function beginAttempt(jobId: string, roleId: string, call: number, providerId: string): AttemptHandle {
  const fields = input.parse({ jobId, roleId, call, provider: providerId });
  const id = `${jobId}:${roleId}:${call}`, token = randomUUID();
  const data: ProviderAttempt = { ...fields, state: 'started', startedAt: new Date().toISOString() };
  // A duplicate key must fail closed BEFORE a second provider request.
  table().prepare('INSERT INTO provider_attempts VALUES (?,?,?,?)').run(id, jobId, token, JSON.stringify(data));
  return { id, token };
}
const safeTokens = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const codes = new Set(['timeout','network','auth','rate_limit','provider','protocol','response_size','configuration','context_size','validation','interrupted']);
/** Finish only an existing capability-bound attempt, independent of job validity.
 * Unknown is sticky: a late observed reply may add usage, never imply no charge,
 * approve an answer, or permit replay. No prompt/response/error bodies enter SQL.
 */
export function finishAttempt(handle: AttemptHandle, observation: {
  state: 'response_received'|'unknown'; inputTokens?: unknown; outputTokens?: unknown; errorCode?: unknown;
}) {
  table();
  let saved: ProviderAttempt;
  updateState(state => {
    const row = table().prepare('SELECT data FROM provider_attempts WHERE id=? AND token=?').get(handle.id, handle.token) as {data:string}|undefined;
    if (!row) throw new Error('Unknown provider attempt');
    const record = JSON.parse(row.data) as ProviderAttempt; saved = record;
    if (record.state === 'response_received' || record.observedAt) return state;
    if (!['response_received','unknown'].includes(observation.state)) throw new Error('Invalid attempt outcome');
    const at = new Date().toISOString();
    if (record.state === 'started') { record.state = observation.state; record.finishedAt = at; }
    if (observation.state === 'response_received') {
      record.observedAt = at;
      record.inputTokens = safeTokens(observation.inputTokens); record.outputTokens = safeTokens(observation.outputTokens);
    } else if (!record.errorCode) {
      record.errorCode = typeof observation.errorCode === 'string' && codes.has(observation.errorCode) ? observation.errorCode : 'unknown';
    }
    table().prepare('UPDATE provider_attempts SET data=? WHERE id=? AND token=?').run(JSON.stringify(record), handle.id, handle.token);
    return state;
  });
  return saved!;
}
/** Internal sweep; caller holds the same transaction that expires the job. */
export function markAttemptsUnknown(jobId: string) {
  const at = new Date().toISOString();
  for (const record of readAttempts(jobId)) if (record.state === 'started') {
    record.state = 'unknown'; record.finishedAt = at; record.errorCode = 'interrupted';
    table().prepare('UPDATE provider_attempts SET data=? WHERE id=?').run(JSON.stringify(record), `${record.jobId}:${record.roleId}:${record.call}`);
  }
}
