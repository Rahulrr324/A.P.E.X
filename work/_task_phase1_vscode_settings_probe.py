#!/usr/bin/env python3
import os, shutil, json, shutil, pathlib

root = r'E:\My Local AI'
vscode = os.path.join(root, '.vscode')
settings = os.path.join(vscode, 'settings.json')
backup = os.path.join(root, 'work', '_vscode_settings_backup.json')
backup_alt = os.path.join(root, 'work', '_vscode_settings_backup_' + '2.json')

print('=== TASK PHASE 1: .vscode settings backup/read (read-only where possible) ===')
print('settings.json present:', os.path.isfile(settings))
print()
if os.path.isfile(settings):
    try:
        data = json.loads(open(settings, encoding='utf-8').read())
        print('settings.json contents:')
        print(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception as e:
        print('settings.json parse error:', e)
    print()
    print('would back up to:', backup)
    print('backup exists already:', os.path.isfile(backup))
    print('backup_alt exists already:', os.path.isfile(backup_alt))
    if os.path.isfile(settings) and not os.path.isfile(backup):
        try:
            shutil.copyfile(settings, backup)
            print('created backup copy:', backup, 'size', os.path.getsize(backup))
        except Exception as e:
            print('backup copy failed:', e)
    else:
        print('no new backup created this run')
