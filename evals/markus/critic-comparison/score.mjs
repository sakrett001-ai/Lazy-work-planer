// Offline deterministic scoring. No model identities are accepted in blind input.
import {readFileSync,writeFileSync} from 'node:fs';
import {hash,compile} from './compile.mjs';
import {MARKUS_REVIEW_CODES} from '../../../agent/lib/markus-policy.ts';
export function assess(item,fixture){
 const base={candidateId:item.candidateId,fixtureId:item.fixtureId,transportOutcome:item.outcome,jsonValid:false,schemaValid:false,citationsValid:false,usableVerdict:false,decisionCorrect:null,falsePositive:false,falseNegative:false,humanReasonScore:'not_scored'};
 if(item.outcome!=='received'||typeof item.text!=='string')return {...base,issue:'no_received_text'};
 let r;try{r=JSON.parse(item.text);base.jsonValid=true;}catch{return {...base,issue:'invalid_json'};}
 const keys=['action','approved','reasonCode','reason','references'];
 if(!r||Array.isArray(r)||Object.keys(r).length!==keys.length||Object.keys(r).some(k=>!keys.includes(k))||r.action!=='review'||typeof r.approved!=='boolean'||!MARKUS_REVIEW_CODES.includes(r.reasonCode)||r.approved!==(r.reasonCode==='appropriate')||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>2000||!Array.isArray(r.references)||r.references.length<1||r.references.length>8)return {...base,issue:'invalid_review_contract'};
 base.schemaValid=true;
 if(r.references.some(q=>!q||Object.keys(q).sort().join(',')!=='quote,sourceId'||typeof q.quote!=='string'||!q.quote.trim()||q.quote.length>1500||!fixture.sources.some(s=>s.sourceId===q.sourceId&&s.text.includes(q.quote))))return {...base,issue:'invalid_citation'};
 base.citationsValid=true;base.usableVerdict=true;base.decisionCorrect=r.approved===fixture.groundTruth.approved;
 return {...base,approved:r.approved,reasonCode:r.reasonCode,reason:r.reason,falsePositive:fixture.groundTruth.approved&&!r.approved,falseNegative:!fixture.groundTruth.approved&&r.approved};
}
export function score(items,cases,binding){
 if(binding){
  if(binding.casesSha256!==hash(JSON.stringify(cases)))throw Error('Gold binding mismatch');
  if(!Array.isArray(binding.candidateIds)||binding.candidateIds.length!==4||new Set(binding.candidateIds).size!==4)throw Error('Require four blind candidates');
  const requests=new Map(compile(cases).requests.map(r=>[r.fixtureId,r.promptHash]));
  for(const r of items)if(!binding.candidateIds.includes(r.candidateId)||r.promptHash!==requests.get(r.fixtureId))throw Error('Prompt/candidate binding mismatch');
 }
 const byCase=new Map(cases.map(c=>[c.id,c])),seen=new Set();
 for(const r of items){if('model'in r||'provider'in r||'modelUri'in r)throw Error('Blind input must omit model identity');if(!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(r.candidateId)||!byCase.has(r.fixtureId))throw Error('Invalid blind identity/case');const key=r.candidateId+':'+r.fixtureId;if(seen.has(key))throw Error('Duplicate outcome; do not cherry-pick retries');seen.add(key);}
 const rows=items.map(r=>assess(r,byCase.get(r.fixtureId)));
 return {kind:'blind_critic_comparison',qualityScope:'single-call critic decisions only; not complete Markus personality',rows,candidates:(binding?binding.candidateIds:[...new Set(items.map(r=>r.candidateId))]).slice().sort().map(id=>{
  const rs=rows.filter(r=>r.candidateId===id),raw=items.filter(r=>r.candidateId===id),lat=raw.filter(r=>Number.isFinite(r.latencyMs)&&r.latencyMs>=0).map(r=>r.latencyMs).sort((a,b)=>a-b);
  return {candidateId:id,expectedCases:12,observedCases:rs.filter(r=>r.transportOutcome!=='missing').length,missingCases:12-rs.filter(r=>r.transportOutcome!=='missing').length,jsonValid:rs.filter(r=>r.jsonValid).length,usableVerdicts:rs.filter(r=>r.usableVerdict).length,correctDecisions:rs.filter(r=>r.decisionCorrect===true).length,falsePositiveRejectValid:rs.filter(r=>r.falsePositive).length,validCaseDenominator:4,falseNegativeApproveInvalid:rs.filter(r=>r.falseNegative).length,invalidCaseDenominator:8,noUsableVerdict:rs.filter(r=>r.transportOutcome!=='missing'&&!r.usableVerdict).length,p50LatencyMs:lat.length?lat[Math.ceil(lat.length*.5)-1]:null,p95LatencyMs:lat.length?lat[Math.ceil(lat.length*.95)-1]:null,calculatedCostRub:raw.every(r=>Number.isFinite(r.costRub)&&r.costRub>=0)?raw.reduce((n,r)=>n+r.costRub,0):null,humanReasonAssessment:'required_before_selection'};
 })};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 const [input,output,bindingPath]=process.argv.slice(2);if(!input||!output||!bindingPath)throw Error('Supply blind input, new output and frozen binding');
 const cases=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url))),items=JSON.parse(readFileSync(input));
 writeFileSync(output,JSON.stringify(score(items,cases,JSON.parse(readFileSync(bindingPath))),null,2)+'\n',{flag:'wx',mode:0o600});console.log(output);
}
