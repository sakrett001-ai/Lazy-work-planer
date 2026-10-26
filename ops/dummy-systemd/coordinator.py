#!/usr/bin/python3
"""Future explicitly approved dummy target gate; no remote action or credentials.
Root stages fixed dummy files; systemd (not a root child) establishes service identities.
"""
import hashlib,json,os,pathlib,pwd,signal,stat,subprocess,sys,time
BASE=pathlib.Path('/run/pulse-native-dummy-systemd-01')
UNITS=('pulse-native-dummy-broker-01.service','pulse-native-dummy-client-01.service')
SYSTEMCTL='/usr/bin/systemctl'
PEER=pathlib.Path('/opt/pulse-releases/5d7235b799a35ab103de936e3646c529c69a37f2/scripts/broker_peer_gate.py')
PEER_HASH='3b1411d1288ba014ba779f854cf1da19ccf174357cdf68cc552f57bcee15c2c7'
ENV={'PATH':'/usr/bin:/bin','LANG':'C'}
COMMON=('Type=exec','RemainAfterExit=yes','Restart=no','RuntimeMaxSec=12','TimeoutStartSec=3','TimeoutStopSec=2','KillMode=control-group','SendSIGKILL=yes','UMask=0077','LimitCORE=0','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','ProtectSystem=strict','ProtectHome=yes','PrivateTmp=yes','PrivateDevices=yes','ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectControlGroups=yes','RestrictSUIDSGID=yes','RestrictAddressFamilies=AF_UNIX','IPAddressDeny=any','MemoryMax=64M','TasksMax=16','CPUQuota=50%')
class Stop(Exception):pass
def need(v):
 if not v:raise Stop()
def command(args,timeout=1):
 return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,env=ENV,text=True,check=False)
def info(unit):
 need(unit in UNITS)
 r=command([SYSTEMCTL,'show','--property=LoadState,ActiveState,SubState,ControlGroup,Result,ExecMainStatus',unit])
 d=dict(line.split('=',1) for line in r.stdout.splitlines() if '=' in line)
 if d.get('LoadState')=='not-found':
  need(r.returncode in (0,1) and d.get('ControlGroup','')=='' and not pathlib.Path('/sys/fs/cgroup/system.slice/'+unit).exists())
 else:need(r.returncode==0)
 return d
def group_empty(unit,d):
 expected='/system.slice/'+unit
 need(d.get('ControlGroup') in ('',expected));p=pathlib.Path('/sys/fs/cgroup'+expected)
 try:return dict(x.split() for x in (p/'cgroup.events').read_text().splitlines()).get('populated')=='0'
 except FileNotFoundError:return not p.exists()
def empty(unit):
 d=info(unit)
 return d.get('ActiveState') in ('inactive','failed') and group_empty(unit,d)
def completed(unit):
 d=info(unit)
 if d.get('ActiveState')=='failed':raise Stop()
 return d.get('ActiveState')=='active' and d.get('SubState')=='exited' and d.get('Result')=='success' and d.get('ExecMainStatus')=='0' and group_empty(unit,d)
def trusted(path,digest):
 need(path.is_absolute() and path.resolve()==path)
 for p in [path,*path.parents]:
  s=p.lstat();need(s.st_uid==0 and not s.st_mode&0o022)
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<65536)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:need(hashlib.sha256(os.read(fd,65537)).hexdigest()==digest)
 finally:os.close(fd)
def launch(role,fixture):
 unit=UNITS[0 if role=='broker' else 1]
 props=COMMON+(('User=997','Group=986','SupplementaryGroups=987') if role=='broker' else ('User=999','Group=988','SupplementaryGroups=986'))
 props+=('ReadWritePaths='+str(BASE/('broker-private' if role=='broker' else 'app-private'))+((' '+str(BASE/'ipc')) if role=='broker' else ''),)
 args=['/usr/bin/systemd-run','--quiet','--unit='+unit]
 for p in props:args+=['--property='+p]
 return args+['/usr/bin/python3','-I','-B',str(fixture),role]
def stage():
 need(not os.path.lexists(BASE));BASE.mkdir(mode=0o711);BASE.chmod(0o711)
 # Root-owned during every write; no exposed partially written dummy data.
 for name in ('broker-private','app-private','ipc'):(BASE/name).mkdir(mode=0o700)
 for name,uid,gid in (('broker-private',997,987),('app-private',999,988)):
  fd=os.open(BASE/name/'dummy',os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_WRONLY,0o600)
  try:os.write(fd,b'DUMMY-NOT-A-PROVIDER-KEY');os.fchown(fd,uid,gid)
  finally:os.close(fd)
 for name,uid,gid,mode in (('broker-private',997,987,0o700),('app-private',999,988,0o700),('ipc',997,986,0o750)):
  os.chown(BASE/name,uid,gid);os.chmod(BASE/name,mode)
def stop_all():
 try:command([SYSTEMCTL,'stop',*UNITS],timeout=3)
 except (OSError,subprocess.TimeoutExpired):pass
 for unit in UNITS:
  try:command([SYSTEMCTL,'kill','--kill-whom=all','--signal=SIGKILL',unit])
  except (OSError,subprocess.TimeoutExpired):pass
 need(all(empty(u) for u in UNITS))
def collect_cleanup():
 # Only after empty cgroups. Reclaim directory control BEFORE inspecting/unlinking leaves.
 allowed={'broker-private':{'dummy','calls','receipt.json'},'app-private':{'dummy','receipt.json'},'ipc':{'ready'}}
 for name in allowed:os.chown(BASE/name,0,0);os.chmod(BASE/name,0o700)
 receipts={}
 for name in ('broker-private','app-private'):
  p=BASE/name/'receipt.json';fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_size<4096);receipts[name]=json.loads(os.read(fd,4096))
  finally:os.close(fd)
 need(receipts['broker-private']=={'dummyOnly':True,'identity':997,'privateReadAndCrossUidDenied':True,'wrongUidRejectedBeforeWorker':True,'workerDeadlineKilledReaped':True,'socketRemovedByOwner':True,'workerCalls':2})
 need(receipts['app-private']=={'dummyOnly':True,'identity':999,'privateReadAndCrossUidDenied':True,'positivePeerResponse':True,'deadlineReturnedNoResponse':True})
 entries=[]
 for name,names in allowed.items():
  directory=BASE/name; actual=list(directory.iterdir());need({p.name for p in actual}==names)
  for p in actual:
   s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1);entries.append((p,s.st_dev,s.st_ino))
 for p,dev,ino in entries:
  s=p.lstat();need((s.st_dev,s.st_ino)==(dev,ino));p.unlink()
 for name in allowed:(BASE/name).rmdir()
 BASE.rmdir();return receipts

def main(argv):
 need(os.geteuid()==0 and len(argv)==2)
 fixture,fixture_hash=pathlib.Path(argv[0]),argv[1]
 trusted(fixture,fixture_hash);trusted(PEER,PEER_HASH)
 need(pwd.getpwuid(997).pw_gid==987 and pwd.getpwuid(999).pw_gid==988)
 need(all(info(u).get('LoadState')=='not-found' and empty(u) for u in UNITS))
 os.umask(0o077);stage()
 start=time.monotonic();success=False
 def expired(*_):raise Stop()
 signal.signal(signal.SIGALRM,expired);signal.signal(signal.SIGTERM,expired);signal.signal(signal.SIGINT,expired);signal.alarm(20)
 try:
  for role in ('broker','client'):need(command(launch(role,fixture),timeout=4).returncode==0)
  while not all(completed(u) for u in UNITS):time.sleep(.1)
  success=True
 finally:
  signal.alarm(0);signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
  stop_all()
 need(success and time.monotonic()-start<30)
 receipts=collect_cleanup()
 print(json.dumps({'dummyOnly':True,'noProviderCalls':True,'cgroupsEmpty':True,'fixturesRemoved':True,'runtimeSeconds':round(time.monotonic()-start,3),'checks':receipts},sort_keys=True))
if __name__=='__main__':
 try:main(sys.argv[1:])
 except BaseException:
  print('DUMMY_GATE_REFUSED: no retry; preserve partial fixture and reconcile exact units.',file=sys.stderr);sys.exit(1)
