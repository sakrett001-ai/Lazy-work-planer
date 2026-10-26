"""Fixture diagnostic tests only; no sockets, workers or model calls."""
import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import Mock, patch

path=Path(__file__).with_name('broker_peer_gate_checks.py')
spec=importlib.util.spec_from_file_location('gate_fixture',path)
fixture=importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Diagnostics(unittest.TestCase):
 def test_deadline_metadata_keeps_original_exception_and_never_payload(self):
  gate=Mock();gate.failed=True;gate.worker_alive=False;gate._worker.poll.return_value=7
  gate.frame_timeout=.25;gate.worker_timeout=.5;gate._busy=threading.Lock()
  secret='not-for-diagnostics';error=TimeoutError(secret)
  gate._recv=Mock(return_value=secret.encode());gate._pipe=Mock(side_effect=error)
  events=fixture.observe_gate_io(gate);deadline=time.monotonic()+.5
  self.assertEqual(gate._recv(None,4,deadline),secret.encode())
  with self.assertRaises(TimeoutError) as caught:gate._pipe(99,deadline,size=4)
  self.assertIs(caught.exception,error)
  text=fixture.request_diagnostic(gate,2,0,.012,1,True,events)
  data=json.loads(text);self.assertNotIn(secret,text)
  self.assertEqual(data['attempt'],2);self.assertEqual(data['response_bytes'],0)
  self.assertTrue(data['gate_failed']);self.assertEqual(data['worker_returncode'],7)
  self.assertEqual(data['io_events'][1]['error_type'],'TimeoutError')
  self.assertGreater(data['io_events'][1]['remaining_before_ms'],0)
  self.assertLessEqual(data['io_events'][1]['remaining_after_ms'],data['io_events'][1]['remaining_before_ms'])

 def test_failed_connect_closes_fixture_connection(self):
  case=fixture.GateChecks();case.socket=Path('/not-connected')
  conn=Mock();conn.connect.side_effect=ConnectionRefusedError('synthetic')
  with patch.object(fixture.socket,'socket',return_value=conn):
   with self.assertRaises(ConnectionRefusedError):case.connection()
  conn.close.assert_called_once()

 def test_teardown_cleans_temp_even_if_gate_close_fails(self):
  case=fixture.GateChecks();case.tmp=Mock();case.gate=Mock()
  case.gate.close.side_effect=RuntimeError('synthetic close error')
  with self.assertRaises(RuntimeError):case.tearDown()
  case.tmp.cleanup.assert_called_once()


if __name__=='__main__':unittest.main(verbosity=2)
