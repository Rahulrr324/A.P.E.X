/**
 * STARK-L11.10: tests for the cross-family cue constructor.
 *
 * Covers, in this order:
 *
 *   S1  every frozen-table case in scope (AMBIG11 1:1, CROSS21 2:1, CROSS31 3:1)
 *       for all ordered signature-group pairs of the frozen T = 3 task space;
 *   S2  multiplicity and ratio derived from feature counts, never from a group
 *       or task index;
 *   S3  canonical ordering and permutation invariance;
 *   S4  determinism and absence of global state;
 *   S5  deterministic rejection of invalid specifications;
 *   S6  exhaustive enumeration of the cross-family cue space;
 *   S7  the constructed stimuli are ACCEPTED BY THE ROUTER: a 3-feature and a
 *       4-feature cue flow through ccPreferredBank() and resolve by count.
 *       S7 uses HAND-SET router weights and never trains or evaluates a model;
 *       it is a unit test of additivity, not an experiment;
 *   S8  separation: the constructor does not depend on the number of signature
 *       groups, and carries no bank, answer or task identity.
 *
 * The test uses the repository's existing self-contained convention (its own
 * main, a CHECK counter, exit code 0 = pass, 1 = fail).
 */

#include "learning/ContextConditionedMemory.h"
#include "learning/L11CueConstruction.h"

#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

using namespace learning;
using namespace learning::l11;

namespace {

int g_checks = 0;
int g_failures = 0;

void check(bool ok, const std::string& what, int line) {
    ++g_checks;
    if (!ok) {
        ++g_failures;
        std::printf("  FAILED (line %d): %s\n", line, what.c_str());
    }
}

#define CHECK(cond) check((cond), #cond, __LINE__)
#define CHECK_MSG(cond, msg) check((cond), (msg), __LINE__)

void section(const char* name) {
    std::printf("[section] %s\n", name);
}

std::vector<int> sortedCopy(std::vector<int> v) {
    std::sort(v.begin(), v.end());
    return v;
}

bool sameCue(const CrossFamilyCue& a, const CrossFamilyCue& b) {
    return a.category == b.category && a.n_feat == b.n_feat && a.group_a == b.group_a &&
           a.group_b == b.group_b && a.count_a == b.count_a && a.count_b == b.count_b &&
           a.majority_count == b.majority_count && a.minority_count == b.minority_count &&
           a.majority_group == b.majority_group && a.features == b.features;
}

// Specification helper: `na` features taken from group `ga` starting at offset
// `off_a`, and `nb` from group `gb` starting at `off_b`. Features are added in
// reverse order on purpose, so that the canonical-order assertion is not
// trivially satisfied by the input order.
CrossFamilyCueSpec makeSpec(int n_feat, int ga, int gb, int na, int nb, int off_a = 0, int off_b = 1) {
    CrossFamilyCueSpec s;
    s.n_feat = n_feat;
    s.group_a = ga;
    s.group_b = gb;
    for (int i = na - 1; i >= 0; --i) s.features_a.push_back(ga * kFeaturesPerSignatureGroup + off_a + i);
    for (int i = nb - 1; i >= 0; --i) s.features_b.push_back(gb * kFeaturesPerSignatureGroup + off_b + i);
    return s;
}

// ---------------------------------------------------------------- S1
void testFrozenTableCases() {
    section("S1 valid inputs: every frozen-table case in scope");
    const int n_feat = 12;   // T = 3 tasks, 3 signature groups of 4 features
    int n_ok = 0;

    for (int ga = 0; ga < 3; ++ga) {
        for (int gb = 0; gb < 3; ++gb) {
            if (ga == gb) continue;

            CrossFamilyCue c11;
            CHECK(buildCrossFamilyCue(makeSpec(n_feat, ga, gb, 1, 1, 0, 2), &c11) == CueBuildError::Ok);
            CHECK(c11.category == CrossFamilyCategory::AMBIG11);
            CHECK_MSG(c11.features.size() == 2, "AMBIG11 carries 2 features");
            CHECK(c11.count_a == 1 && c11.count_b == 1);
            CHECK_MSG(c11.majority_group == -1, "AMBIG11 has no majority group");

            CrossFamilyCue c21;
            CHECK(buildCrossFamilyCue(makeSpec(n_feat, ga, gb, 2, 1), &c21) == CueBuildError::Ok);
            CHECK(c21.category == CrossFamilyCategory::CROSS21);
            CHECK_MSG(c21.features.size() == 3, "CROSS21 carries 3 features (2 + 1)");
            CHECK(c21.majority_count == 2 && c21.minority_count == 1);
            CHECK(c21.majority_group == ga);

            CrossFamilyCue c31;
            CHECK(buildCrossFamilyCue(makeSpec(n_feat, ga, gb, 3, 1, 0, 3), &c31) == CueBuildError::Ok);
            CHECK(c31.category == CrossFamilyCategory::CROSS31);
            CHECK_MSG(c31.features.size() == 4, "CROSS31 carries 4 features (3 + 1)");
            CHECK(c31.majority_count == 3 && c31.minority_count == 1);
            CHECK(c31.majority_group == ga);

            // family membership of every emitted feature
            for (std::size_t i = 0; i < c31.features.size(); ++i) {
                CHECK(signatureGroupOfFeature(c31.features[i], n_feat) ==
                      (i < 3 ? ga : gb));
            }
            ++n_ok;
        }
    }
    CHECK_MSG(n_ok == 6, "all six ordered group pairs of the frozen T=3 space exercised");

    // The frozen cue table's categories are the only three the constructor emits.
    CHECK(std::string(crossFamilyCategoryCode(CrossFamilyCategory::AMBIG11)) == "AMBIG11");
    CHECK(std::string(crossFamilyCategoryCode(CrossFamilyCategory::CROSS21)) == "CROSS21");
    CHECK(std::string(crossFamilyCategoryCode(CrossFamilyCategory::CROSS31)) == "CROSS31");
}

// ---------------------------------------------------------------- S2
void testRatioFromCounts() {
    section("S2 multiplicity and ratio derive from feature counts only");
    const int n_feat = 12;

    // Same groups, different counts -> different category.
    CrossFamilyCue c;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 2, 1, 1), &c) == CueBuildError::Ok);
    CHECK(c.category == CrossFamilyCategory::AMBIG11);
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 2, 2, 1), &c) == CueBuildError::Ok);
    CHECK(c.category == CrossFamilyCategory::CROSS21);
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 2, 3, 1), &c) == CueBuildError::Ok);
    CHECK(c.category == CrossFamilyCategory::CROSS31);

    // Same counts, different groups -> same category and same multiplicities.
    for (int gb = 1; gb < 3; ++gb) {
        CrossFamilyCue g;
        CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, gb, 2, 1), &g) == CueBuildError::Ok);
        CHECK(g.category == CrossFamilyCategory::CROSS21);
        CHECK(g.count_a == 2 && g.count_b == 1);
    }

    // Reversed argument order (1 from A, 2 from B) is the same 2:1 stimulus
    // with the other group in the majority.
    CrossFamilyCue rev;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 2, 1, 2), &rev) == CueBuildError::Ok);
    CHECK_MSG(rev.category == CrossFamilyCategory::CROSS21, "1:2 is a 2:1 cue with the other majority");
    CHECK_MSG(rev.majority_group == 2, "majority follows counts, not argument position");

    // Non-adjacent groups and a larger feature space behave identically.
    CrossFamilyCue far;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 2, 0, 3, 1), &far) == CueBuildError::Ok);
    CHECK(far.category == CrossFamilyCategory::CROSS31);
    CHECK(far.majority_group == 2);
    CrossFamilyCue wide;
    CHECK(buildCrossFamilyCue(makeSpec(20, 3, 4, 2, 1), &wide) == CueBuildError::Ok);
    CHECK_MSG(wide.category == CrossFamilyCategory::CROSS21, "T=5 feature space supported");
    CHECK(wide.features.back() >= 16);
}

// ---------------------------------------------------------------- S3
void testOrderingAndPermutation() {
    section("S3 canonical order and permutation invariance");
    const int n_feat = 12;

    CrossFamilyCue a;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 1, 2, 3, 1, 0, 3), &a) == CueBuildError::Ok);

    // Input order does not matter: reverse both lists and rebuild.
    CrossFamilyCueSpec rev = makeSpec(n_feat, 1, 2, 3, 1, 0, 3);
    std::reverse(rev.features_a.begin(), rev.features_a.end());
    CrossFamilyCue b;
    CHECK(buildCrossFamilyCue(rev, &b) == CueBuildError::Ok);
    CHECK_MSG(sameCue(a, b), "reversed input produces an identical cue");

    // Canonical order: group A ascending, then group B ascending.
    std::vector<int> expect = {4, 5, 6, 11};
    CHECK_MSG(a.features == expect, "canonical order is group A ascending then group B ascending");

    // Feature multiset is preserved exactly (no feature added or dropped).
    CHECK(sortedCopy(a.features) == sortedCopy(std::vector<int>({4, 5, 6, 11})));

    // The same stimulus described with the groups swapped keeps its
    // multiplicities, category and majority -- only the canonical block order
    // and the group labels change.
    CrossFamilyCueSpec swapped;
    swapped.n_feat = n_feat;
    swapped.group_a = 2;
    swapped.group_b = 1;
    swapped.features_a = {11};
    swapped.features_b = {6, 5, 4};
    CrossFamilyCue c;
    CHECK(buildCrossFamilyCue(swapped, &c) == CueBuildError::Ok);
    CHECK(c.category == a.category);
    CHECK(c.majority_count == a.majority_count && c.minority_count == a.minority_count);
    CHECK_MSG(c.majority_group == a.majority_group, "majority group survives argument swap");
    CHECK(sortedCopy(c.features) == sortedCopy(a.features));

    // Allocation-order invariance: the same shape built with every ordered
    // group pair has identical multiplicity metadata. (The frozen A9 arm
    // permutes the task->bank allocation order during TRAINING; construction
    // has no notion of allocation or bank, so the only thing it must preserve
    // under such a permutation is the count structure.)
    for (int ga = 0; ga < 3; ++ga) {
        for (int gb = 0; gb < 3; ++gb) {
            if (ga == gb) continue;
            CrossFamilyCue q;
            CHECK(buildCrossFamilyCue(makeSpec(n_feat, ga, gb, 2, 1), &q) == CueBuildError::Ok);
            CHECK(q.count_a == 2 && q.count_b == 1 && q.category == CrossFamilyCategory::CROSS21);
            CHECK(q.features.size() == 3);
        }
    }
}

// ---------------------------------------------------------------- S4
void testDeterminism() {
    section("S4 determinism and absence of global state");
    const int n_feat = 12;
    CrossFamilyCue first;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 1, 2, 1), &first) == CueBuildError::Ok);

    // Interleave other builds, including failing ones, then rebuild.
    CrossFamilyCue junk;
    CrossFamilyCueSpec bad = makeSpec(n_feat, 0, 2, 2, 2);
    CHECK(buildCrossFamilyCue(bad, &junk) != CueBuildError::Ok);
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 2, 1, 3, 1), &junk) == CueBuildError::Ok);
    (void)buildCrossFamilyCue(makeSpec(n_feat, 5, 1, 2, 1), &junk);

    CrossFamilyCue again;
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 1, 2, 1), &again) == CueBuildError::Ok);
    CHECK_MSG(sameCue(first, again), "identical input after unrelated calls gives identical output");

    std::vector<CrossFamilyCue> e1, e2;
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 2, 2, 1, &e1) == CueBuildError::Ok);
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 2, 2, 1, &e2) == CueBuildError::Ok);
    CHECK_MSG(e1.size() == e2.size(), "enumeration is repeatable");
    bool identical = e1.size() == e2.size();
    for (std::size_t i = 0; identical && i < e1.size(); ++i) identical = sameCue(e1[i], e2[i]);
    CHECK_MSG(identical, "enumeration order and contents are deterministic");
}

// ---------------------------------------------------------------- S5
void testInvalidInputs() {
    section("S5 invalid inputs are rejected deterministically");
    const int n_feat = 12;
    CrossFamilyCue sentinel;
    sentinel.n_feat = -777;
    sentinel.majority_group = -777;
    sentinel.features = {777};

    struct Case {
        const char* what;
        CrossFamilyCueSpec spec;
        CueBuildError want;
    };
    std::vector<Case> cases;

    {
        CrossFamilyCueSpec s = makeSpec(10, 0, 1, 2, 1);
        cases.push_back({"n_feat not a multiple of 4", s, CueBuildError::InvalidFeatureSpace});
    }
    {
        CrossFamilyCueSpec s = makeSpec(0, 0, 1, 2, 1);
        cases.push_back({"n_feat zero", s, CueBuildError::InvalidFeatureSpace});
    }
    {
        CrossFamilyCueSpec s = makeSpec(4, 0, 1, 2, 1);
        cases.push_back({"single group space", s, CueBuildError::TooFewSignatureGroups});
    }
    {
        CrossFamilyCueSpec s = makeSpec(n_feat, -1, 1, 2, 1);
        cases.push_back({"negative group", s, CueBuildError::GroupOutOfRange});
    }
    {
        CrossFamilyCueSpec s = makeSpec(n_feat, 3, 1, 2, 1);
        cases.push_back({"group beyond space", s, CueBuildError::GroupOutOfRange});
    }
    {
        CrossFamilyCueSpec s = makeSpec(n_feat, 0, 0, 2, 1);
        cases.push_back({"identical groups", s, CueBuildError::GroupsNotDistinct});
    }
    {
        CrossFamilyCueSpec s = makeSpec(n_feat, 0, 1, 2, 2);
        cases.push_back({"2:2 ratio", s, CueBuildError::UnsupportedMultiplicity});
    }
    {
        CrossFamilyCueSpec s = makeSpec(n_feat, 0, 1, 3, 2);
        cases.push_back({"3:2 ratio", s, CueBuildError::UnsupportedMultiplicity});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {0, 1, 2, 3}; s.features_b = {5};
        cases.push_back({"4:1 ratio", s, CueBuildError::UnsupportedMultiplicity});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {}; s.features_b = {5};
        cases.push_back({"empty majority", s, CueBuildError::FeatureCountMismatch});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {0, 1}; s.features_b = {};
        cases.push_back({"empty minority", s, CueBuildError::FeatureCountMismatch});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {0, 12}; s.features_b = {5};
        cases.push_back({"feature beyond space", s, CueBuildError::FeatureOutOfRange});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {0, -1}; s.features_b = {5};
        cases.push_back({"negative feature", s, CueBuildError::FeatureOutOfRange});
    }
    {
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 0; s.group_b = 1;
        s.features_a = {0, 0}; s.features_b = {5};
        cases.push_back({"duplicate feature", s, CueBuildError::DuplicateFeature});
    }
    {
        // Feature 1 belongs to group 0, not group 1: family assignment contradicted.
        CrossFamilyCueSpec s;
        s.n_feat = n_feat; s.group_a = 1; s.group_b = 2;
        s.features_a = {5, 1}; s.features_b = {9};
        cases.push_back({"feature in the wrong group", s, CueBuildError::FeatureGroupMismatch});
    }

    for (std::size_t i = 0; i < cases.size(); ++i) {
        CrossFamilyCue out = sentinel;
        const CueBuildError got = buildCrossFamilyCue(cases[i].spec, &out);
        check(got == cases[i].want,
              std::string("rejection reason for \"") + cases[i].what + "\": got \"" +
                  cueBuildErrorMessage(got) + "\"",
              __LINE__);
        check(out.n_feat == -777 && out.majority_group == -777 && out.features.size() == 1 &&
                  out.features[0] == 777,
              std::string("output untouched after rejection of \"") + cases[i].what + "\"", __LINE__);
    }

    // Null output pointer is rejected rather than dereferenced.
    CHECK(buildCrossFamilyCue(makeSpec(n_feat, 0, 1, 2, 1), nullptr) != CueBuildError::Ok);
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 1, 2, 1, nullptr) != CueBuildError::Ok);

    // Enumeration rejects the same specifications and leaves an empty vector.
    std::vector<CrossFamilyCue> v;
    CHECK(enumerateCrossFamilyCues(10, 0, 1, 2, 1, &v) == CueBuildError::InvalidFeatureSpace);
    CHECK(v.empty());
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 0, 2, 1, &v) == CueBuildError::GroupsNotDistinct);
    CHECK(v.empty());
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 1, 2, 2, &v) == CueBuildError::UnsupportedMultiplicity);
    CHECK(v.empty());
    CHECK(enumerateCrossFamilyCues(n_feat, 0, 1, 5, 1, &v) == CueBuildError::FeatureCountMismatch);
    CHECK(v.empty());
}

// ---------------------------------------------------------------- S6
void testEnumeration() {
    section("S6 exhaustive enumeration of the cross-family cue space");
    const int n_feat = 12;

    struct Expect { int na, nb; std::size_t count; CrossFamilyCategory cat; };
    const Expect table[] = {
        {1, 1, 4 * 4, CrossFamilyCategory::AMBIG11},   // C(4,1) * C(4,1)
        {2, 1, 6 * 4, CrossFamilyCategory::CROSS21},   // C(4,2) * C(4,1)
        {3, 1, 4 * 4, CrossFamilyCategory::CROSS31},   // C(4,3) * C(4,1)
    };

    for (const Expect& e : table) {
        std::vector<CrossFamilyCue> cues;
        CHECK(enumerateCrossFamilyCues(n_feat, 0, 2, e.na, e.nb, &cues) == CueBuildError::Ok);
        check(cues.size() == e.count, "enumeration size for the frozen case", __LINE__);
        bool all_good = true, monotone = true;
        for (std::size_t i = 0; i < cues.size(); ++i) {
            const CrossFamilyCue& c = cues[i];
            if (c.category != e.cat) all_good = false;
            if (static_cast<int>(c.features.size()) != e.na + e.nb) all_good = false;
            if (c.majority_count != (e.na > e.nb ? e.na : e.nb)) all_good = false;
            if (c.majority_group != (e.na > e.nb ? 0 : (e.na == e.nb ? -1 : 2))) all_good = false;
            // every feature inside the declared space, in its declared group
            for (std::size_t j = 0; j < c.features.size(); ++j) {
                const int f = c.features[j];
                if (f < 0 || f >= n_feat) all_good = false;
                const int want_group = (j < static_cast<std::size_t>(e.na)) ? 0 : 2;
                if (signatureGroupOfFeature(f, n_feat) != want_group) all_good = false;
            }
            // distinct within a cue
            if (sortedCopy(c.features) != c.features) all_good = false;
            for (std::size_t j = 1; j < c.features.size(); ++j)
                if (c.features[j] == c.features[j - 1]) all_good = false;
            if (i > 0 && !(cues[i - 1].features < c.features)) monotone = false;
        }
        check(all_good, "every enumerated cue satisfies the frozen-table invariants", __LINE__);
        check(monotone, "enumeration is in strictly ascending lexicographic order", __LINE__);
    }

    // The whole 2:1 space for T = 3: 3 tasks * 2 partners * 24 = 144 cues.
    std::size_t total = 0;
    std::map<std::vector<int>, int> seen;
    for (int ga = 0; ga < 3; ++ga) {
        for (int gb = 0; gb < 3; ++gb) {
            if (ga == gb) continue;
            std::vector<CrossFamilyCue> cues;
            CHECK(enumerateCrossFamilyCues(n_feat, ga, gb, 2, 1, &cues) == CueBuildError::Ok);
            total += cues.size();
            for (const CrossFamilyCue& c : cues) ++seen[sortedCopy(c.features)];
        }
    }
    CHECK_MSG(total == 144, "144 CROSS21 cues exist for T = 3");
    CHECK_MSG(seen.size() == 144, "all 144 are distinct stimuli");

    // The existing harness construction (CM_CROSS: one feature from each of two
    // groups) is representable by this constructor, so the 2-feature case has
    // not been redefined.
    CrossFamilyCue legacy;
    CrossFamilyCueSpec s;
    s.n_feat = 12; s.group_a = 1; s.group_b = 2;
    s.features_a = {4 + 3}; s.features_b = {8 + 1};
    CHECK(buildCrossFamilyCue(s, &legacy) == CueBuildError::Ok);
    CHECK_MSG(legacy.category == CrossFamilyCategory::AMBIG11, "CM_CROSS stimuli are AMBIG11");
    CHECK(legacy.features.size() == 2 && legacy.features[0] == 7 && legacy.features[1] == 9);
}

// ---------------------------------------------------------------- S7
void testRouterAcceptsStimulus() {
    section("S7 the constructed stimulus is accepted by the router (hand-set weights, no training)");

    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.n_feat = 12;
    cfg.n_banks = 3;
    CCAgent ag = makeCCAgent(cfg, /*plastic=*/true);
    for (int k = 0; k < cfg.n_banks; ++k) ag.bank_state[static_cast<std::size_t>(k)] = CC_ACTIVE;

    // Group-consistent, equal-magnitude per-feature preference: feature f
    // prefers the bank whose index equals f's signature group. No training and
    // no learning call is made anywhere in this section.
    for (int f = 0; f < cfg.n_feat; ++f) {
        const int g = signatureGroupOfFeature(f, cfg.n_feat);
        for (int k = 0; k < cfg.n_banks; ++k) {
            ag.net.getSynapse(ag.router[static_cast<std::size_t>(f)][static_cast<std::size_t>(k)])
                .setWeight(k == g ? 1.0 : 0.0);
        }
    }

    int resolved = 0, correct = 0;
    for (int ga = 0; ga < 3; ++ga) {
        for (int gb = 0; gb < 3; ++gb) {
            if (ga == gb) continue;
            const int shapes[3][2] = {{2, 1}, {3, 1}, {1, 1}};
            for (const auto& sh : shapes) {
                std::vector<CrossFamilyCue> cues;
                CHECK(enumerateCrossFamilyCues(cfg.n_feat, ga, gb, sh[0], sh[1], &cues) ==
                      CueBuildError::Ok);
                for (const CrossFamilyCue& c : cues) {
                    const int bank = ccPreferredBank(ag, c.features);
                    ++resolved;
                    // Under equal-magnitude group-consistent weights the argmax is
                    // the group with the most features; a 1:1 cue ties and the
                    // engine's tie-break (lowest index) decides.
                    const int expect = (c.majority_group >= 0)
                                           ? c.majority_group
                                           : std::min(ga, gb);
                    if (bank == expect) ++correct;
                }
            }
        }
    }
    CHECK_MSG(resolved == 6 * (24 + 16 + 16), "all 336 cross-family cues reached the router");
    CHECK_MSG(correct == resolved, "every cue resolved to the count-majority group");

    // Out-of-range features must never be constructed, because bankScores()
    // silently ignores them -- a constructor bug would then vanish.
    std::vector<CrossFamilyCue> cues;
    CHECK(enumerateCrossFamilyCues(cfg.n_feat, 0, 1, 3, 1, &cues) == CueBuildError::Ok);
    bool all_in_range = true;
    for (const CrossFamilyCue& c : cues)
        for (int f : c.features)
            if (f < 0 || f >= cfg.n_feat) all_in_range = false;
    CHECK_MSG(all_in_range, "no constructed feature falls outside the router's input space");

    // Unequal per-feature magnitudes can outvote the count rule. This is a
    // property of the ADDITIVE router, not of construction: the constructor
    // guarantees multiplicities, never that routing obeys them.
    for (int f = 0; f < cfg.n_feat; ++f) {
        const int g = signatureGroupOfFeature(f, cfg.n_feat);
        for (int k = 0; k < cfg.n_banks; ++k) {
            const double w = (k == g) ? (g == 2 ? 0.9 : 0.2) : 0.0;
            ag.net.getSynapse(ag.router[static_cast<std::size_t>(f)][static_cast<std::size_t>(k)])
                .setWeight(w);
        }
    }
    CrossFamilyCue c21;
    CHECK(buildCrossFamilyCue(makeSpec(12, 0, 2, 2, 1), &c21) == CueBuildError::Ok);
    CHECK_MSG(ccPreferredBank(ag, c21.features) == 2,
              "documented counter-example: unequal magnitudes beat the 2:1 count");
}

// ---------------------------------------------------------------- S8
void testSeparation() {
    section("S8 separation: no dependence on group count, task index, bank or answer");

    // Same groups, same counts, different total feature space -> identical cue.
    CrossFamilyCue a, b;
    CHECK(buildCrossFamilyCue(makeSpec(12, 0, 1, 2, 1), &a) == CueBuildError::Ok);
    CHECK(buildCrossFamilyCue(makeSpec(24, 0, 1, 2, 1), &b) == CueBuildError::Ok);
    CHECK_MSG(a.category == b.category && a.count_a == b.count_a && a.count_b == b.count_b &&
                  a.majority_group == b.majority_group && a.features == b.features,
              "construction does not depend on the number of signature groups");

    // Emitted features are exactly the union of the inputs: nothing is
    // injected, including any feature that could encode a task or an answer.
    std::vector<int> expect = {0, 1, 5};
    CHECK(a.features == expect);

    // The majority label is always one of the two declared groups, never a
    // task/bank identity introduced by construction.
    bool contained = true;
    for (int ga = 0; ga < 3; ++ga) {
        for (int gb = 0; gb < 3; ++gb) {
            if (ga == gb) continue;
            CrossFamilyCue c;
            CHECK(buildCrossFamilyCue(makeSpec(12, ga, gb, 2, 1), &c) == CueBuildError::Ok);
            if (c.majority_group != ga && c.majority_group != gb) contained = false;
        }
    }
    CHECK_MSG(contained, "majority_group is always one of the declared groups");

    // A cue carries no field whose value could differ between two calls that
    // describe the same stimulus -- i.e. no hidden per-call state.
    CrossFamilyCue again;
    CHECK(buildCrossFamilyCue(makeSpec(12, 0, 1, 2, 1), &again) == CueBuildError::Ok);
    CHECK(sameCue(a, again));
}

} // namespace

int main() {
    std::printf("STARK-L11.10 cross-family cue constructor tests\n");
    testFrozenTableCases();
    testRatioFromCounts();
    testOrderingAndPermutation();
    testDeterminism();
    testInvalidInputs();
    testEnumeration();
    testRouterAcceptsStimulus();
    testSeparation();

    if (g_failures == 0) {
        std::printf("PASS: test_l11_cue_constructor (%d assertions)\n", g_checks);
        return 0;
    }
    std::printf("FAIL: test_l11_cue_constructor (%d assertions, %d failures)\n", g_checks, g_failures);
    return 1;
}
