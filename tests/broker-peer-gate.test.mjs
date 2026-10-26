import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Python Unix kernel-peer gate: framing, lifecycle, worker timeout and no replay',()=>{
 const run=spawnSync('python3',['-B','tests/fixtures/broker_peer_gate_checks.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:20000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 for(const line of (run.stderr||'').split('\n'))if(line.startsWith('persistent_request '))console.log(line);
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.match(run.stderr,/Ran 11 tests/);assert.match(run.stderr,/\bOK\b/);
});
