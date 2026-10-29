import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDirectory, blobRows, hasConnections, hashFile, privateCopy, syncFile } from './document-backup.mjs';

export function restoreBundle(bundlePath, targetPath) {
  const bundle = resolve(bundlePath), target = resolve(targetPath);
  assertDirectory(bundle); assertDirectory(dirname(target));
  if (existsSync(target)) throw new Error('Restore destination must not exist; never overwrite an active data directory');
  const manifestFile = join(bundle, 'manifest.json');
  if (hashFile(manifestFile).size > 64 * 1024 * 1024) throw new Error('Manifest too large');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'pulse-document-backup' || manifest.version !== 1 || !Array.isArray(manifest.blobs)) throw new Error('Unsupported backup manifest');
  const validFile = value => value && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0;
  if (!validFile(manifest.database) || (manifest.key !== null && !validFile(manifest.key))) throw new Error('Invalid file manifest');
  const stage = join(dirname(target), `.document-restore-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
  try {
    privateCopy(join(bundle, 'assistant.sqlite'), join(stage, 'assistant.sqlite'), manifest.database);
    const db = new DatabaseSync(join(stage, 'assistant.sqlite'));
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid SQLite backup');
      const blobs = blobRows(db);
      if (JSON.stringify(blobs) !== JSON.stringify(manifest.blobs)) throw new Error('Manifest and database disagree');
      mkdirSync(join(stage, 'document-blobs'), { mode: 0o700 });
      assertDirectory(join(bundle, 'document-blobs'));
      for (const blob of blobs) privateCopy(join(bundle, 'document-blobs', blob.id), join(stage, 'document-blobs', blob.id), blob);
      if (hasConnections(db)) {
        if (!manifest.key || manifest.key.size !== 32) throw new Error('Connection backup requires its private key');
        privateCopy(join(bundle, 'llm-master.key'), join(stage, 'llm-master.key'), manifest.key);
      } else if (manifest.key !== null) throw new Error('Unexpected key metadata');
      // Old login capabilities must not be revived by disaster recovery.
      for (const table of ['web_sessions', 'web_invites']) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally { db.close(); }
    syncFile(join(stage, 'assistant.sqlite')); syncFile(join(stage, 'document-blobs')); syncFile(stage);
    if (existsSync(target)) throw new Error('Restore destination appeared');
    renameSync(stage, target); syncFile(dirname(target));
    return { blobs: manifest.blobs.length, sessionsRevoked: true };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/document-restore.mjs BACKUP_DIR NEW_DATA_DIR');
  const result = restoreBundle(process.argv[2], process.argv[3]);
  console.log(`Verified restore created (${result.blobs} blobs; old sessions revoked): ${resolve(process.argv[3])}`);
}
