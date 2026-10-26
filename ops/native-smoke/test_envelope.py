import importlib.util, json, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).parent
spec=importlib.util.spec_from_file_location('finite',P/'finite-run.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Envelope(unittest.TestCase):
    def gate(self, role_overrides=None, **overrides):
        a={'secretId':'dummy-secret','versionId':'dummy-version'}
        b={'schemaVersion':1,**a,'payloadHttpStatus':403,**overrides}
        class S: st_mtime=m.time.time()
        role={'schemaVersion':1,**a,'bindingAbsent':True,'folderBindingsUnchanged':True,'serviceAccountUnchanged':True,'evidenceSha256':'a'*64,**(role_overrides or {})}
        with patch.object(m,'private_json',side_effect=[a,b,role]),patch.object(Path,'stat',return_value=S()): m.check_gate()
    def test_exact_denial(self): self.gate()
    def test_role_binding_not_removed_refused(self):
        with self.assertRaises(m.Refused): self.gate(role_overrides={'bindingAbsent':False})
    def test_other_role_version_refused(self):
        with self.assertRaises(m.Refused): self.gate(role_overrides={'versionId':'other'})
    def test_successful_payload_refused(self):
        with self.assertRaises(m.Refused): self.gate(payloadHttpStatus=200)
    def test_other_version_refused(self):
        with self.assertRaises(m.Refused): self.gate(versionId='other')
    def test_extra_proof_refused(self):
        with self.assertRaises(m.Refused): self.gate(arbitrary=True)
    def test_owner_private_reader_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            a=Path(d)/'a'; a.write_text('{}'); a.chmod(0o600); b=Path(d)/'b'; b.symlink_to(a)
            with self.assertRaises((m.Refused,OSError)): m.private_json(b)
    def test_populated_failed_cgroup_refused(self):
        class R: returncode=0; stdout='ActiveState=failed\nControlGroup=/system.slice/pulse-native-app.service\n'
        with patch.object(m,'ctl',return_value=R()),patch.object(Path,'read_text',return_value='populated 1\nfrozen 0\n'):
            self.assertFalse(m.stopped(m.UNITS[0]))
    def test_empty_failed_cgroup_stopped(self):
        class R: returncode=0; stdout='ActiveState=failed\nControlGroup=/system.slice/pulse-native-app.service\n'
        with patch.object(m,'ctl',return_value=R()),patch.object(Path,'read_text',return_value='populated 0\nfrozen 0\n'):
            self.assertTrue(m.stopped(m.UNITS[0]))
    def test_envelope_static(self):
        for name in ['broker','app']:
            s=(P/f'units/pulse-native-{name}.service.in').read_text()
            for v in ['LimitCORE=0','Restart=no','KillMode=control-group','TimeoutStopSec=10','IPAddressDeny=any','@TEST_RELEASE@','NoNewPrivileges=yes']:
                self.assertIn(v,s)
            self.assertNotIn('[Install]',s)
        broker=(P/'units/pulse-native-broker.service.in').read_text()
        self.assertIn('Group=986',broker); self.assertIn('RefuseManualStart=yes',broker)
        app=(P/'units/pulse-native-app.service.in').read_text()
        self.assertIn('BindsTo=pulse-native-broker.service',app); self.assertIn('IPAddressAllow=localhost',app)
    def test_no_broad_network_fallback(self):
        s=(P/'network/broker.nft.in').read_text()
        self.assertIn('meta skuid 997 reject',s); self.assertIn('@DNS4@',s)
        self.assertNotIn('10.42.0.2',s); self.assertNotIn('flush ruleset',s)
        self.assertIn('ip daddr @provider4 tcp dport 443 accept',s)
if __name__=='__main__': unittest.main()
