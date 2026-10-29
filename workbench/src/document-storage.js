__modules['document-storage.js']=(()=>{
'use strict';
// This store is local to this browser and origin. It is not a server, a backup,
// Office editing, malware scanning, or a guarantee against browser-data removal.
const MAX_BYTES=20*1024*1024;
const MIME_TYPES=Object.freeze({
  doc:'application/msword',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:'application/pdf'
});
const DB_NAME='pulse-local-document-files-v1', STORE='immutable-files', DRAFT_PREFIX='pulse-document-draft-v1:';
const failure=message=>new Error(message);
function validateFile(file){
  if(!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>240||/[\x00-\x1f\x7f/\\]/.test(file.name))throw failure('Укажите файл с обычным именем длиной до 240 символов.');
  const ext=file.name.lastIndexOf('.')>0?file.name.split('.').pop().toLowerCase():'',type=MIME_TYPES[ext];
  if(!type)throw failure('Поддерживаются только Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx) и PDF.');
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_BYTES)throw failure('Файл должен быть непустым и не больше 20 МиБ (20 971 520 байт).');
  if(file.type&&file.type.toLowerCase()!==type&&file.type.toLowerCase()!=='application/octet-stream')throw failure('Тип файла не соответствует расширению. Проверьте исходный файл; он не сохранён.');
  return {name:file.name.trim(),size:file.size,type};
}
function cryptoAPI(){
  if(!globalThis.crypto?.subtle?.digest)throw failure('В этом браузере недоступна проверка целостности файла. Файл не сохранён. Откройте прототип в поддерживаемом безопасном контексте.');
  return globalThis.crypto;
}
async function digest(bytes){return Array.from(new Uint8Array(await cryptoAPI().subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
function bytesOf(file){
  if(typeof file.arrayBuffer==='function')return file.arrayBuffer();
  if(typeof FileReader==='undefined')return Promise.reject(failure('Этот браузер не может прочитать выбранный файл.'));
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(failure('Файл не удалось прочитать. Выберите его заново.'));reader.onabort=()=>reject(failure('Чтение файла прервано.'));reader.readAsArrayBuffer(file);});
}
function storageError(error){
  if(error?.name==='QuotaExceededError')return failure('В локальном хранилище браузера недостаточно места. Файл не сохранён; прежние версии не изменены.');
  if(error?.name==='ConstraintError')return failure('Такой идентификатор файла уже существует. Перезапись запрещена; прежняя версия не изменена.');
  return failure('Локальное файловое хранилище недоступно. Файл не сохранён или не прочитан; прежние версии не изменены.');
}
function openStore(){
  if(!globalThis.indexedDB?.open)return Promise.reject(failure('Этот браузер не предоставляет локальное файловое хранилище. Файл не сохранён.'));
  return new Promise((resolve,reject)=>{
    let request,settled=false;
    try{request=indexedDB.open(DB_NAME,1);}catch(error){reject(storageError(error));return;}
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'blobKey'});};
    request.onerror=()=>{settled=true;reject(storageError(request.error));};
    request.onblocked=()=>{settled=true;reject(failure('Локальное хранилище занято другой вкладкой. Закройте старые вкладки Pulse и повторите; файл не сохранён.'));};
    request.onsuccess=()=>{if(settled){request.result.close();return;}resolve(request.result);};
  });
}
async function transact(mode,operation){
  const db=await openStore();
  try{return await new Promise((resolve,reject)=>{
    let tx,result,failed=false;
    const rejectOnce=error=>{if(!failed){failed=true;reject(storageError(error));}};
    try{tx=db.transaction(STORE,mode);const request=operation(tx.objectStore(STORE));request.onsuccess=()=>{result=request.result;};request.onerror=()=>rejectOnce(request.error);}catch(error){rejectOnce(error);return;}
    tx.oncomplete=()=>{if(!failed)resolve(result);};tx.onabort=()=>rejectOnce(tx.error);tx.onerror=()=>rejectOnce(tx.error);
  });}finally{db.close();}
}
function uniqueKey(){
  const crypto=cryptoAPI();
  if(typeof crypto.randomUUID==='function')return 'pulse-file:'+crypto.randomUUID();
  if(typeof crypto.getRandomValues!=='function')throw failure('Невозможно создать независимую версию файла в этом браузере.');
  return 'pulse-file:'+Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
}
async function storeFile(file,{documentId}={}){
  const metadata=validateFile(file);
  if(typeof documentId!=='string'||!documentId.trim()||documentId.length>1000)throw failure('Для файла требуется постоянный идентификатор документа.');
  const bytes=await bytesOf(file);
  if(bytes.byteLength!==metadata.size)throw failure('Размер прочитанного файла изменился. Выберите исходный файл заново.');
  const attachment={...metadata,blobKey:uniqueKey(),sha256:await digest(bytes)};
  // add, never put: a collision must fail rather than replace prior bytes.
  await transact('readwrite',store=>store.add({...attachment,documentId,bytes,storedAt:new Date().toISOString()}));
  return attachment;
}
async function readFile(attachment){
  const metadata=validateFile(attachment);
  if(typeof attachment.blobKey!=='string'||!attachment.blobKey||typeof attachment.sha256!=='string'||!/^([a-f0-9]{64})$/.test(attachment.sha256))throw failure('Ссылка на версию файла повреждена. Исходный файл не изменён.');
  const record=await transact('readonly',store=>store.get(attachment.blobKey));
  if(!record)throw failure('Байты этой версии отсутствуют в этом браузере. Возможно, данные браузера очищены или документ открыт на другом устройстве.');
  if(record.name!==metadata.name||record.size!==metadata.size||record.type!==metadata.type||record.sha256!==attachment.sha256||!record.bytes||record.bytes.byteLength!==metadata.size||await digest(record.bytes)!==attachment.sha256)throw failure('Проверка целостности не пройдена. Эта версия файла не будет скачана; исходная запись сохранена.');
  return new Blob([record.bytes],{type:metadata.type});
}
function draftKey(key){if(typeof key!=='string'||!key||key.length>2000)throw failure('Не задана область черновика.');return DRAFT_PREFIX+key;}
function loadDraft(key){try{const raw=localStorage.getItem(draftKey(key));return raw===null?null:JSON.parse(raw);}catch{return null;}}
function saveDraft(key,data){try{const serialized=JSON.stringify(data);if(serialized===undefined)throw failure('Черновик пуст.');localStorage.setItem(draftKey(key),serialized);return {persisted:true};}catch(error){return {persisted:false,error:'Черновик не удалось сохранить в браузере. Не закрывайте форму, пока не скопируете текст.'};}}
function clearDraft(key){try{localStorage.removeItem(draftKey(key));return {persisted:true};}catch{return {persisted:false,error:'Черновик не удалось удалить из локального хранилища.'};}}
return {MAX_BYTES,MIME_TYPES,validateFile,storeFile,readFile,loadDraft,saveDraft,clearDraft};
})();
