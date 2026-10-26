import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('actual runner through authenticated Unix gate, persistent worker and budget core (fake provider only)',()=>{
 const r=spawnSync(process.execPath,['tests/fixtures/broker-ipc-e2e.mjs'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"unixPeerGate":true/);assert.match(r.stdout,/"disabledNoDispatch":true/);
});
