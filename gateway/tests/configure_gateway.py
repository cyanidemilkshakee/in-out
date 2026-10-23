"""Use the deployment routes/plugins with a small disposable account quota."""
import re
import runpy
from pathlib import Path

source = Path('/source/kong.yml').read_text()
source, count = re.subn(r'(?m)^([ \t]*minute:)[ \t]*300[ \t]*$', r'\1 8', source)
if count == 0:
    raise RuntimeError('Expected the deployment account quota of 300/minute')
for production, fixture in ((1800, 48), (600, 64)):
    source, count = re.subn(rf'(?m)^([ \t]*minute:)[ \t]*{production}[ \t]*$', rf'\g<1> {fixture}', source)
    if count != 1:
        raise RuntimeError(f'Expected one deployment anonymous quota of {production}/minute')
source, count = re.subn(r'(?m)^([ \t]*cache_ttl:)[ \t]*30[ \t]*$', r'\1 2', source)
if count != 1:
    raise RuntimeError('Expected exactly one deployment identity cache of 30 seconds')
Path('/config/kong.yml').write_text(source)
runpy.run_path('/tests/certificates.py', run_name='__main__')
