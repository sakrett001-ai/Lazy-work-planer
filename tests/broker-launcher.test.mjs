import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('real launcher private config/clean environment: four fake-gate cases without sockets',()=>{
 const run=spawnSync('python3',['-I','-B','tests/fixtures/broker_launcher_checks.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.match(run.stderr,/Ran 4 tests/);assert.match(run.stderr,/\bOK\b/);
});
