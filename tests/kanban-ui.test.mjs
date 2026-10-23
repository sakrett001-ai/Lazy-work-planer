import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { installPrototype } from '../dist/prototype-ui.js';

test('Канбан: счётчики по отфильтрованным задачам, закрепление внутри статуса, точный срок и безопасный текст', () => {
  const dom = new JSDOM(readFileSync(new URL('../dist/pilot.html', import.meta.url), 'utf8'), {url:'https://kanban.test/assistant/workspace'});
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const original = {window:globalThis.window,document:globalThis.document,setInterval:globalThis.setInterval};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,setInterval:()=>0});
  const state={identity:{id:'manager',role:'manager'},filter:'open',snapshot:{employees:[{id:'manager',name:'Руководитель'}],preferences:{pins:['second'],seen:{}},assistant:{available:false},brief:{text:'Тестовая сводка'},tasks:[]}};
  const task=(id,status,extra={})=>({id,title:id,employeeId:'manager',status,version:id,contact:'not_requested',due:'2026-10-26',dueTime:'16:30',...extra});
  state.snapshot.tasks=[task('first','active'),task('second','active',{title:'<img src=x onerror=bad()>',protocol:{number:'П-10',point:'2',date:'2026-10-23'}}),task('third','planned',{due:null}),task('fourth','blocked'),task('fifth','review')];
  let proto;
  const ctx={get:()=>state,busy:()=>false,note(){},date:value=>value,renderBoard(){dom.window.document.querySelector('#board').innerHTML=proto.renderBoard(state.snapshot.tasks);}};
  try {
    proto=installPrototype(ctx);ctx.renderBoard();
    const d=dom.window.document;
    assert.equal(d.querySelectorAll('.kanban-column').length,4);
    assert.deepEqual([...d.querySelectorAll('[data-column="active"] [data-card-id]')].map(el=>el.dataset.cardId),['second','first']);
    assert.equal(d.querySelector('[data-column="active"] .kanban-count').textContent,'2');
    assert.equal(d.querySelectorAll('[data-card-id="second"]').length,1,'Закреплённое поручение не дублируется');
    assert.equal(d.querySelector('#board img'),null);
    assert.match(d.querySelector('[data-card-id="second"]').textContent,/Протокол П-10 · п. 2/);
    assert.equal(d.querySelector('[data-card-id="second"] time').dateTime,'2026-10-26T16:30:00+03:00');
    assert.match(d.querySelector('[data-card-id="third"] .card-deadline').textContent,/Срок не задан/);
    d.querySelector('#board').innerHTML=proto.renderBoard([state.snapshot.tasks[3]]);
    assert.equal(d.querySelectorAll('[data-card-id]').length,1);
    assert.equal(d.querySelector('[data-column="blocked"] .kanban-count').textContent,'1');
    assert.equal(d.querySelectorAll('.column-empty').length,3);
    state.filter='done';d.querySelector('#board').innerHTML=proto.renderBoard([task('archived','done')]);
    assert.equal(d.querySelectorAll('.kanban-column').length,1);
    assert.ok(d.querySelector('[data-column="done"] [data-card-id="archived"]'));
    assert.equal(d.querySelectorAll('[draggable="true"]').length,0,'Нет незащищённого drag-and-drop изменения состояния');
    d.querySelector('#board').innerHTML=proto.renderBoard([]);assert.ok(d.querySelector('#board .empty'));
    const before=structuredClone(state.snapshot.tasks);
    d.querySelector('#new-task').click();d.querySelector('#task-editor input[name="title"]').value='Отменённое поручение';
    d.querySelector('#close-editor').click();assert.equal(d.querySelector('#editor-dialog').open,false);
    d.querySelector('#new-task').click();assert.equal(d.querySelector('#task-editor input[name="title"]').value,'');
    d.querySelector('#close-editor').click();assert.deepEqual(state.snapshot.tasks,before,'Закрытие формы ничего не сохраняет');
  } finally {Object.assign(globalThis,original);dom.window.close();}
});
