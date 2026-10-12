import subprocess, sys, os, json
probes = []
def p(name, args, **kw):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=15, **kw)
        probes.append({"name":name,"args":args,"rc":r.returncode,
                       "stdout":r.stdout[:300],"stderr":r.stderr[:300]})
    except Exception as e:
        probes.append({"name":name,"args":args,"error":type(e).__name__+" "+str(e)[:200]})

# candidate native absolute no-space path (E:\ form without spaces)
native = "E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe"
rel = "stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
abs_space = "/e/My Local AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe"

# harmless probes first
p("probe_cmd_echo", ["cmd","/c","echo","probe-ok-cmd"])
p("probe_python_version", [sys.executable,"-V"])
p("probe_cmd_echo_native_no_space", ["cmd","/c","echo","probe-ok-cmd-native"])
# Now attempt to LAUNCH the actual diagnostic exe via cmd /c with native absolute path
# (this ends the 'harmmful-only' portion; result goes into probes)
p("launch_native_abs_via_cmd", ["cmd","/c", native])

print(json.dumps(probes, indent=2))
