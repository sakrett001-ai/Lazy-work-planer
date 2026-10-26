import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantReviewLabel} from '../dist/prototype-ui.js';
import {MARKUS_CHARACTER_POLICY,MARKUS_REVIEW_POLICY} from '../agent/lib/markus-policy.ts';
test('Review label only trusts completed host-recorded check; never model text or enabled role',()=>{
 assert.equal(assistantReviewLabel({status:'completed',text:'Проверено!',execution:{routes:[{roleId:'reviewer'}]}}),'Независимая проверка не подтверждена.');
 assert.equal(assistantReviewLabel({status:'completed',execution:{reviewStatus:'not_run'}}),'Независимая проверка не выполнялась.');
 assert.match(assistantReviewLabel({status:'completed',execution:{reviewStatus:'passed'}}),/проверку моделью/);
 assert.match(assistantReviewLabel({status:'failed',execution:{reviewStatus:'passed'}}),/не подтверждена/);
 assert.match(assistantReviewLabel({status:'failed',execution:{reviewStatus:'rejected'}}),/не опубликован/);
 assert.match(MARKUS_CHARACTER_POLICY,/не выдумывай память/i);assert.match(MARKUS_REVIEW_POLICY,/не гарантирует истинность/);
});

test('Calibration keeps whole fenced output rejected; does not add a transport parser repair',async()=>{
 const {readFileSync}=await import('node:fs');
 const runner=readFileSync(new URL('../agent/lib/consultation-runner.ts',import.meta.url),'utf8');
 assert.match(runner,/actionSchema.parse\(JSON.parse\(result.text\)\)/);
 assert.throws(()=>JSON.parse(' ```\n{"action":"answer"}\n```'));
});
test('v6 evidence policy separates chronology from authority and is used by actual runner',async()=>{
 const {MARKUS_POLICY_VERSION,MARKUS_EVIDENCE_POLICY}=await import('../agent/lib/markus-policy.ts');const {readFileSync}=await import('node:fs');
 assert.equal(MARKUS_POLICY_VERSION,'markus-task-consultation/v6');assert.match(MARKUS_EVIDENCE_POLICY,/receivedAt/);assert.match(MARKUS_EVIDENCE_POLICY,/не автоматически как истину/);assert.match(MARKUS_EVIDENCE_POLICY,/отдельное решение уполномоченного человека/);assert.match(MARKUS_EVIDENCE_POLICY,/recordedAcceptance/);
 const runner=readFileSync(new URL('../agent/lib/consultation-runner.ts',import.meta.url),'utf8');assert.ok(runner.includes('${MARKUS_EVIDENCE_POLICY}'));
 const ui=readFileSync(new URL('../dist/prototype-ui.js',import.meta.url),'utf8');assert.ok(!ui.includes('esc(job.execution.review)'));assert.ok(ui.includes("failed:'Ответ не опубликован'"));
});

test('Decision renderer hides technical keys, escapes host names, and suppresses failed references',async()=>{
 const {decisionEvidenceMarkup}=await import('../dist/prototype-ui.js');const ref={decisionId:'INTERNAL-EVENT',version:'INTERNAL-HASH',actorId:'INTERNAL-ACTOR',actorName:'<img src=x onerror=alert(1)>',at:'2026-09-03T11:00:00Z'};
 const html=decisionEvidenceMarkup({status:'completed',decisionReferences:[ref]});assert.match(html,/По записи платформы результат принят/);assert.ok(!html.includes('INTERNAL-'));assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.equal(decisionEvidenceMarkup({status:'failed',decisionReferences:[ref]}),'');
});
