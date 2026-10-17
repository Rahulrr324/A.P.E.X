# Phase 33 - adversarial fixture generator (writes ONLY into phase33_test/).
#
# Deterministic synthetic fixtures for the hardened validator. These are NOT
# benchmark evidence; they exist solely to prove the validator rejects
# malformed/internally inconsistent input and accepts valid input.
#
# Row formatting mirrors the frozen diagnostic CSV:
#   minimal_sec / instrumented_sec : %.11f
#   signed_overhead_pct            : %.9g, computed FROM the rounded strings
#      so recorded pct is exactly consistent with the printed timings.

import csv
import io
import pathlib
import random

OUT = pathlib.Path(__file__).resolve().parent
HEADER = ["replicate", "iteration", "minimal_sec", "instrumented_sec",
          "signed_overhead_pct"]


def make_rows(replicates, factor):
    """Valid rows: minimal varies deterministically; instrumented = minimal*factor."""
    rows = []
    for r in range(replicates):
        for i in range(50):
            m = 0.0095 + 0.000001 * ((r * 50 + i) % 37)
            ins = m * factor
            ms = f"{m:.11f}"
            iss = f"{ins:.11f}"
            pct = 100.0 * (float(iss) - float(ms)) / float(ms)
            rows.append([str(r), str(i), ms, iss, f"{pct:.9g}"])
    return rows


def write_csv(name, rows, header=HEADER):
    path = OUT / name
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    path.write_text(buf.getvalue(), encoding="utf-8")
    print(f"wrote {path.name} ({len(rows)} data rows)")


def main():
    six = make_rows(6, 1.005)   # ~0.5% overhead -> passes calibration
    eight = make_rows(8, 1.008) # ~0.8% overhead -> passes calibration

    # 1/2. Valid six- and eight-replicate CSVs.
    write_csv("valid_six.csv", six)
    write_csv("valid_eight.csv", eight)

    # 3. Duplicate pair key: row 10 copies key of row 9.
    dup = [list(r) for r in six]
    dup[10][0], dup[10][1] = dup[9][0], dup[9][1]
    write_csv("dup_key.csv", dup)

    # 4. Missing pair key: drop row 37 entirely.
    write_csv("missing_key.csv", [list(r) for r in six[:37] + six[38:]])

    # 5. Unexpected key: replicate=99 (out of profile range).
    unexp = [list(r) for r in six]
    unexp[5][0] = "99"
    write_csv("unexpected_key.csv", unexp)

    # 6. Incorrect row count: one extra row appended (duplicate content, new key 6,0).
    extra = [list(r) for r in six] + [["6", "0", "0.01000000000",
                                       "0.01050000000", "5"]]
    write_csv("wrong_row_count.csv", extra)

    # 7. Wrong header.
    write_csv("wrong_header.csv", six,
              header=["replicate", "iteration", "min_sec", "instr_sec", "pct"])

    # 8a. Missing column: one row has 4 fields.
    misscol = [list(r) for r in six]
    misscol[3] = misscol[3][:4]
    write_csv("missing_column.csv", misscol)

    # 8b. Malformed row: one row has 6 fields.
    malrow = [list(r) for r in six]
    malrow[7] = malrow[7] + ["999"]
    write_csv("malformed_row.csv", malrow)

    # 9. Non-integer replicate / iteration.
    nonint = [list(r) for r in six]
    nonint[4][0] = "1.5"
    nonint[5][1] = "two"
    write_csv("non_integer_key.csv", nonint)

    # 10. Non-numeric timing value.
    nonnum = [list(r) for r in six]
    nonnum[12][2] = "abc"
    write_csv("non_numeric_timing.csv", nonnum)

    # 11. NaN / infinity in each numeric field.
    for field, token in ((2, "nan"), (2, "inf"), (3, "nan"), (3, "inf"),
                         (3, "-inf"), (4, "nan"), (4, "inf")):
        rows = [list(r) for r in six]
        rows[15][field] = token
        col = HEADER[field]
        write_csv(f"bad_{col}_{token.replace('-', 'neg')}.csv", rows)

    # 12. Zero / negative minimal timing.
    zeromin = [list(r) for r in six]
    zeromin[20][2] = "0.00000000000"
    write_csv("zero_minimal.csv", zeromin)
    negmin = [list(r) for r in six]
    negmin[21][2] = "-0.00950000000"
    write_csv("negative_minimal.csv", negmin)

    # 13. Zero / negative instrumented timing.
    zeroinstr = [list(r) for r in six]
    zeroinstr[22][3] = "0.00000000000"
    write_csv("zero_instrumented.csv", zeroinstr)
    neginstr = [list(r) for r in six]
    neginstr[23][3] = "-0.00950000000"
    write_csv("negative_instrumented.csv", neginstr)

    # 14. Incorrect recorded signed_overhead_pct (offset +3.0, beyond tolerance).
    badpct = [list(r) for r in six]
    badpct[30][4] = f"{float(badpct[30][4]) + 3.0:.9g}"
    write_csv("bad_overhead_pct.csv", badpct)

    # 15. Valid rows deliberately reordered (deterministic shuffle).
    rng = random.Random(33)
    shuffled = [list(r) for r in six]
    rng.shuffle(shuffled)
    write_csv("reordered_six.csv", shuffled)

    # 16. Structurally valid + calibration PASS == valid_six (factor 1.005).

    # 17. Structurally valid + calibration FAIL (~5% mean overhead, worst ~5%).
    failcal = make_rows(6, 1.05)
    write_csv("fail_calibration.csv", failcal)

    print("done")


if __name__ == "__main__":
    main()
