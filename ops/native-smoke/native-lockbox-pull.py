#!/usr/bin/python3
"""Explicit root-only provisioning; never invoked by the app or broker.
No online operation occurs on import. CLI errors are intentionally sanitized.
Python cannot guarantee erasure of immutable strings; root process exits promptly.
"""
import json, os, re, resource, secrets, signal, stat, sys, urllib.request, urllib.error
from pathlib import Path

ROOT = Path('/run/pulse-native-smoke')
METADATA = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'
PAYLOAD = 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'
LIMIT = 16384

class Refused(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

class Transport:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def get(self, url, headers):
        try:
            with self.opener.open(urllib.request.Request(url, headers=headers), timeout=12) as r:
                if r.url != url or r.status != 200: raise Refused()
                body = r.read(LIMIT + 1)
                if len(body) > LIMIT: raise Refused()
                return 200, body
        except urllib.error.HTTPError as e:
            # Do not read or log error response body/headers.
            status = e.code
            e.close()
            return status, b''

def parse(body):
    if not isinstance(body, bytes) or len(body) > LIMIT: raise Refused()
    def unique(items):
        out = {}
        for key, value in items:
            if key in out: raise Refused()
            out[key] = value
        return out
    return json.loads(body, object_pairs_hook=unique)

def checked_config(c):
    if not isinstance(c, dict) or set(c) != {'schemaVersion', 'secretId', 'versionId', 'entryKey'}: raise Refused()
    if type(c['schemaVersion']) is not int or c['schemaVersion'] != 1 or c['entryKey'] != 'provider': raise Refused()
    for k in ('secretId', 'versionId'):
        if not isinstance(c[k], str) or not re.fullmatch(r'[a-z0-9]{20,50}', c[k]): raise Refused()
    return c

def private_read(path, uid=0):
    p = Path(path)
    if not p.is_absolute() or p.parent.resolve() != p.parent: raise Refused()
    d = p.parent.stat()
    if not stat.S_ISDIR(d.st_mode) or d.st_uid != uid or stat.S_IMODE(d.st_mode) != 0o700: raise Refused()
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != uid or stat.S_IMODE(s.st_mode) not in (0o400, 0o600) or s.st_nlink != 1 or s.st_size > LIMIT: raise Refused()
        return os.read(fd, LIMIT + 1)
    finally: os.close(fd)

def fetch(c, transport, deny=False):
    c = checked_config(c)
    status, body = transport.get(METADATA, {'Metadata-Flavor': 'Google'})
    if status != 200: raise Refused()
    token = parse(body).get('access_token')
    if not isinstance(token, str) or not token or len(token) > 8192 or any(ord(x) < 33 or ord(x) > 126 for x in token): raise Refused()
    url = PAYLOAD + c['secretId'] + '/payload?versionId=' + c['versionId']
    status, body = transport.get(url, {'Authorization': 'Bearer ' + token})
    del token
    if deny:
        if status != 403: raise Refused()
        return None
    if status != 200: raise Refused()
    payload = parse(body)
    if payload.get('versionId') != c['versionId'] or not isinstance(payload.get('entries'), list) or len(payload['entries']) != 1: raise Refused()
    entry = payload['entries'][0]
    if not isinstance(entry, dict) or set(entry) != {'key', 'textValue'} or entry['key'] != c['entryKey']: raise Refused()
    credential = parse(entry['textValue'].encode())
    if not isinstance(credential, dict) or set(credential) != {'type', 'value'} or credential['type'] != 'api_key': raise Refused()
    key = credential['value']
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{8,256}', key): raise Refused()
    return (json.dumps(credential, separators=(',', ':')) + '\n').encode()

def exclusive(path, body, uid, gid):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(body); f.flush(); os.fsync(fd)
    except BaseException:
        # Only unlink the exact inode opened by us, never an existing/raced path.
        try:
            if os.lstat(path).st_ino == os.fstat(fd).st_ino: os.unlink(path)
        except OSError: pass
        raise
    finally: os.close(fd)

def provision(c, transport, root=ROOT):
    # Fetch before filesystem creation. Root must be a NEW directory on volatile /run.
    credential = fetch(c, transport)
    created = []
    handoff_started = False
    try:
        root.mkdir(mode=0o711); created.append(root)
        os.chmod(root, 0o711)
        for name, uid, gid in [('broker-private',997,987), ('app-private',999,988), ('control',0,0)]:
            d = root / name; d.mkdir(mode=0o700); created.append(d)
            # No service may enter a leaf directory until every write is complete.
            os.chown(d, 0, 0); os.chmod(d, 0o700)
        files = [(root/'broker-private/provider.json',credential,997,987)]
        ipc = (secrets.token_hex(32) + '\n').encode()
        files += [(root/'broker-private/ipc.key',ipc,997,987), (root/'app-private/ipc.key',ipc,999,988)]
        files += [(root/'control/provisioned.json',json.dumps(checked_config(c)).encode(),0,0)]
        for path, body, uid, gid in files:
            exclusive(path, body, uid, gid); created.append(path)
        # Mark BEFORE the syscall: a signal/error can arrive after chown takes effect.
        # Once a service can enter, path-based cleanup might delete its replacements.
        handoff_started = True
        for name, uid, gid in [('broker-private',997,987), ('app-private',999,988)]:
            os.chown(root / name, uid, gid)
    except BaseException:
        if not handoff_started:
            for p in reversed(created):
                try: p.rmdir() if p.is_dir() else p.unlink()
                except OSError: pass
        # After any handoff attempt, preserve partial state and refuse startup.
        # Explicit operator cleanup requires stopped cgroups and key revocation.
        raise
    finally:
        del credential

def verify_denied(c, transport, root=ROOT):
    # Must be a separate invocation AFTER operator removes the temporary role.
    recorded = parse(private_read(root/'control/provisioned.json'))
    if checked_config(c) != recorded: raise Refused()
    fetch(c, transport, deny=True)
    exclusive(root/'control/payload-denied.json', json.dumps({'schemaVersion':1,'secretId':c['secretId'],'versionId':c['versionId'],'payloadHttpStatus':403}).encode(), 0, 0)

def timeout_handler(signum, frame):
    raise Refused()

def main():
    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(30)
    try:
        if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ('provision', 'verify-denied'): raise Refused()
        # Fail closed before metadata IAM or provider payload retrieval.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0): raise Refused()
        os.umask(0o077)
        c = checked_config(parse(private_read(sys.argv[2])))
        (provision if sys.argv[1] == 'provision' else verify_denied)(c, Transport())
        print('Native credential operation completed.')
    except BaseException:
        print('Native credential operation refused; do not start broker.', file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
    return 0

if __name__ == '__main__': sys.exit(main())
