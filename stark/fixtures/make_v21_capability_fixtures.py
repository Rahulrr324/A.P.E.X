#!/usr/bin/env python3
"""
Generate v2.1 CONTROLLED capability fixtures for M0 verification.

These are NOT measurements. They are derived from the controlled-valid fixture
with a single, disclosed edit to the E1/E5 hardware snapshot so the aggregator's
G4 physical-capability logic can be exercised on a known outcome.

Physical GPU presence is carried by hardware.gpu_present (an OS device-inventory
signal, independent of the CUDA build flag). cuda_available describes only whether
this binary could query CUDA.

  v21/controlled-gpu-cuda-off/      gpu_present=true, cuda_available=false,
                                    VRAM unavailable -> G4 FAIL (GPU needs measured VRAM)
  v21/controlled-gpu-vram-measured/ gpu_present=true, cuda_available=true,
                                    VRAM measured    -> all gates PASS
  v21/controlled-unknown-capability/ gpu_present absent, cuda_available=false
                                    -> Unknown capability -> G4 FAIL (fail closed)
"""

import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "controlled-valid")
OUT = os.path.join(HERE, "v21")

NAMES = [
    "P1-B4-skip.json", "P1-B5-skip.json", "P1-E1-B6-52043.json",
    "P1-E2-skip.json", "P1-E5-B6-7336.json", "P1-PROFILE-24-0.json",
    "P1-TELEMETRY-24-1.json",
]
E1 = "P1-E1-B6-52043.json"
E5 = "P1-E5-B6-7336.json"


def load(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return json.load(f)


def write(dirname, records, readme):
    d = os.path.join(OUT, dirname)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    for name, rec in records.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
    with open(os.path.join(d, "README.txt"), "w", encoding="utf-8") as f:
        f.write(readme + "\n")
    print("wrote v21/" + dirname, "->", sorted(records))


def base_records():
    return {n: load(n) for n in NAMES}


def eval_targets(recs, mutate):
    for name in (E1, E5):
        mutate(recs[name])
    return recs


def main():
    # --- gpu present, CUDA build disabled, VRAM unavailable -> G4 FAIL ---------
    gpu_off = base_records()
    eval_targets(gpu_off, lambda r: r["hardware"].update({
        "gpu_present": True, "cuda_available": False,
        "gpu_model": "NVIDIA GeForce RTX 2050 (controlled-fixture)",
    }))
    for name in (E1, E5):
        gpu_off[name]["peak_memory"]["vram_measured"] = False
        gpu_off[name]["peak_memory"]["vram_peak_bytes"] = {
            "value": None, "reason": "unavailable: binary built without CUDA"}
    write("controlled-gpu-cuda-off", gpu_off,
          "CONTROLLED TEST INPUT (not a measurement). E1/E5 declare "
          "hardware.gpu_present=true (physical GPU) with cuda_available=false (this "
          "build has no CUDA). VRAM is unavailable. G4 is expected to FAIL: a "
          "GPU-capable host requires measured VRAM, and the CUDA-less build cannot "
          "measure it. cuda_available=false must NOT be read as CPU-only.")

    # --- gpu present, CUDA enabled, VRAM measured -> all gates PASS -------------
    gpu_vram = base_records()
    eval_targets(gpu_vram, lambda r: r["hardware"].update({
        "gpu_present": True, "cuda_available": True,
        "gpu_model": "NVIDIA GeForce RTX 2050 (controlled-fixture)",
    }))
    for name in (E1, E5):
        gpu_vram[name]["peak_memory"]["vram_measured"] = True
        gpu_vram[name]["peak_memory"]["vram_peak_bytes"] = 134217728  # 128 MiB, synthetic
    write("controlled-gpu-vram-measured", gpu_vram,
          "CONTROLLED TEST INPUT (not a measurement). E1/E5 declare physical GPU "
          "presence (gpu_present=true) with CUDA enabled and a MEASURED VRAM peak "
          "(synthetic numeric value). All gates are expected to PASS, demonstrating "
          "the GPU workload path under the frozen G4 rule.")

    # --- unknown physical capability -> G4 FAIL (fail closed) -------------------
    unknown = base_records()
    def strip(rec):
        rec["hardware"].pop("gpu_present", None)
        rec["hardware"]["cuda_available"] = False
    eval_targets(unknown, strip)
    write("controlled-unknown-capability", unknown,
          "CONTROLLED TEST INPUT (not a measurement). E1/E5 carry NO "
          "hardware.gpu_present evidence and cuda_available=false (a CUDA-less "
          "build). Physical capability is UNKNOWN. G4 is expected to FAIL closed: "
          "unknown capability must never be silently treated as CPU-only.")


if __name__ == "__main__":
    main()
