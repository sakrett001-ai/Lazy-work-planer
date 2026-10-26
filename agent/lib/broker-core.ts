/** Offline/injected broker core. No listener, credentials, environment or default fetch.
 * Production IPC peer identity and tariff/context-bound admission remain separate gates. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const hostId = z.string().regex(/^[\p{L}\p{N}_.:-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const role = z.enum(['analyst', 'reviewer']);
export const brokerRequestSchema = z.object({
  protocol: z.literal(1), policyHash: digest.optional(), requestId: id, jobId: id, actorId: hostId,
  actorRole: z.enum(['manager','employee']), taskId: hostId, taskVersion: digest,
  contextVersion: digest, role, ordinal: z.number().int().min(1).max(4),
  issuedAtMs: positive, deadlineMs: positive,
  system: z.string().min(1).max(16000), prompt: z.string().min(1).max(32000),
}).strict();
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
const envelopeSchema = z.object({ payload: z.string().min(1).max(100000), mac: digest }).strict();
const pricing = z.object({ inputTokenBound: positive.max(1048576), inputMicroRubPerToken: positive,
  outputMicroRubPerToken: positive }).strict();
const policySchema = z.object({ version: z.literal(1), folderId: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/),
  totalMicroRub: positive, jobMicroRub: positive, totalCalls: positive.max(1000000),
  jobCalls: positive.max(8), concurrency: positive.max(4), timeoutMs: positive.max(120000),
  analyst: pricing, reviewer: pricing, systemHashes: z.object({analyst:digest,reviewer:digest}).strict(),
}).strict();
export function brokerPolicyFingerprint(value: unknown) { return hash(JSON.stringify(policySchema.parse(value))); }
export type BrokerPolicy = z.infer<typeof policySchema>;
export type BrokerEnvelope = z.infer<typeof envelopeSchema>;
export type BrokerReply = { text: string; inputTokens: number; outputTokens: number };
export type BrokerDispatch = (input: { model: string; expectedResponseModel: string; system: string;
  prompt: string; maxOutputTokens: 2048; signal: AbortSignal }) => Promise<BrokerReply>;
type Row = { request_id: string; request_hash: string; job_id: string; role: string; ordinal: number;
  state: 'reserved'|'received'|'unknown'; reserved: number; charged: number; input_tokens: number|null; output_tokens: number|null };
export class BrokerError extends Error { readonly code:string; constructor(code: string) { super('Broker request was not admitted or its outcome is unavailable.'); this.code=code; } }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function keyCheck(key: Uint8Array) { if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) throw new BrokerError('auth_configuration'); }
function safeNumber(n: bigint) { if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new BrokerError('money_overflow');return Number(n); }
function money(p: z.infer<typeof pricing>, input: number, output: number) {
  return safeNumber(BigInt(input)*BigInt(p.inputMicroRubPerToken)+BigInt(output)*BigInt(p.outputMicroRubPerToken));
}
export function signBrokerRequest(request: BrokerRequest, key: Uint8Array): BrokerEnvelope {
  keyCheck(key); const payload=JSON.stringify(brokerRequestSchema.parse(request));
  return {payload,mac:createHmac('sha256',key).update(payload).digest('hex')};
}
export function createBrokerCore(options: { path: string; create: boolean; key: Uint8Array;
  policy: BrokerPolicy; dispatch: BrokerDispatch; now?: () => number; requirePolicyHash?: boolean }) {
  keyCheck(options.key);const key=Buffer.from(options.key),policy=policySchema.parse(options.policy),requirePolicyHash=options.requirePolicyHash===true;
  if(typeof options.dispatch!=='function')throw new BrokerError('dispatch_configuration');
  if(policy.jobMicroRub>policy.totalMicroRub||policy.jobCalls>policy.totalCalls)throw new BrokerError('policy');
  for(const r of ['analyst','reviewer'] as const) money(policy[r],policy[r].inputTokenBound,2048);
  const fingerprint=hash(JSON.stringify(policy)),path=resolve(options.path),parent=dirname(path);
  const dir=lstatSync(parent);
  if(realpathSync(parent)!==parent||!dir.isDirectory()||(dir.mode&0o777)!==0o700||dir.uid!==process.getuid?.())throw new BrokerError('private_directory_required');
  if(options.create){const fd=openSync(path,'wx',0o600);closeSync(fd);}
  const file=lstatSync(path);
  if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.())throw new BrokerError('private_ledger_required');
  let db=new DatabaseSync(path,{readOnly:!options.create});let active=0,closed=false,startupReserved=false;
  try {
    if(options.create){db.exec(`CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),policy_hash TEXT NOT NULL,halted INTEGER NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL);
      CREATE TABLE attempts (request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,job_id TEXT NOT NULL,role TEXT NOT NULL,ordinal INTEGER NOT NULL,state TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,UNIQUE(job_id,role,ordinal));`);
      db.prepare('INSERT INTO metadata VALUES(1,?,0)').run(fingerprint);
    }
    const meta=db.prepare('SELECT policy_hash FROM metadata WHERE id=1').get() as {policy_hash:string}|undefined;
    if(meta?.policy_hash!==fingerprint)throw new BrokerError('policy_mismatch');
    rows();startupReserved=Number((db.prepare("SELECT count(*) AS n FROM attempts WHERE state='reserved'").get() as {n:number}).n)>0;
    // Rejected reopen validation is read-only, including empty/wrong-policy files.
    if(!options.create){db.close();db=new DatabaseSync(path);}
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
  }catch(error){if(db.isOpen)db.close();throw error;}
  const now=options.now||Date.now;
  function transaction<T>(fn:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
  function rows() {const saved=db.prepare('SELECT * FROM attempts').all() as Row[];
    for(const r of saved){if(!['reserved','received','unknown'].includes(r.state)||!Number.isSafeInteger(r.reserved)||r.reserved<1||!Number.isSafeInteger(r.charged)||r.charged<0||!['analyst','reviewer'].includes(r.role)||!Number.isInteger(r.ordinal)||r.ordinal<1||r.ordinal>4||!digest.safeParse(r.request_hash).success)throw new BrokerError('ledger_corrupt');}
    return saved;}
  function metadata(row: Row) {return {requestId:row.request_id,state:row.state,reservedMicroRub:row.reserved,chargedMicroRub:row.charged,inputTokens:row.input_tokens,outputTokens:row.output_tokens};}
  function fresh(r:BrokerRequest){const t=now();if(!Number.isSafeInteger(t)||r.issuedAtMs>t+5000||t-r.issuedAtMs>30000||r.deadlineMs<=t||r.deadlineMs-r.issuedAtMs>600000||r.deadlineMs<=r.issuedAtMs)throw new BrokerError('expired');}
  return {
    async complete(raw: unknown):Promise<{duplicate:true;receipt:ReturnType<typeof metadata>}|{duplicate:false;receipt:ReturnType<typeof metadata>;result:BrokerReply}> {
      if(closed)throw new BrokerError('closed');
      const parsed=envelopeSchema.safeParse(raw);if(!parsed.success)throw new BrokerError('schema');const envelope=parsed.data;
      if(Buffer.byteLength(envelope.payload,'utf8')>65536)throw new BrokerError('request_size');
      const mac=createHmac('sha256',key).update(envelope.payload).digest();
      if(!timingSafeEqual(mac,Buffer.from(envelope.mac,'hex')))throw new BrokerError('auth');
      let request:BrokerRequest;try{request=brokerRequestSchema.parse(JSON.parse(envelope.payload));}catch{throw new BrokerError('schema');}
      if((requirePolicyHash && request.policyHash===undefined)||(request.policyHash!==undefined&&request.policyHash!==fingerprint))throw new BrokerError('policy_mismatch');
      if(hash(request.system)!==policy.systemHashes[request.role])throw new BrokerError('system_policy');
      if(Buffer.byteLength(request.system+request.prompt,'utf8')>48000)throw new BrokerError('request_size');
      const requestHash=hash(envelope.payload),scope=hash(JSON.stringify([request.actorId,request.actorRole,request.taskId,request.taskVersion,request.contextVersion]));
      const reservation=money(policy[request.role],policy[request.role].inputTokenBound,2048);
      const admitted=transaction(()=>{
        const old=db.prepare('SELECT * FROM attempts WHERE request_id=?').get(request.requestId) as Row|undefined;
        if(old){if(old.request_hash!==requestHash)throw new BrokerError('request_conflict');return old;}
        fresh(request);if(startupReserved)throw new BrokerError('restart_unresolved');
        const meta=db.prepare('SELECT halted FROM metadata WHERE id=1').get() as {halted:number};if(meta.halted)throw new BrokerError('halted');
        const previous=db.prepare('SELECT scope_hash FROM jobs WHERE id=?').get(request.jobId) as {scope_hash:string}|undefined;
        if(previous&&previous.scope_hash!==scope)throw new BrokerError('scope_conflict');
        if(db.prepare('SELECT request_id FROM attempts WHERE job_id=? AND role=? AND ordinal=?').get(request.jobId,request.role,request.ordinal))throw new BrokerError('ordinal_conflict');
        const all=rows(),job=all.filter(r=>r.job_id===request.jobId);
        if(all.some(r=>r.state==='unknown'))throw new BrokerError('unresolved');
        if(all.filter(r=>r.state==='reserved').length>=policy.concurrency)throw new BrokerError('concurrency');
        const sum=(r:Row[])=>r.reduce((v,x)=>v+BigInt(x.charged),0n);
        if(all.length>=policy.totalCalls||job.length>=policy.jobCalls||sum(all)+BigInt(reservation)>BigInt(policy.totalMicroRub)||sum(job)+BigInt(reservation)>BigInt(policy.jobMicroRub))throw new BrokerError('budget');
        if(!previous)db.prepare('INSERT INTO jobs VALUES(?,?)').run(request.jobId,scope);
        db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,\'reserved\',?,?,NULL,NULL)').run(request.requestId,requestHash,request.jobId,request.role,request.ordinal,reservation,reservation);
        return null;
      });
      if(admitted)return {duplicate:true,receipt:metadata(admitted)};
      active++;const controller=new AbortController(),startedMonotonic=performance.now();let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        fresh(request);
        const name=request.role==='analyst'?'aliceai-llm-flash':'deepseek-v4.1-flash';
        const result=await Promise.race([Promise.resolve().then(async()=>{
          fresh(request);try{return await options.dispatch({model:`gpt://${policy.folderId}/${name}`,expectedResponseModel:`gpt://${name}/latest`,system:request.system,prompt:request.prompt,maxOutputTokens:2048,signal:controller.signal});}catch{throw new BrokerError('unknown');}
        }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BrokerError('unknown'));},Math.min(policy.timeoutMs,Math.max(1,request.deadlineMs-now())));})]);
        const p=policy[request.role];
        if(!Number.isSafeInteger(result?.inputTokens)||result.inputTokens<1||!Number.isSafeInteger(result?.outputTokens)||result.outputTokens<1)throw new BrokerError('unverified_reply');
        const charged=money(p,result.inputTokens,result.outputTokens);
        const overrun=result.inputTokens>p.inputTokenBound||result.outputTokens>2048;
        const late=now()>=request.deadlineMs||performance.now()-startedMonotonic>=policy.timeoutMs;
        const unusable=typeof result.text!=='string'||!result.text.trim()||Buffer.byteLength(result.text,'utf8')>24000;
        // Usage is independent of text usability. Late/invalid replies never refund a hold.
        if(overrun||late||unusable){transaction(()=>{db.prepare('UPDATE attempts SET state=\'unknown\',charged=?,input_tokens=?,output_tokens=? WHERE request_id=? AND state=\'reserved\'').run(Math.max(charged,reservation),result.inputTokens,result.outputTokens,request.requestId);db.prepare('UPDATE metadata SET halted=1 WHERE id=1').run();});throw new BrokerError(overrun?'usage_overrun':late?'late_reply':'unverified_reply');}
        transaction(()=>{const changed=db.prepare('UPDATE attempts SET state=\'received\',charged=?,input_tokens=?,output_tokens=? WHERE request_id=? AND state=\'reserved\'').run(charged,result.inputTokens,result.outputTokens,request.requestId);if(changed.changes!==1)throw new BrokerError('terminal_conflict');});
        return {duplicate:false,receipt:metadata(db.prepare('SELECT * FROM attempts WHERE request_id=?').get(request.requestId) as Row),result:{text:result.text,inputTokens:result.inputTokens,outputTokens:result.outputTokens}};
      }catch(error){transaction(()=>{db.prepare('UPDATE attempts SET state=\'unknown\' WHERE request_id=? AND state=\'reserved\'').run(request.requestId);db.prepare('UPDATE metadata SET halted=1 WHERE id=1').run();});throw error instanceof BrokerError?error:new BrokerError('unknown');}
      finally {if(timer)clearTimeout(timer);controller.abort();active--;}
    },
    snapshot(){if(closed)throw new BrokerError('closed');return {halted:Boolean((db.prepare('SELECT halted FROM metadata WHERE id=1').get() as {halted:number}).halted),attempts:rows().map(metadata)};},
    close(){if(active)throw new BrokerError('active');if(!closed){db.close();key.fill(0);closed=true;}},
  };
}
