// Test-only reference: original lines 121-179 from run_baseline.cpp at
// 371d06f16236204cc20af539f34bbdd643fc5c31. Bodies unmodified; namespace
// placement by the includer resolves the original unqualified-name ambiguity.
// ---------------------------------------------------------------------------
// B6/B9: tiny inference latency & stability
// ---------------------------------------------------------------------------
BenchResult bench_tiny_inference(const BenchConfig& base, TinyDenseModel& model) {
    BenchConfig cfg = base;
    cfg.benchmark_id = "B6";
    cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"logical_params", "262912"}};
    return run_benchmark(cfg, [&] { model.forward(); });
}

struct StabilityOutcome {
    BenchResult result;
    bool bit_identical = false;
};

StabilityOutcome bench_inference_stability(TinyDenseModel& model, const BenchConfig& base) {
    StabilityOutcome out;
    BenchConfig cfg = base;
    cfg.benchmark_id = "B9";
    cfg.deterministic_mode_requested = true;
    cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};

    std::vector<float> reference;
    bool identical = true;
    auto op = [&] {
        model.forward();
        if (reference.empty()) reference = model.output();
        else if (reference != model.output()) identical = false;
    };
    BenchConfig timing_cfg = cfg;
    timing_cfg.benchmark_id = "B9";
    timing_cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};
    out.result = run_benchmark(timing_cfg, op);
    out.bit_identical = identical;
    return out;
}

// ---------------------------------------------------------------------------
// B7: model load time (serialize -> write temp -> load back)
// ---------------------------------------------------------------------------
BenchResult bench_model_load_time(TinyDenseModel& model, const std::string& out_dir, const BenchConfig& base) {
    std::vector<uint8_t> blob = model.serializeWeights();
    std::string path = out_dir + "/tiny_dense_2l_weights.bin";
    {
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char*>(blob.data()), static_cast<std::streamsize>(blob.size()));
        if (!f) throw std::runtime_error("cannot write weight blob");
    }
    BenchConfig cfg = base;
    cfg.benchmark_id = "B7";
    cfg.workload_params = {{"blob_bytes", std::to_string(blob.size())}, {"mode", "warm_cache"}};
    TinyDenseModel loader(1);
    return run_benchmark(cfg, [&] {
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot open weight blob");
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        loader.deserializeWeights(bytes);
    });
}
