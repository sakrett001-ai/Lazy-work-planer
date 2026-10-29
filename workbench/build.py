from pathlib import Path
import json,re,hashlib
r=Path(__file__).parent
m=json.loads((r/'manifest.json').read_text());parts=m['parts'][:]
for extra in ['request-workflow.js','evidence-planning.js','routine-plans.js','markus-policy.js']:
 if (r/'src'/extra).exists():parts.insert(parts.index('simulation.js'),extra)
for extra in ['document-storage.js','document-workbench.js','recursive-ui.js']:
 if (r/'src'/extra).exists():parts.insert(parts.index('prototype-ui.js'),extra)
s=''.join((r/'src'/p).read_text() for p in parts)
styles=[hashlib.sha256(x.encode()).hexdigest() for x in re.findall(r'<style[^>]*>(.*?)</style>',s,re.S)]
assert styles==m['styles_sha256'],'Accepted styles changed'
if (r/'src/workarea.css').exists():
 s=s.replace('</head>','<style data-pulse-workarea-v13>\n'+(r/'src/workarea.css').read_text()+'\n</style></head>',1)
p=r/'artifacts/Pulse-interactive-prototype.html';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
(r/'artifacts/build-manifest.json').write_text(json.dumps({'parts':parts,'sha256':hashlib.sha256(s.encode()).hexdigest(),'baseline_sha256':m['baseline_sha256'],'workarea_baseline_sha256':m.get('workarea_baseline_sha256'),'original_styles_unchanged':True,'scoped_workarea_css':(r/'src/workarea.css').exists()},indent=2))
print(p)
