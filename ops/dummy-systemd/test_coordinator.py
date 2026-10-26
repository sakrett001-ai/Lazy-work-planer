import importlib.util,pathlib,unittest
from types import SimpleNamespace
from unittest.mock import patch
P=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('coordinator',P/'coordinator.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_systemd_owns_identity_not_helper(self):
  broker=m.launch('broker',pathlib.Path('/trusted/fixture.py'))
  client=m.launch('client',pathlib.Path('/trusted/fixture.py'))
  for a in (broker,client):
   for prop in ('RemainAfterExit=yes','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','RestrictAddressFamilies=AF_UNIX','IPAddressDeny=any','Restart=no','RuntimeMaxSec=12','TimeoutStopSec=2','LimitCORE=0'):self.assertIn('--property='+prop,a)
  for prop in ('User=997','Group=986','SupplementaryGroups=987'):self.assertIn('--property='+prop,broker)
  for prop in ('User=999','Group=988','SupplementaryGroups=986'):self.assertIn('--property='+prop,client)
  source=(P/'coordinator.py').read_text()
  for bad in ('os.setuid','os.setgid','os.setgroups','os.fork','shell=True'):self.assertNotIn(bad,source)
 def test_not_found_rc1_only_with_absent_exact_cgroup(self):
  result=SimpleNamespace(returncode=1,stdout='LoadState=not-found\nActiveState=inactive\nControlGroup=\n')
  with patch.object(m,'command',return_value=result),patch.object(pathlib.Path,'exists',return_value=False):self.assertEqual(m.info(m.UNITS[0])['LoadState'],'not-found')
  with patch.object(m,'command',return_value=result),patch.object(pathlib.Path,'exists',return_value=True),self.assertRaises(m.Stop):m.info(m.UNITS[0])
  for r in (SimpleNamespace(returncode=1,stdout='LoadState=loaded\n'),SimpleNamespace(returncode=2,stdout='LoadState=not-found\n')):
   with patch.object(m,'command',return_value=r),patch.object(pathlib.Path,'exists',return_value=False),self.assertRaises(m.Stop):m.info(m.UNITS[0])
 def test_cgroup_empty_required(self):
  for population,expected in [('0',True),('1',False)]:
   with patch.object(m,'info',return_value={'ActiveState':'failed','ControlGroup':''}),patch.object(pathlib.Path,'read_text',return_value='populated '+population+'\n'):
    self.assertEqual(m.empty(m.UNITS[0]),expected)
 def test_completion_needs_exited_success_and_empty_group(self):
  good={'ActiveState':'active','SubState':'exited','Result':'success','ExecMainStatus':'0','ControlGroup':''}
  with patch.object(m,'info',return_value=good),patch.object(m,'group_empty',return_value=True):self.assertTrue(m.completed(m.UNITS[0]))
  for change in ({'SubState':'running'},{'Result':'timeout'},{'ExecMainStatus':'1'},{'ActiveState':'inactive'}):
   with patch.object(m,'info',return_value={**good,**change}),patch.object(m,'group_empty',return_value=True):self.assertFalse(m.completed(m.UNITS[0]))
  with patch.object(m,'info',return_value=good),patch.object(m,'group_empty',return_value=False):self.assertFalse(m.completed(m.UNITS[0]))
 def test_foreign_cgroup_refused(self):
  with patch.object(m,'info',return_value={'ActiveState':'inactive','ControlGroup':'/other'}),self.assertRaises(m.Stop):m.empty(m.UNITS[0])
 def test_cleanup_missing_receipt_is_not_success(self):
  with patch.object(m.os,'chown'),patch.object(m.os,'chmod'),patch.object(m.os,'open',side_effect=FileNotFoundError),patch.object(pathlib.Path,'unlink') as unlink:
   with self.assertRaises(FileNotFoundError):m.collect_cleanup()
   unlink.assert_not_called()
 def test_stop_attempts_both_groups_then_checks_empty(self):
  with patch.object(m,'command') as cmd,patch.object(m,'empty',return_value=True):m.stop_all()
  self.assertEqual(len(cmd.call_args_list),3)
  self.assertEqual(cmd.call_args_list[0].args[0],[m.SYSTEMCTL,'stop',*m.UNITS])
if __name__=='__main__':unittest.main()
