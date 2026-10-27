// STARK-L11.2 audit — read-only observability non-perturbation probe.
// NOT part of the repository build. Compiled and run in /tmp only.
//
// Question: do the observation calls the prepared patch would add
// (ccSerialize, ccBankWeights, ccRouterWeights) perturb the learning
// trajectory?
//
// Method: build two identical agents, drive them through the SAME generated
// trial stream, and in the observed arm call the three observation APIs after
// every trial. Compare (a) the per-trial choice/bank/reward sequence and
// (b) the final serialized state, byte for byte.

#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace learning;

struct Run {
    std::vector<int> choices, banks, querieds;
    std::vector<double> rewards;
    std::string final_state;
};

static Run drive(bool observe, unsigned master, int n_trials) {
    CCConfig cfg;
    CCAgent ag = makeCCAgent(cfg, true);
    LRMapping map = makeLRMapping(master, cfg.lr.n_ids, cfg.lr.n_ctx);
    auto sched = makeLRTrials(cfg.lr, map, 0, 40, master);
    ccAllocateNext(ag, false);

    Run out;
    for (int i = 0; i < n_trials && i < (int)sched.size(); ++i) {
        CCTrialSchedule s;
        s.lr = sched[(size_t)i];
        s.cue = {0, 1};
        CCResult r = runCCTrial(ag, s, map, -1, CC_LEARNED, true, true, -1);
        out.choices.push_back(r.choice);
        out.banks.push_back(r.bank);
        out.querieds.push_back(r.queried);
        out.rewards.push_back(r.reward);

        if (observe) {
            // exactly the calls the prepared patch adds per trial
            (void)ccSerialize(ag);
            (void)ccBankWeights(ag);
            (void)ccRouterWeights(ag);
        }
    }
    out.final_state = ccSerialize(ag);
    return out;
}

int main() {
    const unsigned master = 123456789u;
    const int n = 300;
    Run plain = drive(false, master, n);
    Run obs = drive(true, master, n);

    int choice_diff = 0, bank_diff = 0, queried_diff = 0, reward_diff = 0;
    for (size_t i = 0; i < plain.choices.size(); ++i) {
        if (plain.choices[i] != obs.choices[i]) ++choice_diff;
        if (plain.banks[i] != obs.banks[i]) ++bank_diff;
        if (plain.querieds[i] != obs.querieds[i]) ++queried_diff;
        if (plain.rewards[i] != obs.rewards[i]) ++reward_diff;
    }
    const bool state_equal = (plain.final_state == obs.final_state);

    std::printf("trials=%zu\n", plain.choices.size());
    std::printf("choice_diffs=%d bank_diffs=%d queried_diffs=%d reward_diffs=%d\n",
                choice_diff, bank_diff, queried_diff, reward_diff);
    std::printf("final_state_bytes=%zu final_state_equal=%d\n",
                plain.final_state.size(), (int)state_equal);
    std::printf("VERDICT=%s\n",
                (choice_diff == 0 && bank_diff == 0 && queried_diff == 0 &&
                 reward_diff == 0 && state_equal) ? "OBSERVERS_NON_PERTURBING"
                                                  : "OBSERVERS_PERTURB");
    return 0;
}
