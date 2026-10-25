import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {installPrototype} from '../dist/prototype-ui.js';

test('Delegation/report UI: explicit child assignment, immutable safe report, same-ID retry and role reset',async()=>{
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{url:'https://delegation.test/assistant/workspace',virtualConsole:vc,pretendToBeVisual:true});
  const w=dom.window,d=w.document;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const old={window:globalThis.window,document:globalThis.document,setInterval:globalThis.setInterval};const timers=[];
  Object.assign(globalThis,{window:w,document:d,setInterval(fn,ms){timers.push({fn,ms});return 0;}});
  const root={id:'P1',title:'Родитель <img src=x>',employeeId:'a',status:'active',due:'2026-10-20',dueTime:'16:30',version:'root-v1'};
  const child={id:'C1',parentId:'P1',title:'Собрать факты',employeeId:'b',status:'blocked',due:'2026-10-22',dueTime:'12:00',version:'child-v1',blocker:'Нет исходных данных'};
  const memory={task:root,title:root.title,taskVersion:root.version,current:{...root},children:[child],conversation:[],facts:[],drafts:[],timeline:[],page:{},graph:{edges:[],nodes:[]}};
  const state={identity:{id:'boss',role:'manager'},selected:'P1',memory,filter:'open',snapshot:{tasks:[root,child],employees:[{id:'boss',name:'Руководитель'},{id:'a',name:'Ответственный'},{id:'b',name:'Исполнитель'}],preferences:{pins:[],seen:{}},assistant:{available:false},brief:{text:'Сводка'}}};
  let polls=0;
  let busy=false,lose=true,proto,freshMemory=memory,deferredList=null;const writes=[];
  const snapshot={id:'R1',createdAt:'2026-10-24T12:00:00Z',text:'Отчёт на 24 октября\n<img src=x onerror=bad()>\nПросрочено. Нет исходных данных.'};
  const ctx={pollDetail:async()=>{polls++;},get:()=>state,busy:()=>busy,setBusy:v=>{busy=v;},date:v=>v,note:(selector,text)=>{d.querySelector(selector).textContent=text;},sourceLink:()=>'',sourcesMarkup:()=>'',eventMarkup:()=>'',refresh:async()=>{},openTask:async()=>{},renderBoard(){d.querySelector('#board').innerHTML=proto.renderBoard(state.snapshot.tasks);},api:async(path,body)=>{
    if(path==='reports')return deferredList||{reports:[]};
    if(path==='reports?id=R1')return {report:snapshot};
    if(path.startsWith('memory?'))return structuredClone(freshMemory);
    if(body)writes.push({path,...structuredClone(body)});
    if(path==='report-create'){if(lose){lose=false;throw Error('Ответ потерян. Повторите запрос.');}return{report:snapshot,duplicate:true};}
    return{taskId:'C2'};
  }};
  const $=s=>d.querySelector(s),click=s=>$(s).click(),submit=s=>$(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  async function wait(check){for(let n=0;n<100&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check());}
  try{
    proto=installPrototype(ctx);ctx.renderBoard();$('#task-content').innerHTML=proto.detailMarkup();$('#task-dialog').open=true;
    assert.equal($('#reports').hidden,false);assert.ok($('.delegation').textContent.includes('Первоначальный срок не зафиксирован'));assert.equal($('.delegation img'),null);
    assert.match($('.delegation').textContent,/Нет исходных данных/);
    click('[data-new-child]');const form=$('#task-editor');form.elements.title.value='Дочернее поручение';form.elements.employeeId.value='b';form.elements.due.value='2026-10-25';
    submit('#task-editor');await wait(()=>!busy);
    assert.equal(writes[0].path,'task-create');assert.equal(writes[0].parentId,'P1');assert.equal(writes[0].expectedParentVersion,'root-v1');assert.equal(writes[0].fields.employeeId,'b');assert.equal(writes[0].fields.due,'2026-10-25');
    freshMemory={...memory,children:[{...child,version:'child-v2'}]};
    await timers.find(t=>t.ms===15000).fn();assert.equal(polls,1,'Detail timer delegates to the guarded entrypoint poll');
    $('#task-dialog').close();click('#reports');await wait(()=>$('#snapshot-report-form')&&!busy);
    assert.equal($('#snapshot-report-form img'),null);assert.equal($('#include-report-children').checked,true);assert.equal($('#snapshot-report-form input[name=taskIds]:checked'),null,'Nothing selected before user choice');
    submit('#snapshot-report-form');assert.match($('#editor-message').textContent,/Выбери от 1/);
    $('#snapshot-report-form input[value=P1]').checked=true;$('#snapshot-report-form input[value=P1]').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal($('#snapshot-report-form input[value=C1]').checked,true,'Selecting parent visibly includes its child');
    $('#snapshot-report-form input[value=C1]').checked=false;submit('#snapshot-report-form');await wait(()=>!busy&&$('#editor-message').textContent.includes('потерян'));
    submit('#snapshot-report-form');await wait(()=>$('#snapshot-report-text')&&!busy);
    const requests=writes.filter(r=>r.path==='report-create');assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);assert.deepEqual(requests[1].selection,[{taskId:'P1',expectedVersion:'root-v1'}]);
    assert.equal($('#snapshot-report-text').textContent,snapshot.text);assert.equal($('#snapshot-report-text img'),null);
    root.title='Новый заголовок';assert.equal($('#snapshot-report-text').textContent,snapshot.text,'Snapshot text does not follow live card changes');
    click('#close-editor');click('#new-task');assert.ok(!$('#editor-content').textContent.includes('Часть поручения'));
    click('#close-editor');state.identity={id:'a',role:'employee'};proto.reset();ctx.renderBoard();assert.equal($('#reports').hidden,true);assert.ok(!proto.detailMarkup().includes('data-new-child'));assert.ok(!proto.detailMarkup().includes('Нет исходных данных'));
    state.identity={id:'boss',role:'manager'};ctx.renderBoard();let release;deferredList=new Promise(resolve=>{release=resolve;});
    click('#reports');await new Promise(r=>setImmediate(r));$('#editor-dialog').close();state.identity={id:'a',role:'employee'};proto.reset();ctx.renderBoard();release({reports:[{id:'private-report',createdAt:'2026-10-24',taskCount:1}]});await wait(()=>!busy);
    assert.equal($('#editor-dialog').open,false);assert.equal($('#editor-content').textContent,'','Late report response cannot repopulate a closed or different-user dialog');
    assert.deepEqual(errors,[]);
  }finally{Object.assign(globalThis,old);dom.window.close();}
});
