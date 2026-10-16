import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient, ProviderError } from '../agent/lib/llm-provider.ts';

const key='test-only-dummy-key';
const connection=provider=>({id:provider,label:provider,provider,credentialEnv:'ASSISTANT_LLM_KEY_TEST',models:['test-model'],maxOutputTokens:1024});
const input=provider=>({connection:connection(provider),key,model:'test-model',system:'Правила',prompt:'Вопрос'});
const chat=text=>({choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:15,completion_tokens:7}});

test('Пять провайдеров: правильные endpoint, ключ, модель, формат и usage; без Gateway',async()=>{
  for(const provider of ['openai','vsegpt','anthropic','gigachat','openrouter']){
    const requests=[];
    const complete=createModelClient(async(url,options)=>{
      requests.push({url,...options});
      assert.equal(options.redirect,'error');assert.ok(options.signal);
      if(url.includes('/oauth'))return Response.json({access_token:'test-access-token',expires_at:Date.now()+1800000});
      return Response.json(provider==='openai'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'готово'}]}],usage:{input_tokens:15,output_tokens:7}}:provider==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text:'готово'}],usage:{input_tokens:15,output_tokens:7}}:chat('готово'));
    });
    const result=await complete(input(provider));assert.deepEqual(result,{text:'готово',inputTokens:15,outputTokens:7});
    const request=requests.at(-1),body=JSON.parse(request.body);
    const hosts={openai:'api.openai.com',vsegpt:'api.vsegpt.ru',anthropic:'api.anthropic.com',gigachat:'api.giga.chat',openrouter:'openrouter.ai'};
    assert.equal(new URL(request.url).host,hosts[provider]);assert.equal(body.model,'test-model');assert.ok(!request.body.includes(key));
    if(provider==='openai'){assert.equal(body.instructions,'Правила');assert.equal(body.store,false);assert.equal(body.max_output_tokens,1024);assert.ok(request.url.endsWith('/responses'));}
    else {assert.equal(body.max_tokens,1024);assert.equal(body.messages.at(-1).content,'Вопрос');}
    if(provider==='anthropic'){assert.equal(request.headers['x-api-key'],key);assert.equal(request.headers['anthropic-version'],'2023-06-01');assert.equal(request.headers.authorization,undefined);assert.equal(body.system,'Правила');}
    else assert.equal(request.headers.authorization,`Bearer ${provider==='gigachat'?'test-access-token':key}`);
    if(provider==='gigachat'){
      assert.equal(requests[0].url,'https://ngw.devices.sberbank.ru:9443/api/v2/oauth');assert.equal(requests[0].headers.authorization,`Basic ${key}`);
      assert.match(requests[0].headers.RqUID,/^[a-f0-9-]{36}$/);assert.equal(requests[0].body,'scope=GIGACHAT_API_PERS');assert.equal(body.function_call,'none');
    }
    if(provider==='openrouter')assert.deepEqual(body.provider,{allow_fallbacks:false});
    assert.ok(!JSON.stringify(requests).includes('vercel'));
  }
});

test('GigaChat: OAuth кешируется отдельно для ключа и scope, учитывает ротацию и истечение',async()=>{
  const requests=[];let now=Date.now(),realNow=Date.now;
  Date.now=()=>now;
  try{
    const complete=createModelClient(async(url,options)=>{
      requests.push({url,...options});
      return Response.json(url.includes('/oauth')?{access_token:'access-'+requests.length,expires_at:Math.floor(now/1000)+1800}:chat('ok'));
    });
    await complete(input('gigachat'));await complete(input('gigachat'));
    assert.equal(requests.filter(r=>r.url.includes('/oauth')).length,1);
    await complete({...input('gigachat'),key:'rotated-dummy-key'});
    await complete({...input('gigachat'),connection:{...connection('gigachat'),scope:'GIGACHAT_API_B2B'}});
    assert.equal(requests.filter(r=>r.url.includes('/oauth')).length,3);
    now+=1800000;await complete(input('gigachat'));
    assert.equal(requests.filter(r=>r.url.includes('/oauth')).length,4);
    assert.notEqual(requests[1].headers.authorization,requests.at(-1).headers.authorization);
  }finally{Date.now=realNow;}
});

test('Ошибки, лимиты, перенаправление и обрезанные ответы не запускают fallback и не раскрывают тело',async()=>{
  for(const status of [401,403,429,500,302]){
    let calls=0;
    const complete=createModelClient(async()=>{calls++;return new Response('private prompt '+key,{status});});
    await assert.rejects(complete(input('vsegpt')),e=>e instanceof ProviderError&&!e.message.includes(key)&&!e.message.includes('private prompt'));
    assert.equal(calls,1);
  }
  for(const response of [chat('x'.repeat(270000)),{choices:[{finish_reason:'length',message:{content:'partial'}}]},{choices:[{finish_reason:'stop',message:{content:'ok',tool_calls:[{name:'send_email'}]}}]}]){
    await assert.rejects(createModelClient(async()=>Response.json(response))(input('vsegpt')),ProviderError);
  }
  await assert.rejects(createModelClient(async()=>{throw new Error(key);})(input('openai')),e=>e.code==='network'&&!e.message.includes(key));
  const controller=new AbortController();controller.abort();
  await assert.rejects(createModelClient(async(_,options)=>{options.signal.throwIfAborted();})( {...input('anthropic'),signal:controller.signal}),e=>e.code==='timeout');
  let calls=0;
  await assert.rejects(createModelClient(async()=>{calls++;})({...input('vsegpt'),model:'other-model'}),e=>e.code==='configuration');assert.equal(calls,0);
});
