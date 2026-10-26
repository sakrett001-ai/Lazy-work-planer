import { z } from 'zod';
import { MARKUS_REVIEW_CODES } from './markus-policy.ts';

// Model wire only. Persisted jobs retain their distinct source/decision fields.
export const MODEL_PROTOCOL_VERSION = 2 as const;
const version = z.string().regex(/^[a-f0-9]{64}$/);
const wireReference = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('source'),id:z.string().min(1).max(150),version,quote:z.string().trim().min(1).max(1500)}).strict(),
  z.object({kind:z.literal('decision'),id:z.string().min(1).max(300),version}).strict(),
]);
const references = z.array(wireReference).max(8);
const protocolVersion = z.literal(MODEL_PROTOCOL_VERSION);
export const actionSchema = z.discriminatedUnion('action', [
  z.object({protocolVersion,action:z.literal('read_source'),sourceId:z.string().min(1).max(150),version,offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(2000).default(1600)}).strict(),
  z.object({protocolVersion,action:z.literal('answer'),text:z.string().trim().min(1).max(6000),references}).strict(),
  z.object({protocolVersion,action:z.literal('review'),approved:z.boolean(),reason:z.string().trim().min(1).max(2000),reasonCode:z.enum(MARKUS_REVIEW_CODES),references}).strict(),
]);
export type WireReferences = z.infer<typeof references>;

// Call only after strict schema parsing. No shape guessing or malformed-output repair.
export function normalizeReferences(refs: WireReferences) {
  const sources: {sourceId:string;version:string;quote:string}[] = [];
  const decisions: {decisionId:string;version:string}[] = [];
  for (const ref of refs) {
    if (ref.kind === 'source') sources.push({sourceId:ref.id,version:ref.version,quote:ref.quote});
    else if (ref.kind === 'decision') decisions.push({decisionId:ref.id,version:ref.version});
    else throw new Error('Unknown reference kind');
  }
  return {sources,decisions};
}

export const READ_SOURCE_EXAMPLE = JSON.stringify({protocolVersion:MODEL_PROTOCOL_VERSION,action:'read_source',sourceId:'source-id',version:'a'.repeat(64),offset:0,limit:1600});

export function finalActionExamples(role: string) {
  const source = {kind:'source',id:'source-id',version:'a'.repeat(64),quote:'дословный фрагмент'};
  const decision = {kind:'decision',id:'decision-id',version:'b'.repeat(64)};
  const make = (refs: unknown[]) => role === 'reviewer'
    ? {protocolVersion:MODEL_PROTOCOL_VERSION,action:'review',approved:true,reasonCode:'appropriate',reason:'Основание подтверждено.',references:refs}
    : {protocolVersion:MODEL_PROTOCOL_VERSION,action:'answer',text:'Короткий ответ пользователю.',references:refs};
  return [JSON.stringify(make([source])),JSON.stringify(make([decision]))].join('\n');
}
