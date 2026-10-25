import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import './helpers/server-runtime.mjs';
const directory=mkdtempSync(join(tmpdir(),'pulse-mark-'));
process.env.ASSISTANT_DATA_DIR=directory;
process.env.ASSISTANT_SERVER_ORIGIN='https://mark.test';
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const {database}=await import('../agent/lib/store.ts');
const svg=readFileSync(new URL('../dist/pulse-mark.svg',import.meta.url),'utf8');
after(()=>{database().close();rmSync(directory,{recursive:true,force:true});});

test('Ring is an isolated safe vector symbol, not the full intro composition',()=>{
 const dom=new JSDOM(svg,{contentType:'image/svg+xml'}),d=dom.window.document;
 assert.equal(d.documentElement.getAttribute('viewBox'),'533 383 224 224');
 assert.equal(d.querySelectorAll('path').length,2);
 assert.equal(d.querySelectorAll('linearGradient').length,2);
 assert.equal(d.querySelectorAll('script,image,foreignObject,use,text,rect').length,0);
 for(const element of d.querySelectorAll('*'))for(const attr of element.attributes){
  assert.ok(!/^on/i.test(attr.name));
  assert.ok(!/href/i.test(attr.name));
 }
 for(const path of d.querySelectorAll('path')) {
  const id=path.getAttribute('fill').match(/^url\(#([\w-]+)\)$/)?.[1];
  assert.ok(id&&d.getElementById(id),'Every paint reference is local');
 }
 dom.window.close();
});

test('Brand has readable text and a decorative bounded ring; favicon reuses local SVG',()=>{
 const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'));
 const d=dom.window.document,img=d.querySelector('.brand img');
 assert.equal(img.getAttribute('src'),'./pulse-mark.svg');
 assert.equal(img.getAttribute('alt'),'');assert.equal(img.getAttribute('aria-hidden'),'true');
 assert.equal(img.getAttribute('width'),'48');assert.equal(img.getAttribute('height'),'48');
 assert.match(d.querySelector('.brand').textContent,/Пульс/);
 assert.equal(d.querySelector('link[rel=icon]').getAttribute('href'),'./pulse-mark.svg');
 dom.window.close();
});

test('Only exact ring route is public with SVG MIME, safe headers and no extra file access',async()=>{
 const response=await handleDashboardRequest(new Request('https://mark.test/assistant/pulse-mark.svg'));
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/svg+xml; charset=utf-8');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(await response.text(),svg);
 for(const path of ['/assistant/pulse-mark.svg/extra','/assistant/other.svg','/assistant/pulse-lockup.svg','/assistant/%70ulse-mark.svg']){
  const denied=await handleDashboardRequest(new Request('https://mark.test'+path));
  assert.equal(denied.status,404,path);
 }
 assert.equal((await handleDashboardRequest(new Request('https://mark.test/assistant/pulse-mark.svg',{method:'POST'}))).status,404);
 const legacy=readFileSync(new URL('../agent/channels/dashboard.ts',import.meta.url),'utf8');
 assert.ok(legacy.includes("'/assistant/pulse-mark.svg'"));
});

test('B renderer modules are exact local static routes, not a directory allowlist',async()=>{
 for(const name of ['pulse-motion.js','pulse-signal.js']){
  const response=await handleDashboardRequest(new Request('https://mark.test/assistant/'+name));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/javascript; charset=utf-8');
  assert.equal(await response.text(),readFileSync(new URL('../dist/'+name,import.meta.url),'utf8'));
  assert.equal((await handleDashboardRequest(new Request('https://mark.test/assistant/'+name+'/extra'))).status,404);
  assert.equal((await handleDashboardRequest(new Request('https://mark.test/assistant/'+name,{method:'POST'}))).status,404);
 }
 assert.equal((await handleDashboardRequest(new Request('https://mark.test/assistant/pulse-motion.js.map'))).status,404);
});
