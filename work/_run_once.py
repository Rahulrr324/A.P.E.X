import json, os, subprocess
exe = os.fsdecode(os.environ["APEX_EXE"])
out = os.fsdecode(os.environ["APEX_OUT"])
err = os.fsdecode(os.environ["APEX_ERR"])
ec = os.fsdecode(os.environ["APEX_EC"])
csvp = os.fsdecode(os.environ["APEX_CSV"])
met = os.fsdecode(os.environ["APEX_MET"])
start = subprocess.run(["date","-u","+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()
d = {"run":"run2","exe_sha256":"a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6",
     "src_sha256":"5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9",
     "cmake_sha256":"575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8",
     "host_csv": csvp, "start_utc": start, "status":"running",
     "exe_exists": os.path.exists(exe)}
json.dump(d, open(met,"w"), indent=2)
proc = subprocess.run([exe], stdout=open(out,"wb"), stderr=open(err,"wb"))
rc = proc.returncode
open(ec,"w").write(str(rc)+"\n")
end = subprocess.run(["date","-u","+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()
d["end_utc"] = end
d["exit_code"] = rc
d["csv_present"] = os.path.exists(csvp)
d["stdout_bytes"] = os.path.getsize(out)
d["stderr_bytes"] = os.path.getsize(err)
json.dump(d, open(met,"w"), indent=2)
print("exit_code=", rc)
print("stdout_bytes=", d["stdout_bytes"])
print("stderr_bytes=", d["stderr_bytes"])
print("csv_present=", d["csv_present"])
print("start_utc=", start, "end_utc=", end)
