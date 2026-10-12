#!/usr/bin/env python3
import urllib.request, json
from urllib.error import HTTPError

repos = [
    'Rahulrr324/A.P.E.X',
    'Rahulrr324/APEX',
    'Rahulrr324/APEX-M0',
    'Rahulrr324/stark',
    'Rahulrr324/Apex',
    'Rahulrr324/a.p.e.x',
    'Rahulrr324/AMBER',
    'Rahulrr324/amber',
    'Rahulrr324/SteeringAI',
    'Rahulrr324/steeringai',
    'Rahulrr324/Steering-AI',
    'Rahulrr324/Steering-AI-Project',
    'Rahulrr324/SteeringAI-Project',
]

for repo in repos:
    url = 'https://api.github.com/repos/' + repo
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'codebuff-probe',
            'Accept': 'application/vnd.github+json',
        },
    )
    try:
        r = urllib.request.urlopen(req, timeout=20)
    except HTTPError as e:
        if e.code == 404:
            print('404:', repo)
        else:
            print('HTTP', e.code, repo)
        continue
    except Exception as e:
        print('ERR', repo, repr(e))
        continue
    data = json.loads(r.read())
    print('FOUND:', repo, '->', data.get('full_name'),
          '| private=', data.get('private'),
          '| default=', data.get('default_branch'),
          '| empty=', data.get('empty'))
