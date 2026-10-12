#!/usr/bin/env python3
"""Replace the P3 schedule block in diag_highres_frequency.cpp with the
predeclared v8 schedule (B6: 8 alternating A/B pairs; single idle;
B9: 8 identical B-side execs; no B7). Byte-exact, CRLF-preserving."""
from pathlib import Path

P = Path("stark/tests/diag_highres_frequency.cpp")

START = "        // ---- P3: production execs with A/B perturbation pairs (v5) ----"
END = "        // safety: no collector thread may survive P3"

NEW_BLOCK_CRLF = """        // ---- P3 (v8): PREDECLARED SCHEDULE -- two diagnostics only ----
        // (1) B6: V8_B6_N_PAIRS adjacent A/B pairs, order alternated
        //     (even pair: A then B; odd pair: B then A), all back-to-back
        //     under one thermal/power/background condition block.
        //     A = no collector; B = collector active at the 500 us pace.
        // (2) one 30 s idle; (3) B9: V8_B9_N_EXECS identical B-side execs
        //     (collector active; first flagged after the idle gap).
        // No B7 and no extra execs in v8. Nothing else changed from v7.
        JsonValue execs = JsonValue::array();
        auto idle = [&] {
            std::cout << "idle " << idle_seconds << "s ...\\n" << std::flush;
            std::this_thread::sleep_for(std::chrono::seconds(idle_seconds));
        };

        auto run_b6 = [&](bool collector_on, bool gap, int pair) {
            TinyDenseModel model(1);
            BenchConfig cfg;
            cfg.benchmark_id = "B6";
            cfg.warmup_count = 10;
            cfg.measurement_count = 50;
            cfg.thread_count = 1;
            cfg.batch_size = 1;
            cfg.sequence_length = 0;
            cfg.precision = "FP32";
            cfg.storage_format = "FP32";
            cfg.deterministic_mode_requested = true;
            cfg.workload_params = {{"model", "TINY-DENSE-2L"},
                                   {"logical_params", "262912"}};
            std::vector<double> iters;
            JsonValue e = run_exec("B6", collector_on, gap, pair, q, perf,
                                   [&] { model.forward(); }, iters);
            e.set("exec_index", JsonValue::integer(execs.items().size()));
            std::cout << "B6 " << (collector_on ? "B" : "A")
                      << " pair=" << pair << " gap=" << gap
                      << " median_us="
                      << e.get("median_us_this_path").asDouble() << "\\n";
            execs.append(e);
        };

        for (int pair = 0; pair < V8_B6_N_PAIRS; ++pair) {
            if ((pair % 2) == 0) {
                run_b6(false, false, pair);   // A -> B
                run_b6(true, false, pair);
            } else {
                run_b6(true, false, pair);    // B -> A
                run_b6(false, false, pair);
            }
        }

        idle();

        // B9: shared model + bit-identical check (op unchanged from v7);
        // all v8 B9 execs are B-side (collector active) at 500 us pace.
        {
            TinyDenseModel model(1);
            BenchConfig cfg;
            cfg.benchmark_id = "B9";
            cfg.warmup_count = 10;
            cfg.measurement_count = 50;
            cfg.thread_count = 1;
            cfg.batch_size = 1;
            cfg.sequence_length = 0;
            cfg.precision = "FP32";
            cfg.storage_format = "FP32";
            cfg.deterministic_mode_requested = true;
            cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};
            std::vector<float> reference;
            bool bit_identical = true;
            auto run_b9 = [&](bool gap, int idx) {
                std::vector<double> iters;
                JsonValue e = run_exec(
                    "B9", true, gap, idx, q, perf,
                    [&] {
                        model.forward();
                        auto out = model.output();
                        if (reference.empty()) reference = out;
                        else if (reference != out) bit_identical = false;
                    }, iters);
                e.set("bit_identical", JsonValue::boolean(bit_identical));
                e.set("exec_index", JsonValue::integer(execs.items().size()));
                std::cout << "B9 B pair=" << idx << " gap=" << gap
                          << " median_us="
                          << e.get("median_us_this_path").asDouble() << "\\n";
                execs.append(e);
            };
            for (int k = 0; k < V8_B9_N_EXECS; ++k) run_b9(k == 0, k);
        }

"""


def main() -> None:
    raw = P.read_bytes()
    nl = b"\r\n" if b"\r\n" in raw else b"\n"
    text = raw.decode("utf-8")
    nl_char = "\r\n" if nl == b"\r\n" else "\n"

    start = text.find(START.replace("\n", nl_char))
    if start == -1:
        # anchors were written with \n above; retry against actual newline
        START_ACT = START
        start = text.find(START_ACT)
    assert start != -1, "P3 start anchor not found"

    end = text.find(END)
    assert end != -1, "P3 end anchor not found"
    assert start < end, "anchors out of order"

    new_block = NEW_BLOCK_CRLF.replace("\n", nl_char)
    new_text = text[:start] + new_block + text[end:]

    # sanity: exactly one P3 comment, no B7 left in main schedule
    assert new_text.count("---- P3 (v8)") == 1
    assert new_text.count("---- P3: production execs") == 0
    assert "run_b7" not in new_text
    assert new_text.count("V8_B6_N_PAIRS") >= 2  # define + use
    assert new_text.count("V8_B9_N_EXECS") >= 2

    P.write_bytes(new_text.encode("utf-8"))
    print("P3 schedule replaced with v8; bytes:", len(new_text.encode("utf-8")))


if __name__ == "__main__":
    main()
