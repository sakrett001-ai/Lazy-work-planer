"""Launcher configuration/clean-env tests; fake gate, no sockets or live worker."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('launcher', ROOT / 'scripts/broker-launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='broker-launcher-')
        self.dir = Path(self.tmp.name)
        self.dir.chmod(0o700)
        self.worker = self.dir / 'worker-config.json'
        self.worker.write_text(json.dumps({'enabled': True, 'schemaVersion': 1}))
        self.worker.chmod(0o600)
        # Never executed: fake gate only. Real mounted Python/Node binaries may
        # have an unmapped owner in this sandbox, not an approved service owner.
        self.node = self.dir / 'synthetic-node'
        self.node.write_text('#!/bin/sh\nexit 9\n')
        self.node.chmod(0o700)
        self.config = self.dir / 'launcher.json'
        self.value = {'schemaVersion': 1, 'enabled': True,
            'socketPath': str(self.dir / 'never-created.sock'), 'allowedUid': os.getuid(),
            'nodeExecutable': str(self.node), 'workerConfigPath': str(self.worker)}
        self.write(self.value)
    def tearDown(self):
        self.dir.chmod(0o700)
        self.tmp.cleanup()
    def write(self, value):
        self.config.write_text(json.dumps(value))
        self.config.chmod(0o600)
    def test_disabled_never_constructs_gate_or_loads_worker(self):
        self.write({'schemaVersion': 1, 'enabled': False})
        self.worker.unlink()
        def forbidden(*args, **kwargs):
            self.fail('disabled gate construction')
        self.assertEqual(launcher.run_launcher(str(self.config), gate_factory=forbidden), 'disabled')
    def test_clean_environment_fixed_real_worker_and_close_without_socket(self):
        calls = []
        class FakeGate:
            failed = False
            worker_alive = True
            def __init__(self, *args, **kwargs):
                calls.append(('construct', args, kwargs))
            def start(self):
                calls.append(('start',))
            def close(self):
                calls.append(('close',))
        stop = threading.Event()
        stop.set()
        self.assertEqual(launcher.run_launcher(str(self.config), gate_factory=FakeGate, stop=stop), 'stopped')
        _, args, kwargs = calls[0]
        self.assertEqual(args[2], [str(self.node), str(ROOT / 'scripts/broker-worker.mjs'), '--config', str(self.worker)])
        self.assertEqual(kwargs['worker_timeout'], 50.0)
        self.assertEqual(kwargs['worker_env'], launcher.CLEAN_WORKER_ENV)
        self.assertNotIn('NODE_OPTIONS', kwargs['worker_env'])
        self.assertNotIn('ASSISTANT_LLM_KEY_OPENAI', kwargs['worker_env'])
        self.assertEqual(calls[-1], ('close',))
        self.assertFalse((self.dir / 'never-created.sock').exists())
    def test_strict_schema_private_modes_and_symlink_rejection(self):
        for invalid in [{**self.value, 'url': 'https://not-allowed.invalid'}, {**self.value, 'allowedUid': True}, {'schemaVersion': True, 'enabled': False}]:
            self.write(invalid)
            with self.assertRaises(launcher.LauncherError):launcher.read_launcher_config(str(self.config))
        self.write(self.value)
        self.config.chmod(0o640)
        with self.assertRaises(launcher.LauncherError):launcher.read_launcher_config(str(self.config))
        self.config.chmod(0o400)
        self.dir.chmod(0o500)
        try:self.assertTrue(launcher.read_launcher_config(str(self.config))['enabled'])
        finally:self.dir.chmod(0o700)
        alias = self.dir / 'alias.json'
        alias.symlink_to(self.config)
        with self.assertRaises(launcher.LauncherError):launcher.read_launcher_config(str(alias))
    def test_worker_disabled_fails_before_gate(self):
        self.worker.write_text(json.dumps({'schemaVersion': 1, 'enabled': False}))
        def forbidden(*args, **kwargs):self.fail('worker disabled gate construction')
        with self.assertRaises(launcher.LauncherError):launcher.run_launcher(str(self.config), gate_factory=forbidden)


if __name__ == '__main__':unittest.main(verbosity=2)
