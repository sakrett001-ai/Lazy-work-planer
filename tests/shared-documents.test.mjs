import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
const root=new URL('../',import.meta.url).pathname;
async function start(dir){const child=spawn(process.execPath,['tests/helpers/document-http-server.mjs'],{cwd:root,env:{...process.env,ASSISTANT_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let text='';const info=await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]));});child.on('exit',code=>reject(new Error(`server exited ${code}`)));});return {...info,child};}
async function stop(s){s.child.kill('SIGTERM');await once(s.child,'exit');}
test('actual HTTP: five identities, immutable versions, exact review, conflicts, chat references and process restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pulse-doc-http-'));let s=await start(dir);
 try{
 const sessions={};async function call(path,actor,body,extra={}){return fetch(s.origin+'/assistant/api/'+path,{method:body?'POST':'GET',headers:{...(sessions[actor]||{}),...(body?{'content-type':'application/json',origin:s.origin}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});}
 async function ok(path,actor,body){const r=await call(path,actor,body);const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
 for(const [id,code] of Object.entries(s.codes)){const r=await call('login',id,{code});sessions[id]={cookie:r.headers.get('set-cookie').split(';')[0]};const me=await ok('session',id);sessions[id]['x-csrf-token']=me.csrf;}
 const cmd=x=>({requestId:randomUUID(),...x});const create=cmd({taskId:'synthetic-task',title:'Synthetic shared report',curatorId:'curator',coexecutorIds:['coexecutor']});const doc=await ok('documents','manager',create);const p='documents/'+doc.documentId;
 assert.equal((await ok('documents','manager',create)).duplicate,true);
 assert.equal((await call(p,'outsider')).status,404);assert.equal((await ok('documents','outsider')).documents.length,0);
 assert.equal((await call(p+'/versions','owner',cmd({expectedRevision:1,text:'spoof',actorId:'manager'}))).status,400);
 assert.equal((await call(p+'/versions','owner',cmd({expectedRevision:1,text:'csrf'}),{'x-csrf-token':''})).status,403);
 const one=cmd({expectedRevision:1,text:'First immutable draft',files:[{name:'draft.txt',base64:Buffer.from('original bytes').toString('base64')}]});const v1=await ok(p+'/versions','owner',one);assert.equal((await ok(p+'/versions','owner',one)).duplicate,true);
 assert.equal((await call(p+'/versions','owner',{...one,text:'different'})).status,409);
 assert.equal((await call(p+'/versions','coexecutor',cmd({expectedRevision:1,text:'stale'}))).status,409);
 await ok(p+'/reviews','curator',cmd({expectedRevision:2,versionId:v1.versionId,decision:'return',comment:'Add evidence'}));
 const v2=await ok(p+'/versions','coexecutor',cmd({expectedRevision:3,text:'Corrected report'}));
 assert.equal((await call(p+'/reviews','manager',cmd({expectedRevision:4,versionId:v2.versionId,decision:'accept'}))).status,409);
 await ok(p+'/reviews','curator',cmd({expectedRevision:4,versionId:v2.versionId,decision:'approve'}));
 assert.equal((await call(p+'/reviews','manager',cmd({expectedRevision:5,versionId:v1.versionId,decision:'accept'}))).status,409);
 await ok(p+'/reviews','manager',cmd({expectedRevision:5,versionId:v2.versionId,decision:'accept'}));
 const v3=await ok(p+'/versions','owner',cmd({expectedRevision:6,text:'New unaccepted revision'}));
 let ledger=await ok(p,'curator');assert.equal(ledger.latestVersionId,v3.versionId);assert.equal(ledger.acceptedVersionId,v2.versionId);assert.equal(ledger.versions[0].text,'First immutable draft');assert.equal(ledger.events.length,7);
 const blob=ledger.attachments[0];assert.equal((await call(p+'/blobs/'+blob.id,'outsider')).status,404);assert.equal(await (await call(p+'/blobs/'+blob.id,'coexecutor')).text(),'original bytes');assert.equal(readFileSync(join(dir,'document-blobs',blob.id),'utf8'),'original bytes');
 const message=cmd({taskId:'synthetic-task',text:'Review exact v2',documentReference:{documentId:doc.documentId,versionId:v2.versionId}});await ok('message','manager',message);assert.equal((await ok('message','manager',message)).duplicate,true);
 const memory=await ok('memory?taskId=synthetic-task','owner');assert.equal(memory.conversation[0].documentReference.versionId,v2.versionId);
 await stop(s);s=await start(dir);ledger=await ok(p,'owner');assert.equal(ledger.acceptedVersionId,v2.versionId);assert.equal(ledger.latestVersionId,v3.versionId);assert.equal(await(await call(p+'/blobs/'+blob.id,'owner')).text(),'original bytes');assert.equal((await ok(p+'/versions','owner',one)).duplicate,true);
 }finally{await stop(s);rmSync(dir,{recursive:true,force:true});}
});
