import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readState, updateState, type Employee } from './store.ts';
import { digest, webTables, WebError } from './web-auth.ts';
import { openSecret, sealSecret } from './llm-secrets.ts';

export const roleIds = ['coordinator', 'analyst', 'reviewer'] as const;
export type RoleId = typeof roleIds[number];
export const roleLabels: Record<RoleId, string> = { coordinator: 'Координатор', analyst: 'Аналитик', reviewer: 'Проверяющий' };
export const providerLabels = { openai: 'OpenAI', vsegpt: 'VseGPT', anthropic: 'Claude / Anthropic', gigachat: 'GigaChat', openrouter: 'OpenRouter' } as const;
export type ProviderId = keyof typeof providerLabels;
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@+\-]{0,159}$/);
const connectionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), label: z.string().trim().min(1).max(100),
  provider: z.enum(['openai', 'vsegpt', 'anthropic', 'gigachat', 'openrouter']),
  credentialEnv: z.string().regex(/^ASSISTANT_LLM_KEY_[A-Z0-9_]+$/),
  models: z.array(name).min(1).max(50),
  maxOutputTokens: z.number().int().min(256).max(8192).default(2048),
  scope: z.enum(['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP']).optional(),
}).strict();
const catalogSchema = z.object({ connections: z.array(connectionSchema).max(20) }).strict().superRefine(({ connections }, ctx) => {
  if (new Set(connections.map(c => c.id)).size !== connections.length) ctx.addIssue({ code: 'custom', message: 'Duplicate connection ID' });
  for (const c of connections) {
    if (new Set(c.models).size !== c.models.length || (c.scope && c.provider !== 'gigachat')) ctx.addIssue({ code: 'custom', message: 'Invalid connection options' });
  }
});
const managedSchema = connectionSchema.omit({ credentialEnv: true }).extend({ credentialId: z.string(), revision: z.uuid() });
export type Connection = z.infer<typeof connectionSchema> | z.infer<typeof managedSchema>;
const assignment = z.object({ enabled: z.boolean(), connectionId: z.string().max(64).nullable(), model: name.nullable() }).strict();
const rolesSchema = z.object({ coordinator: assignment, analyst: assignment, reviewer: assignment }).strict();
export type RoleAssignments = z.infer<typeof rolesSchema>;
export type RoleRoute = { roleId: RoleId; connectionId: string; connectionLabel: string; connectionVersion: string; provider: ProviderId; model: string; maxOutputTokens: number };
export type Execution = { configurationVersion: string; routes: RoleRoute[]; steps: { roleId: RoleId; call: number; inputTokens?: number; outputTokens?: number }[]; review?: string; errorCode?: string };

// This administrator-owned file contains references to secrets, never their values.
// Endpoints are fixed in adapters: neither the browser nor a model can redirect a key.
export function loadConnections(): Connection[] {
  const path = process.env.ASSISTANT_LLM_CONFIG;
  try {
    if (path && statSync(path).size > 65536) throw new Error('Catalog too large');
    const configured = path ? catalogSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).connections : [];
    const saved = (tables().prepare('SELECT data FROM llm_connections ORDER BY rowid').all() as {data:string}[]).map(row => managedSchema.parse(JSON.parse(row.data)));
    const all = [...configured, ...saved];
    if (new Set(all.map(c => c.id)).size !== all.length) throw new Error('Duplicate connection ID');
    return all;
  } catch { throw new WebError(503, 'Не удалось прочитать настройки подключений ИИ на сервере.'); }
}
const identityFor = (connection: z.infer<typeof managedSchema>) => JSON.stringify([connection.id, connection.provider, connection.revision]);
export function credential(connection: Connection): string {
  let value: string|undefined;
  if ('credentialId' in connection) {
    try {
      const row = tables().prepare('SELECT secret FROM llm_connections WHERE id=?').get(connection.credentialId) as {secret:string}|undefined;
      if (row) value = openSecret(row.secret, identityFor(connection));
    } catch { throw new WebError(503, 'Не удалось открыть сохранённый ключ подключения. Проверьте хранилище ключей сервера.'); }
  } else value = process.env[connection.credentialEnv]?.trim();
  if (!value || value.length > 8192 || /\s/.test(value)) throw new WebError(503, 'Ключ выбранного подключения не настроен на сервере.');
  return value;
}
function ready(connection: Connection) { try { credential(connection); return true; } catch { return false; } }
function tables() {
  const db = webTables();
  db.exec('CREATE TABLE IF NOT EXISTS llm_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS llm_connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);');
  return db;
}
function assignments(): RoleAssignments {
  const row = tables().prepare('SELECT data FROM llm_settings WHERE id=1').get() as {data:string}|undefined;
  return row ? rolesSchema.parse(JSON.parse(row.data)) : Object.fromEntries(roleIds.map(id => [id, { enabled: false, connectionId: null, model: null }])) as RoleAssignments;
}
function requireManager(actor: Employee) {
  if (readState().employees.find(p => p.id === actor.id)?.role !== 'manager') throw new WebError(403, 'Подключения и роли настраивает руководитель.');
}
function version(roles: RoleAssignments, connections: Connection[]) {
  return digest(JSON.stringify({ roles, connections: connections.map(c => ({ ...c, ready: ready(c) })) }));
}
function routesFor(roles: RoleAssignments, connections: Connection[]): RoleRoute[] {
  return roleIds.filter(role => roles[role].enabled).map(roleId => {
    const selected = roles[roleId], connection = connections.find(c => c.id === selected.connectionId);
    if (!connection || !selected.model || !connection.models.includes(selected.model) || !ready(connection)) throw new WebError(400, `Для роли «${roleLabels[roleId]}» выберите доступное подключение и модель.`);
    return { roleId, connectionId: connection.id, connectionLabel: connection.label, connectionVersion: digest(JSON.stringify(connection)), provider: connection.provider, model: selected.model, maxOutputTokens: connection.maxOutputTokens };
  });
}
export function executionPlan(): Execution {
  if (!aiEnabledOnServer()) throw new WebError(503, 'ИИ выключен в настройках сервера.');
  const connections = loadConnections(), roles = assignments();
  if (!roles.analyst.enabled) throw new WebError(503, 'Включите аналитика в разделе «Модели и роли».');
  return { configurationVersion: version(roles, connections), routes: routesFor(roles, connections), steps: [] };
}
export function assistantAvailable() { try { executionPlan(); return true; } catch { return false; } }
// With no environment override, a manager explicitly enables roles in the UI.
// No role is enabled in a new database. The administrator can still force AI off.
export function aiEnabledOnServer() { const value = process.env.ASSISTANT_AI_ENABLED; return value === undefined || value === '' || value === 'true'; }
export function roleSettings(actor: Employee) {
  requireManager(actor);
  const connections = loadConnections(), roles = assignments();
  return {
    version: version(roles, connections), roles, roleLabels,
    enabledOnServer: aiEnabledOnServer(), available: assistantAvailable(), providerLabels,
    connections: connections.map(c => ({ id: c.id, label: c.label, provider: c.provider, providerLabel: providerLabels[c.provider], models: c.models, scope: c.scope, ready: ready(c), editable: 'credentialId' in c })),
  };
}
export function saveConnection(raw: unknown, actor: Employee) {
  requireManager(actor);
  const input = z.object({ requestId: z.uuid(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), connectionId: z.string().max(64).nullable(),
    label: connectionSchema.shape.label, provider: connectionSchema.shape.provider, models: connectionSchema.shape.models,
    scope: connectionSchema.shape.scope, apiKey: z.string().trim().max(8192).refine(value => !/\s/.test(value)),
  }).strict().parse(raw);
  if (new Set(input.models).size !== input.models.length || input.models.some(m => m === 'REPLACE_WITH_MODEL_ID')) throw new WebError(400, 'Укажите реальные ID моделей без повторов.');
  if (input.scope && input.provider !== 'gigachat') throw new WebError(400, 'Scope применяется только к GigaChat.');
  const operation = `llm-connection:${actor.id}:${input.requestId}`, hash = digest(JSON.stringify(input));
  let result: {ok:boolean;duplicate:boolean;connectionId:string}|undefined;
  tables();
  updateState(state => {
    requireManager(actor);
    const db = tables(), prior = db.prepare('SELECT request_hash,response FROM web_operations WHERE id=?').get(operation) as {request_hash:string;response:string}|undefined;
    if (prior) {
      if (prior.request_hash !== hash) throw new WebError(409, 'Этот запрос уже использован для других настроек подключения.');
      result = { ...JSON.parse(prior.response), duplicate: true }; return state;
    }
    const all = loadConnections(), old = all.find(c => c.id === input.connectionId);
    if (input.expectedVersion !== version(assignments(), all)) throw new WebError(409, 'Подключения изменились. Откройте «Модели и роли» снова.');
    if (input.connectionId && (!old || !('credentialId' in old))) throw new WebError(400, 'Подключение из файла изменяется в настройках сервера. Можно добавить отдельное подключение здесь.');
    if (!old && all.length >= 20) throw new WebError(400, 'Доступно до 20 подключений.');
    if (old && old.provider !== input.provider) throw new WebError(400, 'Для другого провайдера добавьте отдельное подключение.');
    if (!old && !input.apiKey) throw new WebError(400, 'Вставьте API-ключ выбранного провайдера.');
    const id = old?.id || `ui-${randomUUID()}`;
    const connection = managedSchema.parse({ id, label: input.label, provider: input.provider, models: input.models, scope: input.scope,
      credentialId: id, revision: !input.apiKey && old && 'revision' in old ? old.revision : randomUUID(), maxOutputTokens: old?.maxOutputTokens || 2048 });
    let sealed: string;
    try {
      if (input.apiKey) {
        const count = (db.prepare('SELECT count(*) AS n FROM llm_connections').get() as {n:number}).n;
        sealed = sealSecret(input.apiKey, identityFor(connection), count === 0);
      } else {
        credential(connection); // Verify the retained key before committing metadata.
        sealed = (db.prepare('SELECT secret FROM llm_connections WHERE id=?').get(id) as {secret:string}).secret;
      }
    } catch { throw new WebError(503, 'Не удалось сохранить ключ на сервере. Проверьте доступ к хранилищу ключей.'); }
    db.prepare('INSERT INTO llm_connections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret=excluded.secret').run(id, JSON.stringify(connection), sealed);
    result = { ok: true, duplicate: false, connectionId: id };
    // Receipts contain only public metadata and a request digest, never plaintext.
    db.prepare('INSERT INTO web_operations VALUES (?,?,?)').run(operation, hash, JSON.stringify(result));
    return state;
  });
  return result!;
}
export function saveRoleSettings(raw: unknown, actor: Employee) {
  requireManager(actor);
  const input = z.object({ requestId: z.uuid(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), roles: rolesSchema }).strict().parse(raw);
  const key = `llm-roles:${actor.id}:${input.requestId}`, hash = digest(JSON.stringify(input));
  let result: {ok:boolean; duplicate:boolean; version:string}|undefined;
  tables();
  updateState(state => {
    requireManager(actor);
    const db = tables(), previous = db.prepare('SELECT request_hash,response FROM web_operations WHERE id=?').get(key) as {request_hash:string;response:string}|undefined;
    if (previous) {
      if (previous.request_hash !== hash) throw new WebError(409, 'Этот запрос уже использован для других настроек.');
      result = { ...JSON.parse(previous.response), duplicate: true }; return state;
    }
    const connections = loadConnections();
    if (input.expectedVersion !== version(assignments(), connections)) throw new WebError(409, 'Настройки изменились. Закройте окно и откройте «Модели и роли» снова.');
    routesFor(input.roles, connections);
    if (!input.roles.analyst.enabled && (input.roles.coordinator.enabled || input.roles.reviewer.enabled)) throw new WebError(400, 'Для работы команды ролей включите аналитика.');
    // Even disabled selections must refer to the server catalog, or be empty.
    for (const role of Object.values(input.roles)) {
      if (role.connectionId === null && role.model === null) continue;
      if (!connections.some(c => c.id === role.connectionId && c.models.includes(role.model || ''))) throw new WebError(400, 'Выберите модель из списка подключения.');
    }
    db.prepare('INSERT INTO llm_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(input.roles));
    result = { ok: true, duplicate: false, version: version(input.roles, connections) };
    db.prepare('INSERT INTO web_operations VALUES (?,?,?)').run(key, hash, JSON.stringify(result));
    return state;
  });
  return result!;
}
export function resolveRoute(route: RoleRoute): { connection: Connection; key: string } {
  const connection = loadConnections().find(c => c.id === route.connectionId);
  if (!connection || digest(JSON.stringify(connection)) !== route.connectionVersion || connection.provider !== route.provider || !connection.models.includes(route.model)) throw new WebError(409, 'Подключение изменилось. Создайте новый запрос.');
  return { connection, key: credential(connection) };
}
