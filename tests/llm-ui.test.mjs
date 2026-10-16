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
  const previous=Object.fromEntries(['window','document','fetch','setInterval'].map(k=>[k,globalThis[k]])),timers=[],writes=[],connectionWrites=[];let cookie='',loseConnectionResponse=true;
  Object.assign(globalThis,{window:w,document:d,setInterval(fn,ms){const timer=previous.setInterval(fn,ms);timer.unref();timers.push(timer);return timer;},async fetch(url,options={}){
    const headers=new Headers(options.headers);if(cookie)headers.set('cookie',cookie);if(options.method==='POST')headers.set('origin',origin);
    if(options.method==='POST'&&new URL(url).pathname.endsWith('/llm-settings'))writes.push(JSON.parse(options.body));
    const isConnection=options.method==='POST'&&new URL(url).pathname.endsWith('/llm-connection');if(isConnection)connectionWrites.push(JSON.parse(options.body));
    const response=await handleDashboardRequest(new Request(url,{...options,headers}),{assistantAvailable:config.assistantAvailable(),assistantMode:'roles'});
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    if(isConnection&&response.ok&&loseConnectionResponse){loseConnectionResponse=false;throw new Error('Lost response');}return response;
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
    click('#llm-settings');await wait(()=>$('#llm-editor')&&!$('#logout').disabled);
    $('#llm-editor').elements.namedItem('coordinator-model').value='large';
    click('#add-connection');form=$('#connection-editor');assert.equal(form.elements.apiKey.type,'password');assert.equal(form.elements.apiKey.value,'');
    form.elements.label.value='Новый рабочий ключ';form.elements.provider.value='vsegpt';form.elements.apiKey.value='ui-test-private-key';form.elements.models.value='ui-model';
    submit('#connection-editor');await wait(()=>$('#connection-message')?.textContent.includes('связь прервалась')&&!$('#logout').disabled);
    assert.equal(config.loadConnections().length,3);submit('#connection-editor');await wait(()=>!$('#connection-editor')&&!$('#logout').disabled);
    assert.equal(connectionWrites[0].requestId,connectionWrites[1].requestId);assert.equal(config.loadConnections().length,3);
    assert.equal($('#llm-editor').elements.namedItem('coordinator-model').value,'large','Не потеряна несохранённая настройка роли');
    assert.ok(!d.body.innerHTML.includes('ui-test-private-key'));assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
    const created=config.loadConnections().find(c=>c.label==='Новый рабочий ключ');selectRole('analyst',created.id,'ui-model');submit('#llm-editor');await wait(()=>!$('#editor-dialog').open&&!$('#logout').disabled);
    click('#llm-settings');await wait(()=>$('#llm-editor')&&!$('#logout').disabled);click('[data-edit-connection]');form=$('#connection-editor');assert.equal(form.elements.apiKey.value,'');assert.equal(form.elements.provider.disabled,true);
    form.elements.label.value='Переименован';submit('#connection-editor');await wait(()=>!$('#connection-editor')&&!$('#logout').disabled);
    assert.equal(config.credential(config.loadConnections().find(c=>c.id===created.id)),'ui-test-private-key');
    click('[data-edit-connection]');$('#connection-editor').elements.apiKey.value='not-saved-key';click('#cancel-connection');assert.equal($('#connection-editor'),null);assert.ok(!d.body.innerHTML.includes('not-saved-key'));click('#close-editor');
    click('#logout');await wait(()=>!$('#login-panel').hidden&&!$('#logout').disabled);await login('a');assert.equal($('#llm-settings').hidden,true);assert.equal($('#llm-editor'),null);assert.deepEqual(errors,[]);
  }finally{timers.forEach(clearInterval);Object.assign(globalThis,previous);dom.window.close();store.database().close();rmSync(dir,{recursive:true,force:true});}
});
