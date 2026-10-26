import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export type Employee={id:string;name:string;role?:'employee'|'manager';enabled?:boolean;telegramId?:string;[key:string]:unknown};
export type Source={id:string;employeeId:string;taskId:string|null;text:string;receivedAt:string;occurredAt?:string;dispatched?:boolean};
export type State={employees:Employee[];tasks:any[];sources:any[];events:any[];decisionDrafts?:any[];notifications?:any[];graphRuns?:any[];settings:{timezone:string;startHour:number;endHour:number;minHoursBetween:number;excludedDates:string[]}};
const empty:State={employees:[],tasks:[],sources:[],events:[],settings:{timezone:'Europe/Moscow',startHour:9,endHour:18,minHoursBetween:6,excludedDates:[]}};
let connection:DatabaseSync|undefined;
export function database(){
  if(connection)return connection;
  const dir=process.env.ASSISTANT_DATA_DIR||'.data';mkdirSync(dir,{recursive:true,mode:0o700});
  connection=new DatabaseSync(join(dir,'assistant.sqlite'));
  connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);');
  connection.prepare('INSERT OR IGNORE INTO state VALUES (1,?)').run(JSON.stringify(empty));return connection;
}
export function readState():State{return JSON.parse((database().prepare('SELECT data FROM state WHERE id=1').get() as {data:string}).data);}
export function updateState(fn:(state:State)=>State):State{const db=database();db.exec('BEGIN IMMEDIATE');try{const next=fn(readState());db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(next));db.exec('COMMIT');return next;}catch(error){db.exec('ROLLBACK');throw error;}}
export function getEmployee(id:string){const p=readState().employees.find(e=>e.id===id);if(!p)throw new Error('Участник не зарегистрирован');if(p.enabled===false)throw new Error('Доступ сотрудника отключён');return p;}
export function getSource(id:string):Source{const row=database().prepare('SELECT data,dispatched FROM inbox WHERE id=?').get(id) as {data:string;dispatched:number}|undefined;if(!row)throw new Error('Исходное сообщение не найдено');return {...JSON.parse(row.data),dispatched:!!row.dispatched};}
export function saveSource(s:Source){database().prepare('INSERT OR IGNORE INTO inbox(id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));return getSource(s.id);}
export function markDispatched(id:string){database().prepare('UPDATE inbox SET dispatched=1 WHERE id=?').run(id);}
export function currentEmployee(ctx:any){const id=ctx.session.auth.current?.principalId;if(typeof id!=='string')throw new Error('Нет проверенного пользователя');return getEmployee(id);}
