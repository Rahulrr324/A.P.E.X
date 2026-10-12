#!/usr/bin/env python3
import sys, time

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if not target:
        print('usage: _terminate_on_activity.py <marker-path>')
        sys.exit(2)
    print(f'waiting for activity on {target!r}')
    count = 0
    while count < 5:
        time.sleep(1)
        try:
            with open(target) as f:
                content = f.read().strip()
            print(f'saw content len={len(content)}')
            count += 1
        except Exception as e:
            print(f'error {e!r}')
            count += 1
    print('terminating after fixed steps')

if __name__ == '__main__':
    main()
