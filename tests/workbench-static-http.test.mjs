import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
test('actual HTTP: explicit workbench assets retain strict CSP, no static private files or anonymous data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pulse-workbench-http-'));const child=spawn(process.execPath,['tests/helpers/document-http-server.mjs'],{cwd:new URL('../',import.meta.url).pathname,env:{...process.env,ASSISTANT_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 try{let text='';const {origin}=await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]));});child.on('exit',code=>reject(Error('server exit '+code)));});
 const response=await fetch(origin+'/assistant/workbench');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);const csp=response.headers.get('content-security-policy');assert.match(csp,/script-src 'self'/);assert.ok(!csp.includes('unsafe-inline'));assert.ok(!csp.includes('unsafe-eval'));assert.equal(response.headers.get('cache-control'),'no-store');
 const html=await response.text(),dom=new JSDOM(html),doc=dom.window.document;assert.equal(doc.querySelectorAll('base').length,0,'Server shell must not redirect relative paths to demo origin');assert.equal(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length,0,'Only server response owns CSP');assert.ok(doc.querySelector('script[src="/assistant/workbench.js"]'));assert.ok(doc.querySelector('link[href="/assistant/workbench.css"]'));assert.equal(doc.querySelectorAll('script:not([src]),style').length,0,'No inline executable/style blocks under strict CSP');for(const el of doc.querySelectorAll('*'))for(const attr of el.attributes)assert.ok(!/^on/i.test(attr.name),'No inline event handlers');
 for(const [file,type] of [['workbench.js','javascript'],['workbench.css','css']]){const r=await fetch(origin+'/assistant/'+file);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),new RegExp(type));assert.equal(r.headers.get('x-content-type-options'),'nosniff');}
 for(const path of ['/assistant/api/documents','/assistant/api/tasks'])assert.equal((await fetch(origin+path)).status,401);
 for(const path of ['/assistant/document-blobs/unknown','/assistant/assistant.sqlite','/.data/assistant.sqlite','/assistant/workbench-demo.html'])assert.equal((await fetch(origin+path)).status,404);
 }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
