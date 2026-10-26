"""Local Unix peer gate. No provider, credentials, service installer or shell.

The trusted launcher supplies the fixed worker argv. IPC peers can supply only
one bounded frame. Linux SO_PEERCRED is the authentication source for peer UID;
HMAC and application scope are independently checked by the worker core.
"""
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import subprocess
import threading
import time

MAX_REQUEST = 131072
MAX_RESPONSE = 65536


class GateError(Exception):
    pass


class PeerGate:
    def __init__(self, socket_path, allowed_uid, worker_argv, *, frame_timeout=2.0,
                 worker_timeout=125.0, worker_env=None):
        if not hasattr(socket, 'SO_PEERCRED') or not hasattr(socket, 'AF_UNIX'):
            raise GateError('Kernel peer credentials unavailable')
        self.path = Path(socket_path)
        if not self.path.is_absolute() or str(self.path) != str(socket_path):
            raise GateError('Absolute normalized socket path required')
        if not isinstance(allowed_uid, int) or isinstance(allowed_uid, bool) or allowed_uid < 0:
            raise GateError('Invalid principal')
        if not isinstance(worker_argv, (tuple, list)) or not worker_argv or any(
                not isinstance(x, str) or not x or '\0' in x for x in worker_argv):
            raise GateError('Fixed worker argv required')
        if not Path(worker_argv[0]).is_absolute():
            raise GateError('Absolute worker executable required')
        if not 0 < frame_timeout <= 10 or not 0 < worker_timeout <= 130:
            raise GateError('Invalid timeout')
        if worker_env is not None and (not isinstance(worker_env, dict) or any(
                not isinstance(k, str) or not isinstance(v, str) or not k or "\0" in k or "\0" in v or "=" in k
                for k, v in worker_env.items())):
            raise GateError("Invalid worker environment")
        self.worker_env = None if worker_env is None else dict(worker_env)
        self.allowed_uid = allowed_uid
        self.argv = list(worker_argv)
        self.frame_timeout = frame_timeout
        self.worker_timeout = worker_timeout
        self.failed = False
        self._stop = threading.Event()
        self._busy = threading.Lock()
        self._worker_lock = threading.Lock()
        self._listener = None
        self._worker = None
        self._thread = None
        self._handler = None
        self._connection = None
        self._inode = None
        self._closed = False

    @property
    def worker_alive(self):
        return self._worker is not None and self._worker.poll() is None

    @property
    def worker_pid(self):
        return self._worker.pid if self._worker is not None else None

    def _prepare(self):
        if self._listener is not None or self._closed:
            raise GateError('Gate already started or closed')
        parent = self.path.parent
        info = parent.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if (parent.resolve(strict=True) != parent or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or mode not in (0o700, 0o750)):
            raise GateError('Private broker-owned parent required')
        if os.path.lexists(self.path):
            raise GateError('Existing socket path is never removed')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            made = self.path.lstat()
            self._inode = (made.st_dev, made.st_ino)
            os.chmod(self.path, 0o600 if mode == 0o700 else 0o660)
            listener.listen(4)
            listener.settimeout(0.1)
            self._listener = listener
            self._worker = subprocess.Popen(self.argv, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                close_fds=True, shell=False, env=self.worker_env)
            os.set_blocking(self._worker.stdin.fileno(), False)
            os.set_blocking(self._worker.stdout.fileno(), False)
        except Exception:
            listener.close()
            self.close()
            raise GateError('Gate startup unavailable') from None

    def start(self):
        self._prepare()
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)
        self._thread.start()
        return self

    def serve_forever(self):
        if self._listener is None:
            self._prepare()
        while not self._stop.is_set():
            try:
                conn, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if not self._stop.is_set():
                    self.failed = True
                break
            try:
                _, uid, _ = struct.unpack('3i', conn.getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
                if uid != self.allowed_uid or self.failed or not self._busy.acquire(False):
                    conn.close()
                    continue
                self._connection = conn
                self._handler = threading.Thread(target=self._serve_one, args=(conn,), daemon=True)
                self._handler.start()
            except Exception:
                conn.close()
                self.failed = True
        # Worker disposal is explicit close(), never an automatic restart.

    def _recv(self, conn, size, deadline):
        data = bytearray()
        while len(data) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GateError('Frame unavailable')
            conn.settimeout(remaining)
            part = conn.recv(size - len(data))
            if not part:
                raise GateError('Frame unavailable')
            data.extend(part)
        return bytes(data)

    def _serve_one(self, conn):
        try:
            deadline = time.monotonic() + self.frame_timeout
            size = struct.unpack('!I', self._recv(conn, 4, deadline))[0]
            if not 0 < size <= MAX_REQUEST:
                raise GateError('Frame bound')
            body = self._recv(conn, size, deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GateError('Frame unavailable')
            conn.settimeout(remaining)
            if conn.recv(1) != b'':
                raise GateError('Exactly one half-closed frame required')
            value = json.loads(body.decode('utf-8', errors='strict'))
            if not isinstance(value, dict):
                raise GateError('Object frame required')
            if time.monotonic() >= deadline:
                raise GateError('Frame unavailable')
            response = self._exchange(body)
            conn.settimeout(self.frame_timeout)
            conn.sendall(struct.pack('!I', len(response)) + response)
        except (OSError, ValueError, GateError, UnicodeError, RecursionError):
            pass  # No unauthenticated/raw error detail crosses the boundary.
        finally:
            conn.close()
            self._connection = None
            self._busy.release()

    def _pipe(self, fd, deadline, *, data=None, size=None):
        output = bytearray()
        offset = 0
        while offset < (len(data) if data is not None else size):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GateError('Worker unavailable')
            ready = select.select([] if data is not None else [fd],
                                  [fd] if data is not None else [], [], remaining)
            if not (ready[1] if data is not None else ready[0]):
                raise GateError('Worker unavailable')
            if data is not None:
                count = os.write(fd, data[offset:])
                if count <= 0:
                    raise GateError('Worker unavailable')
                offset += count
            else:
                part = os.read(fd, size - offset)
                if not part:
                    raise GateError('Worker unavailable')
                output.extend(part)
                offset += len(part)
        return bytes(output)

    def _exchange(self, body):
        try:
            worker = self._worker
            if self.failed or worker is None or worker.poll() is not None:
                raise GateError('Worker unavailable')
            readfd, writefd = worker.stdout.fileno(), worker.stdin.fileno()
            # Never reuse a worker with a stray response or stdout EOF pending.
            if select.select([readfd], [], [], 0)[0]:
                raise GateError('Worker protocol')
            deadline = time.monotonic() + self.worker_timeout
            self._pipe(writefd, deadline, data=struct.pack('!I', len(body)) + body)
            length = struct.unpack('!I', self._pipe(readfd, deadline, size=4))[0]
            if not 0 < length <= MAX_RESPONSE:
                raise GateError('Worker response bound')
            response = self._pipe(readfd, deadline, size=length)
            if not isinstance(json.loads(response.decode('utf-8', errors='strict')), dict):
                raise GateError('Worker protocol')
            if select.select([readfd], [], [], 0)[0]:
                raise GateError('Worker trailing output')
            if time.monotonic() >= deadline:
                raise GateError('Worker unavailable')
            return response
        except (OSError, ValueError, GateError, UnicodeError, RecursionError):
            self.failed = True
            self._kill_worker()
            raise GateError('Worker unavailable') from None

    def _kill_worker(self):
        with self._worker_lock:
            worker = self._worker
            if worker is None:
                return
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=1)
            for pipe in (worker.stdin, worker.stdout):
                if pipe is not None:
                    pipe.close()

    def close(self):
        self._closed = True
        self._stop.set()
        if self._listener is not None:
            self._listener.close()
        if self._connection is not None:
            try:
                self._connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self._kill_worker()
        for thread in (self._thread, self._handler):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=1)
        if self._inode is not None:
            try:
                current = self.path.lstat()
                if (stat.S_ISSOCK(current.st_mode) and current.st_uid == os.getuid()
                        and (current.st_dev, current.st_ino) == self._inode):
                    self.path.unlink()
            except FileNotFoundError:
                pass
