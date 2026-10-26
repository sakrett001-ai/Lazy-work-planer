#!/usr/bin/env python3
"""Explicit operator launcher: fixed real worker, clean environment, no shell.
No service provisioning, budget bootstrap, credential creation or live probe.
"""
import json
import importlib.util
import os
from pathlib import Path
import signal
import stat
import sys
import threading

_gate_path = Path(__file__).resolve().with_name('broker_peer_gate.py')
_gate_spec = importlib.util.spec_from_file_location('trusted_broker_peer_gate', _gate_path)
_gate_module = importlib.util.module_from_spec(_gate_spec)
_gate_spec.loader.exec_module(_gate_module)
PeerGate = _gate_module.PeerGate

CLEAN_WORKER_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                    'LC_ALL': 'C.UTF-8', 'TZ': 'UTC', 'NODE_ENV': 'production'}


class LauncherError(Exception):
    pass


def _path(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise LauncherError()
    path = Path(value)
    if not path.is_absolute() or str(path) != value or str(path.absolute()) != value:
        raise LauncherError()
    return path


def _private_json(path):
    fd = None
    try:
        path = _path(str(path))
        parent = path.parent
        info = parent.lstat()
        if (parent.resolve(strict=True) != parent or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) not in (0o500, 0o700)):
            raise LauncherError()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) not in (0o400, 0o600) or not 0 < info.st_size <= 16384):
            raise LauncherError()
        body = os.read(fd, 16385)
        if len(body) != info.st_size:
            raise LauncherError()
        value = json.loads(body.decode('utf-8', errors='strict'))
        if not isinstance(value, dict):
            raise LauncherError()
        return value
    except Exception:
        raise LauncherError() from None
    finally:
        if fd is not None:
            os.close(fd)


def read_launcher_config(path):
    value = _private_json(path)
    if (set(value) == {'schemaVersion', 'enabled'} and type(value.get('schemaVersion')) is int
            and value['schemaVersion'] == 1 and value.get('enabled') is False):
        return value
    expected = {'schemaVersion', 'enabled', 'socketPath', 'allowedUid',
                'nodeExecutable', 'workerConfigPath'}
    if (set(value) != expected or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1
            or value['enabled'] is not True or isinstance(value['allowedUid'], bool)
            or not isinstance(value['allowedUid'], int) or value['allowedUid'] < 0):
        raise LauncherError()
    for field in ('socketPath', 'nodeExecutable', 'workerConfigPath'):
        _path(value[field])
    node = Path(value['nodeExecutable'])
    node_stat = node.stat()
    # Trusted operator chooses an installed executable; not a command from IPC.
    if (not stat.S_ISREG(node_stat.st_mode) or node_stat.st_uid not in (0, os.getuid())
            or node_stat.st_mode & 0o022
            or not node_stat.st_mode & 0o111):
        raise LauncherError()
    return value


def run_launcher(path, *, gate_factory=PeerGate, stop=None, ready=None):
    config = read_launcher_config(path)
    if not config['enabled']:
        return 'disabled'
    # Read only worker CONFIG, never its key/provider credential files. A disabled
    # worker must not create a socket or spawn a child through the launcher.
    worker_config = _private_json(config['workerConfigPath'])
    if worker_config.get('enabled') is not True:
        raise LauncherError()
    worker = Path(__file__).resolve().with_name('broker-worker.mjs')
    if not worker.is_file() or worker.is_symlink():
        raise LauncherError()
    gate = gate_factory(config['socketPath'], config['allowedUid'],
        [config['nodeExecutable'], str(worker), '--config', config['workerConfigPath']],
        frame_timeout=2.0, worker_timeout=50.0, worker_env=dict(CLEAN_WORKER_ENV))
    stop = stop or threading.Event()
    try:
        gate.start()
        if ready:
            ready()
        while not stop.wait(0.1):
            if gate.failed or not gate.worker_alive:
                raise LauncherError()
        return 'stopped'
    finally:
        gate.close()


def main(argv):
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    try:
        if len(argv) != 2 or argv[0] != '--config':
            raise LauncherError()
        status = run_launcher(argv[1], stop=stop,
                              ready=lambda: print('BROKER_PEER_GATE_STARTED', flush=True))
        if status == 'disabled':
            print('BROKER_DISABLED', flush=True)
        return 0
    except Exception:
        print('BROKER_UNAVAILABLE', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
