import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM,VirtualConsole} from 'jsdom';
import './helpers/server-runtime.mjs';
const directory=mkdtempSync(join(tmpdir(),'planner-theme-'));
process.env.ASSISTANT_DATA_DIR=directory;
process.env.ASSISTANT_SERVER_ORIGIN='https://theme.test';
const {handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts');
const {database}=await import('../agent/lib/store.ts');
const css=readFileSync(new URL('../dist/pilot-theme.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8');
after(()=>{database().close();rmSync(directory,{recursive:true,force:true});});

test('Real workspace loads the final local theme asset; CSS is served with correct safe headers',async()=>{
 const response=await handleDashboardRequest(new Request('https://theme.test/assistant/pilot-theme.css'));
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/css/);
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(await response.text(),css);
 const page=await handleDashboardRequest(new Request('https://theme.test/assistant/workspace'));
 assert.equal(page.status,200);assert.ok((await page.text()).includes('./pilot-theme.css'));
 assert.ok(html.indexOf('./pilot-theme.css')>html.indexOf('./prototype.css'));
 const legacy=readFileSync(new URL('../agent/channels/dashboard.ts',import.meta.url),'utf8');
 assert.ok(legacy.includes("'/assistant/pilot-theme.css'"));
 assert.ok(!/@import|url\(/.test(css),'Theme adds no external resources');
});

test('Theme cannot reveal hidden login/workspace/identity or closed dialogs',()=>{
 const base=readFileSync(new URL('../dist/pilot.css',import.meta.url),'utf8');
 const proto=readFileSync(new URL('../dist/prototype.css',import.meta.url),'utf8');
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html.replace('</head>',`<style>${base}\n${proto}\n${css}</style></head>`),{virtualConsole:vc});
 const {document:d}=dom.window;
 for(const id of ['login-panel','workspace','identity'])assert.equal(dom.window.getComputedStyle(d.getElementById(id)).display,'none',id);
 for(const id of ['task-dialog','editor-dialog'])assert.equal(dom.window.getComputedStyle(d.getElementById(id)).display,'none',id);
 d.querySelector('#login-panel').hidden=false;assert.notEqual(dom.window.getComputedStyle(d.querySelector('#login-panel')).display,'none');
 d.querySelector('#login-panel').hidden=true;d.querySelector('#workspace').hidden=false;
 assert.equal(dom.window.getComputedStyle(d.querySelector('#login-panel')).display,'none');
 assert.notEqual(dom.window.getComputedStyle(d.querySelector('#workspace')).display,'none');
 d.querySelector('#editor-dialog').setAttribute('open','');assert.notEqual(dom.window.getComputedStyle(d.querySelector('#editor-dialog')).display,'none');
 d.querySelector('#editor-dialog').removeAttribute('open');assert.equal(dom.window.getComputedStyle(d.querySelector('#editor-dialog')).display,'none');
 assert.deepEqual(errors,[]);dom.window.close();
});

test('Recovered inner-light surfaces retain readable text and noninteractive glow without new animation',()=>{
 const rgb=hex=>hex.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16));
 const blend=(base,hex)=>{const c=rgb(hex),a=c[3]/255;return base.map((v,i)=>v*(1-a)+c[i]*a);};
 const lum=rgb=>{const c=rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
 const ratio=(a,b)=>{const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 // Overlap both radial peaks conservatively, though their real corners differ.
 const surfaces=[blend(blend(rgb('#1b2941'),'#a36aff18'),'#55e6ff18'),blend(blend(rgb('#2b2949'),'#55e6ff14'),'#b49aff16'),rgb('#080d1b')];
 for(const fg of ['#f0f5ff','#acbad3','#c1cce0','#55e6ff','#c4adff','#ff9aab','#87efc5']) {
  assert.ok(css.includes(fg),fg+' remains in loaded theme');
  for(const bg of surfaces)assert.ok(ratio(rgb(fg),bg)>=4.5,fg+' contrasts with brightest modeled surface');
 }
 assert.match(css,/pointer-events\s*:\s*none/);assert.match(css,/isolation\s*:\s*isolate/);
 assert.ok(!css.includes('@keyframes'),'No demo pulse animation wired to real tasks');
 assert.match(css,/prefers-reduced-motion/);assert.match(readFileSync(new URL('../dist/prototype.css',import.meta.url),'utf8'),/\.quiet-motion \.has-signal\{animation:none\}/);assert.match(css,/:focus-visible/);
 assert.match(css,/@media\s*print/);assert.match(css,/forced-colors/);assert.match(css,/@media\s*\(max-width:\s*700px\)/);
 assert.match(css,/#board \.overdue\{[^}]*text-decoration:underline/);
 assert.match(css,/#board\.kanban-archive\{grid-template-columns:1fr\}/);
});

test('Actual workspace presents Pulse team copy without legacy branding and preserves access/demo guidance',async()=>{
 const response=await handleDashboardRequest(new Request('https://theme.test/assistant/workspace'));
 assert.equal(response.status,200);
 const page=await response.text();
 assert.equal(page,html);
 assert.doesNotMatch(page,/Lazy Work Planer|Личный ассистент|Меньше держать/i);
 const dom=new JSDOM(page);const d=dom.window.document;
 assert.equal(d.title,'Пульс · Поручения команды');
 assert.match(d.querySelector('.brand').textContent,/Пульс/);
 assert.equal(d.querySelector('.brand-mark').getAttribute('aria-hidden'),'true');
 assert.equal(d.querySelector('#login-title').textContent,'Поручения, сроки, результат.');
 assert.equal(d.querySelector('#page-title').textContent,'Поручения команды');
 assert.equal(d.querySelector('#login-panel > p').textContent,'Войдите, чтобы работать с поручениями, сообщать о ходе выполнения и фиксировать результаты.');
 assert.equal(d.querySelector('#login-panel').getAttribute('aria-labelledby'),'login-title');
 assert.equal(d.querySelector('label[for="login-code"]').textContent,'Персональный код входа');
 assert.equal(d.querySelector('#login-code').type,'password');
 assert.match(d.querySelector('#login-panel .hint').textContent,/Одноразовый код.*30 минут.*8 часов/);
 assert.match(d.querySelector('#example-banner').textContent,/вымышленные примеры/);
 for(const id of ['login-panel','workspace','identity'])assert.equal(d.getElementById(id).hidden,true);
 assert.equal(d.querySelector('#reports').hidden,true);
 dom.window.close();
});
