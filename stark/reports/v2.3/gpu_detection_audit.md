# Physical GPU Detection Audit — v2.3

**Scope:** Correct the v2.2 finding that `EnumDisplayDevicesA` over-counted
adapters and could accept virtual display adapters as real GPU hardware.

## 1. Problem (v2.2 finding)

`collectPhysicalGpuPresence()` (`src/phase1/common/HardwareProfiler.cpp`) treated
the raw `EnumDisplayDevicesA` list as the adapter set and filtered only three
substrings (`Microsoft Basic`, `Remote`, `Basic Render`). Consequences:

- `EnumDisplayDevices` can emit one entry per display output/view, so one adapter
  appears multiple times → the raw count over-counts (host: **5 entries** for 2
  adapters).
- Virtual/remote adapters (Parsec, SpaceDesk, IddSample, Citrix, Meta Virtual,
  USB Display, DisplayLink, …) were accepted as physical hardware.

## 2. Fix

`collectPhysicalGpuPresence()` now gathers only the raw inventory
(`{DeviceString, DeviceID}`) and defers to a new **pure, deterministic**
classifier `HardwareProfiler::classifyDisplayAdapters()`. No new dependency; the
same Win32 API is used, with better identity + classification.

Classification order per adapter:

1. **Known virtual/basic/remote** (name substrings; `ROOT\` / `SWD\` device paths)
   → excluded from physical presence.
2. **Physical** if the device path is a PCI device (`PCI\`) **or** the friendly
   name carries a known GPU vendor (NVIDIA/GeForce/RTX/GTX/Quadro, AMD/Radeon,
   Intel UHD/Iris/Arc).
3. Otherwise → **ambiguous**.

Adapters are **deduplicated** by stable identity (PNP `DeviceID`, else friendly
name) before classification.

Result mapping:

| Situation | `gpu_present` |
|---|---|
| ≥1 physical adapter | `true` |
| all adapters recognized virtual/basic/remote | `false` (confirmed non-GPU) |
| empty inventory | `nullopt` (Unknown) |
| only ambiguous adapters | `nullopt` (Unknown) |

Unknown is **never** downgraded to CPU-only: the classifier reports
`reason: "unknown: …"` and the caller keeps `gpu_present = nullopt`.

## 3. Requirements check

| Requirement | Status |
|---|---|
| Deduplicate adapters by stable identity | ✔ (PNP id, else name) |
| Distinguish physical from virtual/remote/basic | ✔ (vendor + PCI id vs known-virtual list) |
| Preserve Unknown when classification is unreliable | ✔ (`nullopt`) |
| Never classify unknown as CPU-only | ✔ (ambiguous → `nullopt`) |
| CUDA build/runtime availability independent of physical presence | ✔ (`cuda_available` untouched; still a separate probe) |
| No unnecessary dependency/complexity | ✔ (same Win32 API, hand-rolled classifier) |

## 4. Host observation (HP Victus i5-12450H / RTX 2050)

Before (v2.2): raw 5 entries, all counted, `gpu_present=true` with no dedupe.

After (v2.3):

```
gpu_present = true
provenance[gpu_present] = source: OS display-adapter inventory (EnumDisplayDevices),
  deduped by PNP device id | physical: Intel(R) UHD Graphics | NVIDIA GeForce RTX 2050 |
  raw_entries: 5 | unique_adapters: 2
cuda_available = false
```

5 raw entries collapse to 2 unique adapters; both classified physical (Intel UHD
via PCI id, NVIDIA via vendor name). `cuda_available` remains `false` and
independent.

## 5. Deterministic tests (11 cases)

In `tests/test_phase1_gates.cpp` (v2.3 block), calling the pure classifier with
synthetic adapters — **not** dependent on the host RTX 2050:

1. physical NVIDIA adapter → `true`
2. Intel integrated adapter → `true`
3. duplicate enumeration of one adapter → deduped, `unique_count==1`, `true`
4. Microsoft Basic Display Adapter only → `false`
5. Parsec/SpaceDesk virtual adapters only → `false`
6. empty inventory → Unknown (`nullopt`)
7. ambiguous adapter (no PCI id, no known vendor) → Unknown (`nullopt`)
8. mixed physical + virtual → `true`, virtual separated
9. PCI device id with unknown vendor name → `true`
10. dedupe by name when no device id → `unique_count==1`
11. determinism: identical input → identical classification

## 6. Honest limitation

`EnumDisplayDevices` is not a hardware-database API, so this is **best-effort**
detection, not a guarantee. An adapter with a PCI device path but an unrecognized
vendor name is accepted as physical (PCI evidence); an adapter with neither a PCI
path nor a known vendor is reported Unknown rather than guessed. This deliberately
errs toward Unknown (fail closed) instead of a false CPU-only verdict. It is not
claimed to be perfect physical-hardware detection.

## 7. Effect on G4

The GPU-detection fix does **not** make G4 pass. The recovered records still have
no measured VRAM and no `gpu_present` field; G4 remains FAIL under the frozen
rule set. The fix changes only how physical presence is *reported* for future
records, never a frozen threshold.