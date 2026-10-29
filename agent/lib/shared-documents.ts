/** Shared document ledger. Session actor is supplied only by dashboard-api. No model calls. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { z } from 'zod';
import { database, readState, type Employee } from './store.ts';
import { WebError, digest } from './web-auth.ts';

const uuid = z.uuid();
const createSchema = z.object({ requestId: uuid, taskId: z.string().min(1).max(150), title: z.string().trim().min(1).max(200), curatorId: z.string().min(1).max(150), coexecutorIds: z.array(z.string().min(1).max(150)).max(20).default([]) }).strict();
const versionSchema = z.object({ requestId: uuid, expectedRevision: z.number().int().min(1), text: z.string().max(100000), files: z.array(z.object({ name: z.string().trim().min(1).max(180).regex(/^[^\x00-\x1f\x7f/\\]+$/), base64: z.string().max(2796204) }).strict()).max(4).default([]) }).strict();
const reviewSchema = z.object({ requestId: uuid, expectedRevision: z.number().int().min(1), versionId: uuid, decision: z.enum(['return','approve','accept']), comment: z.string().trim().max(4000).default('') }).strict();
type Doc = { id:string; task_id:string; title:string; owner_id:string; curator_id:string; coexecutors:string; created_by:string; created_at:string };
export function documentTables() {
  const db=database();
  db.exec(`CREATE TABLE IF NOT EXISTS shared_documents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,title TEXT NOT NULL,owner_id TEXT NOT NULL,curator_id TEXT NOT NULL,coexecutors TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,number INTEGER NOT NULL,text TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,number));
  CREATE TABLE IF NOT EXISTS document_blobs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,version_id TEXT NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS document_reviews(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,version_id TEXT NOT NULL,decision TEXT NOT NULL,comment TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS document_events(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,version_id TEXT,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,revision));
  CREATE TABLE IF NOT EXISTS document_operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response TEXT NOT NULL);`);
  for(const table of ['shared_documents','document_versions','document_blobs','document_reviews','document_events','document_operations']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END; CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END;`);
  return db;
}
function allowed(doc:Doc,actor:Employee) { return actor.enabled!==false&&(actor.role==='manager'||doc.owner_id===actor.id||doc.curator_id===actor.id||JSON.parse(doc.coexecutors).includes(actor.id)); }
function findDoc(id:string, actor:Employee):Doc {
  const doc=documentTables().prepare('SELECT * FROM shared_documents WHERE id=?').get(id) as Doc|undefined;
  if(!doc||!allowed(doc,actor)) throw new WebError(404,'Документ не найден.');
  return doc;
}
function ledger(doc:Doc) {
  const db=documentTables(), versions=db.prepare('SELECT * FROM document_versions WHERE document_id=? ORDER BY number').all(doc.id), reviews=db.prepare('SELECT * FROM document_reviews WHERE document_id=? ORDER BY rowid').all(doc.id), events=db.prepare('SELECT * FROM document_events WHERE document_id=? ORDER BY revision').all(doc.id);
  const accepted=reviews.filter(r=>r.decision==='accept').at(-1);
  return {...doc,coexecutorIds:JSON.parse(doc.coexecutors),coexecutors:undefined,revision:events.length,latestVersionId:versions.at(-1)?.id??null,acceptedVersionId:accepted?.version_id??null,versions,reviews,events,attachments:db.prepare('SELECT * FROM document_blobs WHERE document_id=?').all(doc.id)};
}
function blobDir() {
  const dir=resolve(process.env.ASSISTANT_DATA_DIR||'.data','document-blobs');
  for(const forbidden of [resolve('dist'),resolve('.git')]) if(!relative(forbidden,dir).startsWith('..')) throw new Error('Private storage cannot be static or Git metadata');
  mkdirSync(dir,{recursive:true,mode:0o700}); if(lstatSync(dir).isSymbolicLink()) throw new Error('Blob directory must not be a symlink'); return dir;
}
function event(docId:string,revision:number,kind:string,versionId:string|null,actor:Employee,at:string) { documentTables().prepare('INSERT INTO document_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),docId,revision,kind,versionId,actor.id,at); }
async function body(request:Request) {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') throw new WebError(415,'Ожидается JSON.');
  const reader=request.body?.getReader(); if(!reader) throw new WebError(400,'Нет данных.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){ const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>11500000){await reader.cancel();throw new WebError(413,'Превышен размер запроса.');}chunks.push(next.value); }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new WebError(400,'Неверный JSON.');}
}
export async function sharedDocumentRoute(request:Request,actor:Employee):Promise<Response|undefined> {
  const url=new URL(request.url), match=url.pathname.match(/^\/assistant\/api\/documents(?:\/([^/]+))?(?:\/(versions|reviews|blobs)(?:\/([^/]+))?)?$/);
  if(!match)return undefined;
  const [,id,action,blobId]=match, db=documentTables();
  if(id)uuid.parse(id);
  if(request.method==='GET') {
    if(!id) { const taskId=url.searchParams.get('taskId'); const docs=db.prepare('SELECT * FROM shared_documents').all() as Doc[]; return Response.json({documents:docs.filter(d=>allowed(d,actor)&&(!taskId||d.task_id===taskId)).map(ledger)}); }
    const doc=findDoc(id,actor);
    if(action==='blobs'&&blobId){ uuid.parse(blobId);const row=db.prepare('SELECT * FROM document_blobs WHERE id=? AND document_id=?').get(blobId,id);if(!row)throw new WebError(404,'Файл не найден.');const bytes=readFileSync(join(blobDir(),blobId));if(bytes.length!==row.size||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new WebError(503,'Файл не прошёл проверку целостности.');return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(String(row.name)).replace(/'/g,'%27')}`,'content-length':String(bytes.length)}}); }
    if(!action)return Response.json(ledger(doc));
    throw new WebError(404,'Действие не найдено.');
  }
  if(request.method!=='POST'||blobId)throw new WebError(405,'Метод не поддерживается.');
  const raw=await body(request), input=!id?createSchema.parse(raw):action==='versions'?versionSchema.parse(raw):action==='reviews'?reviewSchema.parse(raw):null;
  if(!input)throw new WebError(404,'Действие не найдено.');
  const key=`${actor.id}:${input.requestId}`,hash=digest(JSON.stringify({path:url.pathname,input}));const filesCreated:string[]=[];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-evaluate membership inside the transaction, before returning cached receipts.
    const current=readState().employees.find(p=>p.id===actor.id&&p.enabled!==false);if(!current)throw new WebError(401,'Сеанс завершён.');actor=current;
    const doc=id?findDoc(id,actor):null;
    if(!doc&&actor.role!=='manager')throw new WebError(403,'Запрос создаёт руководитель.');
    const prior=db.prepare('SELECT * FROM document_operations WHERE id=?').get(key);
    if(prior){if(prior.request_hash!==hash)throw new WebError(409,'Идентификатор запроса уже использован.');db.exec('COMMIT');return Response.json({...JSON.parse(String(prior.response)),duplicate:true});}
    const at=new Date().toISOString();let receipt:Record<string,unknown>;
    if(!doc){const x=createSchema.parse(input),state=readState(),task=state.tasks.find(t=>t.id===x.taskId);if(!task||!state.employees.some(p=>p.id===task.employeeId&&p.enabled!==false))throw new WebError(404,'Задача не найдена.');if([x.curatorId,...x.coexecutorIds].some(pid=>!state.employees.some(p=>p.id===pid&&p.enabled!==false)))throw new WebError(400,'Участник не найден.');if(x.curatorId===task.employeeId||x.coexecutorIds.includes(x.curatorId))throw new WebError(400,'Куратор не может проверять собственную версию.');const docId=randomUUID();db.prepare('INSERT INTO shared_documents VALUES(?,?,?,?,?,?,?,?)').run(docId,x.taskId,x.title,task.employeeId,x.curatorId,JSON.stringify([...new Set(x.coexecutorIds)]),actor.id,at);event(docId,1,'requested',null,actor,at);receipt={documentId:docId,revision:1};}
    else {const state=ledger(doc),expected='expectedRevision' in input?input.expectedRevision:0;if(expected!==state.revision)throw new WebError(409,'Документ изменился. Обновите данные.');
      if(action==='versions'){const x=versionSchema.parse(input);if(doc.owner_id!==actor.id&&!JSON.parse(doc.coexecutors).includes(actor.id))throw new WebError(403,'Версию передаёт исполнитель.');if(!x.text.trim()&&!x.files.length)throw new WebError(400,'Пустая версия.');const versionId=randomUUID(),buffers=x.files.map(f=>{if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64))throw new WebError(400,'Неверное кодирование файла.');const bytes=Buffer.from(f.base64,'base64');if(!bytes.length||bytes.length>2097152)throw new WebError(413,'Файл должен быть от 1 байта до 2 МиБ.');const ext=extname(f.name).toLowerCase();if(!['.txt','.md','.csv','.pdf','.docx','.xlsx'].includes(ext))throw new WebError(415,'Допустимы TXT, MD, CSV, PDF, DOCX и XLSX.');if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new WebError(415,'Неверная сигнатура PDF.');if(['.docx','.xlsx'].includes(ext)&&!bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])))throw new WebError(415,'Неверная сигнатура Office.');if(['.txt','.md','.csv'].includes(ext)){try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new WebError(415,'Текстовый файл должен быть UTF-8.');}if(bytes.includes(0))throw new WebError(415,'Двоичный текстовый файл.');}return {...f,bytes};});
        for(const file of buffers){const bid=randomUUID(),path=join(blobDir(),bid),fd=openSync(path,'wx',0o600);filesCreated.push(path);try{writeFileSync(fd,file.bytes);fsyncSync(fd);}finally{closeSync(fd);}db.prepare('INSERT INTO document_blobs VALUES(?,?,?,?,?,?)').run(bid,doc.id,versionId,file.name,createHash('sha256').update(file.bytes).digest('hex'),file.bytes.length);}
        const dirFd=openSync(blobDir(),'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
        db.prepare('INSERT INTO document_versions VALUES(?,?,?,?,?,?)').run(versionId,doc.id,state.versions.length+1,x.text,actor.id,at);event(doc.id,state.revision+1,'submitted',versionId,actor,at);receipt={documentId:doc.id,versionId,revision:state.revision+1};
      }else{const x=reviewSchema.parse(input);if(x.versionId!==state.latestVersionId)throw new WebError(409,'Проверять можно только актуальную точную версию.');const reviews=state.reviews.filter(r=>r.version_id===x.versionId),last=reviews.at(-1);if(x.decision==='accept'){if(actor.role!=='manager')throw new WebError(403,'Принимает руководитель.');if(last?.decision!=='approve')throw new WebError(409,'Нужно согласование куратора этой версии.');}else{if(doc.curator_id!==actor.id)throw new WebError(403,'Проверяет назначенный куратор.');if(last)throw new WebError(409,'Версия уже проверена; нужна новая версия.');if(x.decision==='return'&&!x.comment)throw new WebError(400,'Укажите причину возврата.');}const reviewId=randomUUID();db.prepare('INSERT INTO document_reviews VALUES(?,?,?,?,?,?,?)').run(reviewId,doc.id,x.versionId,x.decision,x.comment,actor.id,at);event(doc.id,state.revision+1,x.decision,x.versionId,actor,at);receipt={documentId:doc.id,reviewId,versionId:x.versionId,revision:state.revision+1};}
    }
    const result={ok:true,duplicate:false,...receipt};db.prepare('INSERT INTO document_operations VALUES(?,?,?)').run(key,hash,JSON.stringify(result));db.exec('COMMIT');return Response.json(result);
  }catch(error){db.exec('ROLLBACK');for(const path of filesCreated){try{unlinkSync(path);}catch{/* Unreachable orphan is never served; backup only copies committed references. */}}throw error;}
}

/** Exact reference validation for the existing task discussion, no new messenger. */
export function documentReference(actor:Employee,taskId:string,reference:{documentId:string;versionId:string}) {
 const doc=findDoc(reference.documentId,actor);if(doc.task_id!==taskId)throw new WebError(404,'Документ не относится к задаче.');
 const version=documentTables().prepare('SELECT id,number FROM document_versions WHERE id=? AND document_id=?').get(reference.versionId,doc.id);if(!version)throw new WebError(404,'Версия не найдена.');
 return {documentId:doc.id,versionId:String(version.id),versionNumber:Number(version.number)};
}
