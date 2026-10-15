import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dataDir = resolve(process.env.ASSISTANT_DATA_DIR || '.data');
const source = join(dataDir, 'assistant.sqlite');
const target = resolve(process.argv[2] || join(dataDir, 'backups', 'assistant-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite'));
if (source === target) throw new Error('Копия должна быть отдельным файлом');
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
} finally { copy.close(); }
console.log('Проверенная резервная копия: ' + target);
