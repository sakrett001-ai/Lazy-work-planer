"""Socket-free subprocess framing checks; NOT Unix listener/peer-UID evidence."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gate_checks', HERE / 'broker_peer_gate_checks.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class PipeChecks(unittest.TestCase):
    def check_mode(self, mode):
        with tempfile.TemporaryDirectory(prefix='peer-pipe-only-') as tmp:
            directory = Path(tmp)
            worker = directory / 'worker.py'
            worker.write_text(checks.WORKER)
            gate = checks.PeerGate(str(directory / 'unused.sock'), os.getuid(),
                [sys.executable, str(worker), mode, str(directory / 'calls')],
                worker_timeout=0.3)
            # Bypass only the absent socket stage in this explicitly pipe-only
            # unit test. Production startup and peer authentication are NOT run.
            gate._worker = subprocess.Popen(gate.argv, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                close_fds=True, shell=False)
            os.set_blocking(gate._worker.stdin.fileno(), False)
            os.set_blocking(gate._worker.stdout.fileno(), False)
            try:
                if mode == 'echo':
                    self.assertIn(b'"echo"', gate._exchange(b'{}'))
                    self.assertFalse(gate.failed)
                else:
                    with self.assertRaises(checks.GateError):
                        gate._exchange(b'{}')
                    self.assertTrue(gate.failed)
                    self.assertIsNotNone(gate._worker.poll(), 'Worker must be reaped')
                    pid = gate.worker_pid
                    with self.assertRaises(checks.GateError):
                        gate._exchange(b'{}')
                    self.assertEqual(gate.worker_pid, pid, 'No automatic worker replacement')
            finally:
                gate.close()
            self.assertFalse((directory / 'unused.sock').exists(), 'No socket created')

    def test_echo(self):
        self.check_mode('echo')

    def test_oversized_response(self):
        self.check_mode('oversize')

    def test_bad_json(self):
        self.check_mode('invalid')

    def test_coalesced_responses(self):
        self.check_mode('pipeline')

    def test_worker_eof(self):
        self.check_mode('eof')

    def test_worker_hang_kill_reap(self):
        self.check_mode('hang')


if __name__ == '__main__':
    unittest.main(verbosity=2)
