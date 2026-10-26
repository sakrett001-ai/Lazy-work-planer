import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'planner-attempt-audit-'));
const configFile = join(dir, 'connections.json');
process.env.ASSISTANT_DATA_DIR = dir;
process.env.ASSISTANT_SERVER_ORIGIN = 'https://attempt-audit.test';
process.env.ASSISTANT_AI_ENABLED = 'true';
process.env.ASSISTANT_LLM_CONFIG = configFile;
process.env.ASSISTANT_LLM_KEY_RECOVERY_TEST = 'fictional-test-key-not-a-secret';
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Network forbidden in recovery tests'); };
const store = await import('../agent/lib/store.ts');
const auth = await import('../agent/lib/web-auth.ts');
const proto = await import('../agent/lib/prototype.ts');
const config = await import('../agent/lib/llm-config.ts');
const { handleDashboardRequest } = await import('../agent/lib/dashboard-api.ts');
const { createConsultationRunner } = await import('../agent/lib/consultation-runner.ts');
const attempts = await import('../agent/lib/provider-attempts.ts');
const {sourceVersion}=await import('../agent/lib/assistant-memory.ts');
const fixtureSource={id:'S1',taskId:'T1',employeeId:'employee',text:'Нужны исходные данные.',receivedAt:'2026-10-24T08:00:00.000Z'};
const off = { enabled: false, connectionId: null, model: null };
const answer = { text: JSON.stringify({ protocolVersion:2, action: 'answer', text: 'Запросить исходные данные.', references: [{ kind:'source',id:'S1',version:sourceVersion(fixtureSource),quote:'Нужны исходные данные.' }] }) };
const manager = () => store.readState().employees[0];
function reset() {
  writeFileSync(configFile, JSON.stringify({ connections: [{ id: 'test', label: 'Offline fixture', provider: 'vsegpt', credentialEnv: 'ASSISTANT_LLM_KEY_RECOVERY_TEST', models: ['fixture-model'] }] }));
  store.updateState(() => ({
    employees: [{ id: 'boss', name: 'Руководитель · тест', role: 'manager' }, { id: 'employee', name: 'Исполнитель · тест', role: 'employee' }],
    tasks: Array.from({ length: 4 }, (_, i) => ({ id: `T${i + 1}`, title: `Поручение ${i + 1}`, employeeId: 'employee', status: 'active', due: '2030-12-01' })),
    sources: [{ id: 'S1', taskId: 'T1', employeeId: 'employee', text: 'Нужны исходные данные.', receivedAt: '2026-10-24T08:00:00.000Z' }],
    events: [], settings: { timezone: 'Europe/Moscow', startHour: 9, endHour: 18, minHoursBetween: 6, excludedDates: [] },
  }));
  config.roleSettings(manager()); proto.preferences('boss');
  auth.webTables().exec('DELETE FROM llm_settings; DELETE FROM web_assistant_jobs; DELETE FROM web_operations; DELETE FROM web_sessions; DELETE FROM web_invites;');
  config.saveRoleSettings({ requestId: randomUUID(), expectedVersion: config.roleSettings(manager()).version,
    roles: { coordinator: off, analyst: { enabled: true, connectionId: 'test', model: 'fixture-model' }, reviewer: off } }, manager());
}
function job(taskId = 'T1') {
  return proto.createAssistantJob({ requestId: randomUUID(), taskId, expectedVersion: proto.versionOf(store.readState().tasks.find(t => t.id === taskId)), question: 'Что делать?' }, manager(), true, config.executionPlan()).jobId;
}
function age(id, status) {
  const record = proto.getJob(id), at = new Date(Date.now() - 11 * 60000).toISOString();
  Object.assign(record, { status, createdAt: at, updatedAt: at, ...(status === 'running' ? { startedAt: at } : {}) });
  store.database().prepare('UPDATE web_assistant_jobs SET data=? WHERE id=?').run(JSON.stringify(record), id);
}
async function api(path, body, session) {
  return handleDashboardRequest(new Request(process.env.ASSISTANT_SERVER_ORIGIN + '/assistant/api/' + path, {
    headers: { ...(session ? { cookie: session.cookie } : {}), ...(body === undefined ? {} : { origin: process.env.ASSISTANT_SERVER_ORIGIN, 'content-type': 'application/json', 'x-csrf-token': session?.csrf || '' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  }), { assistantAvailable: config.assistantAvailable(), assistantMode: 'roles' });
}
after(() => { globalThis.fetch = realFetch; store.database().close(); rmSync(dir, { recursive: true, force: true }); });


async function signin(id = 'boss') {
  const response = await api('login', { code: auth.issueInvite(id) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, ...await (await api('session', undefined, { cookie })).json() };
}
const safeRow = row => {
  assert.ok(!Object.hasOwn(row, 'handle'));
  assert.ok(!Object.hasOwn(row, 'token'));
  assert.ok(!Object.hasOwn(row, 'model'));
  assert.ok(!JSON.stringify(row).includes('fixture-model'));
  assert.ok(!Object.hasOwn(row, 'prompt'));
  assert.ok(!Object.hasOwn(row, 'text'));
  assert.ok(!Object.hasOwn(row, 'key'));
  assert.ok(!JSON.stringify(row).includes('fictional-test-key-not-a-secret'));
};

test('Runner persists attempt before calling adapter; sanitized completed audit is visible only to authorized manager', async () => {
  reset(); const id = job(), boss = await signin(), employee = await signin('employee');
  let calls = 0;
  const run = createConsultationRunner({ complete: async input => {
    calls++;
    const rows = attempts.readAttempts(id);
    assert.equal(rows.length, 1, 'Durable journal exists before provider side effect');
    assert.equal(rows[0].state, 'started');
    assert.equal(rows[0].roleId, 'analyst');
    assert.equal(rows[0].call, 1);
    assert.equal(rows[0].provider, 'vsegpt');
    safeRow(rows[0]);
    assert.equal(input.key, 'fictional-test-key-not-a-secret');
    return { ...answer, inputTokens: 17, outputTokens: 8 };
  } });
  await run(id); await run(id);
  assert.equal(calls, 1);
  assert.equal(proto.getJob(id).status, 'completed');
  const [record] = attempts.readAttempts(id);
  assert.equal(record.state, 'response_received');
  assert.equal(record.inputTokens, 17); assert.equal(record.outputTokens, 8); safeRow(record);
  const published = await (await api('assistant?taskId=T1', undefined, boss)).json();
  assert.deepEqual(published.jobs.find(j => j.id === id).attempts, attempts.readAttempts(id));
  const denied = await (await api('assistant?taskId=T1', undefined, employee)).json();
  assert.deepEqual(denied.jobs, []);
  assert.equal((await api('assistant?taskId=T1')).status, 401);
});

test('Valid provider usage survives changed context, revoked role or elapsed job TTL even when answer publication fails', async () => {
  for (const mode of ['context', 'role', 'ttl', 'swept-during-call']) {
    reset(); const id = job(); let calls = 0;
    const run = createConsultationRunner({ complete: async () => {
      calls++;
      if (mode === 'ttl' || mode === 'swept-during-call') {
        age(id, 'running');
        if (mode === 'swept-during-call') {
          proto.pendingAssistantJobs();
          assert.equal(attempts.readAttempts(id)[0].state, 'unknown');
        }
      }
      else store.updateState(state => { if (mode === 'role') state.employees[0].role = 'employee'; else state.sources[0].text = 'Новые сведения после начала запроса.'; return state; });
      return { ...answer, inputTokens: 23, outputTokens: 11 };
    } });
    await run(id); await run(id);
    assert.equal(calls, 1, mode);
    assert.equal(proto.getJob(id).status, 'failed', mode);
    assert.equal(proto.getJob(id).text, undefined, mode);
    const [record] = attempts.readAttempts(id);
    assert.equal(record.state, mode === 'swept-during-call' ? 'unknown' : 'response_received', mode);
    assert.ok(record.observedAt, mode);
    assert.equal(record.inputTokens, 23, mode); assert.equal(record.outputTokens, 11, mode);
    safeRow(record);
  }
});

test('Malformed usage never becomes trusted counters; valid zero counters survive', async () => {
  for (const usage of [
    { inputTokens: -1, outputTokens: 1.5 },
    { inputTokens: '123', outputTokens: NaN },
    { inputTokens: Infinity, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    reset(); const id = job();
    await createConsultationRunner({ complete: async () => ({ ...answer, ...usage }) })(id);
    const [record] = attempts.readAttempts(id);
    assert.equal(record.state, 'response_received');
    assert.equal(record.inputTokens, undefined); assert.equal(record.outputTokens, undefined);
    assert.equal(proto.getJob(id).execution.steps[0].inputTokens,undefined);
    assert.equal(proto.getJob(id).execution.steps[0].outputTokens,undefined);
  }
  reset(); const id = job();
  await createConsultationRunner({ complete: async () => ({ ...answer, inputTokens: 0, outputTokens: 0 }) })(id);
  const [record] = attempts.readAttempts(id);
  assert.equal(record.inputTokens, 0); assert.equal(record.outputTokens, 0);
});

test('Provider exception yields sanitized unknown attempt and is never retried automatically', async () => {
  reset(); const id = job(); let calls = 0;
  const raw = 'private provider response fictional-test-key-not-a-secret https://secret.example/path';
  const run = createConsultationRunner({ complete: async () => { calls++; throw Error(raw); } });
  await run(id); await run(id);
  const [record] = attempts.readAttempts(id);
  assert.equal(record.state, 'unknown');
  assert.equal(calls, 1);
  assert.equal(proto.getJob(id).status, 'failed');
  assert.ok(!JSON.stringify(record).includes(raw)); safeRow(record);
  assert.ok(!JSON.stringify(record).includes('secret.example'));
  assert.ok(!JSON.stringify(proto.getJob(id)).includes(raw));
});

test('A new process sees durable started audit after interrupted execution; expiry marks unknown without replay', () => {
  reset(); const id = job();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch=()=>{throw Error('Network forbidden');};
    const proto=await import('./agent/lib/prototype.ts');
    const attempts=await import('./agent/lib/provider-attempts.ts');
    const job=proto.claimAssistantJob(${JSON.stringify(id)});
    if(!job)throw Error('Claim failed');
    const ctx={session:{auth:{current:{principalId:'boss',attributes:{webJobId:job.id}}}}};
    proto.beginProviderAttempt(ctx,'analyst',1,'vsegpt');
    if(attempts.readAttempts(job.id)[0]?.state!=='started')throw Error('Journal missing');
    process.exit(0);
  `], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(attempts.readAttempts(id)[0].state, 'started');
  assert.equal(proto.getJob(id).status, 'running');
  age(id, 'running');
  assert.deepEqual(proto.pendingAssistantJobs(), []);
  assert.equal(attempts.readAttempts(id)[0].state, 'unknown');
  assert.equal(proto.getJob(id).recoveryReason, 'execution_uncertain');
  assert.equal(proto.claimAssistantJob(id), undefined);
  assert.equal(attempts.readAttempts(id).length, 1);
});

test('Atomic preflight rejects stale context and duplicate attempts; opaque finish capability preserves first observation', () => {
  reset(); const id = job();
  assert.ok(proto.claimAssistantJob(id));
  const ctx = { session: { auth: { current: { principalId: 'boss', attributes: { webJobId: id } } } } };
  store.updateState(state => { state.tasks[0].title = 'Изменённая задача'; return state; });
  assert.throws(() => proto.beginProviderAttempt(ctx, 'analyst', 1, 'vsegpt'));
  assert.deepEqual(attempts.readAttempts(id), []);

  reset(); const validId = job();
  assert.ok(proto.claimAssistantJob(validId));
  const validContext = { session: { auth: { current: { principalId: 'boss', attributes: { webJobId: validId } } } } };
  const handle = proto.beginProviderAttempt(validContext, 'analyst', 1, 'vsegpt');
  assert.throws(() => proto.beginProviderAttempt(validContext, 'analyst', 1, 'vsegpt'));
  assert.equal(attempts.readAttempts(validId).length, 1);
  assert.throws(() => attempts.finishAttempt({ ...handle, token: 'wrong-token' }, { state: 'response_received', inputTokens: 99 }));
  assert.throws(() => attempts.finishAttempt({ id: handle.id }, { state: 'unknown' }));
  assert.equal(attempts.readAttempts(validId)[0].state, 'started');
  attempts.finishAttempt(handle, { state: 'response_received', inputTokens: 7, outputTokens: 3 });
  const first = attempts.readAttempts(validId);
  assert.ok(!JSON.stringify(first).includes(handle.token));
  attempts.finishAttempt(handle, { state: 'response_received', inputTokens: 999, outputTokens: 999 });
  attempts.finishAttempt(handle, { state: 'unknown', errorCode: 'private error text' });
  assert.deepEqual(attempts.readAttempts(validId), first);
});

test('Journal write failures fail closed: no call before durable start, no orphan started attempt after receipt failure', async () => {
  reset();
  // Ensure the table exists, then inject failures only in this disposable DB.
  attempts.readAttempts('initialize-test-table');
  let calls = 0;
  const run = createConsultationRunner({ complete: async () => { calls++; return { ...answer, inputTokens: 13, outputTokens: 5 }; } });
  const beforeStart = job();
  store.database().exec(`CREATE TRIGGER reject_attempt_start BEFORE INSERT ON provider_attempts BEGIN SELECT RAISE(ABORT, 'injected start write failure'); END;`);
  try {
    await run(beforeStart); await run(beforeStart);
    assert.equal(calls, 0, 'Never call a provider without its durable start record');
    assert.equal(proto.getJob(beforeStart).status, 'failed');
    assert.equal(proto.getJob(beforeStart).text, undefined);
    assert.deepEqual(attempts.readAttempts(beforeStart), []);
  } finally { store.database().exec('DROP TRIGGER IF EXISTS reject_attempt_start'); }

  reset(); const receiptFailure = job(); calls = 0;
  store.database().exec(`CREATE TRIGGER reject_attempt_receipt BEFORE UPDATE ON provider_attempts
    WHEN json_extract(NEW.data, '$.state') = 'response_received' OR json_extract(NEW.data, '$.observedAt') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;`);
  try {
    await run(receiptFailure); await run(receiptFailure);
    assert.equal(calls, 1, 'An uncertain receipt must not retry a provider request');
    assert.equal(proto.getJob(receiptFailure).status, 'failed');
    assert.equal(proto.getJob(receiptFailure).text, undefined);
    const records = attempts.readAttempts(receiptFailure);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'unknown', 'Terminal failed job cannot leave its attempt started');
    assert.equal(records[0].observedAt, undefined);
    assert.equal(records[0].inputTokens, undefined);
    assert.equal(records[0].outputTokens, undefined);
    safeRow(records[0]);
  } finally { store.database().exec('DROP TRIGGER IF EXISTS reject_attempt_receipt'); }
});
