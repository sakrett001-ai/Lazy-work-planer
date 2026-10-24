// Explicit, one-time initialization only. No listener, invitations or model calls.
import { initializePrototype } from './prototype.mjs';
import { database } from '../agent/lib/store.ts';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--examples') || args.length > 1) {
  console.error('Usage: node scripts/bootstrap-hosted.mjs [--examples]');
  process.exitCode = 1;
} else {
  try {
    const created = initializePrototype({ examples: args.includes('--examples') });
    console.log(created ? 'Initialized hosted data. Issue invitations separately.' : 'Existing data preserved. No invitations issued.');
  } finally { database().close(); }
}
