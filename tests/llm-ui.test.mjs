import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM,VirtualConsole} from 'jsdom';

test('Модели и роли в интерфейсе: смена провайдера сбрасывает модель, сохранение и права сотрудника',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lazy-llm-ui-')),origin='https://llm-ui.test';
  process.env.ASSISTANT_DATA_DIR=dir;process.env.ASSISTANT_SERVER_ORIGIN=origin;process.env.ASSISTANT_LLM_CONFIG=join(dir,'llm.json');process.env.ASSISTANT_AI_ENABLED='true';
  process.env.ASSISTANT_LLM_KEY_TEST_UI='dummy-ui-key';process.env.ASSISTANT_LLM_KEY_TEST_UI_ALT='dummy-ui-alt-key';
  writeFileSync(process.env.ASSISTANT_LLM_CONFIG,JSON.stringify({connections:[
    {id:'one',label:'Рабочий VseGPT',provider:'vsegpt',credentialEnv:'ASSISTANT_LLM_KEY_TEST_UI',models:['small','large']},
    {id:'two',label:'Отдельный Claude',provider:'anthropic',credentialEnv:'ASSISTANT_LLM_KEY_TEST_UI_ALT',models:['sonnet']},
  ]}));
  const store=await import('../agent/lib/store.ts'),{issueInvite}=await import('../agent/lib/web-auth.ts'),{handleDashboardRequest}=await import('../agent/lib/dashboard-api.ts'),config=await import('../agent/lib/llm-config.ts');
  store.updateState(()=>({employees:[{id:'boss',name:'Руководитель',role:'manager'},{id:'a',name:'Сотрудник',role:'employee'}],tasks:[],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}}));
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(readFileSync(new URL('../dist/pilot.html',import.meta.url),'utf8'),{url:origin+'/assistant/workspace',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window,d=w.document;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const previous=Object.fromEntries(['window','document','fetch','setInterval'].map(k=>[k,globalThis[k]])),timers=[],writes=[];let cookie='';
  Object.assign(globalThis,{window:w,document:d,setInterval(fn,ms){const timer=previous.setInterval(fn,ms);timer.unref();timers.push(timer);return timer;},async fetch(url,options={}){
    const headers=new Headers(options.headers);if(cookie)headers.set('cookie',cookie);if(options.method==='POST')headers.set('origin',origin);
    if(options.method==='POST'&&new URL(url).pathname.endsWith('/llm-settings'))writes.push(JSON.parse(options.body));
    const response=await handleDashboardRequest(new Request(url,{...options,headers}),{assistantAvailable:config.assistantAvailable(),assistantMode:'roles'});
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;
  }});
  const $=s=>d.querySelector(s),click=s=>$(s).click(),submit=s=>$(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  async function wait(check){const until=Date.now()+3000;while(!check()){assert.ok(Date.now()<until,'UI timeout');await new Promise(r=>setTimeout(r,5));}}
  async function login(id){$('#login-code').value=issueInvite(id);submit('#login-form');await wait(()=>!$('#workspace').hidden&&!$('#logout').disabled);}
  function selectRole(role,connection,model){const form=$('#llm-editor');form.elements.namedItem(role+'-enabled').checked=true;const select=form.elements.namedItem(role+'-connection');select.value=connection;select.dispatchEvent(new w.Event('change',{bubbles:true}));form.elements.namedItem(role+'-model').value=model;}
  try{
    await import('../dist/pilot.js');await wait(()=>!$('#login-panel').hidden);await login('boss');
    assert.equal($('#llm-settings').hidden,false);click('#llm-settings');await wait(()=>$('#llm-editor')&&!$('#logout').disabled);
    assert.ok(!$('#editor-content').textContent.includes('dummy-ui'));assert.equal($('#editor-content input[type=password]'),null);
    selectRole('coordinator','one','small');selectRole('analyst','two','sonnet');submit('#llm-editor');await wait(()=>!$('#editor-dialog').open&&!$('#logout').disabled);
    assert.equal(writes[0].roles.coordinator.model,'small');assert.equal(writes[0].roles.analyst.connectionId,'two');assert.equal($('#mode-label').textContent,'ИИ: консультации по задачам');
    click('#llm-settings');await wait(()=>$('#llm-editor')&&!$('#logout').disabled);let form=$('#llm-editor');assert.equal(form.elements.namedItem('analyst-connection').value,'two');assert.equal(form.elements.namedItem('analyst-model').value,'sonnet');
    const select=form.elements.namedItem('analyst-connection');select.value='one';select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(form.elements.namedItem('analyst-model').value,'');assert.ok(!form.elements.namedItem('analyst-model').textContent.includes('sonnet'));
    form.elements.namedItem('analyst-model').value='large';submit('#llm-editor');await wait(()=>!$('#editor-dialog').open&&!$('#logout').disabled);
    const selected=config.roleSettings(store.readState().employees[0]).roles;assert.equal(selected.analyst.model,'large');assert.equal(selected.coordinator.model,'small');
    click('#logout');await wait(()=>!$('#login-panel').hidden&&!$('#logout').disabled);await login('a');assert.equal($('#llm-settings').hidden,true);assert.equal($('#llm-editor'),null);assert.deepEqual(errors,[]);
  }finally{timers.forEach(clearInterval);Object.assign(globalThis,previous);dom.window.close();store.database().close();rmSync(dir,{recursive:true,force:true});}
});
