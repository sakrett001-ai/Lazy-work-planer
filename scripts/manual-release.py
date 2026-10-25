#!/usr/bin/env python3
"""Offline release preparation/pointer switch. No network, service or database access."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile

MAX_BYTES = 32 * 1024 * 1024
RESERVE_BYTES = 256 * 1024 * 1024

def require(ok, message):
    if not ok:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def safe_path(value):
    require(isinstance(value, str), 'Path must be text')
    p = PurePosixPath(value)
    require(str(p) == value and not p.is_absolute()
            and all(part not in ('', '.', '..', '.git', 'node_modules', '.data') for part in p.parts)
            and '\\' not in value, 'Unsafe archive path')
    require(p.name not in ('hosted.env', 'llm-master.key', '.release-receipt.json')
            and (not p.name.startswith('.env') or p.name == '.env.example')
            and not p.name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.llm-key', '.local.json', '.pem', '.key')),
            'Runtime/private files are not release source')
    return p

def receipt(path):
    value = json.loads(path.read_text())
    require(value['schemaVersion'] == 1, 'Unsupported receipt schema')
    require(value['repository'] == 'sakrett001-ai/Lazy-work-planer', 'Unexpected repository')
    for key in ('remoteGitCommit', 'remoteGitTree'):
        require(re.fullmatch('[0-9a-f]{40}', value[key]) is not None,
                'Published remote commit/tree required; local candidate is not a release')
    require(re.fullmatch('[0-9a-f]{64}', value['archiveSha256']) is not None, 'Invalid archive hash')
    require(isinstance(value['files'], list) and 0 < len(value['files']) <= 1000, 'Invalid file list')
    directory = value.get('releaseDirectory', value['remoteGitCommit'])
    require(re.fullmatch('[0-9a-f]{8,40}', directory) is not None, 'Invalid release directory alias')
    return value

def prepare(args):
    r = receipt(args.receipt)
    require(args.archive.stat().st_size <= MAX_BYTES, 'Archive too large')
    require(sha(args.archive.read_bytes()) == r['archiveSha256'], 'Archive hash mismatch')
    root = args.releases.resolve(strict=True)
    require(root.is_dir(), 'Release root missing')
    target = root / r.get('releaseDirectory', r['remoteGitCommit'])
    require(not target.exists() and not target.is_symlink(), 'Release already exists; never overwrite it')
    expected = {}
    for item in r['files']:
        safe_path(item['path'])
        require(item['path'] not in expected and item['mode'] in ('100644', '100755'), 'Duplicate/unsupported manifest entry')
        require(re.fullmatch('[0-9a-f]{64}', item['sha256']) is not None, 'Invalid file hash')
        expected[item['path']] = item
    with zipfile.ZipFile(args.archive) as z:
        entries = z.infolist()
        require(len(entries) == len(expected) and len({i.filename for i in entries}) == len(entries), 'Archive membership mismatch')
        size = sum(i.file_size for i in entries)
        require(size <= MAX_BYTES and shutil.disk_usage(root).free >= size * 2 + RESERVE_BYTES, 'Insufficient free space or oversized release')
        # Validate every byte before creating a release; no extractall/path following.
        data = {}
        for info in entries:
            safe_path(info.filename)
            kind = stat.S_IFMT(info.external_attr >> 16)
            require(not info.is_dir() and kind in (0, stat.S_IFREG), 'Links/special entries forbidden')
            require(info.filename in expected and not (info.flag_bits & 1), 'Unexpected/encrypted entry')
            body = z.read(info)
            item = expected[info.filename]
            require(len(body) == item['bytes'] and sha(body) == item['sha256'], 'File integrity mismatch')
            data[info.filename] = body
    staging = Path(tempfile.mkdtemp(prefix='.preparing-', dir=root))
    try:
        for name, body in data.items():
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            path.chmod(0o755 if expected[name]['mode'] == '100755' else 0o644)
        (staging / '.release-receipt.json').write_text(json.dumps(r, sort_keys=True) + '\n')
        (staging / '.release-receipt.json').chmod(0o600)
        # Operator owns release root exclusively; target is never reused.
        require(not target.exists() and not target.is_symlink(), 'Release appeared during preparation')
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(json.dumps({'prepared': str(target), 'remoteGitCommit': r['remoteGitCommit'], 'bytes': size}))

def switch(args):
    root = args.releases.resolve(strict=True)
    require(re.fullmatch('[0-9a-f]{8,40}', args.revision) is not None, 'Invalid revision')
    target = (root / args.revision).resolve(strict=True)
    require(target.parent == root and not (root / args.revision).is_symlink(), 'Release must be a real direct child')
    r = receipt(target / '.release-receipt.json')
    require(r.get('releaseDirectory', r['remoteGitCommit']) == args.revision, 'Release receipt mismatch')
    for item in r['files']:
        safe_path(item['path'])
        path = target / item['path']
        require(path.resolve(strict=True) == path and path.is_file() and not path.is_symlink(), 'Release source links forbidden')
        body = path.read_bytes()
        require(len(body) == item['bytes'] and sha(body) == item['sha256'], 'Prepared source changed; revalidate release')
    current = args.current.absolute()
    require(current.is_symlink(), 'Current must already be an operator-configured symlink')
    expected = args.expected.resolve(strict=True)
    require(expected.parent == root, 'Expected old release outside release root')
    # Cooperative update lock and expected-current guard; does not stop the service.
    with open(root / '.update.lock', 'a', encoding='utf8') as lock:
        os.chmod(root / '.update.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(current.resolve(strict=True) == expected, 'Current changed; inspect before retry')
        tmp = current.parent / ('.' + current.name + '.next-' + str(os.getpid()))
        require(not tmp.exists() and not tmp.is_symlink(), 'Temporary pointer exists')
        try:
            tmp.symlink_to(target)
            os.replace(tmp, current)
        finally:
            if tmp.is_symlink():
                tmp.unlink()
    print(json.dumps({'previous': str(expected), 'current': str(target), 'databaseTouched': False}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--receipt', type=Path, required=True)
    p.add_argument('--releases', type=Path, required=True)
    p = sub.add_parser('switch')
    p.add_argument('--releases', type=Path, required=True)
    p.add_argument('--revision', required=True)
    p.add_argument('--current', type=Path, required=True)
    p.add_argument('--expected', type=Path, required=True)
    args = parser.parse_args()
    try:
        prepare(args) if args.action == 'prepare' else switch(args)
    except (ValueError, TypeError, KeyError, OSError, zipfile.BadZipFile) as error:
        # Do not print file contents, environment, source payload or credentials.
        print('Release operation refused: ' + type(error).__name__)
        raise SystemExit(1)
