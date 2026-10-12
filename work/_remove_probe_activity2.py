import os, sys
path = sys.argv[1] if len(sys.argv) > 1 else None
if not path:
    print('need path')
    sys.exit(2)
if os.path.exists(path):
    os.remove(path)
    print('removed', path)
else:
    print('already absent', path)
