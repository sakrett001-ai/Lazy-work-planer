# Synthetic local test launcher, not an installable service.
import sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'scripts'))
from broker_peer_gate import PeerGate
node,socket_path,uid,config=sys.argv[1:]
gate=PeerGate(socket_path,int(uid),[node,str(root/'tests/fixtures/broker-ipc-worker.mjs'),config],frame_timeout=2.0,worker_timeout=5.0)
try:
    gate.start()
    print('READY',flush=True)
    sys.stdin.readline()
finally:gate.close()
