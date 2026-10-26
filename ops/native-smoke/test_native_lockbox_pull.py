import importlib.util, json, pathlib, unittest, os, tempfile
from unittest.mock import patch
P = pathlib.Path(__file__).with_name('native-lockbox-pull.py')
spec = importlib.util.spec_from_file_location('native_pull', P)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
C = {'schemaVersion':1,'secretId':'s'*20,'versionId':'v'*20,'entryKey':'provider'}
def payload(**changes):
    p = {'versionId': C['versionId'], 'entries':[{'key':'provider','textValue':json.dumps({'type':'api_key','value':'DUMMY-NOT-A-KEY'})}]}
    p.update(changes); return json.dumps(p).encode()
class Fake:
    def __init__(self, status=200, body=None, metadata=None):
        self.calls=[]; self.status=status; self.body=payload() if body is None else body
        self.metadata=b'{"access_token":"DUMMY-IAM"}' if metadata is None else metadata
    def get(self,url,headers):
        self.calls.append((url,headers))
        return (200,self.metadata) if len(self.calls)==1 else (self.status,self.body)
class Tests(unittest.TestCase):
    def test_pinned_fetch(self):
        f=Fake(); result=json.loads(m.fetch(C,f))
        self.assertEqual(result,{'type':'api_key','value':'DUMMY-NOT-A-KEY'})
        self.assertEqual(f.calls[0],(m.METADATA,{'Metadata-Flavor':'Google'}))
        self.assertEqual(f.calls[1][0],m.PAYLOAD+C['secretId']+'/payload?versionId='+C['versionId'])
    def test_placeholder_not_runnable(self):
        with self.assertRaises(m.Refused): m.checked_config({**C,'secretId':'FUTURE_SECRET_ID'})
    def test_boolean_schema_version_rejected(self):
        with self.assertRaises(m.Refused): m.checked_config({**C,'schemaVersion':True})
    def test_timeout_raises_sanitized_refusal(self):
        with self.assertRaises(m.Refused): m.timeout_handler(None,None)
    def test_cli_alarm_canceled_and_handler_restored(self):
        previous=object()
        with patch.object(m.signal,'getsignal',return_value=previous), patch.object(m.signal,'signal') as handler, patch.object(m.signal,'alarm') as alarm, patch.object(m.os,'geteuid',return_value=1000), patch.object(m.sys,'stderr'):
            self.assertEqual(m.main(),1)
            self.assertEqual([x.args for x in alarm.call_args_list],[(30,),(0,)])
            self.assertEqual(handler.call_args_list[-1].args,(m.signal.SIGALRM,previous))
    def test_core_limit_precedes_sensitive_operation(self):
        order=[]
        def limit(which,value):
            self.assertEqual((which,value),(m.resource.RLIMIT_CORE,(0,0))); order.append('core')
        def provision(*args):
            self.assertEqual(order,['core']); order.append('provision')
        with patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'argv',['helper','provision','/dummy']), patch.object(m.resource,'setrlimit',side_effect=limit), patch.object(m.resource,'getrlimit',return_value=(0,0)), patch.object(m,'private_read',return_value=json.dumps(C).encode()), patch.object(m,'Transport',return_value=object()), patch.object(m,'provision',side_effect=provision), patch('builtins.print'):
            self.assertEqual(m.main(),0)
        self.assertEqual(order,['core','provision'])
    def test_core_limit_failure_blocks_all_credential_reads(self):
        for result in ('error','not-zero'):
            with self.subTest(result=result), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'argv',['helper','provision','/dummy']), patch.object(m.resource,'setrlimit',side_effect=PermissionError() if result=='error' else None), patch.object(m.resource,'getrlimit',return_value=(1,1)), patch.object(m,'private_read',side_effect=AssertionError('must not read')) as read, patch.object(m,'Transport',side_effect=AssertionError('must not construct transport')) as transport, patch('builtins.print'):
                self.assertEqual(m.main(),1); read.assert_not_called(); transport.assert_not_called()
    def test_extra_config_refused(self):
        with self.assertRaises(m.Refused): m.checked_config({**C,'url':'https://other.example'})
    def test_version_mismatch(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(body=payload(versionId='wrong')))
    def test_oversized_payload(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(body=b' '*(m.LIMIT+1)))
    def test_duplicate_keys(self):
        with self.assertRaises(m.Refused): m.parse(b'{"a":1,"a":2}')
    def test_multiple_entries(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(body=payload(entries=[])))
    def test_binary_payload(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(body=payload(entries=[{'key':'provider','binaryValue':'abc'}])))
    def test_deny_exact403_only(self):
        self.assertIsNone(m.fetch(C,Fake(status=403),deny=True))
        for status in (200,301,401,404,429,500):
            with self.subTest(status=status), self.assertRaises(m.Refused): m.fetch(C,Fake(status=status),deny=True)
    def test_provision_refuses_denial(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(status=403))
    def test_token_header_injection(self):
        with self.assertRaises(m.Refused): m.fetch(C,Fake(metadata=b'{"access_token":"x\\ny"}'))
    def test_no_redirect(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.example'))
    def test_key_shape_matches_worker(self):
        for key in ('short', 'x'*257, 'unsafe/key'):
            body=payload(entries=[{'key':'provider','textValue':json.dumps({'type':'api_key','value':key})}])
            with self.subTest(key_length=len(key)), self.assertRaises(m.Refused): m.fetch(C,Fake(body=body))
    def test_exclusive_refuses_existing_and_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'existing'; p.write_text('retain')
            link=pathlib.Path(d)/'link'; link.symlink_to(p)
            for target in (p,link):
                with self.assertRaises(FileExistsError): m.exclusive(target,b'new',os.getuid(),os.getgid())
            self.assertEqual(p.read_text(),'retain')
    def test_partial_write_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'new'
            with patch.object(m.os,'fchown',side_effect=PermissionError()):
                with self.assertRaises(PermissionError): m.exclusive(p,b'dummy',997,987)
            self.assertFalse(p.exists())
    def test_all_writes_precede_service_directory_handoff(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'runtime'; events=[]; original=m.exclusive
            def write(path,body,uid,gid):
                self.assertFalse(any(e[0]=='handoff' for e in events))
                original(path,body,uid,gid); events.append(('write',path.name))
            def chown(path,uid,gid):
                events.append(('root' if uid==0 else 'handoff',path.name))
                if uid!=0: self.assertEqual(len([e for e in events if e[0]=='write']),4)
            with patch.object(m.os,'chown',side_effect=chown), patch.object(m.os,'fchown'), patch.object(m,'exclusive',side_effect=write):
                m.provision(C,Fake(),root)
            self.assertEqual(events[:3],[('root','broker-private'),('root','app-private'),('root','control')])
            self.assertEqual(events[-2:],[('handoff','broker-private'),('handoff','app-private')])
    def test_partial_handoff_failure_preserves_replacement_and_receipts(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'runtime'
            def chown(path,uid,gid):
                if uid==999:
                    replacement=root/'broker-private/provider.json'
                    replacement.unlink(); replacement.write_text('replacement must survive')
                    raise PermissionError('simulated second handoff failure')
            with patch.object(m.os,'chown',side_effect=chown), patch.object(m.os,'fchown'):
                with self.assertRaises(PermissionError): m.provision(C,Fake(),root)
            self.assertEqual((root/'broker-private/provider.json').read_text(),'replacement must survive')
            self.assertTrue((root/'control/provisioned.json').is_file())
            self.assertTrue((root/'app-private/ipc.key').is_file())
    def test_no_files_before_fetch_valid(self):
        with patch.object(m.Path,'mkdir',side_effect=AssertionError('must not create')):
            with self.assertRaises(m.Refused): m.provision(C,Fake(status=403))
if __name__=='__main__': unittest.main()
