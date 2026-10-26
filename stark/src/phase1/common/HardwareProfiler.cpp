#include "common/HardwareProfiler.h"

#include <chrono>
#include <cstring>
#include <set>
#include <string>
#include <thread>
#include <vector>

#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_X86)
#define STARK_P1_X86 1
#if defined(_MSC_VER)
#include <intrin.h>
#else
#include <cpuid.h>
#endif
#endif

#ifdef _WIN32
#include <windows.h>
#else
#include <cstdio>
#include <cstring>
#include <sys/statvfs.h>   // statvfs() used by collectStorage() on POSIX
#endif

#if defined(STARK_ENABLE_CUDA)
#include <cuda_runtime.h>
#define STARK_P1_CUDA_COMPILED 1
#endif

namespace stark_p1 {

using Clock = std::chrono::system_clock;

static std::string utc_now() { return RecordStore::utc_timestamp_now(); }

// ---------------------------------------------------------------------------
// Physical GPU presence — OS device inventory, INDEPENDENT of the CUDA build.
//
// `cuda_available` is a *build/runtime CUDA query*: a binary compiled without
// CUDA always reports false even on a machine that physically has a GPU. To
// separate "no GPU on this machine" from "this build has no CUDA", we ask the
// OS for installed display adapters. This is evidence of PHYSICAL presence only;
// it says nothing about CUDA usability.
// ---------------------------------------------------------------------------
static void collectPhysicalGpuPresence(StaticHardwareProfile& p) {
#ifdef _WIN32
    // Gather the RAW display-adapter inventory. EnumDisplayDevices can report the
    // same adapter more than once (one entry per active display output/view), so
    // the raw count is deliberately NOT treated as a GPU count; dedupe and
    // classification happen in classifyDisplayAdapters().
    std::vector<DisplayAdapterInfo> adapters;
    for (DWORD i = 0;; ++i) {
        DISPLAY_DEVICEA dd;
        std::memset(&dd, 0, sizeof(dd));
        dd.cb = sizeof(dd);
        if (!EnumDisplayDevicesA(nullptr, i, &dd, 0)) break;
        DisplayAdapterInfo info;
        info.name = dd.DeviceString;
        info.device_id = dd.DeviceID;
        if (!info.name.empty() || !info.device_id.empty()) adapters.push_back(std::move(info));
    }
    GpuPresenceResult r = HardwareProfiler::classifyDisplayAdapters(adapters);
    p.gpu_present = r.present;
    p.provenance["gpu_present"] = r.reason;
#else
    p.gpu_present = std::nullopt;
    p.provenance["gpu_present"] = "unavailable: no physical GPU inventory source in Phase 1 (non-Windows)";
#endif
}

// ---------------------------------------------------------------------------
// CPU identification (cpuid brand string + feature bits only — no registry)
// ---------------------------------------------------------------------------
void HardwareProfiler::collectCpuId(StaticHardwareProfile& p) {
#ifdef STARK_P1_X86
    int regs[4];
    // Brand string: leaves 0x80000002..0x80000004
    char brand[49];
    char* dst = brand;
    for (int leaf = 0x80000002; leaf <= 0x80000004; ++leaf) {
#ifdef _MSC_VER
        __cpuid(regs, leaf);
#else
        unsigned int ux[4];
        __get_cpuid_count(static_cast<unsigned int>(leaf), 0, &ux[0], &ux[1], &ux[2], &ux[3]);
        for (int i = 0; i < 4; ++i) regs[i] = static_cast<int>(ux[i]);
#endif
        for (int i = 0; i < 4; ++i) {
            int r = regs[i];
            *dst++ = static_cast<char>(r & 0xFF);
            *dst++ = static_cast<char>((r >> 8) & 0xFF);
            *dst++ = static_cast<char>((r >> 16) & 0xFF);
            *dst++ = static_cast<char>((r >> 24) & 0xFF);
        }
    }
    *dst = '\0';
    // Trim leading spaces
    char* s = brand;
    while (*s == ' ') ++s;
    p.cpu_model = s;

    // Feature bits: leaf 1 ECX/EDX, leaf 7 EBX (if max leaf allows)
    std::vector<std::string> feats;
#ifdef _MSC_VER
    __cpuid(regs, 1);
#else
    {
        unsigned int ux[4];
        __get_cpuid_count(1, 0, &ux[0], &ux[1], &ux[2], &ux[3]);
        for (int i = 0; i < 4; ++i) regs[i] = static_cast<int>(ux[i]);
    }
#endif
    if (regs[2] & (1 << 20)) feats.push_back("SSE4.2");
    if (regs[2] & (1 << 27)) feats.push_back("OSXSAVE");
    if (regs[2] & (1 << 28)) feats.push_back("AVX");
    if (regs[3] & (1 << 25)) feats.push_back("SSE");
    if (regs[3] & (1 << 26)) feats.push_back("SSE2");
#ifdef _MSC_VER
    __cpuidex(regs, 7, 0);
#else
    {
        unsigned int ux[4];
        __get_cpuid_count(7, 0, &ux[0], &ux[1], &ux[2], &ux[3]);
        for (int i = 0; i < 4; ++i) regs[i] = static_cast<int>(ux[i]);
    }
#endif
    if (regs[1] & (1 << 5)) feats.push_back("AVX2");
    if (regs[1] & (1 << 16)) feats.push_back("AVX512F");
    std::string note;
    for (size_t i = 0; i < feats.size(); ++i) {
        if (i) note += ", ";
        note += feats[i];
    }
    p.cpu_instruction_set_notes = note;

    // Physical cores: counted from OS sources below (not fabricated from CPUID).
#else
    p.cpu_model = "";
    p.provenance["cpu_model"] = "unavailable: non-x86 target, cpuid brand string not applicable";
#endif

    // Logical cores
    unsigned hc = std::thread::hardware_concurrency();
    if (hc > 0) {
        p.logical_cores = hc;
        p.provenance["logical_cores"] = "source: std::thread::hardware_concurrency()";
    } else {
        p.provenance["logical_cores"] = "unavailable: hardware_concurrency() returned 0";
    }

#ifdef _WIN32
    // Physical core count via processor info (logical cores minus HT detection heuristic
    // is not fabricated: we count unique processor cores reported by the OS).
    {
        DWORD len = 0;
        GetLogicalProcessorInformation(nullptr, &len);
        if (GetLastError() == ERROR_INSUFFICIENT_BUFFER && len > 0) {
            std::vector<char> buf(len);
            auto* info = reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION>(buf.data());
            DWORD count = len / sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION);
            if (GetLogicalProcessorInformation(info, &len)) {
                DWORD cores = 0;
                for (DWORD i = 0; i < count; ++i) {
                    if (info[i].Relationship == RelationProcessorCore) ++cores;
                }
                if (cores > 0) {
                    p.physical_cores = cores;
                    p.provenance["physical_cores"] = "source: GetLogicalProcessorInformation (RelationProcessorCore count)";
                }
            }
        }
        if (!p.physical_cores.has_value())
            p.provenance["physical_cores"] = "unavailable: GetLogicalProcessorInformation did not yield core count";
    }
#else
    p.provenance["physical_cores"] = "unavailable: no portable POSIX source in Phase 1";
#endif

    if (!p.cpu_model.empty())
        p.provenance["cpu_model"] = "source: cpuid brand string (leaves 0x80000002..4)";
    else if (p.provenance.find("cpu_model") == p.provenance.end())
        p.provenance["cpu_model"] = "unavailable: cpuid brand string empty";
}

// ---------------------------------------------------------------------------
// RAM (installed capacity)
// ---------------------------------------------------------------------------
void HardwareProfiler::collectRam(StaticHardwareProfile& p) {
#ifdef _WIN32
    MEMORYSTATUSEX ms{};
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        p.ram_total_bytes = ms.ullTotalPhys;
        p.provenance["ram_total_bytes"] = "source: GlobalMemoryStatusEx ullTotalPhys (installed)";
    } else {
        p.provenance["ram_total_bytes"] = "unavailable: GlobalMemoryStatusEx failed";
    }
#else
    std::FILE* f = std::fopen("/proc/meminfo", "r");
    if (f) {
        char line[256];
        unsigned long kb = 0;
        while (std::fgets(line, sizeof(line), f)) {
            if (std::strncmp(line, "MemTotal:", 9) == 0) {
                if (std::sscanf(line + 9, " %lu", &kb) == 1) {
                    p.ram_total_bytes = static_cast<uint64_t>(kb) * 1024ULL;
                    p.provenance["ram_total_bytes"] = "source: /proc/meminfo MemTotal";
                }
                break;
            }
        }
        std::fclose(f);
    }
    if (!p.ram_total_bytes.has_value())
        p.provenance["ram_total_bytes"] = "unavailable: /proc/meminfo not readable";
#endif
}

// ---------------------------------------------------------------------------
// GPU (CUDA Runtime API only when compiled with CUDA)
// ---------------------------------------------------------------------------
void HardwareProfiler::collectGpu(StaticHardwareProfile& p) {
#ifdef STARK_P1_CUDA_COMPILED
    int count = 0;
    cudaError_t err = cudaGetDeviceCount(&count);
    if (err == cudaSuccess && count > 0) {
        p.cuda_available = true;
        cudaDeviceProp prop{};
        if (cudaGetDeviceProperties(&prop, 0) == cudaSuccess) {
            p.gpu_model = prop.name;
            p.vram_total_bytes = static_cast<uint64_t>(prop.totalGlobalMem);
            p.gpu_compute_capability_major = prop.major;
            p.gpu_compute_capability_minor = prop.minor;
            // Theoretical bandwidth from device properties ONLY:
            // memoryClockRate (kHz) * busWidth (bits) * 2 (DDR) / 8 -> bytes/s
            double bw = static_cast<double>(prop.memoryClockRate) * 1000.0 *
                        static_cast<double>(prop.memoryBusWidth) * 2.0 / 8.0;
            p.theoretical_memory_bandwidth_gbps = bw / 1e9;
            p.provenance["gpu_model"] = "source: cudaGetDeviceProperties";
            p.provenance["theoretical_memory_bandwidth_gbps"] =
                "source: device props (memoryClockRate x busWidth x 2 / 8); THEORETICAL, not measured";
        }
        int driver = 0, runtime = 0;
        cudaDriverGetVersion(&driver);
        cudaRuntimeGetVersion(&runtime);
        p.cuda_version = "runtime " + std::to_string(runtime / 1000) + "." +
                         std::to_string((runtime % 1000) / 10) + " / driver " +
                         std::to_string(driver / 1000) + "." + std::to_string((driver % 1000) / 10);
    } else if (err == cudaSuccess && count == 0) {
        p.provenance["gpu_model"] = "unavailable: CUDA runtime reports 0 devices";
    } else {
        p.provenance["gpu_model"] = std::string("unavailable: cudaGetDeviceCount error: ") + cudaGetErrorString(err);
    }
    p.provenance["cuda_available"] = "source: cudaGetDeviceCount (build: STARK_ENABLE_CUDA=ON)";
#else
    p.cuda_available = false;
    p.provenance["cuda_available"] = "unavailable: binary built without CUDA (STARK_ENABLE_CUDA=OFF / no toolkit)";
    p.provenance["gpu_model"] = "unavailable: binary built without CUDA";
    p.provenance["cuda_version"] = "unavailable: binary built without CUDA";
#endif
    p.provenance["pytorch_cuda_available_note"] =
        "unavailable: PyTorch runtime out of scope for C++ Phase 1 (spec §A / §L.7)";
}

// ---------------------------------------------------------------------------
// Storage volumes
// ---------------------------------------------------------------------------
void HardwareProfiler::collectStorage(StaticHardwareProfile& p) {
#ifdef _WIN32
    DWORD drives = GetLogicalDrives();
    for (int i = 0; i < 26; ++i) {
        if (!(drives & (1u << i))) continue;
        char root[4] = {static_cast<char>('A' + i), ':', '\\', '\0'};
        UINT type = GetDriveTypeA(root);
        if (type != DRIVE_FIXED) continue;
        ULARGE_INTEGER total{}, freeq{};
        if (GetDiskFreeSpaceExA(root, nullptr, &total, &freeq)) {
            StaticHardwareProfile::Volume vol;
            vol.path = root;
            vol.total_bytes = total.QuadPart;
            vol.free_bytes = freeq.QuadPart;
            p.storage_volumes.push_back(std::move(vol));
        }
    }
    p.provenance["storage_volumes"] = "source: GetDiskFreeSpaceExA over fixed drives";
#else
    // Minimal POSIX: statvfs on "/" only (Phase 1 scope)
    struct statvfs vfs{};
    if (statvfs("/", &vfs) == 0) {
        StaticHardwareProfile::Volume vol;
        vol.path = "/";
        vol.total_bytes = static_cast<uint64_t>(vfs.f_blocks) * vfs.f_frsize;
        vol.free_bytes = static_cast<uint64_t>(vfs.f_bavail) * vfs.f_frsize;
        p.storage_volumes.push_back(std::move(vol));
        p.provenance["storage_volumes"] = "source: statvfs(/)";
    } else {
        p.provenance["storage_volumes"] = "unavailable: statvfs failed";
    }
#endif
    if (p.storage_volumes.empty() && p.provenance.find("storage_volumes") == p.provenance.end())
        p.provenance["storage_volumes"] = "unavailable: no fixed volumes reported";
}

// ---------------------------------------------------------------------------
// Platform / toolchain
// ---------------------------------------------------------------------------
void HardwareProfiler::collectPlatform(StaticHardwareProfile& p) {
#ifdef _WIN32
    OSVERSIONINFOA vi{};
    vi.dwOSVersionInfoSize = sizeof(vi);
#pragma warning(push)
#pragma warning(disable : 4996)
    GetVersionExA(&vi);
#pragma warning(pop)
    p.os_name = "Windows";
    p.os_version = std::to_string(vi.dwMajorVersion) + "." + std::to_string(vi.dwMinorVersion) +
                    " (build " + std::to_string(vi.dwBuildNumber) + ")";
    // Note: GetVersionEx is manifestation-limited on Win10+; record the limitation as provenance
    // rather than fabricating an exact version. RtlGetVersion is used when available:
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    HMODULE h = GetModuleHandleA("ntdll.dll");
    if (h) {
        auto rtl = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(h, "RtlGetVersion"));
        if (rtl) {
            RTL_OSVERSIONINFOW w{};
            w.dwOSVersionInfoSize = sizeof(w);
            if (rtl(&w) == 0) {
                p.os_version = std::to_string(w.dwMajorVersion) + "." + std::to_string(w.dwMinorVersion) +
                                " (build " + std::to_string(w.dwBuildNumber) + ")";
                p.provenance["os_version"] = "source: ntdll RtlGetVersion (unmanifested true version)";
            }
        }
    }
    if (p.provenance.find("os_version") == p.provenance.end())
        p.provenance["os_version"] = "source: GetVersionExA (may be manifestation-limited)";
#else
    std::FILE* f = std::fopen("/proc/sys/kernel/ostype", "r");
    if (f) {
        char buf[128] = {0};
        if (std::fgets(buf, sizeof(buf), f)) p.os_name = buf;
        std::fclose(f);
        // strip newline
        while (!p.os_name.empty() && (p.os_name.back() == '\n')) p.os_name.pop_back();
    }
    f = std::fopen("/proc/sys/kernel/osrelease", "r");
    if (f) {
        char buf[128] = {0};
        if (std::fgets(buf, sizeof(buf), f)) p.os_version = buf;
        std::fclose(f);
        while (!p.os_version.empty() && (p.os_version.back() == '\n')) p.os_version.pop_back();
    }
    p.provenance["os_version"] = "source: /proc/sys/kernel/osrelease";
#endif

#if defined(_MSC_VER)
    p.toolchain = std::string("MSVC ") + std::to_string(_MSC_VER);
#elif defined(__clang__)
    p.toolchain = std::string("Clang ") + __clang_version__;
#elif defined(__GNUC__)
    p.toolchain = std::string("GCC ") + std::to_string(__GNUC__) + "." + std::to_string(__GNUC_MINOR__) +
                  "." + std::to_string(__GNUC_PATCHLEVEL__);
#else
    p.toolchain = "unknown";
    p.provenance["toolchain"] = "unavailable: unknown compiler macros";
#endif

#ifdef NDEBUG
    p.build_type = "Release";
#else
    p.build_type = "Debug";
#endif
    p.collected_utc = utc_now();
}

// ---------------------------------------------------------------------------
// Physical GPU classification (v2.3): dedupe + real-vs-virtual separation.
//
// Best-effort OS device inventory. Windows does not expose a perfect "this is a
// physical GPU" query via EnumDisplayDevices, so we combine the stable PNP
// device id (a real GPU enumerates through the PCI bus) with a conservative
// known-vendor name list, and we EXCLUDE known virtual/remote/basic adapters and
// software-enumerated devices. When nothing can be classified reliably we return
// Unknown (nullopt) so the caller never records a false CPU-only verdict.
// ---------------------------------------------------------------------------
namespace {
std::string lower_ascii(std::string s) {
    for (char& c : s)
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}
bool contains_ci(const std::string& hay, const std::string& needle) {
    return lower_ascii(hay).find(lower_ascii(needle)) != std::string::npos;
}

// Known virtual / remote / fallback display adapters: these are NOT physical GPU
// hardware and must never make gpu_present true.
bool is_known_virtual_adapter(const std::string& name, const std::string& device_id) {
    static const char* kVirtualNames[] = {
        "microsoft basic display", "microsoft basic render", "basic display adapter",
        "basic render driver", "remote display", "remote desktop", "parsec",
        "spacedesk", "iddsample", "indirect display", "virtual display",
        "citrix", "mirror driver", "dameware", "meta virtual", "usb display",
        "displaylink",
    };
    for (const char* n : kVirtualNames)
        if (contains_ci(name, n)) return true;
    // Software-enumerated devices (ROOT\ / SWD\) are never physical PCI GPUs.
    const std::string id = lower_ascii(device_id);
    if (id.rfind("root\\", 0) == 0 || id.rfind("swd\\", 0) == 0) return true;
    return false;
}

// A physical GPU adapter enumerates through the PCI bus, or carries a known GPU
// vendor string (secondary signal when the device id is unavailable).
bool is_physical_gpu(const std::string& name, const std::string& device_id) {
    if (contains_ci(device_id, "pci\\") || contains_ci(device_id, "pci#")) return true;
    static const char* kGpuVendors[] = {
        "nvidia", "geforce", "quadro", "rtx", "gtx", "radeon", "amd ",
        "intel(r) uhd", "intel uhd", "intel iris", "intel arc",
    };
    for (const char* v : kGpuVendors)
        if (contains_ci(name, v)) return true;
    return false;
}
}  // namespace

GpuPresenceResult HardwareProfiler::classifyDisplayAdapters(
    const std::vector<DisplayAdapterInfo>& adapters) {
    GpuPresenceResult r;
    r.raw_count = adapters.size();

    // Dedupe by stable identity: prefer the PNP device id, fall back to the
    // friendly name. Preserve first-seen order for deterministic reporting.
    std::vector<DisplayAdapterInfo> unique;
    std::set<std::string> seen;
    for (const auto& a : adapters) {
        const std::string key = !a.device_id.empty() ? a.device_id : ("name:" + a.name);
        if (seen.insert(key).second) unique.push_back(a);
    }
    r.unique_count = unique.size();

    for (const auto& a : unique) {
        if (is_known_virtual_adapter(a.name, a.device_id)) {
            r.virtual_adapters.push_back(a.name.empty() ? a.device_id : a.name);
        } else if (is_physical_gpu(a.name, a.device_id)) {
            r.physical.push_back(a.name.empty() ? a.device_id : a.name);
        } else {
            r.ambiguous.push_back(a.name.empty() ? a.device_id : a.name);
        }
    }

    auto join = [](const std::vector<std::string>& v) {
        std::string s;
        for (size_t i = 0; i < v.size(); ++i) { if (i) s += " | "; s += v[i]; }
        return s;
    };

    if (r.unique_count == 0) {
        r.present = std::nullopt;
        r.reason = "unavailable: display-adapter inventory empty (no adapters enumerated)";
        return r;
    }
    if (!r.physical.empty()) {
        r.present = true;
        r.reason = "source: OS display-adapter inventory (EnumDisplayDevices), deduped by PNP device id | "
                   "physical: " + join(r.physical) +
                   " | raw_entries: " + std::to_string(r.raw_count) +
                   " | unique_adapters: " + std::to_string(r.unique_count);
        return r;
    }
    if (!r.ambiguous.empty()) {
        // Adapters exist but none could be confirmed physical. Do NOT downgrade
        // to CPU-only: record Unknown (fail closed).
        r.present = std::nullopt;
        r.reason = "unknown: no adapter could be confirmed physical and none is a known "
                   "virtual/basic adapter | ambiguous: " + join(r.ambiguous) +
                   " | physical: (none) | raw_entries: " + std::to_string(r.raw_count) +
                   " | unique_adapters: " + std::to_string(r.unique_count);
        return r;
    }
    // Every unique adapter is a recognized non-GPU (virtual/basic/remote).
    r.present = false;
    r.reason = "source: OS display-adapter inventory (EnumDisplayDevices) reports only "
               "non-GPU (virtual/basic/remote) adapters | adapters: " + join(r.virtual_adapters) +
               " | raw_entries: " + std::to_string(r.raw_count) +
               " | unique_adapters: " + std::to_string(r.unique_count);
    return r;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
StaticHardwareProfile HardwareProfiler::collectStatic() {
    StaticHardwareProfile p;
    collectCpuId(p);
    collectRam(p);
    collectPhysicalGpuPresence(p);  // OS device inventory (CUDA-build independent)
    collectGpu(p);
    collectStorage(p);
    collectPlatform(p);
    return p;
}

RuntimeTelemetry HardwareProfiler::sampleDynamic() {
    RuntimeTelemetry t;
    t.sampled_at_utc = utc_now();
#ifdef _WIN32
    MEMORYSTATUSEX ms{};
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        t.ram_total_bytes = ms.ullTotalPhys;
        t.ram_available_bytes = ms.ullAvailPhys;
        t.platform_source = "GlobalMemoryStatusEx";
    } else {
        t.platform_source = "GlobalMemoryStatusEx (failed)";
        t.provenance["ram_available_bytes"] = "unavailable: GlobalMemoryStatusEx failed";
    }
#ifdef STARK_P1_CUDA_COMPILED
    if (HardwareProfiler::cudaRuntimeAvailable()) {
        size_t freeb = 0, totalb = 0;
        if (cudaMemGetInfo(&freeb, &totalb) == cudaSuccess) {
            t.vram_free_bytes = freeb;
            t.platform_source += "+cudaMemGetInfo";
        } else {
            t.provenance["vram_free_bytes"] = "unavailable: cudaMemGetInfo failed";
        }
    } else {
        t.provenance["vram_free_bytes"] = "unavailable: built without CUDA or no device";
    }
#else
    t.provenance["vram_free_bytes"] = "unavailable: binary built without CUDA";
#endif
#else
    std::FILE* f = std::fopen("/proc/meminfo", "r");
    if (f) {
        char line[256];
        unsigned long total_kb = 0, avail_kb = 0;
        while (std::fgets(line, sizeof(line), f)) {
            if (std::strncmp(line, "MemTotal:", 9) == 0) std::sscanf(line + 9, " %lu", &total_kb);
            if (std::strncmp(line, "MemAvailable:", 13) == 0) std::sscanf(line + 13, " %lu", &avail_kb);
        }
        std::fclose(f);
        if (total_kb) t.ram_total_bytes = static_cast<uint64_t>(total_kb) * 1024ULL;
        if (avail_kb) t.ram_available_bytes = static_cast<uint64_t>(avail_kb) * 1024ULL;
        t.platform_source = "/proc/meminfo";
    } else {
        t.provenance["ram_available_bytes"] = "unavailable: /proc/meminfo not readable";
    }
#endif
    return t;
}

bool HardwareProfiler::cudaRuntimeAvailable() {
#ifdef STARK_P1_CUDA_COMPILED
    int n = 0;
    return cudaGetDeviceCount(&n) == cudaSuccess && n > 0;
#else
    return false;
#endif
}

std::string HardwareProfiler::schemaVersion() { return "STARKP1 1"; }

// ---------------------------------------------------------------------------
// JSON codecs
// ---------------------------------------------------------------------------
static JsonValue reasoned_u64_json(const std::optional<uint64_t>& v, const char* key,
                                   const std::map<std::string, std::string>& prov) {
    if (v.has_value()) return JsonValue::uinteger(*v);
    JsonValue o = JsonValue::object();
    o.set("value", JsonValue::null());
    auto it = prov.find(key);
    o.set("reason", JsonValue::str(it != prov.end() ? it->second : "unavailable: no provenance recorded"));
    return o;
}
static JsonValue reasoned_str_json(const std::optional<std::string>& v, const char* key,
                                   const std::map<std::string, std::string>& prov) {
    if (v.has_value()) return JsonValue::str(*v);
    JsonValue o = JsonValue::object();
    o.set("value", JsonValue::null());
    auto it = prov.find(key);
    o.set("reason", JsonValue::str(it != prov.end() ? it->second : "unavailable: no provenance recorded"));
    return o;
}
static JsonValue reasoned_i_json(const std::optional<int>& v, const char* key,
                                 const std::map<std::string, std::string>& prov) {
    if (v.has_value()) return JsonValue::integer(*v);
    JsonValue o = JsonValue::object();
    o.set("value", JsonValue::null());
    auto it = prov.find(key);
    o.set("reason", JsonValue::str(it != prov.end() ? it->second : "unavailable: no provenance recorded"));
    return o;
}
static JsonValue reasoned_d_json(const std::optional<double>& v, const char* key,
                                 const std::map<std::string, std::string>& prov) {
    if (v.has_value()) return JsonValue::number(*v);
    JsonValue o = JsonValue::object();
    o.set("value", JsonValue::null());
    auto it = prov.find(key);
    o.set("reason", JsonValue::str(it != prov.end() ? it->second : "unavailable: no provenance recorded"));
    return o;
}

static std::optional<uint64_t> parse_reasoned_u64(const JsonValue& v) {
    if (v.isNull()) return std::nullopt;
    if (v.isObject()) {
        if (v.has("value") && !v.get("value").isNull()) return v.get("value").asUInt();
        return std::nullopt;
    }
    return v.asUInt();
}
static std::optional<std::string> parse_reasoned_str(const JsonValue& v) {
    if (v.isNull()) return std::nullopt;
    if (v.isObject()) {
        if (v.has("value") && !v.get("value").isNull()) return v.get("value").asString();
        return std::nullopt;
    }
    return v.asString();
}
static std::optional<int> parse_reasoned_i(const JsonValue& v) {
    if (v.isNull()) return std::nullopt;
    if (v.isObject()) {
        if (v.has("value") && !v.get("value").isNull()) return static_cast<int>(v.get("value").asInt());
        return std::nullopt;
    }
    return static_cast<int>(v.asInt());
}
static std::optional<double> parse_reasoned_d(const JsonValue& v) {
    if (v.isNull()) return std::nullopt;
    if (v.isObject()) {
        if (v.has("value") && !v.get("value").isNull()) return v.get("value").asDouble();
        return std::nullopt;
    }
    return v.asDouble();
}

JsonValue StaticHardwareProfile::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("cpu_model", cpu_model.empty() ? reasoned_str_json(std::nullopt, "cpu_model", provenance)
                                         : JsonValue::str(cpu_model));
    o.set("physical_cores", reasoned_u64_json(
        physical_cores.has_value() ? std::optional<uint64_t>(*physical_cores) : std::nullopt,
        "physical_cores", provenance));
    o.set("logical_cores", reasoned_u64_json(
        logical_cores.has_value() ? std::optional<uint64_t>(*logical_cores) : std::nullopt,
        "logical_cores", provenance));
    o.set("cpu_instruction_set_notes", reasoned_str_json(cpu_instruction_set_notes, "cpu_instruction_set_notes", provenance));
    o.set("ram_total_bytes", reasoned_u64_json(ram_total_bytes, "ram_total_bytes", provenance));
    o.set("cuda_available", JsonValue::boolean(cuda_available));
    if (gpu_present.has_value()) {
        o.set("gpu_present", JsonValue::boolean(*gpu_present));
    } else {
        JsonValue gp = JsonValue::object();
        gp.set("value", JsonValue::null());
        auto it = provenance.find("gpu_present");
        gp.set("reason", JsonValue::str(it != provenance.end() ? it->second
                                                               : "unavailable: no provenance recorded"));
        o.set("gpu_present", std::move(gp));
    }
    o.set("gpu_model", reasoned_str_json(gpu_model, "gpu_model", provenance));
    o.set("vram_total_bytes", reasoned_u64_json(vram_total_bytes, "vram_total_bytes", provenance));
    o.set("gpu_compute_capability_major", reasoned_i_json(gpu_compute_capability_major, "gpu_compute_capability_major", provenance));
    o.set("gpu_compute_capability_minor", reasoned_i_json(gpu_compute_capability_minor, "gpu_compute_capability_minor", provenance));
    o.set("theoretical_memory_bandwidth_gbps", reasoned_d_json(theoretical_memory_bandwidth_gbps, "theoretical_memory_bandwidth_gbps", provenance));
    o.set("cuda_version", reasoned_str_json(cuda_version, "cuda_version", provenance));
    o.set("pytorch_cuda_available", JsonValue::null());  // reserved per spec
    JsonValue vols = JsonValue::array();
    for (const auto& vol : storage_volumes) {
        JsonValue vo = JsonValue::object();
        vo.set("path", JsonValue::str(vol.path));
        vo.set("total_bytes", reasoned_u64_json(vol.total_bytes, "storage_volumes", provenance));
        vo.set("free_bytes", reasoned_u64_json(vol.free_bytes, "storage_volumes", provenance));
        vols.append(std::move(vo));
    }
    o.set("storage_volumes", std::move(vols));
    o.set("os_name", JsonValue::str(os_name));
    o.set("os_version", JsonValue::str(os_version));
    o.set("toolchain", JsonValue::str(toolchain));
    o.set("build_type", JsonValue::str(build_type));
    o.set("collected_utc", JsonValue::str(collected_utc));
    JsonValue prov = JsonValue::object();
    for (const auto& [k, v] : provenance) prov.set(k, JsonValue::str(v));
    o.set("provenance", std::move(prov));
    return o;
}

StaticHardwareProfile StaticHardwareProfile::from_json(const JsonValue& o) {
    StaticHardwareProfile p;
    p.cpu_model = o.get("cpu_model").type() == JsonValue::Type::String ? o.get("cpu_model").asString() : std::string();
    p.physical_cores = parse_reasoned_u64(o.get("physical_cores"));
    p.logical_cores = parse_reasoned_u64(o.get("logical_cores"));
    p.cpu_instruction_set_notes = parse_reasoned_str(o.get("cpu_instruction_set_notes"));
    p.ram_total_bytes = parse_reasoned_u64(o.get("ram_total_bytes"));
    p.cuda_available = o.get("cuda_available").asBool();
    if (o.has("gpu_present")) {
        const JsonValue& gp = o.get("gpu_present");
        if (gp.type() == JsonValue::Type::Bool) {
            p.gpu_present = gp.asBool();
        } else if (gp.isObject() && gp.has("value") &&
                   gp.get("value").type() == JsonValue::Type::Bool) {
            p.gpu_present = gp.get("value").asBool();
        }
        // object with null value / other malformed forms => unknown (nullopt)
    }
    p.gpu_model = parse_reasoned_str(o.get("gpu_model"));
    p.vram_total_bytes = parse_reasoned_u64(o.get("vram_total_bytes"));
    p.gpu_compute_capability_major = parse_reasoned_i(o.get("gpu_compute_capability_major"));
    p.gpu_compute_capability_minor = parse_reasoned_i(o.get("gpu_compute_capability_minor"));
    p.theoretical_memory_bandwidth_gbps = parse_reasoned_d(o.get("theoretical_memory_bandwidth_gbps"));
    p.cuda_version = parse_reasoned_str(o.get("cuda_version"));
    const JsonValue& vols = o.get("storage_volumes");
    for (const auto& vo : vols.items()) {
        StaticHardwareProfile::Volume vol;
        vol.path = vo.get("path").asString();
        vol.total_bytes = parse_reasoned_u64(vo.get("total_bytes"));
        vol.free_bytes = parse_reasoned_u64(vo.get("free_bytes"));
        p.storage_volumes.push_back(std::move(vol));
    }
    p.os_name = o.get("os_name").asString();
    p.os_version = o.get("os_version").asString();
    p.toolchain = o.get("toolchain").asString();
    p.build_type = o.get("build_type").asString();
    p.collected_utc = o.get("collected_utc").asString();
    const JsonValue& prov = o.get("provenance");
    for (const auto& [k, v] : prov.entries()) p.provenance[k] = v.asString();
    return p;
}

JsonValue RuntimeTelemetry::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("ram_total_bytes", reasoned_u64_json(ram_total_bytes, "ram_total_bytes", provenance));
    o.set("ram_available_bytes", reasoned_u64_json(ram_available_bytes, "ram_available_bytes", provenance));
    o.set("vram_free_bytes", reasoned_u64_json(vram_free_bytes, "vram_free_bytes", provenance));
    o.set("sampled_at_utc", JsonValue::str(sampled_at_utc));
    o.set("platform_source", JsonValue::str(platform_source));
    JsonValue prov = JsonValue::object();
    for (const auto& [k, v] : provenance) prov.set(k, JsonValue::str(v));
    o.set("provenance", std::move(prov));
    return o;
}

RuntimeTelemetry RuntimeTelemetry::from_json(const JsonValue& o) {
    RuntimeTelemetry t;
    t.ram_total_bytes = parse_reasoned_u64(o.get("ram_total_bytes"));
    t.ram_available_bytes = parse_reasoned_u64(o.get("ram_available_bytes"));
    t.vram_free_bytes = parse_reasoned_u64(o.get("vram_free_bytes"));
    t.sampled_at_utc = o.get("sampled_at_utc").asString();
    t.platform_source = o.get("platform_source").asString();
    if (o.has("provenance") && o.get("provenance").isObject())
        for (const auto& [k, v] : o.get("provenance").entries()) t.provenance[k] = v.asString();
    return t;
}

std::vector<std::string> StaticHardwareProfile::validate() const {
    std::vector<std::string> errs;
    if (cpu_model.empty()) errs.push_back("cpu_model empty without provenance (provenance: " +
                                          (provenance.count("cpu_model") ? provenance.at("cpu_model") : "<none>") + ")");
    if (!ram_total_bytes.has_value()) errs.push_back("ram_total_bytes unavailable");
    else if (*ram_total_bytes == 0) errs.push_back("ram_total_bytes == 0 (generic validity violation)");
    if (storage_volumes.empty()) errs.push_back("storage_volumes empty");
    if (logical_cores.has_value() && *logical_cores == 0)
        errs.push_back("logical_cores == 0 (generic validity violation)");
    if (os_name.empty()) errs.push_back("os_name empty");
    if (toolchain.empty()) errs.push_back("toolchain empty");
    if (cuda_available && !vram_total_bytes.has_value())
        errs.push_back("cuda_available but vram_total_bytes missing");
    return errs;
}

} // namespace stark_p1
