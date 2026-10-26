import ast, errno, importlib.util, pathlib, tempfile, unittest
from unittest.mock import patch
P=pathlib.Path(__file__).with_name('fixture.py')
spec=importlib.util.spec_from_file_location('dummy_fixture',P);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class FixtureTests(unittest.TestCase):
    def ident(self,role,groups,cap='0',nnp='1'):
        uid,gid=(997,986) if role=='broker' else (999,988)
        with patch.object(m.os,'getuid',return_value=uid),patch.object(m.os,'geteuid',return_value=uid),patch.object(m.os,'getgid',return_value=gid),patch.object(m.os,'getegid',return_value=gid),patch.object(m.os,'getgroups',return_value=groups),patch.object(pathlib.Path,'read_text',return_value='CapEff:\t'+cap+'\nNoNewPrivs:\t'+nnp+'\n'):
            m.identity(role)
    def test_exact_service_identities(self):
        self.ident('broker',[987]);self.ident('broker',[986,987]);self.ident('app',[986]);self.ident('app',[986,988])
    def test_extra_supplementary_identity_refused(self):
        with self.assertRaises(m.Stop):self.ident('app',[986,0])
    def test_capability_and_nnp_refused(self):
        with self.assertRaises(m.Stop):self.ident('broker',[987],cap='1')
        with self.assertRaises(m.Stop):self.ident('broker',[987],nnp='0')
    def test_missing_ipc_group_refused(self):
        with self.assertRaises(m.Stop):self.ident('app',[988])
    def test_no_identity_switch_or_network_provider_source(self):
        tree=ast.parse(P.read_text());calls={ast.unparse(n.func) for n in ast.walk(tree) if isinstance(n,ast.Call)}
        self.assertFalse({'os.setuid','os.setgid','os.setgroups','os.fork','os.system'}&calls)
        source=P.read_text();self.assertNotIn('AF_INET',source);self.assertNotIn('https://',source)
        self.assertIn('signal.alarm(12)',source);self.assertIn('worker_timeout=.3',source)
        self.assertIn("need(not os.path.lexists(BASE/'broker-private/calls')",source)
    def test_worker_compiles(self):compile(m.WORKER,'dummy_worker','exec')
    def test_exclusive_output_refuses_existing_or_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'receipt';p.write_bytes(b'keep');link=pathlib.Path(d)/'link';link.symlink_to(p)
            for q in (p,link):
                with self.assertRaises(FileExistsError):m.create(q,b'overwrite')
            self.assertEqual(p.read_bytes(),b'keep')
    def test_private_access_requires_eacces_not_missing(self):
        for code,passes in ((errno.EACCES,True),(errno.ENOENT,False)):
            with patch.object(m.os,'open',side_effect=[31,OSError(code,'dummy')]),patch.object(m.os,'read',return_value=m.DUMMY),patch.object(m.os,'close'):
                if passes:m.private_access('app')
                else:
                    with self.assertRaises(m.Stop):m.private_access('app')
    def test_private_access_refuses_cross_uid_success(self):
        with patch.object(m.os,'open',side_effect=[31,32]),patch.object(m.os,'read',return_value=m.DUMMY),patch.object(m.os,'close'):
            with self.assertRaises(m.Stop):m.private_access('broker')
    def test_bad_cli_refuses_before_any_socket(self):
        with patch.object(m.socket,'socket',side_effect=AssertionError('never')):
            for args in ([],['root'],['broker','extra']):
                with self.assertRaises(m.Stop):m.main(args)
    def test_request_fake_only_preserves_framing(self):
        class FakeSocket:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def settimeout(self,t):self.timeout=t
            def connect(self,p):self.path=p
            def sendall(self,b):self.sent=b
            def shutdown(self,d):self.direction=d
            def recv(self,n):return self.chunks.pop(0)
        s=FakeSocket();s.chunks=[b'answer',b'']
        with patch.object(m.socket,'socket',return_value=s) as ctor:self.assertEqual(m.request(b'{}'),b'answer')
        ctor.assert_called_once_with(m.socket.AF_UNIX,m.socket.SOCK_STREAM)
        self.assertEqual(s.sent,b'\0\0\0\2{}');self.assertEqual(s.timeout,2)
if __name__=='__main__':unittest.main()
