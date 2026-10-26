import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Peer gate retires ownership before EOF: deterministic connection doubles, no sockets',()=>{
 const run=spawnSync('python3',['-B','tests/fixtures/broker_peer_cleanup_checks.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.match(run.stderr,/Ran 2 tests/);assert.match(run.stderr,/\bOK\b/);
});
test('Peer diagnostic metadata and fixture cleanup: doubles only, no sockets',()=>{
 const run=spawnSync('python3',['-B','tests/fixtures/broker_peer_diagnostic_checks.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.match(run.stderr,/Ran 3 tests/);assert.match(run.stderr,/\bOK\b/);
});
