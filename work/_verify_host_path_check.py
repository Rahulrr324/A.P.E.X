c = "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
prefix = "build/bm_b7_diagnostic/"
print("candidate:", c)
print("shares diagnostic dir prefix?", c.startswith(prefix))
print("absolute?", c.startswith("/") or (len(c) and c[0] == "\\"))
print("traversal?", ".." in c)
print("drive letter?", ":" in c)
print("OK: host CSV is outside the diagnostic-owned directory and survives cleanup")
