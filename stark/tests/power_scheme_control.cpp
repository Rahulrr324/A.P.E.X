// power_scheme_control.cpp
//
// Session-scoped Windows power-scheme control for the G7 reproducibility
// investigation (stability-gate validation only; never runs a G7 campaign).
//
// Subcommands:
//   power_scheme_control status [--json <path>]
//     Query the active power scheme (GUID + friendly name) and write a
//     timestamped JSON artifact. READ-ONLY: never changes policy.
//
//   power_scheme_control run --cmd <command line> [--json <path>]
//     Snapshot the original scheme -> apply the documented High Performance
//     GUID via PowerSetActiveScheme -> run <command line> -> ALWAYS restore
//     the original scheme (normal exit, child failure, Ctrl+C/close) ->
//     re-query and prove the restored GUID equals the original.
//     Exits nonzero if apply or restore fails.
//
// Documented Windows API only (powrprof.dll: PowerGetActiveScheme,
// PowerSetActiveScheme, PowerReadFriendlyName). No registry edits, no MSR
// writes, no BIOS changes, no clock forcing, no thermal-policy changes.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// powrprof.dll: the documented APIs are declared manually (same pattern as
// tests/diag_frequency_evidence.cpp). Layouts match the Windows SDK.
extern "C" {
DWORD WINAPI PowerGetActiveScheme(HKEY UserRootKey, GUID** ActiveSchemeGuid);
DWORD WINAPI PowerSetActiveScheme(HKEY UserRootKey, const GUID* SchemeGuid);
DWORD WINAPI PowerReadFriendlyName(HKEY RootKey, const GUID* SchemeGuid,
                                   const GUID* SubGroupGuid,
                                   const GUID* SettingGuid, PBYTE* Buffer,
                                   DWORD* BufferSize);
}

namespace {

// Documented Windows "High performance" power scheme.
const GUID kHighPerformance = {
    0x8c5e7fda, 0xe8bf, 0x4a96,
    {0x9a, 0x85, 0xa6, 0xe2, 0x3a, 0x8c, 0x63, 0x5c}};

std::string guid_to_string(const GUID& g) {
    char buf[64];
    std::snprintf(buf, sizeof(buf),
                  "%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                  static_cast<unsigned long>(g.Data1), g.Data2, g.Data3,
                  g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3], g.Data4[4],
                  g.Data4[5], g.Data4[6], g.Data4[7]);
    return buf;
}

bool guid_equal(const GUID& a, const GUID& b) {
    return std::memcmp(&a, &b, sizeof(GUID)) == 0;
}

std::string iso_timestamp() {
    FILETIME ft{};
    GetSystemTimeAsFileTime(&ft);
    SYSTEMTIME st{};
    FileTimeToSystemTime(&ft, &st);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
                  st.wSecond, st.wMilliseconds);
    return buf;
}

// ASCII-safe JSON string escaping (cp1252 consoles: keep artifacts ASCII).
std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char tmp[8];
                    std::snprintf(tmp, sizeof(tmp), "\\u%04x", c);
                    out += tmp;
                } else if (c < 0x80) {
                    out += static_cast<char>(c);
                } else {
                    char tmp[8];
                    std::snprintf(tmp, sizeof(tmp), "\\u00%02x", c);
                    out += tmp;
                }
        }
    }
    return out;
}

struct SchemeState {
    DWORD query_status = static_cast<DWORD>(-1);
    GUID guid{};
    bool has_guid = false;
    std::string friendly_name;  // may be empty
    std::string timestamp;
};

SchemeState query_scheme() {
    SchemeState s;
    s.timestamp = iso_timestamp();
    GUID* raw = nullptr;
    s.query_status = PowerGetActiveScheme(nullptr, &raw);
    if (s.query_status == ERROR_SUCCESS && raw != nullptr) {
        s.guid = *raw;
        s.has_guid = true;
        LocalFree(raw);  // documented caller responsibility

        PBYTE name_buf = nullptr;
        DWORD name_sz = 0;
        if (PowerReadFriendlyName(nullptr, &s.guid, nullptr, nullptr, &name_buf,
                                  &name_sz) == ERROR_SUCCESS &&
            name_buf != nullptr) {
            std::wstring w(reinterpret_cast<wchar_t*>(name_buf));
            // Wide -> narrow (ASCII-safe for the artifact).
            s.friendly_name.assign(w.begin(), w.end());
            LocalFree(name_buf);
        }
    }
    return s;
}

bool write_all(const std::string& path, const std::string& data) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    bool ok = std::fwrite(data.data(), 1, data.size(), f) == data.size();
    ok = (std::fclose(f) == 0) && ok;
    return ok;
}

// ---------------------------------------------------------------------------
// Crash-safety: restore target kept globally so a Ctrl+C / console close can
// still put the original scheme back.
// ---------------------------------------------------------------------------
GUID g_restore_target{};
bool g_have_restore_target = false;
volatile LONG g_restored = 0;

bool restore_original_now(DWORD* out_status) {
    if (!g_have_restore_target) return false;
    if (InterlockedCompareExchange(&g_restored, 1, 0) != 0) {
        // Already restored (or in progress) elsewhere; report success.
        if (out_status) *out_status = ERROR_SUCCESS;
        return true;
    }
    DWORD st = PowerSetActiveScheme(nullptr, &g_restore_target);
    if (out_status) *out_status = st;
    if (st != ERROR_SUCCESS) InterlockedExchange(&g_restored, 0);  // allow retry
    return st == ERROR_SUCCESS;
}

BOOL WINAPI console_ctrl_handler(DWORD ctrl_type) {
    switch (ctrl_type) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_LOGOFF_EVENT:
        case CTRL_SHUTDOWN_EVENT: {
            DWORD st = ERROR_SUCCESS;
            restore_original_now(&st);
            return FALSE;  // let the default action proceed
        }
        default:
            return FALSE;
    }
}

int cmd_status(const std::string& json_path) {
    SchemeState s = query_scheme();
    std::printf("query_status=%lu\n",
                static_cast<unsigned long>(s.query_status));
    if (s.has_guid) {
        std::printf("active_guid=%s\n", guid_to_string(s.guid).c_str());
        std::printf("friendly_name=%s\n",
                    s.friendly_name.empty() ? "(none)" : s.friendly_name.c_str());
    } else {
        std::printf("active_guid=(query failed)\n");
    }
    std::printf("timestamp=%s\n", s.timestamp.c_str());

    if (!json_path.empty()) {
        std::string json = "{\n";
        json += "  \"tool\": \"power_scheme_control\",\n";
        json += "  \"subcommand\": \"status\",\n";
        json += "  \"read_only\": true,\n";
        json += "  \"timestamp\": \"" + json_escape(s.timestamp) + "\",\n";
        char line[128];
        std::snprintf(line, sizeof(line), "  \"query_status\": %lu,\n",
                      static_cast<unsigned long>(s.query_status));
        json += line;
        json += "  \"active_guid\": " +
                (s.has_guid ? "\"" + guid_to_string(s.guid) + "\"" : "null") +
                ",\n";
        json += "  \"friendly_name\": " +
                (s.friendly_name.empty()
                     ? "null"
                     : "\"" + json_escape(s.friendly_name) + "\"") +
                "\n}\n";
        if (!write_all(json_path, json)) {
            std::fprintf(stderr, "error: failed to write %s\n",
                         json_path.c_str());
            return 3;
        }
        std::printf("json_written=%s\n", json_path.c_str());
    }
    return s.has_guid ? 0 : 4;
}

int cmd_run(const std::string& command, const std::string& json_path) {
    if (command.empty()) {
        std::fprintf(stderr, "error: run requires --cmd <command line>\n");
        return 2;
    }

    SchemeState original = query_scheme();
    if (!original.has_guid) {
        std::fprintf(stderr,
                     "error: cannot query active scheme (status=%lu); refusing "
                     "to change policy without a snapshot\n",
                     static_cast<unsigned long>(original.query_status));
        return 5;
    }
    const std::string original_guid_str = guid_to_string(original.guid);
    std::printf("original_guid=%s\n", original_guid_str.c_str());
    std::printf("original_name=%s\n",
                original.friendly_name.empty() ? "(none)"
                                               : original.friendly_name.c_str());
    std::printf("original_timestamp=%s\n", original.timestamp.c_str());
    std::fflush(stdout);

    g_restore_target = original.guid;
    g_have_restore_target = true;
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);

    // ---- Apply High Performance (documented API) ----
    GUID requested = kHighPerformance;
    DWORD apply_status = PowerSetActiveScheme(nullptr, &requested);
    std::string apply_ts = iso_timestamp();
    SchemeState after_apply = query_scheme();
    bool apply_ok = (apply_status == ERROR_SUCCESS) && after_apply.has_guid &&
                    guid_equal(after_apply.guid, kHighPerformance);

    std::printf("requested_guid=%s\n", guid_to_string(kHighPerformance).c_str());
    std::printf("apply_status=%lu\n", static_cast<unsigned long>(apply_status));
    std::printf("scheme_after_apply=%s\n",
                after_apply.has_guid ? guid_to_string(after_apply.guid).c_str()
                                     : "(query failed)");
    std::fflush(stdout);

    int child_exit = -1;
    bool child_ran = false;
    std::string child_begin, child_end;
    std::string child_output;

    if (apply_ok) {
        child_ran = true;
        std::printf("running: %s\n", command.c_str());
        std::fflush(stdout);
        child_begin = iso_timestamp();
        std::string full = command + " 2>&1";
        FILE* pipe = _popen(full.c_str(), "r");
        if (!pipe) {
            std::fprintf(stderr, "error: failed to spawn child\n");
            child_exit = -1;
        } else {
            char buf[512];
            while (std::fgets(buf, sizeof(buf), pipe) != nullptr) {
                child_output += buf;
                std::fputs(buf, stdout);
                std::fflush(stdout);
            }
            int status = _pclose(pipe);
            child_exit = (status < 0) ? -1 : status;
            // Normalize a wait-style status (exit code in the high byte).
            if (child_exit > 255 && (child_exit & 0x7f) == 0)
                child_exit = (child_exit >> 8) & 0xff;
        }
        child_end = iso_timestamp();
        std::printf("child_exit=%d\n", child_exit);
    } else {
        std::fprintf(stderr,
                     "error: applying High Performance FAILED; child NOT run; "
                     "restoring original scheme\n");
    }
    std::fflush(stdout);

    // ---- ALWAYS restore ----
    DWORD restore_status = static_cast<DWORD>(-1);
    bool restored = restore_original_now(&restore_status);
    std::string restore_ts = iso_timestamp();
    SchemeState after_restore = query_scheme();
    bool restore_ok = restored && after_restore.has_guid &&
                      guid_equal(after_restore.guid, original.guid);

    std::printf("restore_status=%lu\n",
                static_cast<unsigned long>(restore_status));
    std::printf("scheme_after_restore=%s\n",
                after_restore.has_guid ? guid_to_string(after_restore.guid).c_str()
                                       : "(query failed)");
    std::printf("restore_matches_original=%s\n", restore_ok ? "true" : "false");
    std::fflush(stdout);

    // ---- Artifact ----
    std::string json = "{\n";
    json += "  \"tool\": \"power_scheme_control\",\n";
    json += "  \"subcommand\": \"run\",\n";
    json += "  \"command\": \"" + json_escape(command) + "\",\n";
    json += "  \"original\": {\n";
    json += "    \"query_status\": " + std::to_string(original.query_status) +
            ",\n";
    json += "    \"guid\": \"" + original_guid_str + "\",\n";
    json += "    \"friendly_name\": " +
            (original.friendly_name.empty()
                 ? "null"
                 : "\"" + json_escape(original.friendly_name) + "\"") +
            ",\n";
    json += "    \"timestamp\": \"" + json_escape(original.timestamp) +
            "\"\n  },\n";
    json += "  \"apply\": {\n";
    json += "    \"requested_guid\": \"" + guid_to_string(kHighPerformance) +
            "\",\n";
    json += "    \"status\": " + std::to_string(apply_status) + ",\n";
    json += "    \"timestamp\": \"" + json_escape(apply_ts) + "\",\n";
    json += "    \"scheme_after\": " +
            (after_apply.has_guid
                 ? "\"" + guid_to_string(after_apply.guid) + "\""
                 : "null") +
            ",\n";
    json += "    \"ok\": " + std::string(apply_ok ? "true" : "false") +
            "\n  },\n";
    json += "  \"child\": {\n";
    json += "    \"ran\": " + std::string(child_ran ? "true" : "false") + ",\n";
    json += "    \"exit_code\": " + std::to_string(child_exit) + ",\n";
    json += "    \"begin\": \"" + json_escape(child_begin) + "\",\n";
    json += "    \"end\": \"" + json_escape(child_end) + "\",\n";
    json += "    \"output\": \"" + json_escape(child_output) + "\"\n  },\n";
    json += "  \"restore\": {\n";
    json += "    \"status\": " + std::to_string(restore_status) + ",\n";
    json += "    \"timestamp\": \"" + json_escape(restore_ts) + "\",\n";
    json += "    \"scheme_after\": " +
            (after_restore.has_guid
                 ? "\"" + guid_to_string(after_restore.guid) + "\""
                 : "null") +
            ",\n";
    json += "    \"matches_original\": " +
            std::string(restore_ok ? "true" : "false") + "\n  },\n";
    json += "  \"result\": \"";
    if (!restore_ok) json += "RESTORE_FAILED";
    else if (!apply_ok) json += "APPLY_FAILED";
    else if (child_exit != 0) json += "CHILD_FAILED";
    else json += "OK";
    json += "\"\n}\n";

    if (!json_path.empty()) {
        if (write_all(json_path, json))
            std::printf("json_written=%s\n", json_path.c_str());
        else
            std::fprintf(stderr, "error: failed to write %s\n",
                         json_path.c_str());
    }

    if (!restore_ok) {
        std::fprintf(stderr,
                     "CRITICAL: original power scheme NOT restored "
                     "(status=%lu, expected=%s, got=%s)\n",
                     static_cast<unsigned long>(restore_status),
                     original_guid_str.c_str(),
                     after_restore.has_guid
                         ? guid_to_string(after_restore.guid).c_str()
                         : "(query failed)");
        return 11;  // restore failure is the highest-priority outcome
    }
    if (!apply_ok) return 10;
    if (child_exit != 0) return 12;
    return 0;
}

void usage() {
    std::fprintf(stderr,
                 "usage:\n"
                 "  power_scheme_control status [--json <path>]\n"
                 "  power_scheme_control run --cmd <command line> "
                 "[--json <path>]\n");
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage();
        return 2;
    }
    std::string sub = argv[1];
    std::string json_path;
    std::string cmd;
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--json" && i + 1 < argc) {
            json_path = argv[++i];
        } else if (a == "--cmd" && i + 1 < argc) {
            cmd = argv[++i];
        } else {
            std::fprintf(stderr, "error: unknown argument: %s\n", a.c_str());
            usage();
            return 2;
        }
    }
    if (sub == "status") return cmd_status(json_path);
    if (sub == "run") return cmd_run(cmd, json_path);
    usage();
    return 2;
}
