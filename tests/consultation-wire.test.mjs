import test from 'node:test';
import assert from 'node:assert/strict';
import {actionSchema,normalizeReferences,finalActionExamples,MODEL_PROTOCOL_VERSION,READ_SOURCE_EXAMPLE} from '../agent/lib/consultation-wire.ts';
const source={kind:'source',id:'fresh-source',version:'a'.repeat(64),quote:'Новый замер нужен.'};
const decision={kind:'decision',id:'fresh-decision',version:'b'.repeat(64)};
const answer=references=>({protocolVersion:2,action:'answer',text:'Ответ.',references});
test('Wire v2 has one strict typed citation list; normalization is exact, not inferred',()=>{
 assert.equal(MODEL_PROTOCOL_VERSION,2);
 for(const refs of [[source],[decision],[source,decision],[]]){
  const parsed=actionSchema.parse(answer(refs)),normalized=normalizeReferences(parsed.references);
  assert.deepEqual(normalized.sources,refs.filter(x=>x.kind==='source').map(x=>({sourceId:x.id,version:x.version,quote:x.quote})));
  assert.deepEqual(normalized.decisions,refs.filter(x=>x.kind==='decision').map(x=>({decisionId:x.id,version:x.version})));
 }
});
test('Malformed nesting, missing/old versions, unknown kind and ambiguous legacy shapes fail closed',()=>{
 const invalid=[{...answer([source]),protocolVersion:1},{action:'answer',text:'x',references:[source]},answer([{sourceId:source.id,quote:source.quote}]),answer([{decisionReferences:[{decisionId:decision.id,version:decision.version}]}]),{...answer([]),decisionReferences:[{decisionId:decision.id,version:decision.version}]},answer([{...source,kind:'document'}]),answer([{...decision,quote:'fake quote'}]),answer([{...source,version:undefined}]),answer([{...source,sourceId:source.id}]),answer(Array(9).fill(source))];
 for(const value of invalid)assert.throws(()=>actionSchema.parse(value));
 assert.throws(()=>actionSchema.parse(JSON.parse('```json\n'+JSON.stringify(answer([source]))+'\n```')));
});
test('Role-specific full JSON examples themselves match exact schema and no sibling arrays',()=>{
 for(const role of ['analyst','coordinator','reviewer']){
  const examples=finalActionExamples(role).split('\n').map(s=>actionSchema.parse(JSON.parse(s)));
  assert.equal(examples.length,2);
  for(const a of examples){assert.equal(a.protocolVersion,2);assert.equal(a.action,role==='reviewer'?'review':'answer');assert.equal('decisionReferences'in a,false);assert.equal(a.references.length,1);}
  assert.equal(examples[0].references[0].kind,'source');assert.equal(examples[1].references[0].kind,'decision');
 }
});
test('Read-source is also explicitly versioned; its schema cannot smuggle new tools or references',()=>{
 assert.equal(actionSchema.parse(JSON.parse(READ_SOURCE_EXAMPLE)).action,'read_source');
 const read={protocolVersion:2,action:'read_source',sourceId:source.id,version:source.version};assert.equal(actionSchema.parse(read).limit,1600);
 assert.throws(()=>actionSchema.parse({...read,protocolVersion:undefined}));assert.throws(()=>actionSchema.parse({...read,references:[]}));assert.throws(()=>actionSchema.parse({...read,action:'accept'}));
});
