import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Python bridge pipe-only: six cases, no Unix socket or peer-UID proof',()=>{
 const run=spawnSync('python3',['-B','tests/fixtures/broker_peer_pipe_checks.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.match(run.stderr,/Ran 6 tests/);assert.match(run.stderr,/\bOK\b/);
});
