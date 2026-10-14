import sys
from pathlib import Path

SRC = Path("stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp")
raw = SRC.read_bytes().decode("utf-8")
assert "\r\n" in raw
text = raw.replace("\r\n", "\n")

def rep(old, new):
    global text
    n = text.count(old)
    if n != 1:
        print(f"ANCHOR COUNT {n}: {old[:70]!r}")
        sys.exit(1)
    text = text.replace(old, new)

# 1) DiagnosticPaths carries the optional host-capture directory.
rep("""struct DiagnosticPaths {
    // Base directory only: the run-owned subdirectory and blob name are
    // assigned at exclusive creation, so no path here can pre-exist as a file.
    std::string directory = kDiagnosticDir;
};
""", """struct DiagnosticPaths {
    // Base directory only: the run-owned subdirectory and blob name are
    // assigned at exclusive creation, so no path here can pre-exist as a file.
    std::string directory = kDiagnosticDir;
    // Optional, relative host-capture directory for the paired-sample CSV.
    // Empty => no host persistence (legacy behaviour). Validated before use.
    std::string host_capture_dir;
};
""")

# 2) run_bm_b7_diagnostic configures the PairedArtifact before its write.
rep("""    BlobCleanup cleanup;
    PairedArtifact paired;

    try {""", """    BlobCleanup cleanup;
    PairedArtifact paired;
    if (!paths.host_capture_dir.empty()) {
        // Validated again at write time by validate_host_capture_path(); set here so the
        // artifact actually receives the configured destination.
        paired.set_host_path(paths.host_capture_dir);
    }

    try {""")

# 3) main(): explicit, strict argument grammar.
rep("""    DiagnosticPaths paths;
    if (argc == 2) {
        paths.directory = argv[1];
    } else if (argc != 1) {
        std::cerr << "usage: " << argv[0] << " [diagnostic-directory]\\n"
                  << "  default directory: build/bm_b7_diagnostic/ "
                     "(diagnostic-owned; isolation is validated at run time)\\n";
        return 2;
    }
""", """    DiagnosticPaths paths;
    const std::string usage =
        std::string("usage: ") + argv[0] +
        " [diagnostic-directory] [--host-capture-dir <relative-dir>]\\n"
        "  default directory: build/bm_b7_diagnostic/ "
        "(diagnostic-owned; isolation is validated at run time)\\n"
        "  --host-capture-dir: relative, non-traversal directory that receives "
        "paired_samples.csv (exclusive, no overwrite). Omit to skip host persistence.\\n";

    bool have_positional = false;
    bool have_host = false;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--host-capture-dir") {
            if (have_host) {
                std::cerr << "error: duplicate --host-capture-dir\\n" << usage;
                return 2;
            }
            if (i + 1 >= argc) {
                std::cerr << "error: --host-capture-dir requires a value\\n" << usage;
                return 2;
            }
            const std::string value = argv[++i];
            if (value.empty() || value.rfind("--", 0) == 0) {
                std::cerr << "error: --host-capture-dir requires a non-option value\\n" << usage;
                return 2;
            }
            const std::string herr = stark_p1::b7diag::validate_host_capture_path(value);
            if (!herr.empty()) {
                std::cerr << "error: invalid --host-capture-dir: " << herr << "\\n" << usage;
                return 2;
            }
            paths.host_capture_dir = value;
            have_host = true;
        } else if (a.rfind("--", 0) == 0) {
            std::cerr << "error: unknown option: " << a << "\\n" << usage;
            return 2;
        } else {
            if (have_positional) {
                std::cerr << "error: more than one diagnostic-directory argument\\n" << usage;
                return 2;
            }
            paths.directory = a;
            have_positional = true;
        }
    }
""")

SRC.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
print("applied OK")
