/** Operator-only allocation bootstrap. No HTTP/IPC control, refunds, recovery, or provider calls.
 * Carry is a conservative frozen total (including unresolved prior reservations).
 * Allocations remain charged to this book in full, even after ledger spend/disable/crash. */
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { brokerPolicyFingerprint, createBrokerCore, type BrokerPolicy, BrokerError } from './broker-core.ts';
const money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bookSchema=z.object({version:z.literal(1),aggregateMicroRub:money.positive(),carryMicroRub:money,carryEvidenceSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export type AllocationBook = z.infer<typeof bookSchema>;
function privatePath(path:string, file=true) {
 const abs=resolve(path),parent=dirname(abs),dir=lstatSync(parent);
 if(realpathSync(parent)!==parent||!dir.isDirectory()||(dir.mode&0o777)!==0o700||dir.uid!==process.getuid?.())throw new BrokerError('private_directory_required');
 if(file){const st=lstatSync(abs);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.uid!==process.getuid?.())throw new BrokerError('private_ledger_required');}
 return abs;
}
function openBook(path:string,readOnly=true) {
 const db=new DatabaseSync(privatePath(path),{readOnly});
 try {
  const meta=db.prepare('SELECT value FROM allocation_metadata WHERE id=1').get() as {value:string}|undefined;
  const policy=bookSchema.parse(JSON.parse(meta?.value||''));
  if(policy.carryMicroRub>policy.aggregateMicroRub)throw new BrokerError('allocation_corrupt');
  const rows=db.prepare('SELECT * FROM allocations').all();let sum=BigInt(policy.carryMicroRub);
  for(const r of rows){if(!id.safeParse(r.id).success||!money.positive().safeParse(r.amount).success||!['reserved','ready'].includes(String(r.state))||typeof r.ledger_path!=='string'||!/^\/[\s\S]+$/.test(r.ledger_path)||typeof r.policy_hash!=='string'||!/^[a-f0-9]{64}$/.test(r.policy_hash))throw new BrokerError('allocation_corrupt');sum+=BigInt(Number(r.amount));}
  if(sum>BigInt(policy.aggregateMicroRub))throw new BrokerError('allocation_corrupt');
  return {db,policy};
 }catch{db.close();throw new BrokerError('allocation_corrupt');}
}
export function createBrokerAllocationBook(path:string,value:AllocationBook) {
 const policy=bookSchema.parse(value);if(policy.carryMicroRub>policy.aggregateMicroRub)throw new BrokerError('allocation_budget');
 const abs=privatePath(path,false),fd=openSync(abs,'wx',0o600);closeSync(fd);
 const db=new DatabaseSync(abs);
 try {db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE allocation_metadata(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE allocations(id TEXT PRIMARY KEY,ledger_path TEXT NOT NULL UNIQUE,policy_hash TEXT NOT NULL,amount INTEGER NOT NULL,state TEXT NOT NULL,device INTEGER,inode INTEGER);');db.prepare('INSERT INTO allocation_metadata VALUES(1,?)').run(JSON.stringify(policy));db.exec('COMMIT');}finally{db.close();}
}
/** One-shot operator operation. Failure after reservation is intentionally non-retryable;
 * the allocation remains held, and a partial ledger is never silently replaced. */
export function bootstrapBrokerLedger(options:{path:string;allocationId:string;ledgerPath:string;policy:BrokerPolicy;key:Uint8Array}) {
 const allocationId=id.parse(options.allocationId),ledgerPath=privatePath(options.ledgerPath,false),fingerprint=brokerPolicyFingerprint(options.policy);
 // Validate key before committing a reservation. Never send it to the allocation book.
 if(!(options.key instanceof Uint8Array)||options.key.byteLength<32||options.key.byteLength>128)throw new BrokerError('auth_configuration');
 const {db,policy}=openBook(options.path,false);
 try {
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
  try {
   if(db.prepare('SELECT id FROM allocations WHERE id=? OR ledger_path=?').get(allocationId,ledgerPath))throw new BrokerError('allocation_exists');
   const rows=db.prepare('SELECT amount FROM allocations').all();const used=rows.reduce((sum,r)=>sum+BigInt(Number(r.amount)),BigInt(policy.carryMicroRub));
   if(used+BigInt(options.policy.totalMicroRub)>BigInt(policy.aggregateMicroRub))throw new BrokerError('allocation_budget');
   db.prepare("INSERT INTO allocations VALUES(?,?,?,?, 'reserved',NULL,NULL)").run(allocationId,ledgerPath,fingerprint,options.policy.totalMicroRub);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const core=createBrokerCore({path:ledgerPath,create:true,key:options.key,policy:options.policy,dispatch:async()=>{throw new BrokerError('bootstrap_only');}});core.close();
  const ledger=new DatabaseSync(ledgerPath);
  try { ledger.exec('PRAGMA synchronous=FULL; CREATE TABLE broker_allocation_binding(id TEXT PRIMARY KEY,book_path TEXT NOT NULL,policy_hash TEXT NOT NULL)');ledger.prepare('INSERT INTO broker_allocation_binding VALUES(?,?,?)').run(allocationId,resolve(options.path),fingerprint); } finally {ledger.close();}
  const stat=lstatSync(ledgerPath);
  db.prepare("UPDATE allocations SET state='ready',device=?,inode=? WHERE id=? AND state='reserved'").run(stat.dev,stat.ino,allocationId);
 }finally{db.close();}
}
export function verifyBrokerAllocation(options:{path:string;allocationId:string;ledgerPath:string;policy:BrokerPolicy}) {
 const allocationId=id.parse(options.allocationId),ledgerPath=privatePath(options.ledgerPath),fingerprint=brokerPolicyFingerprint(options.policy);
 const {db}=openBook(options.path);
 try {const row=db.prepare('SELECT * FROM allocations WHERE id=?').get(allocationId);const stat=lstatSync(ledgerPath);
  if(!row||row.state!=='ready'||row.ledger_path!==ledgerPath||row.policy_hash!==fingerprint||row.amount!==options.policy.totalMicroRub||row.device!==stat.dev||row.inode!==stat.ino)throw new BrokerError('allocation_binding');
  const ledger=new DatabaseSync(ledgerPath,{readOnly:true});
  try {const meta=ledger.prepare('SELECT policy_hash FROM metadata WHERE id=1').get();if(meta?.policy_hash!==fingerprint)throw new BrokerError('allocation_binding');const binding=ledger.prepare('SELECT * FROM broker_allocation_binding WHERE id=?').get(allocationId);if(!binding||binding.book_path!==resolve(options.path)||binding.policy_hash!==fingerprint)throw new BrokerError('allocation_binding');}finally{ledger.close();}
  return Object.freeze({allocationId,amountMicroRub:Number(row.amount)});
 }finally{db.close();}
}
