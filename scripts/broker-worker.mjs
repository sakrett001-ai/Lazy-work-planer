#!/usr/bin/env node
// Explicit operator-only startup. No model call without a valid admitted IPC request.
import {loadBrokerWorker} from '../agent/lib/broker-worker.ts';
import {runBrokerWorker} from '../agent/lib/broker-ipc.ts';
let worker;
try {
 if(process.argv.length!==4||process.argv[2]!=='--config')throw new Error('arguments');
 worker=loadBrokerWorker(process.argv[3],{fetchImpl:globalThis.fetch});
 if(!worker.enabled){process.stderr.write('BROKER_DISABLED\n');}
 else await runBrokerWorker(worker.handler,process.stdin,process.stdout);
} catch {process.stderr.write('BROKER_UNAVAILABLE\n');process.exitCode=1;}
finally {try{if(worker?.enabled)worker.close();}catch{process.stderr.write('BROKER_UNAVAILABLE\n');process.exitCode=1;}}
