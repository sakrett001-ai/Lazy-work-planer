from pathlib import Path
import re, hashlib, json
root=Path(__file__).resolve().parents[1]; src=root/'workbench/src'
m=json.loads((root/'workbench/manifest.json').read_text()); parts=m['parts'][:]
for x in ['request-workflow.js','evidence-planning.js','routine-plans.js','markus-policy.js']: parts.insert(parts.index('simulation.js'),x)
for x in ['document-storage.js','document-workbench.js','recursive-ui.js']: parts.insert(parts.index('prototype-ui.js'),x)
parts[parts.index('adapter.js')]='server-adapter.js'
s=''.join((src/p).read_text() for p in parts)
styles=re.findall(r'<style[^>]*>(.*?)</style>',s,re.S)
assert [hashlib.sha256(x.encode()).hexdigest() for x in styles]==m['styles_sha256'], 'Accepted styles changed'
styles.append((src/'workarea.css').read_text())
scripts=re.findall(r'<script[^>]*>(.*?)</script>',s,re.S)
s=re.sub(r'<style[^>]*>.*?</style>','',s,flags=re.S);s=re.sub(r'<script[^>]*>.*?</script>','',s,flags=re.S)
s=s.replace('</head>','<link rel="stylesheet" href="/assistant/workbench.css"></head>').replace('</body>','<script src="/assistant/workbench.js"></script></body>')
(root/'dist/workbench.html').write_text(s);(root/'dist/workbench.css').write_text('\n'.join(styles));(root/'dist/workbench.js').write_text('\n'.join(scripts))
print('Built separate server workbench HTML/JS/CSS; accepted CSS hashes verified.')
