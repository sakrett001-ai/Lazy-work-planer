import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateSuite,runTaskScenarios,contractStub} from './harness.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split('=')));
const partition=args.partition||'baseline',mode=args.mode||'contract';
if(!['baseline','calibration','holdout','validation','confirmation','paired'].includes(partition)||!['contract','stdio'].includes(mode))throw Error('Invalid partition/mode');
if(['holdout','validation','confirmation','paired'].includes(partition)&&mode==='stdio'&&!args.freeze)throw Error('Heldout requires recorded frozen candidate ID via --freeze');
if(mode==='stdio'&&(!args.model||!args['response-model']))throw Error('External evaluation requires approved request and expected response model IDs');
const digest=value=>createHash('sha256').update(value).digest('hex');
const scenarioBytes=readFileSync(new URL('./scenarios/'+partition+'.json',import.meta.url));
const runtimeCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('../..',import.meta.url),encoding:'utf8'}).trim();
const policyHash=digest(readFileSync(new URL('../../agent/lib/markus-policy.ts',import.meta.url)));
if(partition==='paired'&&mode==='stdio'&&!['flash-deepseek','deepseek-deepseek'].includes(args['eval-route']))throw Error('Paired external evaluation needs explicit route label');
const fingerprints={runtimeCommit,evalRoute:args['eval-route']||null,policyHash,runnerHash:digest(readFileSync(new URL('../../agent/lib/consultation-runner.ts',import.meta.url))),scenarioHash:digest(scenarioBytes),harnessHash:digest(readFileSync(new URL('./harness.mjs',import.meta.url))),driverHash:digest(readFileSync(new URL('./run.mjs',import.meta.url))),targetModel:args.model||'eval-target',expectedResponseModel:args['response-model']||null,reviewerModel:args['reviewer-model']||args.model||'eval-target',reviewerResponseModel:args['reviewer-response-model']||args['response-model']||null,maxOutputTokens:Number(args['max-output-tokens']||800),maxCalls:Number(args['max-calls']||24)};
if(['holdout','validation','confirmation','paired'].includes(partition)&&mode==='stdio'&&args.freeze!==runtimeCommit+':'+policyHash)throw Error('Freeze marker must match actual commit:policyHash');
if(mode==='stdio'&&args['reviewer-model']&&!args['reviewer-response-model'])throw Error('Reviewer response alias required');
const maxOutputTokens=Number(args['max-output-tokens']||800);
const receiptTimeout=Number(args['receipt-timeout-ms']||60000);if(!Number.isInteger(receiptTimeout)||receiptTimeout<1||receiptTimeout>300000)throw Error('Invalid receipt timeout');
const allScenarios=validateSuite(JSON.parse(scenarioBytes),partition);
const scenarios=args.scenario?allScenarios.filter(s=>s.id===args.scenario):allScenarios;
if(!scenarios.length)throw Error('Unknown scenario ID in selected partition');
const output=resolve(args.output||'/tmp/markus-eval-'+partition+'-'+Date.now()+'.jsonl');
writeFileSync(output,JSON.stringify({kind:'manifest',...fingerprints,receiptTimeoutMs:receiptTimeout,selectedScenarioIds:scenarios.map(s=>s.id),partition,mode,freeze:args.freeze||null,qualityVerdict:'not_scored',startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
let reader,iterator;
if(mode==='stdio'){reader=createInterface({input:process.stdin});iterator=reader[Symbol.asyncIterator]();}
const observe=value=>appendFileSync(output,JSON.stringify(value)+'\n');
const complete=mode==='contract'?contractStub:async (request,{signal}={})=>{
 // This program does NOT perform network calls. A separately authorized sole
 // caller reserves budget, invokes Yandex once, then returns a matching receipt.
 console.log(JSON.stringify({kind:'provider_request',...request}));
 let timer,onAbort;
 let line;try{line=await Promise.race([iterator.next(),new Promise((_,reject)=>{onAbort=()=>reject(Error('Receipt interrupted: unknown, no replay'));signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,receiptTimeout);if(signal?.aborted)onAbort();})]);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 if(line.done)throw Error('No transport receipt: unknown, do not replay');
 const receipt=JSON.parse(line.value);
 if(receipt.requestHash!==request.requestHash||receipt.sequence!==request.sequence||typeof receipt.reservationId!=='string'||!receipt.reservationId||receipt.provider!=='yandex'||receipt.model!==(request.role==='reviewer'?(args['reviewer-response-model']||args['response-model']):args['response-model']))throw Error('Missing or mismatched externally admitted receipt');
 const r=receipt.result;
 const knownEmptyRefusal=receipt.usable===false&&r?.text===''&&(receipt.finishReason==='content_filter'||receipt.refused===true);
 if(typeof r?.text!=='string'||r.text.length>16000||!Number.isSafeInteger(r.inputTokens)||r.inputTokens<1||!Number.isSafeInteger(r.outputTokens)||(r.outputTokens<1&&!(r.outputTokens===0&&knownEmptyRefusal))||r.outputTokens>maxOutputTokens)throw Error('Unverified external result');
 observe({kind:'external_receipt',sequence:request.sequence,reservationId:receipt.reservationId,provider:receipt.provider,model:receipt.model,finishReason:receipt.finishReason,usable:receipt.usable});
 if(receipt.finishReason!=='stop'||receipt.usable!==true||receipt.refused===true){const error=new Error('Known received but unusable external result; no retry');error.knownUnusable=true;observe({kind:'external_unusable',sequence:request.sequence,inputTokens:r.inputTokens,outputTokens:r.outputTokens,finishReason:receipt.finishReason});throw error;}return r;
};
try {const result=await runTaskScenarios(scenarios,{complete,backend:mode==='contract'?'contract_stub':'external_eval_transport',maxCalls:Number(args['max-calls']||24),targetModel:args.model||'eval-target',reviewerModel:args['reviewer-model']||args.model||'eval-target',maxOutputTokens,onObservation:observe});observe({kind:'summary',...result});console.log(JSON.stringify({kind:'summary',output,...result}));}
finally{reader?.close();}
