import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installPrototype} from '../dist/prototype-ui.js';

test('history restoration does not undo native browser scroll anchoring',()=>{
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{pretendToBeVisual:true});
  const prior={window:globalThis.window,document:globalThis.document,setInterval:globalThis.setInterval};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,setInterval:()=>0});
  try{
    const $=s=>document.querySelector(s),task={id:'t',title:'Fixture',employeeId:'w',status:'active'};
    const event={key:'old',text:'Existing history',at:'2026-10-25T12:00:00Z'};
    const memory={task,title:task.title,current:task,conversation:[],sources:[],timeline:[event],facts:[],children:[],drafts:[],page:{},graph:{edges:[],nodes:[]}};
    const state={identity:{id:'m',role:'manager'},selected:'t',memory,snapshot:{tasks:[],employees:[],assistant:{available:false},preferences:{pins:[],seen:{}}}};
    const markup=e=>`<div class="history-item" data-event-key="${e.key}">${e.text}</div>`;
    const ui=installPrototype({get:()=>state,busy:()=>false,date:x=>x,note(){},sourceLink:()=>'',sourcesMarkup:()=>'',eventMarkup:markup});
    $('#task-content').innerHTML=ui.detailMarkup();
    const dialog=$('#task-dialog'),anchor=$('[data-event-key="old"]'),timeline=$('#timeline');
    dialog.scrollTop=100;dialog.getBoundingClientRect=()=>({top:0,bottom:400});
    let insertedHeight=0;
    anchor.getBoundingClientRect=()=>({top:150+insertedHeight-dialog.scrollTop,bottom:180+insertedHeight-dialog.scrollTop});
    const insert=timeline.insertAdjacentHTML.bind(timeline);
    timeline.insertAdjacentHTML=(position,html)=>{
      insert(position,html);
      if(html){insertedHeight+=50;dialog.scrollTop+=50;} // Chromium's native overflow anchoring.
    };
    const before=anchor.getBoundingClientRect().top;
    ui.appendDetail({...memory,timeline:[{...event,key:'new',text:'New history'},event]});
    assert.equal(dialog.scrollTop,150,'Do not reset the browser-adjusted scroll offset to its pre-insertion value');
    assert.equal(anchor.getBoundingClientRect().top,before);
  }finally{Object.assign(globalThis,prior);dom.window.close();}
});
