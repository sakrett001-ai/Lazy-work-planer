import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'planner-job-recovery-'));
const configFile = join(dir, 'connections.json');
process.env.ASSISTANT_DATA_DIR = dir;
process.env.ASSISTANT_SERVER_ORIGIN = 'https://recovery.test';
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
const { createConsultationWorker } = await import('../agent/lib/consultation-worker.ts');
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

test('Pending authenticated request survives restart and worker consumes it once using an injected offline adapter', async () => {
  reset();
  const login = await api('login', { code: auth.issueInvite('boss') });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = { cookie, ...await (await api('session', undefined, { cookie })).json() };
  const command = { requestId: randomUUID(), taskId: 'T1', expectedVersion: proto.versionOf(store.readState().tasks[0]), question: 'Как снять препятствие?' };
  const response = await api('assistant', command, session);
  assert.equal(response.status, 200);
  const { jobId } = await response.json();
  assert.equal(proto.getJob(jobId).status, 'pending');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch=()=>{throw Error('Network forbidden');};
    const {createConsultationRunner}=await import('./agent/lib/consultation-runner.ts');
    const {createConsultationWorker}=await import('./agent/lib/consultation-worker.ts');
    const {getJob}=await import('./agent/lib/prototype.ts');
    const {database}=await import('./agent/lib/store.ts');
    let calls=0;
    const run=createConsultationRunner({complete:async()=>{calls++;return ${JSON.stringify(answer)};}});
    const worker=createConsultationWorker({runConsultation:run,intervalMs:1000000});
    try {await worker.wake();await worker.wake();console.log(JSON.stringify({calls,job:getJob(${JSON.stringify(jobId)})}));}
    finally {worker.stop();database().close();}
  `], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.calls, 1);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.references[0].sourceId, 'S1');
  assert.ok(result.job.references[0].version);
  const afterRestart = await (await api('assistant?taskId=T1', undefined, session)).json();
  assert.equal(afterRestart.jobs.find(j => j.id === jobId).status, 'completed');
  assert.equal((await (await api('assistant', command, session)).json()).duplicate, true);
  assert.equal(store.readState().tasks[0].status, 'active');
});

async function parallelClaims(ids) {
  const children = [], completions = [], ready = [];
  try {
    for (const id of ids) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const {claimAssistantJob}=await import('./agent/lib/prototype.ts');
        const {database}=await import('./agent/lib/store.ts');
        process.on('message',()=>{try{const value=claimAssistantJob(${JSON.stringify(id)});console.log(JSON.stringify({claimed:Boolean(value),id:value?.id}));database().close();process.disconnect();}catch(e){console.error(e.message);process.exitCode=1;process.disconnect();}});
        process.send('ready');
      `], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      ready.push(new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(Error(`Claim child exited ${code}`)); }); }));
      completions.push(new Promise((resolve, reject) => {
        let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
        child.once('error', reject); child.once('exit', code => {
          if (code !== 0) reject(Error(errors || `Claim child exited ${code}`));
          else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
        });
      }));
    }
    await Promise.all(ready);
    children.forEach(child => child.send('claim'));
    return await Promise.all(completions);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}

test('SQLite claim is atomic across processes: globally two running jobs and one winner per job', { timeout: 15000 }, async () => {
  reset();
  const ids = ['T1', 'T2', 'T3', 'T4'].map(job);
  const claims = await parallelClaims(ids);
  assert.equal(claims.filter(c => c.claimed).length, 2);
  assert.equal(ids.filter(id => proto.getJob(id).status === 'running').length, 2);
  assert.equal(ids.filter(id => proto.getJob(id).status === 'pending').length, 2, 'Capacity does not fail or consume queued work');
  for (const id of ids) proto.failAssistantJob(id);
  const single = job('T1');
  assert.equal((await parallelClaims([single, single, single, single])).filter(c => c.claimed).length, 1);
});

test('Expired running jobs become execution_uncertain, expired pending jobs become expired; neither replays', async () => {
  reset(); const running = job('T1'), pending = job('T2');
  age(running, 'running'); age(pending, 'pending');
  let calls = 0;
  const worker = createConsultationWorker({ runConsultation: async () => { calls++; }, intervalMs: 1000000 });
  try { await worker.wake(); await worker.wake(); }
  finally { worker.stop(); }
  assert.equal(calls, 0);
  assert.equal(proto.getJob(running).status, 'failed');
  assert.equal(proto.getJob(running).recoveryReason, 'execution_uncertain');
  assert.equal(proto.getJob(pending).status, 'failed');
  assert.equal(proto.getJob(pending).recoveryReason, 'expired');
  assert.equal(proto.claimAssistantJob(running), undefined);
  assert.equal(proto.claimAssistantJob(pending), undefined);
  const unknownMessage=proto.getJob(running).error;
  proto.failAssistantJob(running); // Late provider failure must not erase the unknown-outcome warning.
  assert.equal(proto.getJob(running).error,unknownMessage);
});

test('Changed context or revoked manager role fails preflight without any adapter call', async () => {
  for (const revoke of [false, true]) {
    reset(); const id = job();
    store.updateState(state => { if (revoke) state.employees[0].role = 'employee'; else state.sources[0].text = 'Обновлённые данные.'; return state; });
    let calls = 0;
    const run = createConsultationRunner({ complete: async () => { calls++; return answer; } });
    const worker = createConsultationWorker({ runConsultation: run, intervalMs: 1000000 });
    try { await worker.wake(); }
    finally { worker.stop(); }
    assert.equal(calls, 0);
    assert.equal(proto.getJob(id).status, 'failed');
    assert.equal(proto.getJob(id).recoveryReason, 'context_changed');
  }
});

test('Reentrant wake does not duplicate dispatch; stop prevents dispatch after in-flight completion', async () => {
  reset(); ['T1', 'T2', 'T3'].forEach(job);
  const calls = [], releases = [];
  const worker = createConsultationWorker({ intervalMs: 1000000, runConsultation: async id => {
    calls.push(id); assert.ok(proto.claimAssistantJob(id));
    await new Promise(resolve => releases.push(resolve));
    proto.failAssistantJob(id);
  } });
  const first = worker.wake(), second = worker.wake();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls).size, 2);
    worker.stop(); releases.forEach(resolve => resolve());
    await Promise.all([first, second]); await worker.wake();
    assert.equal(calls.length, 2);
  } finally { worker.stop(); releases.forEach(resolve => resolve()); }
});

async function concurrentEnqueues(commands) {
  const children = [], ready = [], completed = [];
  try {
    for (const command of commands) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const {createAssistantJob}=await import('./agent/lib/prototype.ts');
        const {executionPlan}=await import('./agent/lib/llm-config.ts');
        const {readState,database}=await import('./agent/lib/store.ts');
        process.on('message',()=>{
          try {const receipt=createAssistantJob(${JSON.stringify(command)},readState().employees[0],true,executionPlan());console.log(JSON.stringify({status:200,receipt}));}
          catch(error){console.log(JSON.stringify({status:error.status||500}));}
          finally {database().close();process.disconnect();}
        });
        process.send('ready');
      `], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      ready.push(new Promise((resolve, reject) => {
        child.once('message', resolve); child.once('error', reject);
        child.once('exit', code => { if (code) reject(Error(`Enqueue child exited ${code}`)); });
      }));
      completed.push(new Promise((resolve, reject) => {
        let output = '', errors = '';
        child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
        child.once('error', reject); child.once('exit', code => {
          if (code !== 0) reject(Error(errors || `Enqueue child exited ${code}`));
          else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
        });
      }));
    }
    await Promise.all(ready);
    children.forEach(child => child.send('enqueue'));
    return await Promise.all(completed);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}

test('Concurrent enqueue admits one pending request per actor/task and rejects conflicting content under the same request ID', { timeout: 15000 }, async () => {
  for (const sameId of [false, true]) {
    reset();
    const requestId = randomUUID(), expectedVersion = proto.versionOf(store.readState().tasks[0]);
    const commands = [
      { requestId, taskId: 'T1', expectedVersion, question: 'Первый вопрос о задаче' },
      { requestId: sameId ? requestId : randomUUID(), taskId: 'T1', expectedVersion, question: 'Другой вопрос о задаче' },
    ];
    const outcomes = await concurrentEnqueues(commands);
    assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
    const winner = outcomes.findIndex(result => result.status === 200);
    const rows = store.database().prepare('SELECT data FROM web_assistant_jobs').all();
    assert.equal(rows.length, 1, 'No duplicate durable jobs');
    const saved = JSON.parse(rows[0].data);
    assert.equal(saved.id, outcomes[winner].receipt.jobId);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.question, commands[winner].question, 'Losing payload cannot overwrite the accepted question');
    assert.equal(saved.taskVersion, expectedVersion);
  }
});

test('Late provider response after expiry cannot erase uncertain outcome or publish/replay an answer', async () => {
  reset();const id=job();let calls=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const run=createConsultationRunner({complete:async()=>{calls++;await held;return answer;}});
  const running=run(id);
  try {
    assert.equal(calls,1);assert.equal(proto.getJob(id).status,'running');
    age(id,'running');proto.pendingAssistantJobs();
    const before=proto.getJob(id);assert.equal(before.recoveryReason,'execution_uncertain');
    release();await running;await run(id);
    const after=proto.getJob(id);
    assert.equal(after.status,'failed');assert.equal(after.recoveryReason,'execution_uncertain');
    assert.equal(after.error,before.error);assert.equal(after.text,undefined);assert.equal(calls,1);
  } finally {release();await running;}
});
