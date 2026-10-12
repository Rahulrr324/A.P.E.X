import os, sys
path = sys.argv[1] if len(sys.argv) > 1 else None
if not path:
    print('need path')
    sys.exit(2)
print('exists', os.path.exists(path))
