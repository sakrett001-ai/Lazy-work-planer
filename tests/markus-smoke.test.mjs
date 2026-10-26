import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
for(const mode of ['success','unknown','malformed','reject','abort-late','deadline','pages','existing','unsafe-parent','wrong-policy','missing-config','singleton'])test('finite synthetic smoke: '+mode,()=>{
 const r=spawnSync(process.execPath,['tests/fixtures/markus-smoke-check.mjs',mode],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,new RegExp('PASS '+mode));
});
test('CLI refuses absent opt-in, duplicate flags and arbitrary prompts without config reads',()=>{
 for(const args of [[],['--run-synthetic-smoke','--prompt=arbitrary'],['--run-synthetic-smoke','--root=/never','--root=/never']]){const r=spawnSync(process.execPath,['scripts/markus-smoke.mjs',...args],{encoding:'utf8',timeout:5000});assert.equal(r.status,2);assert.ok(!r.stdout);}
});
