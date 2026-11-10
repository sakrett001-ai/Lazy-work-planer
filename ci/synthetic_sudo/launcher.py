"""Pure command construction for harmless, caller-supplied test bodies."""
import base64
import hashlib
import shlex
import zlib

PROLOGUE = 'import os;os.umask(63);assert os.umask(63)==63;'
GUARD = '{ case $- in *[exvET]*) command false;; *) t=$(command builtin trap) && [ -z "$t" ];; esac; } 2>/dev/null'

def loader(source):
    blob = base64.b64encode(zlib.compress(source.encode(), 9)).decode()
    return 'import base64,zlib,hashlib; s=zlib.decompress(base64.b64decode('+repr(blob)+')); assert hashlib.sha256(s).hexdigest()=='+repr(hashlib.sha256(source.encode()).hexdigest())+'; exec(compile(s,"<frozen-child>","exec"))'

def child(source, observer=False, short=False):
    wrapped = PROLOGUE + source
    outer, inner = ('185s', '180s') if observer else ('125s', '120s')
    if short:
        outer, inner = '4s', '1s'
    return '/usr/bin/timeout -k 2s '+outer+' /usr/bin/sudo -n -- /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout -k 2s '+inner+' /usr/bin/python3 -I -B -c '+min((shlex.quote(loader(wrapped)), shlex.quote(wrapped)), key=len)+' </dev/null'

def line(sources, observer=False, short=False):
    body = ' && '.join(child(s, observer, short) for s in sources)
    refusal = "/usr/bin/printf '%s\\n' '{\"status\":\"STOP\",\"code\":\"LAUNCH\"}'"
    guarded = 'if '+GUARD+' && { [ "$(command umask)" = "0077" -o "$(command umask)" = "077" ]; }; then '+body+'; r=$?; else '+refusal+'; r=1; fi'
    return '( { '+guarded+'; /usr/bin/printf \'SYNTHETIC_RC=%s\\n\' "$r"; exit "$r"; } 2>/dev/null )'
