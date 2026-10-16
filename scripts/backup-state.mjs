import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readSecretKey } from '../agent/lib/llm-secrets.ts';

const dataDir = resolve(process.env.ASSISTANT_DATA_DIR || '.data');
const source = join(dataDir, 'assistant.sqlite');
const target = resolve(process.argv[2] || join(dataDir, 'backups', 'assistant-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite'));
if (source === target) throw new Error('Копия должна быть отдельным файлом');
if (existsSync(target + '.llm-key')) throw new Error('Файл ключа резервной копии уже существует; выберите другое имя копии');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try {
  // Reserve a private, new file atomically; VACUUM INTO accepts an empty file.
  closeSync(openSync(target, 'wx', 0o600));
  db.prepare('VACUUM INTO ?').run(target);
} finally { db.close(); }
chmodSync(target, 0o600);
const copy = new DatabaseSync(target, { readOnly: true });
try {
  if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Проверка целостности копии не пройдена');
  const hasConnections = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_connections'").get();
  if (hasConnections && copy.prepare('SELECT count(*) AS n FROM llm_connections').get().n > 0) {
    const key = readSecretKey();
    try { writeFileSync(target + '.llm-key', key, { flag: 'wx', mode: 0o600 }); }
    finally { key.fill(0); }
    console.log('Ключ восстановления подключений: ' + target + '.llm-key');
  }
} finally { copy.close(); }
console.log('Проверенная резервная копия: ' + target);
