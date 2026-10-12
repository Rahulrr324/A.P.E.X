import os
path = 'work/_phase2_cli_probe_activity.md'
if os.path.exists(path):
    os.remove(path)
    print('removed', path)
else:
    print('already absent', path)
