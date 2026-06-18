# Posted PR Replies

## `jiangge/pi-cache-optimizer#2`

Posted prepared reply from `PR_REPLIES.md`:

https://github.com/jiangge/pi-cache-optimizer/pull/2#issuecomment-4739347005

## `danialranjha/pi-auto-router#3`

Posted prepared reply from `PR_REPLIES.md`:

https://github.com/danialranjha/pi-auto-router/pull/3#issuecomment-4739347481

## Verification

Command used:

```bash
python3 - <<'PY'
from pathlib import Path
import re, subprocess, sys
p = Path('.trellis/tasks/06-12-pi-router-transparent-two-tier-router-extension/PR_REPLIES.md')
text = p.read_text()
blocks = re.findall(r'```\n(.*?)\n```', text, flags=re.S)
comments = [
    ('jiangge/pi-cache-optimizer', '2', blocks[0].strip()),
    ('danialranjha/pi-auto-router', '3', blocks[1].strip()),
]
for repo, number, body in comments:
    result = subprocess.run(['gh', 'pr', 'comment', number, '--repo', repo, '--body', body], text=True, capture_output=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
PY
```
