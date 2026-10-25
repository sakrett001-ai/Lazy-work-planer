// Real Chromium layout, isolated synthetic fixture; no accounts, models or delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const fixture=`
import {installPrototype} from '/prototype-ui.js';
const $=s=>document.querySelector(s);
const task={id:'T',title:'Synthetic scroll check',employeeId:'w',status:'active'};
const source=i=>({id:'s'+i,authorName:'Fixture',text:'Source '+i+' long text '.repeat(12),occurredAt:'2026-10-25T12:00:00Z'});
const event=i=>({key:'e'+i,text:'History '+i+' context '.repeat(15),at:'2026-10-25T12:00:00Z'});
const memory={task,title:task.title,current:task,taskVersion:'baseline',conversation:Array.from({length:30},(_,i)=>source(i)),sources:[],timeline:Array.from({length:30},(_,i)=>event(i)),facts:[],children:[],drafts:[],page:{},graph:{edges:[],nodes:[]}};
const state={identity:{id:'m',role:'manager'},selected:'T',memory,snapshot:{tasks:[],employees:[],assistant:{available:false},preferences:{pins:[],seen:{}}}};
const ctx={get:()=>state,busy:()=>false,date:x=>x,note:(s,t)=>{if($(s))$(s).textContent=t;},sourceLink:()=>'',sourcesMarkup:()=>'',eventMarkup:e=>'<div class="history-item" data-event-key="'+e.key+'"><p>'+e.text+'</p></div>',api:async()=>({jobs:[]}),detailContext:()=>1};
const ui=installPrototype(ctx);$('#task-content').innerHTML=ui.detailMarkup();$('#task-dialog').showModal();
const box=$('.conversation'),dialog=$('#task-dialog'),input=$('#manager-message'),checks={};
box.scrollTop=box.scrollHeight;$('#close-dialog').focus();ui.appendDetail({...memory,conversation:[...memory.conversation,source(30)]});checks.tail=box.scrollHeight-box.clientHeight-box.scrollTop<2;
input.value='Draft remains';input.focus();input.setSelectionRange(2,7);box.scrollTop=100;const top=box.scrollTop;ui.appendDetail({...memory,conversation:[...memory.conversation,source(30),source(31)]});checks.reading=box.scrollTop===top;checks.draft=input===$('#manager-message')&&input.value==='Draft remains'&&input.selectionStart===2&&input.selectionEnd===7;
const details=$('#timeline').closest('details');details.open=true;const anchor=$('[data-event-key="e15"]');dialog.scrollTop+=anchor.getBoundingClientRect().top-dialog.getBoundingClientRect().top-60;const before=anchor.getBoundingClientRect().top;ui.appendDetail({...memory,timeline:[event(99),...memory.timeline]});checks.history=Math.abs(anchor.getBoundingClientRect().top-before)<2;
const out=document.createElement('pre');out.id='test-result';out.textContent=JSON.stringify(checks);document.body.append(out);
`;
test('selected thread keeps real conversation tail, draft selection and history scroll anchor', {skip:!existsSync('/usr/bin/chromium')},async()=>{
  const profile=mkdtempSync(join(tmpdir(),'thread-chromium-'));
  const server=createServer((req,res)=>{try{
    const name=basename(new URL(req.url,'http://local').pathname);
    const body=name==='fixture.js'?fixture:name===''?readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8').replace('./pilot.js','/fixture.js'):readFileSync(new URL('../dist/'+name,import.meta.url));
    res.setHeader('content-type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);
  }catch{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const {stdout}=await promisify(execFile)('/usr/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+profile,'--dump-dom','--virtual-time-budget=2000','http://127.0.0.1:'+server.address().port+'/'],{timeout:15000,maxBuffer:2e6});
    const result=stdout.match(/<pre id="test-result">(.*?)<\/pre>/)?.[1];assert.ok(result,'Browser fixture completed');assert.deepEqual(JSON.parse(result),{tail:true,reading:true,draft:true,history:true});
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});}
});
