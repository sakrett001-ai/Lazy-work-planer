import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const secretKeyPath = () => join(process.env.ASSISTANT_DATA_DIR || '.data', 'llm-master.key');

export function readSecretKey(): Buffer {
  const fd = openSync(secretKeyPath(), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Invalid secret store key');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function masterKey(allowCreate: boolean) {
  if (!existsSync(secretKeyPath()) && allowCreate) {
    mkdirSync(process.env.ASSISTANT_DATA_DIR || '.data', { recursive: true, mode: 0o700 });
    const fd = openSync(secretKeyPath(), 'wx', 0o600), value = randomBytes(32);
    try { writeFileSync(fd, value); fsyncSync(fd); }
    finally { value.fill(0); closeSync(fd); }
  }
  return readSecretKey();
}
export function sealSecret(value: string, identity: string, allowCreate = false) {
  const key = masterKey(allowCreate);
  try {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(identity));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  } finally { key.fill(0); }
}
export function openSecret(envelope: string, identity: string) {
  const key = readSecretKey();
  try {
    if (envelope.length > 20000) throw new Error('Invalid envelope');
    const value = JSON.parse(envelope), iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64');
    if (value.v !== 1 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(identity)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } finally { key.fill(0); }
}
