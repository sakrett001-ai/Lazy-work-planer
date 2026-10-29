import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundle } from '../scripts/document-backup.mjs';
import { restoreBundle } from '../scripts/document-restore.mjs';
function fixture(t, withKey = false) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-document-backup-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 }); mkdirSync(join(data, 'document-blobs'), { mode: 0o700 });
  const db = new DatabaseSync(join(data, 'assistant.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE document_blobs (id TEXT PRIMARY KEY, document_id TEXT, version_id TEXT, name TEXT, sha256 TEXT, size INTEGER); CREATE TABLE web_sessions (id TEXT); CREATE TABLE web_invites (id TEXT); INSERT INTO web_sessions VALUES (\'old-session\'); INSERT INTO web_invites VALUES (\'old-invite\'); CREATE TABLE document_events (id TEXT); INSERT INTO document_events VALUES (\'immutable-event\');');
  const id = randomUUID(), bytes = Buffer.from('synthetic original v1\n');
  db.prepare('INSERT INTO document_blobs VALUES (?,?,?,?,?,?)').run(id, 'doc', 'version', 'synthetic.txt', createHash('sha256').update(bytes).digest('hex'), bytes.length);
  writeFileSync(join(data, 'document-blobs', id), bytes, { mode: 0o600 });
  writeFileSync(join(data, 'document-blobs', randomUUID()), 'unreachable orphan', { mode: 0o600 });
  if (withKey) { db.exec('CREATE TABLE llm_connections (id TEXT); INSERT INTO llm_connections VALUES (\'synthetic-connection\')'); writeFileSync(join(data, 'llm-master.key'), Buffer.alloc(32, 7), { mode: 0o600 }); }
  t.after(() => db.close());
  return { root, data, db, id, bytes, backup: join(root, 'backup'), restored: join(root, 'restored') };
}
test('snapshot backs up committed WAL metadata and bytes, excludes orphan, restores privately with revoked sessions', t => {
  const f = fixture(t); const manifest = createBundle(f.data, f.backup);
  assert.equal(manifest.blobs.length, 1); assert.deepEqual(readdirSync(join(f.backup, 'document-blobs')), [f.id]);
  const result = restoreBundle(f.backup, f.restored); assert.equal(result.sessionsRevoked, true);
  assert.deepEqual(readFileSync(join(f.restored, 'document-blobs', f.id)), f.bytes);
  assert.equal(statSync(f.restored).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.restored, 'document-blobs', f.id)).mode & 0o777, 0o600);
  const restored = new DatabaseSync(join(f.restored, 'assistant.sqlite'));
  try { assert.equal(restored.prepare('SELECT count(*) n FROM web_sessions').get().n, 0); assert.equal(restored.prepare('SELECT count(*) n FROM web_invites').get().n, 0); assert.equal(restored.prepare('SELECT id FROM document_events').get().id, 'immutable-event'); } finally { restored.close(); }
  assert.equal(f.db.prepare('SELECT count(*) n FROM web_sessions').get().n, 1);
  assert.throws(() => restoreBundle(f.backup, f.restored), /must not exist/);
  assert.throws(() => createBundle(f.data, f.backup), /must not exist/);
});
test('backup/restore carries required synthetic connection key and refuses missing key', t => {
  const f = fixture(t, true); createBundle(f.data, f.backup); restoreBundle(f.backup, f.restored);
  assert.deepEqual(readFileSync(join(f.restored, 'llm-master.key')), Buffer.alloc(32, 7));
  rmSync(join(f.backup, 'llm-master.key'));
  assert.throws(() => restoreBundle(f.backup, join(f.root, 'missing-key'))); assert.equal(existsSync(join(f.root, 'missing-key')), false);
});
test('tampered or missing bytes fail before publication, leaving no partial target', t => {
  const f = fixture(t); createBundle(f.data, f.backup);
  writeFileSync(join(f.backup, 'document-blobs', f.id), 'changed');
  assert.throws(() => restoreBundle(f.backup, f.restored), /integrity mismatch/);
  assert.equal(existsSync(f.restored), false);
  assert.equal(readdirSync(f.root).some(p => p.startsWith('.document-restore-')), false);
  rmSync(join(f.data, 'document-blobs', f.id));
  assert.throws(() => createBundle(f.data, join(f.root, 'missing-blob')));
  assert.equal(existsSync(join(f.root, 'missing-blob')), false);
});
test('database and manifest disagreement and symlinked blobs are rejected', t => {
  const f = fixture(t); createBundle(f.data, f.backup);
  const manifest = JSON.parse(readFileSync(join(f.backup, 'manifest.json'))); manifest.blobs[0].id = '../escape';
  writeFileSync(join(f.backup, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => restoreBundle(f.backup, f.restored), /disagree/);
  rmSync(join(f.data, 'document-blobs', f.id)); symlinkSync(join(f.root, 'arbitrary'), join(f.data, 'document-blobs', f.id)); writeFileSync(join(f.root, 'arbitrary'), f.bytes);
  assert.throws(() => createBundle(f.data, join(f.root, 'symlink-blob')));
});
test('database corruption fails hash verification before restore opens database', t => {
  const f = fixture(t); createBundle(f.data, f.backup); writeFileSync(join(f.backup, 'assistant.sqlite'), 'not sqlite');
  assert.throws(() => restoreBundle(f.backup, f.restored), /integrity mismatch/); assert.equal(existsSync(f.restored), false);
});
