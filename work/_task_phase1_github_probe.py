#!/usr/bin/env python3
import urllib.request, json, sys

url = 'https://api.github.com/repos/Rahulrr324/A.P.E.X'
req = urllib.request.Request(
    url,
    headers={
        'User-Agent': 'codebuff-probe',
        'Accept': 'application/vnd.github+json',
    },
)

try:
    r = urllib.request.urlopen(req, timeout=30)
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.reason)
    body = e.read().decode('utf-8', 'replace')
    print('body snippet:', body[:500])
    sys.exit(0)
except Exception as e:
    print('request error:', repr(e))
    sys.exit(1)

data = json.loads(r.read())
fields = [
    'exists', 'private', 'default_branch', 'empty', 'size', 'fork', 'archived',
    'open_issues_count', 'updated_at', 'pushed_at', 'created_at', 'description',
    'full_name', 'html_url', 'owner', 'clone_url', 'ssh_url',
]
print('repo response:')
for f in fields:
    v = data.get(f)
    if f == 'owner' and isinstance(v, dict):
        v = v.get('login')
    print(f'  {f}: {v}')
