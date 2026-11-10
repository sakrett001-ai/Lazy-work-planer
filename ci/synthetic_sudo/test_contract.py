"""Synthetic runtime contract; never imports operational helpers or data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import time
import unittest
from launcher import child, line, PROLOGUE

ROOT = None
REAL = False
SINGLES = 2
PAIRS = 3

def run(sources, *, observer=False, short=False, prelude='umask 077;', prefix=()):
    command = line(sources, observer=observer, short=short)
    started = time.monotonic()
    result = subprocess.run([*prefix, '/bin/bash', '--noprofile', '--norc', '-c', prelude+command], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=12 if short else 195,
        env={'PATH':'/usr/bin:/bin', 'SYNTHETIC_POISON':'must-not-leak', 'PYTHONPATH':'/nonexistent'})
    rows = result.stdout.splitlines()
    assert rows and rows[-1] == 'SYNTHETIC_RC='+str(result.returncode), (result.returncode, rows, result.stderr)
    assert not result.stderr, result.stderr
    return result.returncode, rows[:-1], time.monotonic()-started

def probe(name, *, code=0, partial=False, pause=False):
    path = str(ROOT / name)
    return ('import os,sys,json,time,stat; '
      'assert os.getuid()==0 and os.geteuid()==0; '
      'assert sys.flags.isolated==1 and sys.flags.dont_write_bytecode==1; '
      'assert "SYNTHETIC_POISON" not in os.environ and "PYTHONPATH" not in os.environ; '
      'assert os.environ["PATH"]=="/usr/bin:/bin"; '
      'assert sys.stdin.read()==""; '
      'assert os.umask(63)==63; '
      'p='+repr(path)+'; '
      'fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o666); '
      'os.write(fd,b"'+('partial' if partial else 'complete')+'"); os.close(fd); '
      's=os.stat(p); assert s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600; '
      'print(json.dumps({"status":"OK","uid":os.getuid(),"name":'+repr(name)+'}),flush=True); '
      + ('time.sleep(20); ' if pause else '') + 'sys.exit('+str(code)+')')

def decision(rows, rc):
    """Deliberately small synthetic schema, not an operational parser."""
    if len(rows) != 1:
        return 'STOP'
    try:
        value = json.loads(rows[0])
    except (ValueError, TypeError):
        return 'STOP'
    if rc == 0 and value == {'status':'MATCH'}:
        return 'OBSERVE'
    if rc == 1 and value == {'status':'PROFILE','checks':{'alpha':True,'beta':False}} and all(type(v) is bool for v in value['checks'].values()):
        return 'OBSERVE'
    return 'STOP'

def branch(state):
    return {'MATCH':'A','ABSENT':'B'}.get(state, 'STOP')

class Local(unittest.TestCase):
    def test_launch_construction(self):
        for observer in (False, True):
            cmd = child('print("ok")', observer)
            argv = shlex.split(cmd)
            self.assertEqual(argv[:7], ['/usr/bin/timeout','-k','2s','185s' if observer else '125s','/usr/bin/sudo','-n','--'])
            self.assertEqual(argv[7:19], ['/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/timeout','-k','2s','180s' if observer else '120s','/usr/bin/python3','-I','-B','-c',PROLOGUE+'print("ok")'])
            self.assertEqual(argv[19:], ['</dev/null'])
        for sources in (['pass'], ['pass','pass']):
            self.assertEqual(subprocess.run(['/bin/bash','-n'],input=line(sources),text=True).returncode,0)
    def test_compressed_transport(self):
        source='values='+repr(['harmless']*300)+'; assert len(values)==300'
        payload=shlex.split(child(source))[-2]
        self.assertIn('zlib.decompress',payload)
        result=subprocess.run(['/usr/bin/python3','-I','-B','-c',payload],capture_output=True)
        self.assertEqual(result.returncode,0)
    def test_shell_refusals(self):
        for prelude in ('umask 022;', 'umask 077; set -e;', "umask 077; trap ':' EXIT;", "umask 077; trap ':' USR1;"):
            rc,rows,_=run(['raise RuntimeError("must not run")'],prelude=prelude)
            self.assertEqual((rc,rows),(1,['{"status":"STOP","code":"LAUNCH"}']))
    def test_strict_decisions(self):
        self.assertEqual(decision(['{"status":"MATCH"}'],0),'OBSERVE')
        self.assertEqual(decision(['{"status":"PROFILE","checks":{"alpha":true,"beta":false}}'],1),'OBSERVE')
        for rows, rc in [([],0),(['oops'],0),(['{"status":"PROFILE"}'],1),(['{"status":"MATCH"}'],1),(['{"status":"MATCH"}','extra'],0),(['{"status":"PROFILE","checks":{"alpha":1,"beta":false}}'],1)]:
            self.assertEqual(decision(rows,rc),'STOP')
        for value in ('PARTIAL','UNKNOWN','WRONG_MODE'):
            self.assertEqual(branch(value),'STOP')

@unittest.skipUnless(REAL, 'real sudo explicitly required; not a local mock')
class Runtime(unittest.TestCase):
    def assert_file(self,name,content=b'complete'):
        path=ROOT/name
        s=path.stat()
        self.assertEqual((s.st_uid,stat.S_IMODE(s.st_mode)),(0,0o600))
        out=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/python3','-I','-B','-c','from pathlib import Path; import sys; sys.stdout.buffer.write(Path('+repr(str(path))+').read_bytes())'],capture_output=True,check=True,timeout=5)
        self.assertEqual(out.stdout,content)
    def test_all_positions(self):
        # An arbitrary synthetic graph; not an application topology.
        for i in range(SINGLES + PAIRS):
            names=['position_'+str(i)+'_left']
            if i>=SINGLES: names.append('position_'+str(i)+'_right')
            rc,rows,_=run([probe(n) for n in names],observer=i==1)
            self.assertEqual(rc,0)
            self.assertEqual([json.loads(r)['name'] for r in rows], names)
            for n in names:self.assert_file(n)
    def test_gate_refusals(self):
        for i in range(PAIRS):
            lhs,rhs='refused_'+str(i),'suppressed_'+str(i)
            rc,rows,_=run([probe(lhs,code=23),probe(rhs)])
            self.assertEqual(rc,23)
            self.assertEqual(len(rows),1)
            self.assert_file(lhs)
            self.assertFalse((ROOT/rhs).exists())
    def test_each_rhs_partial_failure(self):
        for i in range(PAIRS):
            gate, writer = 'good_gate_'+str(i), 'failed_writer_'+str(i)
            rc, rows, _ = run([probe(gate), probe(writer, partial=True, code=37)])
            self.assertEqual(rc, 37)
            self.assertEqual(len(rows), 2)
            self.assert_file(gate)
            self.assert_file(writer, b'partial')

    def test_missing_executable(self):
        body = 'import os; os.execv('+repr(str(ROOT/'no-such-executable'))+', ["missing"])'
        rc, rows, _ = run([body, probe('after_missing')])
        self.assertNotEqual(rc, 0)
        self.assertEqual(rows, [])
        self.assertFalse((ROOT/'after_missing').exists())

    def test_partial_preservation(self):
        name='partial_failure'
        rc,_,_=run([probe(name,partial=True,code=31),probe('after_partial')])
        self.assertEqual(rc,31)
        self.assert_file(name,b'partial')
        self.assertFalse((ROOT/'after_partial').exists())
        rc,rows,_=run([probe(name),probe('after_replay')])
        self.assertNotEqual(rc,0)
        self.assertEqual(rows,[])
        self.assert_file(name,b'partial')
        self.assertFalse((ROOT/'after_replay').exists())
    def test_timeouts(self):
        rc,rows,elapsed=run([probe('timeout_partial',partial=True,pause=True),probe('after_timeout')],short=True)
        self.assertEqual(rc,124)
        self.assertLess(elapsed,8)
        self.assertEqual(len(rows),1)
        self.assert_file('timeout_partial',b'partial')
        self.assertFalse((ROOT/'after_timeout').exists())
    def test_permission_and_real_sudo_refusal(self):
        # Existing unprivileged account; no policy, account, or credential changes.
        prefix=['/usr/bin/sudo','-n','-u','nobody','--']
        identity = subprocess.run([*prefix, '/usr/bin/id', '-u'], capture_output=True, text=True, check=True, timeout=5)
        self.assertNotEqual(identity.stdout.strip(), '0')
        denied = subprocess.run([*prefix, '/usr/bin/sudo', '-n', '--', '/usr/bin/id', '-u'], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)
        self.assertNotEqual(denied.stdout.strip(), '0')
        self.assertIn('sudo', denied.stderr)
        rc,rows,_=run([probe('denied')],prefix=prefix)
        self.assertNotEqual(rc,0)
        self.assertEqual(rows,[])
        self.assertFalse((ROOT/'denied').exists())
        self.assertEqual(run([probe('permission_fixture')])[0], 0)
        self.assert_file('permission_fixture')
        p=subprocess.run([*prefix,'/usr/bin/python3','-I','-c','open('+repr(str(ROOT/'permission_fixture'))+',"rb")'],capture_output=True,timeout=5)
        self.assertNotEqual(p.returncode,0)
    def test_rejected_capture_never_observes(self):
        for i, (body, expected) in enumerate([
            ('print("malformed")', 0),
            ('print(\'{"status":"MATCH"}\'); print("extra")', 0),
            ('import sys; print(\'{"status":"PROFILE"}\'); sys.exit(1)', 1),
            ('import sys; print(\'{"status":"MATCH"}\'); sys.exit(2)', 2),
        ]):
            rc, rows, _ = run([body])
            self.assertEqual(rc, expected)
            if decision(rows, rc) == 'OBSERVE':
                run([probe('invalid_observe_'+str(i))])
            self.assertFalse((ROOT/('invalid_observe_'+str(i))).exists())

    def test_synthetic_orchestration(self):
        for state in ('MATCH','ABSENT','PARTIAL'):
            flow=branch(state)
            if flow=='STOP':
                self.assertFalse((ROOT/('flow_'+state)).exists())
                continue
            if flow=='B':
                self.assertEqual(run([probe('sender_'+state)])[0],0)
            self.assertEqual(run([probe('flow_'+state)])[0],0)
            for profile in (False,True):
                capture={'status':'PROFILE','checks':{'alpha':True,'beta':False}} if profile else {'status':'MATCH'}
                body='import sys; print('+repr(json.dumps(capture))+'); sys.exit('+str(int(profile))+')'
                rc,rows,_=run([body])
                self.assertEqual(decision(rows,rc),'OBSERVE')
                # A separate launch, explicitly not shell && after exit 1.
                self.assertEqual(run([probe('observe_'+state+'_'+str(profile))],observer=True)[0],0)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--local',action='store_true')
    group.add_argument('--sudo',action='store_true')
    args=parser.parse_args()
    REAL=args.sudo
    if REAL:
        assert os.getuid()!=0, 'must start as ordinary user'
        assert Path('/usr/bin/sudo').is_file(), 'real sudo unavailable'
        subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/true'],check=True,timeout=5)
        # Select the runner-provided temporary root, or /tmp for manual tests.
        # mkdtemp creates a fresh private fixture directory beneath it.
        base=Path(os.environ.get('RUNNER_TEMP','/tmp')).resolve()
        ROOT=Path(tempfile.mkdtemp(prefix='synthetic-sudo-',dir=base))
        Runtime.__unittest_skip__=False
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Runtime if REAL else Local)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if REAL:
        print(json.dumps({'suite':'real-sudo','ordinary_uid':os.getuid(),'result':'PASS' if result.wasSuccessful() else 'FAIL','fixture_preserved':True}))
    else:
        print(json.dumps({'suite':'local-only','real_sudo':'NOT_RUN'}))
    raise SystemExit(not result.wasSuccessful())
