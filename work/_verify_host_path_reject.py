for p in ("work/b7_diag_20261011_paired_capture/run2/paired_samples.csv",
          "reports/evidence_manifest.json",
          "reports/g7-campaign/evidence_manifest.json",
          "reports/g7-campaign-affinityfix/records_sha256.txt",
          "reports/v2.4/evidence_manifest.json",
          "reports/g7-campaign/tiny_dense_2l_weights.bin",
          "/absolute/path/paired_samples.csv",
          "work/../evidence_manifest.json",
          "work:g7cam/paired_samples.csv"):
    raw = p
    reason = None
    if not raw:
        reason = "empty"
    elif ":" in raw:
        reason = "drive/scheme"
    elif raw[0] == "/" or raw[0] == "\\":
        reason = "absolute"
    elif ".." in raw:
        reason = "traversal"
    else:
        low = raw.lower()
        for f in ("g7-campaign","g7cam","reports","records",".jsonl","evidence_manifest","gate_results","tiny_dense_2l_weights.bin"):
            if f in low:
                reason = "forbidden:" + f
                break
    status = "REJECT" if reason else "OK"
    print("%-60s %s  %s" % (p, status, reason or ""))
