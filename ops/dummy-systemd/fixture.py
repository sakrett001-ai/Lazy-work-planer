#!/usr/bin/python3
"""Dummy-only Unix fixture. systemd chooses identity; this program never changes UID/GID.
No providers, secrets, HTTP, retries, service management or privilege elevation.
"""
import errno, hashlib, importlib.util, json, os, pathlib, signal, socket, stat, struct, sys, time
BASE = pathlib.Path('/run/pulse-native-dummy-systemd-01')
PEER = pathlib.Path('/opt/pulse-releases/5d7235b799a35ab103de936e3646c529c69a37f2/scripts/broker_peer_gate.py')
PEER_SHA256 = '3b1411d1288ba014ba779f854cf1da19ccf174357cdf68cc552f57bcee15c2c7'
DUMMY = b'DUMMY-NOT-A-PROVIDER-KEY'
WORKER = '''import json,os,struct,sys,time
count=0
while True:
 h=sys.stdin.buffer.read(4)
 if not h:break
 assert len(h)==4
 n=struct.unpack('!I',h)[0];assert 0<n<1024
 b=sys.stdin.buffer.read(n);assert len(b)==n
 flags=os.O_WRONLY|os.O_NOFOLLOW|(os.O_CREAT|os.O_EXCL if count==0 else os.O_APPEND)
 fd=os.open(sys.argv[1],flags,0o600)
 try:os.write(fd,b'called\\n')
 finally:os.close(fd)
 count+=1
 if json.loads(b).get('mode')=='deadline':time.sleep(30)
 out=b'{"dummy":true}'
 sys.stdout.buffer.write(struct.pack('!I',len(out))+out);sys.stdout.buffer.flush()
'''
class Stop(Exception): pass
def need(ok):
    if not ok: raise Stop()
def identity(role):
    uid,gid,supp=(997,986,987) if role=='broker' else (999,988,986)
    need(os.getuid()==uid and os.geteuid()==uid and os.getgid()==gid and os.getegid()==gid)
    groups=set(os.getgroups());need(supp in groups and groups<={gid,supp})
    values=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
    need(int(values['CapEff'].strip(),16)==0 and values['NoNewPrivs'].strip()=='1')
def private_access(role):
    other='app' if role=='broker' else 'broker'
    own=BASE/(role+'-private')/'dummy'
    fd=os.open(own,os.O_RDONLY|os.O_NOFOLLOW)
    try: need(os.read(fd,128)==DUMMY)
    finally: os.close(fd)
    try: fd=os.open(BASE/(other+'-private')/'dummy',os.O_RDONLY|os.O_NOFOLLOW)
    except OSError as e: need(e.errno==errno.EACCES)
    else:
        os.close(fd);raise Stop()
def create(path,body,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        os.fchmod(fd,mode);need(os.write(fd,body)==len(body));os.fsync(fd)
    finally: os.close(fd)
def trusted_gate():
    need(PEER.is_absolute() and PEER.resolve()==PEER)
    for p in [PEER,*PEER.parents]:
        s=p.lstat();need(s.st_uid==0 and not s.st_mode&0o022)
    s=PEER.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<65536)
    fd=os.open(PEER,os.O_RDONLY|os.O_NOFOLLOW)
    try: need(hashlib.sha256(os.read(fd,65537)).hexdigest()==PEER_SHA256)
    finally: os.close(fd)
    spec=importlib.util.spec_from_file_location('reviewed_dummy_peer',PEER);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod.PeerGate

def request(body):
    need(isinstance(body,bytes) and len(body)<1024)
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(2);s.connect(str(BASE/'ipc/broker.sock'))
        try: s.sendall(struct.pack('!I',len(body))+body);s.shutdown(socket.SHUT_WR)
        except (BrokenPipeError,ConnectionResetError): pass
        data=b''
        while True:
            try: b=s.recv(2048)
            except ConnectionResetError: break
            if not b: break
            data+=b;need(len(data)<2048)
        return data

def broker():
    identity('broker');private_access('broker');gate=None
    try:
        gate=trusted_gate()(str(BASE/'ipc/broker.sock'),999,['/usr/bin/python3','-I','-B','-c',WORKER,str(BASE/'broker-private/calls')],frame_timeout=.3,worker_timeout=.3,worker_env={'PATH':'/usr/bin:/bin','LANG':'C'}).start()
        s=(BASE/'ipc/broker.sock').lstat()
        need(stat.S_ISSOCK(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(997,986,0o660))
        # UID997 is an authenticated wrong peer; rejection must precede worker dispatch.
        need(request(b'{"mode":"wrong-peer"}')==b'')
        need(not os.path.lexists(BASE/'broker-private/calls') and not gate.failed and gate.worker_alive)
        create(BASE/'ipc/ready',b'wrong-peer-rejected\n',0o640)
        until=time.monotonic()+9
        while not (gate.failed and not gate.worker_alive) and time.monotonic()<until: time.sleep(.02)
        need(gate.failed and not gate.worker_alive)
        need((BASE/'broker-private/calls').read_bytes()==b'called\ncalled\n')
        gate.close();need(not os.path.lexists(BASE/'ipc/broker.sock'))
        create(BASE/'broker-private/receipt.json',json.dumps({'dummyOnly':True,'identity':997,'privateReadAndCrossUidDenied':True,'wrongUidRejectedBeforeWorker':True,'workerDeadlineKilledReaped':True,'socketRemovedByOwner':True,'workerCalls':2}).encode())
    finally:
        if gate is not None: gate.close()

def client():
    identity('app');private_access('app')
    until=time.monotonic()+8
    while not os.path.lexists(BASE/'ipc/ready') and time.monotonic()<until: time.sleep(.02)
    p=BASE/'ipc/ready';s=p.lstat();need(stat.S_ISREG(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(997,986,0o640))
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try: need(os.read(fd,128)==b'wrong-peer-rejected\n')
    finally: os.close(fd)
    need(request(b'{"mode":"positive"}')==struct.pack('!I',14)+b'{"dummy":true}')
    # A new request follows completed prior response; no automatic retry on gate busy/failure.
    time.sleep(.05)
    started=time.monotonic();need(request(b'{"mode":"deadline"}')==b'');need(time.monotonic()-started<2)
    create(BASE/'app-private/receipt.json',json.dumps({'dummyOnly':True,'identity':999,'privateReadAndCrossUidDenied':True,'positivePeerResponse':True,'deadlineReturnedNoResponse':True}).encode())

def interrupted(*_): raise Stop()
def main(argv):
    need(argv in (['broker'],['client']))
    os.umask(0o077)
    for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT): signal.signal(sig,interrupted)
    signal.alarm(12)
    try: (broker if argv==['broker'] else client)()
    finally: signal.alarm(0)
if __name__=='__main__':
    try: main(sys.argv[1:])
    except BaseException:
        print('DUMMY_FIXTURE_STOP; no retry; retain partial state for exact reconciliation.',file=sys.stderr);sys.exit(1)
