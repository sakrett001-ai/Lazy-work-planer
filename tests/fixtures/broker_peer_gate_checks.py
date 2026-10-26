import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('peer_gate', ROOT / 'scripts/broker_peer_gate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PeerGate, GateError = module.PeerGate, module.GateError
WORKER = r'''
import json,os,struct,sys,time
mode,marker=sys.argv[1:]
def exact(n):
 b=b''
 while len(b)<n:
  q=sys.stdin.buffer.read(n-len(b))
  if not q:sys.exit(0)
  b+=q
 return b
while True:
 n=struct.unpack('!I',exact(4))[0];body=exact(n)
 with open(marker,'a') as f:f.write('called\n')
 if mode=='hang':time.sleep(60)
 if mode=='eof':sys.exit(0)
 if mode=='oversize':sys.stdout.buffer.write(struct.pack('!I',65537));sys.stdout.buffer.flush();continue
 if mode=='invalid':out=b'not json'
 else:out=json.dumps({'echo':json.loads(body),'pid':os.getpid()}).encode()
 framed=struct.pack('!I',len(out))+out
 sys.stdout.buffer.write(framed+(framed if mode=='pipeline' else b''));sys.stdout.buffer.flush()
 if mode=='delayedtrail':time.sleep(.05);sys.stdout.buffer.write(b'noise');sys.stdout.buffer.flush()
'''


def recv_all(sock):
 data=b''
 while True:
  try:part=sock.recv(65536)
  except (ConnectionResetError,BrokenPipeError):break
  if not part:break
  data+=part
 return data


class GateChecks(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='peer-gate-');self.dir=Path(self.tmp.name);os.chmod(self.dir,0o700)
  self.socket=self.dir/'broker.sock';self.worker=self.dir/'fake_worker.py';self.worker.write_text(WORKER);self.marker=self.dir/'calls';self.gate=None
 def tearDown(self):
  if self.gate:self.gate.close()
  self.tmp.cleanup()
 def start(self,mode='echo',uid=None,**kw):
  self.gate=PeerGate(str(self.socket),os.getuid() if uid is None else uid,[sys.executable,str(self.worker),mode,str(self.marker)],frame_timeout=kw.get('frame_timeout',.25),worker_timeout=kw.get('worker_timeout',.5)).start();return self.gate
 def connection(self):
  s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(2);s.connect(str(self.socket));return s
 def request(self,body=b'{"value":"synthetic"}',raw=None):
  with self.connection() as s:
   try:s.sendall(raw if raw is not None else struct.pack('!I',len(body))+body);s.shutdown(socket.SHUT_WR)
   except (BrokenPipeError,ConnectionResetError):pass
   return recv_all(s)
 def count(self):return len(self.marker.read_text().splitlines()) if self.marker.exists() else 0
 def test_kernel_peer_credentials_and_persistent_exact_framing(self):
  g=self.start();pid=g.worker_pid
  for _ in range(2):
   r=self.request();n=struct.unpack('!I',r[:4])[0];self.assertEqual(n,len(r)-4);v=json.loads(r[4:]);self.assertEqual(v['echo'],{'value':'synthetic'});self.assertEqual(v['pid'],pid)
  self.assertEqual(self.count(),2);self.assertFalse(g.failed);self.assertEqual(stat.S_IMODE(self.socket.stat().st_mode),0o600)
 def test_real_kernel_uid_mismatch_rejected_before_worker(self):
  self.start(uid=os.getuid()+1);self.assertEqual(self.request(),b'');self.assertEqual(self.count(),0)
 def test_incoming_oversize_zero_truncated_and_trailing_rejected(self):
  self.start()
  for raw in [struct.pack('!I',131073),struct.pack('!I',0),struct.pack('!I',10)+b'{}',struct.pack('!I',2)+b'{}x',struct.pack('!I',8)+b'not json']:
   self.assertEqual(self.request(raw=raw),b'');time.sleep(.01)
  self.assertEqual(self.count(),0);self.assertFalse(self.gate.failed)
 def test_slow_header_and_missing_halfclose_have_absolute_frame_deadline(self):
  self.start(frame_timeout=.1)
  for raw in [b'\0',struct.pack('!I',2)+b'{}']:
   with self.connection() as s:
    begin=time.monotonic();s.sendall(raw);self.assertEqual(recv_all(s),b'');self.assertLess(time.monotonic()-begin,.8)
  self.assertEqual(self.count(),0)
 def test_worker_hang_kills_reaps_and_never_respawns(self):
  g=self.start('hang',worker_timeout=.1);pid=g.worker_pid;self.assertEqual(self.request(),b'');self.assertTrue(g.failed)
  with self.assertRaises(ProcessLookupError):os.kill(pid,0)
  self.assertEqual(self.request(),b'');self.assertEqual(g.worker_pid,pid);self.assertEqual(self.count(),1)
 def test_worker_eof_invalid_oversized_and_coalesced_frames_fail_closed(self):
  for mode in ['eof','invalid','oversize','pipeline']:
   with self.subTest(mode=mode):
    g=self.start(mode);self.assertEqual(self.request(),b'');self.assertTrue(g.failed);g.close();self.gate=None
 def test_delayed_extra_worker_output_rejected_before_reuse(self):
  g=self.start('delayedtrail');self.assertTrue(self.request());time.sleep(.1);self.assertEqual(self.request(),b'');self.assertTrue(g.failed);self.assertEqual(self.count(),1)
 def test_busy_connection_does_not_dispatch_second_request(self):
  g=self.start('hang',worker_timeout=.3)
  with self.connection() as first:
   first.sendall(struct.pack('!I',2)+b'{}');first.shutdown(socket.SHUT_WR)
   end=time.monotonic()+.5
   while self.count()!=1 and time.monotonic()<end:time.sleep(.005)
   self.assertEqual(self.request(),b'');self.assertEqual(self.count(),1);self.assertEqual(recv_all(first),b'')
  self.assertTrue(g.failed)
 def test_existing_file_symlink_and_nonprivate_parent_are_never_changed(self):
  for symlink in [False,True]:
   target=self.dir/'target';target.write_text('preserve')
   if symlink:self.socket.symlink_to(target)
   else:self.socket.write_text('preserve')
   with self.assertRaises(GateError):self.start()
   self.assertTrue(os.path.lexists(self.socket));self.assertEqual(target.read_text(),'preserve');self.socket.unlink()
  os.chmod(self.dir,0o755)
  with self.assertRaises(GateError):self.start()
  self.assertEqual(stat.S_IMODE(self.dir.stat().st_mode),0o755)
 def test_symlink_parent_and_replacement_cleanup_safety(self):
  alias=self.dir/'alias';inner=self.dir/'inner';inner.mkdir(mode=0o700);alias.symlink_to(inner,target_is_directory=True)
  with self.assertRaises(GateError):PeerGate(str(alias/'s'),os.getuid(),[sys.executable,str(self.worker),'echo',str(self.marker)]).start()
  g=self.start();self.socket.unlink();self.socket.write_text('replacement');g.close();self.assertEqual(self.socket.read_text(),'replacement')
 def test_successful_cleanup_removes_only_created_socket(self):
  g=self.start();g.close();self.assertFalse(os.path.lexists(self.socket));self.assertTrue(self.worker.is_file())

if __name__=='__main__':unittest.main(verbosity=2)
