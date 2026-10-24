#pragma once

/**
 * STARK-L10: Context-Conditioned Memory (CCM).
 *
 * Frozen protocol: stark/design/context_conditioned_memory_milestone.md v1.0.
 *
 * L9 established that the LRAgent's SINGLE shared plastic S→A matrix cannot
 * hold two conflicting identity→action mappings. L10 partitions the plastic
 * memory into K banks and adds a LEARNED routing policy over OBSERVABLE
 * context-cue features:
 *
 *   score[k] = sum_{f active} W[f][k];   p = softmax(score / router_T)
 *   k* ~ p   (learning)      k* = argmax p   (evaluation)
 *   dW[f][k] = beta_route * r * (1[k==k*] - p[k])       (REINFORCE)
 *
 * Plasticity is confined to S[k*][queried] (STARK-L5 eligibility gate, which
 * is per pre-synaptic neuron — hence one S population per bank). Banks that
 * have been superseded are sealed (write-protected).
 *
 * Non-leakage: the mechanism never sees pi, phi, the task index or the answer
 * table. pi is consulted only to compute the scalar reward (driver side) and
 * at analysis time to score accuracy. The ORACLE-BANK arm is a labelled
 * diagnostic upper bound only.
 *
 * Bookkeeping weights (router) are stored as ordinary synapses
 * (`cue[f] -> R[k]`), so STARK-007 serialization covers them; bank metadata
 * (allocation/seal flags) is serialized in a deterministic composite record.
 */

#include "learning/RelevanceRouting.h"
#include "neural/Network.h"
#include <string>
#include <vector>

namespace learning {

/// L10 arm semantics for the bank-selection mechanism.
enum CCBankMode {
    CC_LEARNED = 0,      // sample from the learned router (train) / argmax (eval)
    CC_ORACLE = 1,       // DIAGNOSTIC UPPER BOUND: driver forces the task's bank
    CC_FROZEN = 2,       // router never updated; selection = argmax of zero scores
};

struct CCConfig {
    LRConfig lr;              // channel-routing + neuron/synapse parameters (L9)
    int n_banks = 3;          // K plastic memory banks
    int n_feat = 12;          // observable cue features
    double router_T = 0.5;    // softmax temperature for bank selection
    double beta_route_bank = 0.5; // REINFORCE rate for the router
    int n_probe_per_bank = 20;    // probe trials per bank before each task
    double theta_alloc = 0.5;     // allocate when best probe reward < theta
    bool seal_superseded = true;  // write-protect superseded banks
    // v1.1 (protocol revision §13): a bank with no memory cannot be selected,
    // so the routing softmax is restricted to ALLOCATED banks, and the router
    // uses a running reward baseline (variance reduction).
    bool route_over_allocated_only = true;
    bool use_reward_baseline = true;
    // v1.5: a per-bank baseline saturates at the bank's own success rate and
    // silently switches routing learning off once the policy is correct,
    // leaving rarely observed cue features under-trained (measured: task-3
    // held-out combinations fell to 0.55 on the development seed). A single
    // slow GLOBAL baseline keeps the advantage informative for the whole
    // task, which is what the rarely observed features need.
    bool baseline_per_bank = false;
    double baseline_rate = 0.02;
    // v1.2: behaviour is masked to allocated banks, but routing credit is
    // computed against the UNMASKED policy so that a context which currently
    // has a single candidate still learns a preference for that bank (a
    // masked-only gradient is exactly zero when |candidates| == 1).
    bool router_credit_unmasked = true;
    // v1.3: epsilon-exploration over the selectable banks during learning.
    // Without it the softmax commits to whichever bank happens to win the
    // first few trials, before a newly allocated bank has had a chance to
    // learn its mapping (measured on the development seed: p collapsed to
    // 0.97 on a wrong bank within ~100 trials of task 3).
    double explore_eps = 0.2;
    // v1.4: after allocating a bank for a novel context, commit the next
    // `commit_trials` learning trials to it (the resource must have content
    // before its routing can be evaluated) and keep the router update
    // off-policy (no update on forced choices). Measured motivation: without
    // a commitment window the fresh bank received 8-27 trials/identity and
    // stayed at chance on the development seed.
    int commit_trials = 480;
};

/// One trial: the L9 schedule plus the observable cue pattern.
struct CCTrialSchedule {
    LRTrialSchedule lr;       // L9 trial (identities, distractors, noise, draws)
    std::vector<int> cue;     // active cue feature indices (observable input)
};

struct CCResult {
    int queried = 0;
    int choice = -1;
    double reward = 0.0;
    int bank = -1;            // bank used on this trial
    int sel_slot = -1;        // channel selection (L6-L9 mechanism)
    double a0 = 0.0, a1 = 0.0;
    bool plastic_write = false; // was bank `bank` writable this trial
};

/// Bank lifecycle state (persisted with the agent).
enum CCBankState {
    CC_UNALLOCATED = 0,
    CC_ACTIVE = 1,
    CC_SEALED = 2,
};

struct CCAgent {
    Network net;
    CCConfig cfg;
    // neuron ids
    std::vector<size_t> cue;                    // n_feat
    std::vector<std::vector<size_t>> s;         // [bank][identity]
    std::vector<std::vector<size_t>> a;         // [bank][response]
    std::vector<size_t> l;                      // n_chan
    std::vector<size_t> c;                      // n_ctx
    std::vector<size_t> rr;                     // [bank] router readout cells
    // synapse ids
    std::vector<std::vector<std::vector<size_t>>> syn;  // [bank][id][resp] S->A
    std::vector<std::vector<size_t>> wta;       // [bank][pair]
    std::vector<std::vector<size_t>> self;      // [bank][resp]
    std::vector<std::vector<size_t>> route;     // [ctx][chan] C->L (v)
    std::vector<std::vector<size_t>> router;    // [feat][bank] cue->R (W)
    // lifecycle
    std::vector<int> bank_state;                // CCBankState per bank
    // running reward baseline for the router (persisted in the composite record)
    std::vector<double> reward_baseline;      // per-bank running reward baseline
};

CCAgent makeCCAgent(const CCConfig& cfg, bool plastic);

/// Router weights as [feat][bank].
std::vector<std::vector<double>> ccRouterWeights(const CCAgent& agent);

/// Bank S->A weights as [bank][id][resp].
std::vector<std::vector<std::vector<double>>> ccBankWeights(const CCAgent& agent);

/**
 * Execute one trial. `task_bank` is consulted ONLY when mode == CC_ORACLE
 * (driver-side diagnostic upper bound) and by the analyser; it is otherwise
 * ignored by the mechanism.
 */
CCResult runCCTrial(CCAgent& agent, const CCTrialSchedule& sched,
                    const LRMapping& map, int task_bank,
                    CCBankMode mode, bool learning_enabled,
                    bool router_learning = true, int forced_bank = -1);

/// Bank the router currently prefers (argmax of scores) for a cue pattern.
int ccPreferredBank(const CCAgent& agent, const std::vector<int>& cue);

/**
 * Allocate the lowest-indexed unallocated bank as the active (writable) bank,
 * sealing the previously active bank when `seal` is true. Returns the new
 * active bank, or -1 when no unallocated bank remains (capacity exhausted).
 * Deterministic; uses no task information.
 */
int ccAllocateNext(CCAgent& agent, bool seal);

/// Bank currently writable (-1 if none).
int ccActiveBank(const CCAgent& agent);

/// Deterministic composite state: Network serialization + bank metadata.
std::string ccSerialize(const CCAgent& agent);
void ccDeserialize(CCAgent& agent, const std::string& data);

} // namespace learning
