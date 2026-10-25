import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const run = (directory, args) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: {
    ...process.env, ASSISTANT_DATA_DIR: directory, ASSISTANT_AI_ENABLED: 'false',
    ASSISTANT_DELIVERY_ENABLED: 'false', ASSISTANT_LLM_CONFIG: '',
  }});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const evaluate = (directory, code) => run(directory, ['--input-type=module', '-e', code]);
const snapshot = directory => JSON.parse(evaluate(directory, `
  const {database}=await import('./agent/lib/store.ts');const db=database();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const data=Object.fromEntries(tables.map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
  console.log(JSON.stringify(data));db.close();`));

async function start(directory) {
  const reservation = createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  const port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/pilot-server.mjs'], { env: {
    ...process.env, ASSISTANT_DATA_DIR: directory, ASSISTANT_HOST: '127.0.0.1', ASSISTANT_PORT: String(port),
    ASSISTANT_SERVER_ORIGIN: origin, ASSISTANT_AI_ENABLED: 'false', ASSISTANT_DELIVERY_ENABLED: 'false', ASSISTANT_LLM_CONFIG: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';child.stdout.on('data', data => { output += data; });child.stderr.on('data', data => { output += data; });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const response=await fetch(origin+'/assistant/workspace', {signal: AbortSignal.timeout(1000)});if(response.status===200)return {child,origin,output:()=>output}; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Local hosted server did not become ready: '+output);
  } catch (error) { await stop({child});throw error; }
}
async function stop(server) {
  const child=server.child;
  if(child.exitCode!==null || child.signalCode!==null)return;
  const done=once(child,'exit');child.kill();await done;
}

test('Hosted bootstrap is explicit, idempotent and never issues login codes', () => {
  const root=mkdtempSync(join(tmpdir(),'pulse-bootstrap-'));
  try {
    assert.match(run(root,['scripts/bootstrap-hosted.mjs']),/Initialized/);
    let state=snapshot(root);assert.equal(JSON.parse(state.state[0].data).tasks.length,0);
    assert.equal(JSON.parse(state.state[0].data).employees.length,1);
    assert.ok(!state.web_invites);
    assert.match(run(root,['scripts/bootstrap-hosted.mjs','--examples']),/preserved/);
    assert.deepEqual(snapshot(root),state);
    const exampleDir=join(root,'examples');run(exampleDir,['scripts/bootstrap-hosted.mjs','--examples']);
    assert.equal(JSON.parse(snapshot(exampleDir).state[0].data).tasks.length,6);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Synthetic SQLite backup restores tasks, sources, reports, auth and encrypted key; actual server restart preserves them', async () => {
  const root=mkdtempSync(join(tmpdir(),'pulse-move-')),source=join(root,'source'),target=join(root,'destination');
  let server;
  try {
    run(source,['scripts/bootstrap-hosted.mjs','--examples']);
    evaluate(source,`
      const s=await import('./agent/lib/store.ts'),a=await import('./agent/lib/web-auth.ts');
      const c=await import('./agent/lib/llm-config.ts'),r=await import('./agent/lib/task-reports.ts');
      const manager=s.readState().employees.find(p=>p.id==='manager');
      c.saveConnection({requestId:crypto.randomUUID(),expectedVersion:c.roleSettings(manager).version,connectionId:null,label:'Synthetic only',provider:'vsegpt',apiKey:'synthetic-portability-key',models:['test-model']},manager);
      a.issueInvite('employee-1');a.login(a.issueInvite('manager'));
      const tasks=s.readState().tasks;r.createReport({requestId:crypto.randomUUID(),selection:tasks.map(t=>({taskId:t.id,expectedVersion:a.digest(JSON.stringify(t))}))},manager);
      s.database().close();`);
    const before=snapshot(source),backup=join(root,'snapshot.sqlite');
    run(source,['scripts/backup-state.mjs',backup]);
    mkdirSync(target,{mode:0o700});copyFileSync(backup,join(target,'assistant.sqlite'));
    copyFileSync(backup+'.llm-key',join(target,'llm-master.key'));chmodSync(join(target,'llm-master.key'),0o600);
    assert.deepEqual(snapshot(target),before);
    assert.equal(evaluate(target,`const c=await import('./agent/lib/llm-config.ts');console.log(c.credential(c.loadConnections()[0])==='synthetic-portability-key');`),'true\n');
    assert.ok(!readFileSync(backup).includes(Buffer.from('synthetic-portability-key')));
    const loginCode=evaluate(target,`const a=await import('./agent/lib/web-auth.ts');console.log(a.issueInvite('manager'));`).trim();
    server=await start(target);
    const login=await fetch(server.origin+'/assistant/api/login',{method:'POST',headers:{origin:server.origin,'content-type':'application/json'},body:JSON.stringify({code:loginCode})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(server.origin+'/assistant/api/session',{headers:{cookie}})).status,200);
    assert.doesNotMatch(server.output(),/Код входа|одноразовый|synthetic-portability-key/);
    await stop(server);server=null;const afterLogin=snapshot(target);
    server=await start(target);
    assert.equal((await fetch(server.origin+'/assistant/api/session',{headers:{cookie}})).status,200);
    assert.doesNotMatch(server.output(),/Код входа|одноразовый|synthetic-portability-key/);
    await stop(server);server=null;
    assert.deepEqual(snapshot(target),afterLogin);
    assert.deepEqual(snapshot(source),before,'Source unchanged by destination use');
  } finally {if(server)await stop(server);rmSync(root,{recursive:true,force:true});}
});
