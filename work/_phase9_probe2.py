import subprocess, json
native = r"E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe"
probes = []
# probe: cmd /c "E:\path\to\exe"  (cmd runs the quoted string as a command)
probes.append(subprocess.run(["cmd","/c", native], capture_output=True, text=True, timeout=15).__dict__)
# probe: cmd /c "set" to print env and see PATH and CWD as cmd sees them (harmless)
probes.append(subprocess.run(["cmd","/c","set"], capture_output=True, text=True, timeout=15).__dict__)
# probe: cmd /c cd and echo CWD as cmd sees it
probes.append(subprocess.run(["cmd","/c","echo CWD-as-cmd=%CD%"], capture_output=True, text=True, timeout=15).__dict__)
print(json.dumps(probes, indent=2))
