#!/usr/bin/env python3
"""One authorized foreground run only. No credentials, cloud mutations or automatic retries.
Only run after separately approved target staging and verified rendered units/nft policy.
"""
import json, os, re, signal, stat, subprocess, sys, time
from pathlib import Path
ROOT=Path('/run/pulse-native-smoke')
UNITS=('pulse-native-app.service','pulse-native-broker.service')
SYSTEMCTL='/usr/bin/systemctl'
class Refused(Exception): pass

def private_json(path):
    p=path.parent; d=p.lstat()
    if p.resolve()!=p or not stat.S_ISDIR(d.st_mode) or d.st_uid!=0 or stat.S_IMODE(d.st_mode)!=0o700: raise Refused()
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0o600 or not 0<s.st_size<=8192: raise Refused()
        b=os.read(fd,8193)
        if len(b)!=s.st_size: raise Refused()
        return json.loads(b)
    finally: os.close(fd)

def check_gate(root=ROOT):
    a=private_json(root/'control/provisioned.json'); b=private_json(root/'control/payload-denied.json')
    if set(b)!={'schemaVersion','secretId','versionId','payloadHttpStatus'} or b['schemaVersion']!=1 or b['payloadHttpStatus']!=403: raise Refused()
    if any(a.get(k)!=b[k] for k in ('secretId','versionId')): raise Refused()
    role=private_json(root/'control/role-removal.json')
    if set(role)!={'schemaVersion','secretId','versionId','bindingAbsent','folderBindingsUnchanged','serviceAccountUnchanged','evidenceSha256'}: raise Refused()
    if role['schemaVersion']!=1 or any(role.get(k)!=b[k] for k in ('secretId','versionId')): raise Refused()
    if any(role[k] is not True for k in ('bindingAbsent','folderBindingsUnchanged','serviceAccountUnchanged')): raise Refused()
    if not isinstance(role['evidenceSha256'],str) or not re.fullmatch('[a-f0-9]{64}',role['evidenceSha256']): raise Refused()
    if not 0<=time.time()-(root/'control/role-removal.json').stat().st_mtime<=300: raise Refused()
    # No old proof reused after role changes; still requires operator role-binding readback.
    age=time.time()-(root/'control/payload-denied.json').stat().st_mtime
    if not 0<=age<=300: raise Refused()

def ctl(*args, timeout=3):
    return subprocess.run([SYSTEMCTL,*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout,check=False,env={'PATH':'/usr/bin:/bin','LANG':'C'},text=True)

def stopped(unit):
    if unit not in UNITS: raise Refused()
    r=ctl('show','--property=ActiveState,ControlGroup',unit)
    fields=dict(line.split('=',1) for line in r.stdout.splitlines() if '=' in line)
    expected='/system.slice/'+unit
    if r.returncode or fields.get('ActiveState') not in ('inactive','failed') or fields.get('ControlGroup') not in ('',expected): return False
    path=Path('/sys/fs/cgroup'+expected)
    try:
        values=dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
        return values.get('populated')=='0'
    except FileNotFoundError:
        return not path.exists()

def wait_socket():
    until=time.monotonic()+8
    while time.monotonic()<until:
        try:
            s=(ROOT/'ipc/broker.sock').lstat()
            if stat.S_ISSOCK(s.st_mode) and s.st_uid==997 and s.st_gid==986 and stat.S_IMODE(s.st_mode)==0o660: return
        except FileNotFoundError: pass
        time.sleep(.1)
    raise Refused()

def run():
    if os.geteuid()!=0: raise Refused()
    check_gate()
    if not all(stopped(u) for u in UNITS): raise Refused()
    # Exhausted even if launch fails: no automatic restart or second allocation.
    fd=os.open(ROOT/'control/run-started',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.close(fd)
    begin=time.monotonic(); until=begin+560; success=False
    def interrupted(*_): raise Refused()
    signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted)
    try:
        if ctl('start',UNITS[0],timeout=12).returncode: raise Refused()
        time.sleep(.2)
        while time.monotonic()<until:
            if stopped(UNITS[0]):
                r=ctl('show','--property=Result','--value',UNITS[0]); success=r.returncode==0 and r.stdout.strip()=='success'; break
            if stopped(UNITS[1]): raise Refused()
            time.sleep(.25)
    finally:
        signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGINT,signal.SIG_IGN)
        try: ctl('stop','--no-block',*UNITS)
        except (OSError, subprocess.TimeoutExpired): pass
        stop_end=min(time.monotonic()+12,begin+575)
        while time.monotonic()<stop_end:
            try:
                if all(stopped(u) for u in UNITS): break
            except (OSError, ValueError, subprocess.TimeoutExpired): break
            time.sleep(.2)
        for unit in UNITS:
            try: ctl('kill','--kill-whom=all','--signal=SIGKILL',unit)
            except (OSError, subprocess.TimeoutExpired): pass
        if not all(stopped(u) for u in UNITS): raise Refused()
    if not success: raise Refused()

if __name__=='__main__':
    try:
        if sys.argv[1:]==['wait-socket']: wait_socket()
        elif sys.argv[1:]==['--run-approved-once']: run()
        else: raise Refused()
    except BaseException:
        print('Finite smoke stopped or refused; preserve ledgers and reconcile unknown outcomes.',file=sys.stderr)
        sys.exit(1)
