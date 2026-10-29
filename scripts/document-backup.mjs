import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, chmodSync, copyFileSync, renameSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function hashFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular file');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return { sha256: hash.digest('hex'), size: stat.size };
  } finally { closeSync(fd); }
}
export function syncFile(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function privateCopy(source, target, expected) {
  // Check both sides of the copy; no symlink or partial/corrupt source is accepted.
  const before = hashFile(source);
  if (expected && (before.sha256 !== expected.sha256 || before.size !== expected.size)) throw new Error('File integrity mismatch');
  copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
  const after = hashFile(target);
  if (after.sha256 !== before.sha256 || after.size !== before.size) throw new Error('File changed during copy');
  syncFile(target); return after;
}
export function blobRows(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_blobs'").get()) return [];
  return db.prepare('SELECT id, sha256, size FROM document_blobs ORDER BY id').all().map(row => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) || !/^[0-9a-f]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0) throw new Error('Invalid blob metadata');
    return { id: row.id, sha256: row.sha256, size: row.size };
  });
}
export function hasConnections(db) { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_connections'").get() && db.prepare('SELECT count(*) AS n FROM llm_connections').get().n); }
export function assertDirectory(path) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Expected a non-symlink directory'); }
export function createBundle(dataPath, targetPath) {
  const data = resolve(dataPath), target = resolve(targetPath);
  assertDirectory(data); if (existsSync(target)) throw new Error('Backup destination must not exist');
  assertDirectory(dirname(target));
  const stage = join(dirname(target), `.document-backup-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
  try {
    hashFile(join(data, 'assistant.sqlite'));
    const db = new DatabaseSync(join(data, 'assistant.sqlite'), { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(join(stage, 'assistant.sqlite')); } finally { db.close(); }
    chmodSync(join(stage, 'assistant.sqlite'), 0o600);
    const snapshot = new DatabaseSync(join(stage, 'assistant.sqlite'), { readOnly: true }); let blobs, needsKey;
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid SQLite snapshot');
      blobs = blobRows(snapshot); needsKey = hasConnections(snapshot);
    } finally { snapshot.close(); }
    mkdirSync(join(stage, 'document-blobs'), { mode: 0o700 });
    if (blobs.length) assertDirectory(join(data, 'document-blobs'));
    for (const blob of blobs) privateCopy(join(data, 'document-blobs', blob.id), join(stage, 'document-blobs', blob.id), blob);
    let key = null;
    if (needsKey) {
      const keyPath = join(data, 'llm-master.key'), stat = lstatSync(keyPath);
      if (stat.size !== 32 || (stat.mode & 0o077) !== 0) throw new Error('Invalid private key');
      key = privateCopy(keyPath, join(stage, 'llm-master.key'));
    }
    syncFile(join(stage, 'assistant.sqlite'));
    const manifest = { format: 'pulse-document-backup', version: 1, createdAt: new Date().toISOString(), database: hashFile(join(stage, 'assistant.sqlite')), blobs, key };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(join(stage, 'manifest.json')); syncFile(join(stage, 'document-blobs')); syncFile(stage);
    if (existsSync(target)) throw new Error('Backup destination appeared');
    renameSync(stage, target); syncFile(dirname(target)); return manifest;
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/document-backup.mjs DATA_DIR NEW_BACKUP_DIR');
  const manifest = createBundle(process.argv[2], process.argv[3]);
  console.log(`Verified backup created (${manifest.blobs.length} blobs): ${resolve(process.argv[3])}`);
}
