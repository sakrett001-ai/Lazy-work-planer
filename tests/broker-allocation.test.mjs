import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,writeFileSync,readFileSync,existsSync,renameSync,copyFileSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {createBrokerAllocationBook,bootstrapBrokerLedger,verifyBrokerAllocation} from '../agent/lib/broker-allocation.ts';
import {createBrokerCore} from '../agent/lib/broker-core.ts';

const key=Buffer.alloc(32,37);
const policy=(totalMicroRub=1000000)=>({version:1,folderId:'synthetic-folder',totalMicroRub,jobMicroRub:Math.min(totalMicroRub,100000),totalCalls:100,jobCalls:8,concurrency:1,timeoutMs:1000,analyst:{inputTokenBound:1000,inputMicroRubPerToken:2,outputMicroRubPerToken:3},reviewer:{inputTokenBound:1000,inputMicroRubPerToken:4,outputMicroRubPerToken:5},systemHashes:{analyst:'a'.repeat(64),reviewer:'b'.repeat(64)}});
const book=(aggregateMicroRub=2500000,carryMicroRub=500000)=>({version:1,aggregateMicroRub,carryMicroRub,carryEvidenceSha256:'c'.repeat(64)});
const code=c=>e=>e?.code===c;
function fixture(t,settings=book()){
 const dir=mkdtempSync(join(tmpdir(),'broker-allocation-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'book.sqlite');createBrokerAllocationBook(path,settings);
 const options=(allocationId='one',p=policy(),name=allocationId+'.sqlite')=>({path,allocationId,ledgerPath:join(dir,name),policy:p,key});
 return {dir,path,options};
}
function sql(path,fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
const rows=path=>sql(path,db=>db.prepare('SELECT * FROM allocations ORDER BY id').all());

test('allocation book creation is exclusive; missing/partial files never initialize on bootstrap',t=>{
 const f=fixture(t),before=readFileSync(f.path);assert.throws(()=>createBrokerAllocationBook(f.path,book()));assert.deepEqual(readFileSync(f.path),before);
 const missing=join(f.dir,'missing.sqlite');assert.throws(()=>bootstrapBrokerLedger({...f.options(),path:missing}));assert.equal(existsSync(missing),false);
 const partial=join(f.dir,'partial.sqlite');writeFileSync(partial,'',{mode:0o600});assert.throws(()=>createBrokerAllocationBook(partial,book()));assert.throws(()=>bootstrapBrokerLedger({...f.options(),path:partial}),code('allocation_corrupt'));assert.equal(readFileSync(partial).length,0);assert.equal(existsSync(f.options().ledgerPath),false);
});

test('allocation requires private directories and book/ledger permissions without relaxing them',t=>{
 const f=fixture(t);chmodSync(f.path,0o644);assert.throws(()=>bootstrapBrokerLedger(f.options()),code('private_ledger_required'));assert.equal(existsSync(f.options().ledgerPath),false);chmodSync(f.path,0o600);
 chmodSync(f.dir,0o755);assert.throws(()=>bootstrapBrokerLedger(f.options()),code('private_directory_required'));assert.throws(()=>createBrokerAllocationBook(join(f.dir,'other.sqlite'),book()),code('private_directory_required'));chmodSync(f.dir,0o700);
 bootstrapBrokerLedger(f.options());chmodSync(f.options().ledgerPath,0o644);assert.throws(()=>verifyBrokerAllocation(f.options()),code('private_ledger_required'));assert.equal(lstatSync(f.options().ledgerPath).mode&0o777,0o644);
});

test('carry plus two distinct immutable allocations reaches exact budget; no extra unit admitted',t=>{
 const f=fixture(t);bootstrapBrokerLedger(f.options());bootstrapBrokerLedger(f.options('two'));
 assert.deepEqual(rows(f.path).map(r=>[r.id,r.amount,r.state]),[['one',1000000,'ready'],['two',1000000,'ready']]);
 for(const name of ['one','two'])assert.deepEqual(verifyBrokerAllocation(f.options(name)),{allocationId:name,amountMicroRub:1000000});
 assert.throws(()=>bootstrapBrokerLedger(f.options('over',policy(1))),code('allocation_budget'));assert.equal(existsSync(f.options('over').ledgerPath),false);assert.equal(rows(f.path).length,2);
 assert.throws(()=>bootstrapBrokerLedger(f.options('one',policy(1),'new.sqlite')),code('allocation_exists'));
 assert.throws(()=>bootstrapBrokerLedger(f.options('new',policy(),'one.sqlite')),code('allocation_exists'));
});

test('safe integer boundary uses exact aggregate arithmetic and rejects unsafe book values',t=>{
 const max=Number.MAX_SAFE_INTEGER,f=fixture(t,book(max,max-10));bootstrapBrokerLedger(f.options('exact',policy(10)));
 assert.throws(()=>bootstrapBrokerLedger(f.options('one-more',policy(1))),code('allocation_budget'));assert.equal(rows(f.path).length,1);
 for(const value of [book(max+1,0),book(10,11),{...book(),carryEvidenceSha256:'not-a-hash'}]){const path=join(f.dir,'invalid.sqlite');assert.throws(()=>createBrokerAllocationBook(path,value));assert.equal(existsSync(path),false);}
});

test('failed core creation holds allocation permanently; retry/verify cannot bless a partial ledger',t=>{
 const f=fixture(t),o=f.options();writeFileSync(o.ledgerPath,'',{mode:0o600});assert.throws(()=>bootstrapBrokerLedger(o));
 assert.equal(rows(f.path)[0].state,'reserved');assert.equal(rows(f.path)[0].amount,o.policy.totalMicroRub);assert.equal(readFileSync(o.ledgerPath).length,0);
 assert.throws(()=>bootstrapBrokerLedger(o),code('allocation_exists'));assert.throws(()=>verifyBrokerAllocation(o),code('allocation_binding'));
 rmSync(o.ledgerPath);assert.throws(()=>bootstrapBrokerLedger(o),code('allocation_exists'));assert.equal(existsSync(o.ledgerPath),false);
 bootstrapBrokerLedger(f.options('two'));assert.throws(()=>bootstrapBrokerLedger(f.options('over',policy(1))),code('allocation_budget'));
});

test('invalid key reserves nothing; overflowing core pricing fails closed after reservation',t=>{
 const f=fixture(t),o=f.options();assert.throws(()=>bootstrapBrokerLedger({...o,key:Buffer.alloc(1)}),code('auth_configuration'));assert.deepEqual(rows(f.path),[]);
 const unsafe=policy();unsafe.analyst.inputMicroRubPerToken=Number.MAX_SAFE_INTEGER;
 assert.throws(()=>bootstrapBrokerLedger({...o,policy:unsafe}),code('money_overflow'));assert.equal(rows(f.path)[0].state,'reserved');assert.equal(existsSync(o.ledgerPath),false);
});

test('verify binds ID, requested policy and ledger path; core reopen never resets allocation',t=>{
 const f=fixture(t),o=f.options();bootstrapBrokerLedger(o);const before=rows(f.path);
 assert.throws(()=>verifyBrokerAllocation({...o,allocationId:'unknown'}),code('allocation_binding'));assert.throws(()=>verifyBrokerAllocation({...o,policy:{...o.policy,totalCalls:99}}),code('allocation_binding'));
 const core=createBrokerCore({path:o.ledgerPath,create:false,key,policy:o.policy,dispatch:async()=>{throw Error('No dispatch allowed');}});core.close();assert.deepEqual(rows(f.path),before);assert.ok(Object.isFrozen(verifyBrokerAllocation(o)));
 const replacement=join(f.dir,'copy.sqlite');copyFileSync(o.ledgerPath,replacement);chmodSync(replacement,0o600);assert.throws(()=>verifyBrokerAllocation({...o,ledgerPath:replacement}),code('allocation_binding'));
});

test('missing or replaced ledger cannot reuse ready allocation even with identical copied bytes',t=>{
 const f=fixture(t),o=f.options();bootstrapBrokerLedger(o);const old=join(f.dir,'retained-original.sqlite');renameSync(o.ledgerPath,old);
 assert.throws(()=>verifyBrokerAllocation(o));assert.throws(()=>bootstrapBrokerLedger(o),code('allocation_exists'));
 copyFileSync(old,o.ledgerPath);chmodSync(o.ledgerPath,0o600);assert.notEqual(lstatSync(old).ino,lstatSync(o.ledgerPath).ino);assert.throws(()=>verifyBrokerAllocation(o),code('allocation_binding'));assert.equal(rows(f.path)[0].state,'ready');
});

test('binding metadata corruption and corrupt/missing allocation book are refused without reset',t=>{
 const f=fixture(t),o=f.options();bootstrapBrokerLedger(o);
 sql(o.ledgerPath,db=>db.prepare('UPDATE broker_allocation_binding SET book_path=?').run(join(f.dir,'foreign.sqlite')));assert.throws(()=>verifyBrokerAllocation(o),code('allocation_binding'));
 sql(o.ledgerPath,db=>db.prepare('UPDATE broker_allocation_binding SET book_path=?').run(f.path));
 sql(f.path,db=>db.prepare('UPDATE allocation_metadata SET value=? WHERE id=1').run(JSON.stringify(book(1,0))));assert.throws(()=>verifyBrokerAllocation(o),code('allocation_corrupt'));
 renameSync(f.path,join(f.dir,'retained-book.sqlite'));assert.throws(()=>verifyBrokerAllocation(o));assert.throws(()=>bootstrapBrokerLedger(o));assert.equal(existsSync(f.path),false);
});

test('allocation verification refuses a ledger whose core policy metadata was altered in place',t=>{
 const f=fixture(t),o=f.options();bootstrapBrokerLedger(o);sql(o.ledgerPath,db=>db.prepare('UPDATE metadata SET policy_hash=? WHERE id=1').run('0'.repeat(64)));
 assert.throws(()=>verifyBrokerAllocation(o));assert.equal(rows(f.path)[0].amount,o.policy.totalMicroRub);
});

test('corrupt row states, ready inode and allocation sums cannot verify as valid',t=>{
 const f=fixture(t),o=f.options();bootstrapBrokerLedger(o);const original=rows(f.path)[0];
 for(const [field,value] of [['state','refunded'],['state','reserved'],['inode',null],['device',-1],['amount',2500001]]){
  sql(f.path,db=>db.prepare(`UPDATE allocations SET ${field}=? WHERE id=?`).run(value,o.allocationId));
  assert.throws(()=>verifyBrokerAllocation(o));
  sql(f.path,db=>db.prepare(`UPDATE allocations SET ${field}=? WHERE id=?`).run(original[field],o.allocationId));
 }
 assert.deepEqual(verifyBrokerAllocation(o),{allocationId:'one',amountMicroRub:1000000});
});

test('two child processes competing for one remaining allocation never oversubscribe the book',async t=>{
 const f=fixture(t,book(1000000,0));
 const moduleUrl=new URL('../agent/lib/broker-allocation.ts',import.meta.url).href;
 const script=`import {bootstrapBrokerLedger} from ${JSON.stringify(moduleUrl)};const options=JSON.parse(process.argv[1]);options.key=Buffer.alloc(32,37);try{bootstrapBrokerLedger(options);console.log('ready');}catch(e){console.log('blocked');}`;
 const run=name=>new Promise((resolve,reject)=>{
  const {key:unused,...options}=f.options(name);const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(options)],{env:process.env,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(out.trim()):reject(Error(err)));
 });
 const outcomes=await Promise.all([run('racer-one'),run('racer-two')]);assert.deepEqual(outcomes.sort(),['blocked','ready']);
 const allocations=rows(f.path);assert.equal(allocations.length,1);assert.equal(allocations[0].amount,1000000);assert.equal(allocations[0].state,'ready');assert.equal(verifyBrokerAllocation(f.options(allocations[0].id)).amountMicroRub,1000000);
});

const bootstrapScript=new URL('../scripts/broker-bootstrap.mjs',import.meta.url);
function cli(command,path,...extra){return spawnSync(process.execPath,[bootstrapScript.pathname,command,path,...extra],{env:process.env,encoding:'utf8',timeout:10000});}
function cliFixture(t){
 const dir=mkdtempSync(join(tmpdir(),'allocation-cli-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'book.sqlite'),ledgerPath=join(dir,'ledger.sqlite'),ipcKeyFile=join(dir,'synthetic-ipc.key'),create=join(dir,'create.json'),allocate=join(dir,'allocate.json');
 writeFileSync(ipcKeyFile,key.toString('hex')+'\n',{mode:0o600});writeFileSync(create,JSON.stringify({path,book:book()}),{mode:0o600});
 const options={path,ledgerPath,allocationId:'cli-one',policy:policy(),ipcKeyFile};writeFileSync(allocate,JSON.stringify(options),{mode:0o600});return {dir,path,ledgerPath,ipcKeyFile,create,allocate,options};
}
test('operator CLI explicitly creates book then allocates a bound ledger with synthetic private key',t=>{
 const f=cliFixture(t);
 for(const [command,path]of [['create-book',f.create],['allocate-ledger',f.allocate]]){const r=cli(command,path);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'Broker bootstrap completed.\n');assert.equal(r.stderr,'');}
 assert.deepEqual(verifyBrokerAllocation(f.options),{allocationId:'cli-one',amountMicroRub:1000000});assert.equal(rows(f.path)[0].state,'ready');
 sql(f.ledgerPath,db=>{assert.equal(db.prepare('SELECT id FROM broker_allocation_binding').get().id,'cli-one');assert.ok(db.prepare('SELECT policy_hash FROM metadata WHERE id=1').get().policy_hash);});
});
test('operator CLI duplicate operations refuse without modifying existing book rows or ledger bytes',t=>{
 const f=cliFixture(t);assert.equal(cli('create-book',f.create).status,0);assert.equal(cli('allocate-ledger',f.allocate).status,0);
 const before=rows(f.path),ledger=readFileSync(f.ledgerPath);
 for(const [command,path]of [['create-book',f.create],['allocate-ledger',f.allocate]]){const r=cli(command,path);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/Broker bootstrap refused/);assert.deepEqual(rows(f.path),before);assert.deepEqual(readFileSync(f.ledgerPath),ledger);}
});
test('operator CLI malformed and unknown commands disclose no input, private path or key',t=>{
 const f=cliFixture(t),bad=join(f.dir,'PRIVATE_PATH_CANARY.json'),secret=key.toString('hex');
 writeFileSync(bad,'{"PRIVATE_INPUT_CANARY":"'+secret+'",',{mode:0o600});
 for(const [command,path,extra]of [['create-book',bad,[]],['UNKNOWN_COMMAND_CANARY',f.allocate,[]],['allocate-ledger',f.allocate,['UNEXPECTED_ARGUMENT_CANARY']]]){
  const r=cli(command,path,...extra);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'Broker bootstrap refused; inspect local allocation state before any further operator action.\n');
  for(const forbidden of [f.dir,secret,'PRIVATE_INPUT_CANARY','PRIVATE_PATH_CANARY','UNKNOWN_COMMAND_CANARY','UNEXPECTED_ARGUMENT_CANARY'])assert.ok(!r.stderr.includes(forbidden));
 }
 assert.equal(existsSync(f.path),false);assert.equal(existsSync(f.ledgerPath),false);
});
