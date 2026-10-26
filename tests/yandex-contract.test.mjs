import test from 'node:test';
import assert from 'node:assert/strict';
import { createYandexContract, YANDEX_CHAT_ENDPOINT, YandexContractError } from '../agent/lib/yandex-contract.ts';
const config = { maxContextTokens: 65536, apiKey: 'fictional-test-key', model: 'gpt://fictional-pilot-folder/fixture-model', expectedResponseModel: 'gpt://fixture-model/latest' };
const input = { system: 'Trusted instructions', prompt: 'Synthetic task only' };
const envelope = () => ({ model: config.expectedResponseModel, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"action":"answer"}' } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const unknown = e => e instanceof YandexContractError && e.outcome === 'unknown' && !String(e).includes(config.apiKey);

test('explicit injected transport only; no global fetch or old folder/config fallback', async () => {
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw Error('Network forbidden'); };
  try {
    for (const extra of [{}, { fetchImpl: null }, { fetchImpl: async () => {}, model: 'fixture-model' }, { fetchImpl: async () => {}, apiKey: 'bad\nheader' }, { fetchImpl: async () => {}, expectedResponseModel: '' }]) {
      assert.throws(() => createYandexContract({ ...config, ...extra }), e => e.outcome === 'not_started');
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = saved; }
});
test('fixed endpoint, JSON-only bounded request, privacy headers and exact usage', async () => {
  let calls = 0;
  const run = createYandexContract({ ...config, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, YANDEX_CHAT_ENDPOINT); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Api-Key '+config.apiKey); assert.equal(init.headers['x-data-logging-enabled'], 'false');
    const body = JSON.parse(init.body); assert.equal(body.model, config.model); assert.equal(body.max_completion_tokens, 800);
    assert.equal(body.store, false); assert.equal(body.stream, false); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined); assert.equal(body.messages[1].content, input.prompt);
    return response(envelope());
  } });
  assert.deepEqual(await run(input), { text: '{"action":"answer"}', inputTokens: 20, outputTokens: 10 }); assert.equal(calls, 1);
});
test('model, finish, tools, refusals and malformed usage fail closed without retries', async () => {
  for (const mutate of [
    b=>b.model='gpt://wrong/latest', b=>b.choices[0].finish_reason='length', b=>b.choices.push(b.choices[0]),
    b=>b.choices[0].message.tool_calls=[], b=>b.choices[0].message.function_call={}, b=>b.choices[0].message.refusal='no',
    b=>delete b.usage, b=>b.usage.total_tokens=31, b=>b.usage.prompt_tokens=-1, b=>b.usage.completion_tokens=801,
    b=>b.usage.total_tokens='30', b=>b.usage.completion_tokens_details={reasoning_tokens:11}, b=>b.choices[0].message.content=''
  ]) {
    let calls=0;const body=envelope();mutate(body);
    await assert.rejects(createYandexContract({...config,fetchImpl:async()=>{calls++;return response(body);}})(input),unknown);
    assert.equal(calls,1);
  }
});
test('network, redirect status, malformed JSON and excessive body are unknown, never replayed', async () => {
  for (const fake of [async()=>{throw Error(config.apiKey);}, async()=>new Response('',{status:302,headers:{location:'https://other.test'}}), async()=>new Response('{'), async()=>new Response('x'.repeat(32769)), async()=>new Response('{}',{headers:{'content-length':'32769'}})]) {
    let calls=0;await assert.rejects(createYandexContract({...config,fetchImpl:async(...a)=>{calls++;return fake(...a);}})(input),unknown);assert.equal(calls,1);
  }
});
test('timeout and cancellation are bounded even when fake transport ignores signal', async () => {
  let calls=0;const run=createYandexContract({...config,timeoutMs:5,fetchImpl:async()=>{calls++;return new Promise(()=>{});}});
  await assert.rejects(run(input),unknown);assert.equal(calls,1);
  const abort=new AbortController();abort.abort();await assert.rejects(run({...input,signal:abort.signal}),e=>e.outcome==='not_started');assert.equal(calls,1);
  const active=new AbortController();const result=run({...input,signal:active.signal});active.abort();await assert.rejects(result,unknown);assert.equal(calls,2);
});
test('timeout also bounds a stalled response stream; input bounds never dispatch', async () => {
  let calls=0;const run=createYandexContract({...config,timeoutMs:5,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(){}}));}});
  await assert.rejects(run(input),unknown);assert.equal(calls,1);
  await assert.rejects(run({...input,prompt:'x'.repeat(48001)}),e=>e.outcome==='not_started');assert.equal(calls,1);
});
test('strict UTF-8 and bounded envelope reject before returning unverified content', async () => {
  let calls=0;
  const run=createYandexContract({...config,fetchImpl:async()=>{calls++;return new Response(new Uint8Array([0xff,0xfe]));}});
  await assert.rejects(run(input),unknown);assert.equal(calls,1);
  const raw='```json\n{"action":"answer"}\n```',body=envelope();body.choices[0].message.content=raw;
  assert.equal((await createYandexContract({...config,fetchImpl:async()=>response(body)})(input)).text,raw,'Host parser must see original content; no transport repair');
});
test('rejected output retains validated usage without claiming success or refund', async () => {
  const body=envelope();body.choices[0].finish_reason='length';
  await assert.rejects(createYandexContract({...config,fetchImpl:async()=>response(body)})(input),e=>{
    assert.equal(e.outcome,'unknown');assert.deepEqual(e.observedUsage,{inputTokens:20,outputTokens:10});assert.ok(Object.isFrozen(e.observedUsage));return true;
  });
  body.usage.total_tokens=99;
  await assert.rejects(createYandexContract({...config,fetchImpl:async()=>response(body)})(input),e=>e.outcome==='unknown'&&e.observedUsage===undefined);
});
test('malformed UTF-8 in an open body cancels its reader and aborts dispatched request', async () => {
  let calls=0,cancelled=false,dispatchedSignal;
  const run=createYandexContract({...config,fetchImpl:async(_url,init)=>{
    calls++;dispatchedSignal=init.signal;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([255]));},cancel(){cancelled=true;}}));
  }});
  await assert.rejects(run(input),unknown);
  assert.equal(calls,1);assert.equal(cancelled,true);assert.equal(dispatchedSignal.aborted,true);
});
test('explicit Flash/DeepSeek context bounds include input plus completion, independent of text estimate', async () => {
  for (const maxContextTokens of [65536,1048576]) {
    let calls=0;const body=envelope();
    body.usage={prompt_tokens:maxContextTokens-10,completion_tokens:10,total_tokens:maxContextTokens};
    const run=createYandexContract({...config,maxContextTokens,fetchImpl:async()=>{calls++;return response(body);}});
    assert.deepEqual(await run(input),{text:body.choices[0].message.content,inputTokens:maxContextTokens-10,outputTokens:10});
    // Prompt alone is in range, but total exceeds this model's exact context.
    body.usage={prompt_tokens:maxContextTokens,completion_tokens:10,total_tokens:maxContextTokens+10};
    await assert.rejects(run(input),e=>unknown(e)&&e.observedUsage===undefined);
    body.usage={prompt_tokens:maxContextTokens+1,completion_tokens:10,total_tokens:maxContextTokens+11};
    await assert.rejects(run(input),e=>unknown(e)&&e.observedUsage===undefined);
    assert.equal(calls,3);
  }
  const body=envelope();body.usage={prompt_tokens:1048566,completion_tokens:10,total_tokens:1048576};body.choices[0].finish_reason='length';
  await assert.rejects(createYandexContract({...config,maxContextTokens:1048576,fetchImpl:async()=>response(body)})(input),e=>{
    assert.equal(e.outcome,'unknown');assert.deepEqual(e.observedUsage,{inputTokens:1048566,outputTokens:10});return true;
  });
});
test('model bounds must be explicit; broker timeout is accepted up to 45 seconds only', async () => {
  let calls=0;const fetchImpl=async()=>{calls++;return response(envelope());};
  for (const maxContextTokens of [undefined,null,65535,1048577,65536.5,'1048576',Infinity]) {
    assert.throws(()=>createYandexContract({...config,maxContextTokens,fetchImpl}),e=>e.outcome==='not_started');
  }
  for (const timeoutMs of [0,45001,45000.5,Infinity]) {
    assert.throws(()=>createYandexContract({...config,timeoutMs,fetchImpl}),e=>e.outcome==='not_started');
  }
  assert.equal(calls,0);
  await createYandexContract({...config,timeoutMs:45000,fetchImpl})(input);assert.equal(calls,1);
});
test('configured 45-second deadline aborts once at the boundary without a retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,signal;
  const run=createYandexContract({...config,timeoutMs:45000,fetchImpl:async(_url,init)=>{calls++;signal=init.signal;return new Promise(()=>{});}});
  const pending=run(input),rejected=assert.rejects(pending,unknown);
  t.mock.timers.tick(44999);assert.equal(signal.aborted,false);assert.equal(calls,1);
  t.mock.timers.tick(1);await rejected;assert.equal(signal.aborted,true);assert.equal(calls,1);
});
