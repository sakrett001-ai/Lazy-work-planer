import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,symlinkSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'release-offline-')),root=join(dir,'releases'),current=join(dir,'current');mkdirSync(root);
const script=resolve('scripts/manual-release.py');
after(()=>rmSync(dir,{recursive:true,force:true}));
function run(args,ok=true){const p=spawnSync('python3',[script,...args],{encoding:'utf8'});assert.equal(p.status,ok?0:1,p.stdout+p.stderr);return p;}
function fixture(rev,variant='valid'){
 const r=spawnSync('python3',['-c',`
import json,hashlib,zipfile,pathlib,sys
p=pathlib.Path(sys.argv[1]);rev=sys.argv[2];variant=sys.argv[3];name='../escape' if variant=='traversal' else ('.env.production' if variant=='privateenv' else 'package.json')
body=b'{"name":"fictional-release"}'; zpath=p/(rev+'.zip')
with zipfile.ZipFile(zpath,'w') as z:
 i=zipfile.ZipInfo(name);i.external_attr=(0o120777 if variant=='symlink' else 0o100644)<<16;z.writestr(i,body)
r={'schemaVersion':1,'repository':'sakrett001-ai/Lazy-work-planer','remoteGitCommit':rev,'remoteGitTree':'b'*40,'archiveSha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'files':[{'path':name,'mode':'100644','bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}]}
if variant=='badfile':r['files'][0]['sha256']='0'*64
if variant=='unpublished':r['remoteGitCommit']=None
(p/(rev+'.json')).write_text(json.dumps(r))
`,dir,rev,variant],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 return ['prepare','--archive',join(dir,rev+'.zip'),'--receipt',join(dir,rev+'.json'),'--releases',root];
}
test('Offline package gate rejects changed archive/file, unsafe links/traversal and missing remote metadata',()=>{
 for(const [index,variant]of ['traversal','symlink','badfile','unpublished','privateenv'].entries())run(fixture(String(index+1).repeat(40),variant),false);
 const args=fixture('6'.repeat(40));writeFileSync(join(dir,'6'.repeat(40)+'.zip'),'changed archive');run(args,false);
});
test('Verified source prepare and expected-pointer switch/rollback never modify application data',()=>{
 const old='716f8fdf',next='c'.repeat(40);const args=fixture(old);const receiptPath=join(dir,old+'.json');const r=JSON.parse(readFileSync(receiptPath));r.releaseDirectory=old;r.remoteGitCommit='11a9f72b37adfce74574ff1978587fcbbbcda50c';r.remoteGitTree='f0c14f1ff623375e0980024f4de4004962dc33ed';writeFileSync(receiptPath,JSON.stringify(r));run(args);run(fixture(next));run(fixture(next),false);
 symlinkSync(join(root,old),current);const database=join(dir,'private.sqlite');writeFileSync(database,'synthetic database sentinel');
 const change=(rev,expected)=>['switch','--releases',root,'--revision',rev,'--current',current,'--expected',join(root,expected)];
 run(change(next,old));assert.equal(readlinkSync(current),join(root,next));run(change(old,old),false);
 run(change(old,next));assert.equal(readlinkSync(current),join(root,old));
 writeFileSync(join(root,next,'package.json'),'modified after tests');run(change(next,old),false);
 assert.equal(readFileSync(database,'utf8'),'synthetic database sentinel');assert.equal(readlinkSync(current),join(root,old));
});

test('Actual server starts from current symlink with relative script path, without production environment',async()=>{
 const {createServer}=await import('node:net');const {spawn}=await import('node:child_process');
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const link=join(dir,'app-current');symlinkSync(process.cwd(),link);
 const child=spawn(process.execPath,['scripts/pilot-server.mjs'],{cwd:link,env:{PATH:process.env.PATH,ASSISTANT_DATA_DIR:join(dir,'server-data'),ASSISTANT_HOST:'127.0.0.1',ASSISTANT_PORT:String(port),ASSISTANT_SERVER_ORIGIN:`http://127.0.0.1:${port}`,ASSISTANT_AI_ENABLED:'false',ASSISTANT_DELIVERY_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('Server did not listen')),8000);
   child.stdout.on('data',data=>{if(data.toString().includes('Рабочее пространство:')){clearTimeout(timeout);resolve();}});
   child.once('exit',()=>{clearTimeout(timeout);reject(Error('Server exited before listening'));});
   child.once('error',error=>{clearTimeout(timeout);reject(error);});
  });
  const response=await fetch(`http://127.0.0.1:${port}/assistant/workspace`,{signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);assert.match(await response.text(),/pilot-theme.css/);
  const denied=await fetch(`http://127.0.0.1:${port}/assistant/api/tasks`,{signal:AbortSignal.timeout(3000)});assert.equal(denied.status,401);
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
});
