# APEX M0 v2.2 — Windows Physical GPU Detection Audit

**Date:** 2026-10-05
**Scope:** Independent review of the v2.1 `EnumDisplayDevices` physical-GPU detection and its
consumption in `gates.cpp`. No source was modified; this is analysis plus a proposed (not applied)
correction.

**Legend:** **[V]** verified from source/host, **[H]** host observation, **[I]** inference, **[U]** unresolved, **[P]** proposal.

---

## 1. The implementation under audit

`src/phase1/common/HardwareProfiler.cpp:44-80` (`collectPhysicalGpuPresence`), called from
`collectGpu`-adjacent collection at `:394`, with the field declared in
`src/phase1/common/HardwareProfiler.h:52-62`. **[V]**

```c
for (DWORD i = 0;; ++i) {
    DISPLAY_DEVICEA dd; memset(&dd,0,sizeof dd); dd.cb = sizeof dd;
    if (!EnumDisplayDevicesA(nullptr, i, &dd, 0)) break;      // :51
    std::string desc = dd.DeviceString;
    if (!desc.empty()) adapters.push_back(desc);              // :53-54
}
if (adapters.empty()) { gpu_present = nullopt; provenance=...; return; }   // :55-58
bool any_real=false;
for (a : adapters) {
    if (a.find("Microsoft Basic") || a.find("Remote") || a.find("Basic Render")) continue;  // :63-69
    any_real = true;
}
gpu_present = any_real;                                       // :73
```

Serialization/parse: `to_json` writes a **bare boolean** when known and
`{ "value": null, "reason": "…" }` when unknown (`HardwareProfiler.cpp:547-556`); `from_json`
accepts both and treats any malformed form as unknown (`:591-600`). **[V]**

Consumption: `device_capability()` in `src/phase1/gates.cpp:140-166` classifies
`gpu_present == true → GPU`, `gpu_present == false → CPU`, otherwise `Unknown`; `cuda_available == false`
is explicitly *not* CPU-only evidence. `Unknown` fails G4 closed (`gates.cpp:255-268`). **[V]**

---

## 2. Findings against the enumerated concerns

| Concern | Finding | Tag |
|---|---|---|
| Detect adapters not currently driving a display | **Partial.** `EnumDisplayDevicesA(NULL, i, …)` with flag `0` enumerates the display devices in the *current session's* display-adapter list. It does list non-primary adapters, but it does **not** enumerate adapters that are disabled, headless, or absent from the display subsystem (e.g. a GPU with no driver bound / in "Microsoft Basic Display" fallback). | [V] |
| Distinguish physical GPU from virtual/mirror adapter | **Weak / heuristic.** Only three substrings are filtered: `Microsoft Basic`, `Remote`, `Basic Render`. Common virtual/mirror display adapters — Parsec, Spacedesk, IddSampleDriver, Citrix/ICA, VNC, "Mirror Driver", other `Idd*` indirect display drivers — are **not** filtered and would be counted as `gpu_present = true`. | [V][I] |
| Multiple GPUs | **Collapsed and over-counted.** `gpu_present` is a single boolean. The adapter list is joined into one provenance string; `EnumDisplayDevices` enumerates *per display device* (one entry per monitor attached to an adapter), so a single adapter with multiple outputs is listed multiple times. | [V] |
| Enumeration errors | **Safe but coarse.** Loop terminates on the first `FALSE` return (`:51`). `GetLastError()` is not inspected, so a transient failure is indistinguishable from "no adapters"; the result is `gpu_present = nullopt` (Unknown) → G4 fails closed. There is no crash path and no false PASS. | [V] |
| `gpu_present` tri-state in the serialized schema | **Yes.** `optional<bool>`: `true`/`false` serialize as bare booleans; `nullopt` serializes as `{value:null,reason}`. Parse reconstructs the three states. | [V] |
| Missing / null preserves Unknown | **Yes.** A record without `gpu_present`, or with `{value:null,…}`, yields `nullopt` → `Capability::Unknown` → G4 FAIL. Encoded in the 340-assertion suite and in `fixtures/v21/controlled-unknown-capability` (verified: G4 FAIL). | [V][T] |
| CUDA-disabled builds retain physical info | **Yes.** `collectPhysicalGpuPresence` is independent of `STARK_P1_CUDA_COMPILED`; the current CUDA-less build produced `gpu_present = true` on this host. | [V][H] |
| Older records backward compatible and fail closed | **Yes.** Pre-`gpu_present` records parse to `nullopt` → Unknown → G4 FAIL. This is the intentional fail-closed migration limitation. | [V] |

### 2.1 Host inventory comparison

**[H]** OS inventory (`Get-CimInstance Win32_VideoController`): **2** adapters —
`Intel(R) UHD Graphics` (driver 32.0.101.5542) and `NVIDIA GeForce RTX 2050`
(AdapterRAM 4,293,918,720 B, driver 32.0.16.1714).

**[V][H]** Production profiler provenance (from `archive_recovery/v21_evidence/P1-PROFILE-24-0.json`
and the candidate skip records):

> `source: EnumDisplayDevices display-adapter enumeration | adapters: Intel(R) UHD Graphics | Intel(R) UHD Graphics | Intel(R) UHD Graphics | Intel(R) UHD Graphics | NVIDIA GeForce RTX 2050`

Two independent sources agree on the **answer** (`gpu_present = true`; a discrete RTX 2050 is
present). But note the production enumerator listed Intel **four** times against the OS's one Intel
adapter — confirmation of the per-display-device over-count in §2. The over-count does not change
the boolean on this host (it is still `true`), but it means the adapter count is not a reliable
physical-device count.

**[V]** This is *presence only*. It says nothing about: driver health, CUDA runtime availability
(`cuda_available=false` here), CUDA build support, measured VRAM capacity, or whether any GPU
workload can execute. Those remain separate facts and must not be conflated (the spec's G3 keys on
CUDA; G4 keys on measured peak memory; physical presence is orthogonal).

---

## 3. Is the current implementation sufficient?

**For the M0 decision on this host: yes, the verdict is correct and conservative.** On this machine
it reports `gpu_present = true`, matches the CIM inventory, and drives G4 to fail closed for records
lacking physical-capability evidence. It cannot manufacture a false PASS.

**As a general physical-GPU classifier: no — it is a heuristic, not an inventory.** The two
material risks are (a) **false positives** from virtual/mirror display adapters (e.g. Parsec/SpaceDesk
would set `gpu_present = true` on a genuinely CPU-only machine, which would then force a spurious
G4 "GPU-capable" classification), and (b) **false Unknown** when the only GPU is in Basic-Display
fallback (driver unbound), which fails closed rather than mis-passing.

---

## 4. Smallest safe correction (proposed — NOT applied)

Ordered by cost. None is required to change the M0 outcome; the current fail-closed behaviour is
already safe on the audited host.

1. **[P] Harden the virtual-adapter filter** — extend the substring list at `HardwareProfiler.cpp:63-69`
   with `Idd`, `Mirror`, `Parsec`, `Spacedesk`, `Virtual`, `Citrix`, `VNC`, `RDP`. Smallest possible
   change; reduces false positives; still a heuristic.
2. **[P] Count distinct adapter descriptions** and record `adapters[]` (and a distinct count) in the
   profile instead of collapsing to one boolean; keep `gpu_present` as the derived tri-state. Fixes
   the over-count and preserves evidence.
3. **[P] Use SetupAPI (`SetupDiGetClassDevs` on `GUID_DEVCLASS_DISPLAY`) or `EnumDisplayDevices` with
   `EDD_GET_DEVICE_INTERFACE_NAME`, then filter on the device instance path**, to enumerate real
   display class devices rather than display outputs. Larger change; the authoritative fix. Adds no
   third-party dependency (Windows SDK only).

Regression tests proposed for whichever correction is adopted **[P]**:
- a fixture/unit case for each virtual-adapter substring mapping to "not a real GPU";
- a distinct-count assertion given a synthetic multi-output adapter list;
- round-trip parse tests for `gpu_present` ∈ {true, false, `{value:null}`, absent, malformed} →
  {GPU, CPU, Unknown, Unknown, Unknown};
- retain the existing end-to-end capability fixtures (`fixtures/v21/controlled-gpu-cuda-off`,
  `controlled-gpu-vram-measured`, `controlled-unknown-capability`), which already exercise
  G4 FAIL / PASS / FAIL respectively. **[T]**

No source file was modified in v2.2; these remain proposals for a future change under normal review
(and cannot retroactively alter the frozen historical records).
