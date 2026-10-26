"""Deterministic cleanup ordering checks: fake connection, no kernel sockets."""
import importlib.util
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('peer_gate', ROOT / 'scripts/broker_peer_gate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Connection:
    def __init__(self, data, on_close):
        self.data = data
        self.on_close = on_close
        self.sent = b''

    def settimeout(self, timeout):
        pass

    def recv(self, size):
        result, self.data = self.data[:size], self.data[size:]
        return result

    def sendall(self, data):
        self.sent += data

    def close(self):
        self.on_close()


class CleanupChecks(unittest.TestCase):
    def check_cleanup(self, frame, expected_calls):
        # Constructor only: never start(), create a socket, spawn or contact a worker.
        gate = module.PeerGate('/tmp/not-opened.sock', 0, ['/not-executed'])
        calls = []
        def exchange(body):
            self.assertTrue(gate._busy.locked(), 'Admission remains exclusive during exchange')
            calls.append(body)
            return b'{"ok":true}'
        gate._exchange = exchange
        successor = object()
        def peer_observes_eof():
            # A peer may immediately connect again when close publishes EOF.
            self.assertIsNone(gate._connection)
            self.assertTrue(gate._busy.acquire(False), 'EOF must not precede release of admission')
            gate._connection = successor
        conn = Connection(frame, peer_observes_eof)
        gate._connection = conn
        gate._busy.acquire()
        try:
            gate._serve_one(conn)
            self.assertEqual(len(calls), expected_calls)
            self.assertIs(gate._connection, successor, 'Old cleanup must not clear a new connection')
            self.assertTrue(gate._busy.locked(), 'Old cleanup must not release successor ownership')
            self.assertEqual(bool(conn.sent), bool(expected_calls))
        finally:
            if gate._busy.locked():
                gate._busy.release()

    def test_success_is_ready_for_next_request_before_peer_eof(self):
        self.check_cleanup(struct.pack('!I', 2) + b'{}', 1)

    def test_rejected_frame_releases_admission_before_peer_eof(self):
        self.check_cleanup(struct.pack('!I', 0), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
