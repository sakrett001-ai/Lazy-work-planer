(()=>{
'use strict';
// Explicit server mode. Network errors never select the local demo adapter.
window.__PULSE_MODE='server';
const nativeFetch=window.fetch.bind(window), reads=new Set(), docs=new Map(), tasks=new Map(), drafts=new Map();
let actor=null,csrf='';
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
async function json(url,options={}){const r=await nativeFetch(url,{credentials:'same-origin',redirect:'error',...options});if(!r.ok)return {error:r};return {data:await r.json()};}
const endpoint=path=>new URL('/assistant/api/'+path,document.baseURI);
const post=(path,body)=>nativeFetch(endpoint(path),{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
async function receipt(promise,taskId){const r=await promise;if(!r.ok)return r;return response({...await r.json(),taskId});}
function projected(doc){
 const last=doc.reviews.filter(x=>x.version_id===doc.latestVersionId).at(-1),status=!doc.latestVersionId?'requested':last?.decision==='return'?'returned':last?.decision==='approve'?'curator_accepted':last?.decision==='accept'?'accepted':'submitted';
 const artifacts=doc.versions.map(v=>({id:v.id,requestId:doc.id,documentId:doc.id,taskId:doc.task_id,title:doc.title,version:v.number,createdAt:v.created_at,authorId:v.actor_id,sections:[{heading:'Содержание версии',body:v.text}],criteria:[],sourceIds:[],attachments:doc.attachments.filter(f=>f.version_id===v.id).map(f=>({...f,documentId:doc.id,blobKey:f.id,type:'application/octet-stream'}))}));
 return {request:{id:doc.id,documentId:doc.id,taskId:doc.task_id,text:doc.title,kind:'result',version:doc.revision,ownerId:doc.owner_id,curatorId:doc.curator_id,coexecutorIds:doc.coexecutorIds,status,artifactId:doc.latestVersionId,acceptedArtifactId:doc.acceptedVersionId,criteria:[],deliveredAt:doc.created_at,acknowledgedAt:doc.created_at,requiredRemarks:last?.decision==='return'?last.comment:'',reviews:doc.reviews.map(r=>({artifactId:r.version_id,action:{approve:'curator_accept',accept:'manager_accept',return:'return'}[r.decision],reason:r.comment,actorId:r.actor_id,at:r.created_at})),artifactReads:doc.versions.filter(v=>reads.has(actor?.id+':'+v.id)).map(v=>({actorId:actor.id,artifactId:v.id}))},artifacts};
}
function requestState(list){const mapped=list.map(projected),requests=mapped.map(x=>x.request);return {requests,artifacts:mapped.flatMap(x=>x.artifacts),pending:requests.filter(r=>r.status!=='accepted')};}
function stub(doc){return {id:doc.task_id,title:doc.title,employeeId:doc.owner_id,status:'active',version:String(doc.revision),project:'Только доступ к документу',summary:'Назначенный документ. Поручение и переписка не предоставлены.',canControl:false,documentOnly:true,priority:'normal',supervision:true};}
window.fetch=async(url,options={})=>{
 const u=new URL(url,document.baseURI);if(u.origin!==location.origin||!u.pathname.startsWith('/assistant/api/'))throw Error('Серверный режим разрешает только API этого сервера.');
 const path=u.pathname.slice('/assistant/api/'.length);
 if(path==='request-action'){
  const b=JSON.parse(options.body),x=b.input,doc=docs.get(x.documentId||x.requestId);
  if(x.action==='create')return receipt(post('documents',{requestId:b.requestId,taskId:b.taskId,title:x.text,curatorId:x.curatorId,coexecutorIds:[]}),b.taskId);
  if(!doc)return new Response(JSON.stringify({error:'Документ не найден. Обновите карточку.'}),{status:404});
  if(x.action==='open_artifact'){if(!doc.versions.some(v=>v.id===x.artifactId))return new Response('{}',{status:404});reads.add(actor.id+':'+x.artifactId);return response({ok:true,taskId:b.taskId});}
  if(x.action==='submit'){
   const files=[];for(const f of x.artifact.attachments||[]){if(f.base64)files.push({name:f.name,base64:f.base64});else{const r=await nativeFetch(endpoint('documents/'+doc.id+'/blobs/'+f.blobKey),{credentials:'same-origin',redirect:'error'});if(!r.ok)return r;files.push({name:f.name,base64:toBase64(await r.arrayBuffer())});}}
   const text=x.artifact.sections.map(s=>s.body).join('\n\n')+(x.response?'\n\nКак устранены замечания:\n'+x.response:'');
   return receipt(post('documents/'+doc.id+'/versions',{requestId:b.requestId,expectedRevision:x.expectedVersion,text,files}),b.taskId);
  }
  const decision={return:'return',curator_accept:'approve',manager_accept:'accept'}[x.action];
  if(decision)return receipt(post('documents/'+doc.id+'/reviews',{requestId:b.requestId,expectedRevision:x.expectedVersion,versionId:x.artifactId,decision,comment:x.reason||''}),b.taskId);
  return new Response(JSON.stringify({error:'Это действие доступно только в локальной модели.'}),{status:400});
 }
 if(path==='tasks'){
  const [a,b]=await Promise.all([json(u,options),json(endpoint('documents'))]);if(a.error)return a.error;if(b.error)return b.error;
  docs.clear();b.data.documents.forEach(d=>docs.set(d.id,d));tasks.clear();a.data.tasks.forEach(t=>tasks.set(t.id,t));for(const d of docs.values())if(!tasks.has(d.task_id))tasks.set(d.task_id,stub(d));
  return response({...a.data,tasks:[...tasks.values()]});
 }
 if(path==='memory'){
  const id=u.searchParams.get('taskId'),t=tasks.get(id),b=await json(endpoint('documents?taskId='+encodeURIComponent(id)));if(b.error)return b.error;b.data.documents.forEach(d=>docs.set(d.id,d));
  let data;if(t?.documentOnly){data={task:t,current:t,title:t.title,taskVersion:b.data.documents.map(d=>d.revision).join(':'),currentActor:actor,children:[],drafts:[],facts:[],timeline:[],sources:[],conversation:[],page:{nextBefore:null}};}else{const a=await json(u,options);if(a.error)return a.error;data=a.data;}
  const link=s=>s.documentReference?{...s,artifactId:s.documentReference.versionId,documentId:s.documentReference.documentId}:s;
  return response({...data,requestState:requestState(b.data.documents),conversation:(data.conversation||[]).map(link),sources:(data.sources||[]).map(link)});
 }
 const r=await nativeFetch(u,options);
 if(path==='session'&&r.ok){const s=await r.clone().json();actor=s.actor;csrf=s.csrf;}
 if(path==='logout'&&r.ok){actor=null;csrf='';reads.clear();docs.clear();tasks.clear();drafts.clear();}
 return r;
};
function toBase64(bytes){let s='';const a=new Uint8Array(bytes);for(let i=0;i<a.length;i+=16384)s+=String.fromCharCode(...a.subarray(i,i+16384));return btoa(s);}
const MAX_BYTES=2*1024*1024;
function validateFile(f){if(!f?.name||f.name.length>180||/[\x00-\x1f\x7f/\\]/.test(f.name)||! /\.(txt|md|csv|pdf|docx|xlsx)$/i.test(f.name))throw Error('Допустимы TXT, MD, CSV, PDF, DOCX и XLSX; обычное имя до 180 символов.');if(!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX_BYTES)throw Error('Файл должен быть непустым и не больше 2 МиБ.');return {name:f.name,size:f.size,type:f.type||'application/octet-stream'};}
function bytesOf(file){if(file.arrayBuffer)return file.arrayBuffer();return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Не удалось прочитать файл.'));r.readAsArrayBuffer(file);});}
__modules['document-storage.js']={MAX_BYTES,validateFile,async storeFile(file){return {...validateFile(file),base64:toBase64(await bytesOf(file)),blobKey:'pending:'+crypto.randomUUID()};},async readFile(f){const r=await nativeFetch(endpoint('documents/'+f.documentId+'/blobs/'+f.blobKey),{credentials:'same-origin',redirect:'error'});if(!r.ok)throw Error('Сервер не подтвердил доступ или целостность файла. Обновите карточку и повторите.');return r.blob();},loadDraft:key=>drafts.get(actor?.id+':'+key)||null,saveDraft(key,value){drafts.set(actor?.id+':'+key,value);return {persisted:false,error:'Черновик только в памяти этой вкладки. На сервер ещё не передан; перед закрытием скопируйте текст.'};},clearDraft(key){drafts.delete(actor?.id+':'+key);return {persisted:true};}};
window.__PULSE_SERVER={projected,requestState,validateFile};
})();
