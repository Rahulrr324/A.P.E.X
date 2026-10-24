// STARK-L11.10: deterministic construction of cross-family (2:1 / 3:1) cues.
// See L11CueConstruction.h for the scope and the determinism contract.
//
// No dependency on the memory model: this translation unit includes only the
// C++ standard library and its own header.

#include "learning/L11CueConstruction.h"

#include <algorithm>

namespace learning {
namespace l11 {
namespace {

int popcount4(unsigned mask) {
    int n = 0;
    for (int i = 0; i < 4; ++i) {
        if (mask & (1u << static_cast<unsigned>(i))) ++n;
    }
    return n;
}

// {1,1}, {2,1}, {3,1} in either order. Everything else is rejected: the
// frozen cue table defines exactly these three cross-family multiplicities.
bool supportedMultiplicity(int ca, int cb) {
    const int hi = ca > cb ? ca : cb;
    const int lo = ca > cb ? cb : ca;
    return lo == 1 && (hi == 1 || hi == 2 || hi == 3);
}

CrossFamilyCategory categoryFor(int hi) {
    if (hi >= 3) return CrossFamilyCategory::CROSS31;
    if (hi == 2) return CrossFamilyCategory::CROSS21;
    return CrossFamilyCategory::AMBIG11;
}

CueBuildError validateSpace(int n_feat) {
    if (n_feat <= 0) return CueBuildError::InvalidFeatureSpace;
    if (n_feat % kFeaturesPerSignatureGroup != 0) return CueBuildError::InvalidFeatureSpace;
    if (n_feat / kFeaturesPerSignatureGroup < 2) return CueBuildError::TooFewSignatureGroups;
    return CueBuildError::Ok;
}

CueBuildError validateGroup(int g, int n_feat) {
    const int n_groups = n_feat / kFeaturesPerSignatureGroup;
    if (g < 0 || g >= n_groups) return CueBuildError::GroupOutOfRange;
    return CueBuildError::Ok;
}

// Validate one group's feature list: size, range, membership, distinctness.
CueBuildError validateFeatureList(const std::vector<int>& feats, int group, int n_feat,
                                  std::vector<int>* sorted_out) {
    sorted_out->clear();
    for (std::size_t i = 0; i < feats.size(); ++i) {
        const int f = feats[i];
        if (f < 0 || f >= n_feat) return CueBuildError::FeatureOutOfRange;
        if (signatureGroupOfFeature(f, n_feat) != group) return CueBuildError::FeatureGroupMismatch;
    }
    *sorted_out = feats;
    std::sort(sorted_out->begin(), sorted_out->end());
    for (std::size_t i = 1; i < sorted_out->size(); ++i) {
        if ((*sorted_out)[i] == (*sorted_out)[i - 1]) return CueBuildError::DuplicateFeature;
    }
    return CueBuildError::Ok;
}

} // namespace

int signatureGroupOfFeature(int feature, int n_feat) {
    if (n_feat <= 0) return -1;
    if (n_feat % kFeaturesPerSignatureGroup != 0) return -1;
    if (feature < 0 || feature >= n_feat) return -1;
    return feature / kFeaturesPerSignatureGroup;
}

const char* crossFamilyCategoryName(CrossFamilyCategory c) {
    switch (c) {
        case CrossFamilyCategory::AMBIG11: return "ambiguous 1:1";
        case CrossFamilyCategory::CROSS21: return "cross-family 2:1";
        case CrossFamilyCategory::CROSS31: return "cross-family 3:1";
    }
    return "unknown";
}

const char* crossFamilyCategoryCode(CrossFamilyCategory c) {
    switch (c) {
        case CrossFamilyCategory::AMBIG11: return "AMBIG11";
        case CrossFamilyCategory::CROSS21: return "CROSS21";
        case CrossFamilyCategory::CROSS31: return "CROSS31";
    }
    return "UNKNOWN";
}

const char* cueBuildErrorMessage(CueBuildError e) {
    switch (e) {
        case CueBuildError::Ok: return "ok";
        case CueBuildError::InvalidFeatureSpace:
            return "n_feat must be a positive multiple of 4";
        case CueBuildError::TooFewSignatureGroups:
            return "at least two signature groups are required for a cross-family cue";
        case CueBuildError::GroupOutOfRange: return "signature group out of range";
        case CueBuildError::GroupsNotDistinct: return "group A and group B must differ";
        case CueBuildError::UnsupportedMultiplicity:
            return "multiplicity must be one of {1,1}, {2,1}, {3,1}";
        case CueBuildError::FeatureCountMismatch:
            return "feature count does not match the declared multiplicity";
        case CueBuildError::FeatureOutOfRange: return "feature index out of range";
        case CueBuildError::DuplicateFeature: return "duplicate feature index";
        case CueBuildError::FeatureGroupMismatch:
            return "feature does not belong to its declared signature group";
    }
    return "unknown error";
}

CueBuildError buildCrossFamilyCue(const CrossFamilyCueSpec& spec, CrossFamilyCue* out) {
    if (out == nullptr) return CueBuildError::InvalidFeatureSpace;

    CueBuildError e = validateSpace(spec.n_feat);
    if (e != CueBuildError::Ok) return e;
    e = validateGroup(spec.group_a, spec.n_feat);
    if (e != CueBuildError::Ok) return e;
    e = validateGroup(spec.group_b, spec.n_feat);
    if (e != CueBuildError::Ok) return e;
    if (spec.group_a == spec.group_b) return CueBuildError::GroupsNotDistinct;

    const int ca = static_cast<int>(spec.features_a.size());
    const int cb = static_cast<int>(spec.features_b.size());
    if (ca < 1 || cb < 1) return CueBuildError::FeatureCountMismatch;
    if (!supportedMultiplicity(ca, cb)) return CueBuildError::UnsupportedMultiplicity;

    std::vector<int> sa, sb;
    e = validateFeatureList(spec.features_a, spec.group_a, spec.n_feat, &sa);
    if (e != CueBuildError::Ok) return e;
    e = validateFeatureList(spec.features_b, spec.group_b, spec.n_feat, &sb);
    if (e != CueBuildError::Ok) return e;

    // Distinctness across the whole cue. Features of different groups cannot
    // collide (the groups partition the space), but check anyway so that the
    // invariant is enforced in one place rather than implied.
    for (std::size_t i = 0; i < sa.size(); ++i) {
        for (std::size_t j = 0; j < sb.size(); ++j) {
            if (sa[i] == sb[j]) return CueBuildError::DuplicateFeature;
        }
    }

    CrossFamilyCue cue;
    cue.n_feat = spec.n_feat;
    cue.group_a = spec.group_a;
    cue.group_b = spec.group_b;
    cue.count_a = ca;
    cue.count_b = cb;
    cue.majority_count = ca > cb ? ca : cb;
    cue.minority_count = ca > cb ? cb : ca;
    cue.majority_group = (ca == cb) ? -1 : (ca > cb ? spec.group_a : spec.group_b);
    cue.category = categoryFor(cue.majority_count);
    cue.features.reserve(static_cast<std::size_t>(ca + cb));
    cue.features.insert(cue.features.end(), sa.begin(), sa.end());
    cue.features.insert(cue.features.end(), sb.begin(), sb.end());

    *out = cue;
    return CueBuildError::Ok;
}

CueBuildError enumerateCrossFamilyCues(int n_feat, int group_a, int group_b,
                                       int count_a, int count_b,
                                       std::vector<CrossFamilyCue>* out) {
    if (out == nullptr) return CueBuildError::InvalidFeatureSpace;
    out->clear();

    CueBuildError e = validateSpace(n_feat);
    if (e != CueBuildError::Ok) return e;
    e = validateGroup(group_a, n_feat);
    if (e != CueBuildError::Ok) return e;
    e = validateGroup(group_b, n_feat);
    if (e != CueBuildError::Ok) return e;
    if (group_a == group_b) return CueBuildError::GroupsNotDistinct;
    if (count_a < 1 || count_b < 1 || count_a > kFeaturesPerSignatureGroup ||
        count_b > kFeaturesPerSignatureGroup) {
        return CueBuildError::FeatureCountMismatch;
    }
    if (!supportedMultiplicity(count_a, count_b)) return CueBuildError::UnsupportedMultiplicity;

    const int base_a = group_a * kFeaturesPerSignatureGroup;
    const int base_b = group_b * kFeaturesPerSignatureGroup;

    // Deterministic enumeration: bit masks scanned in ascending order, which
    // yields lexicographically ascending feature subsets; the inner loop then
    // makes the whole list lexicographic on (features_a, features_b).
    for (unsigned ma = 0; ma < 16u; ++ma) {
        if (popcount4(ma) != count_a) continue;
        for (unsigned mb = 0; mb < 16u; ++mb) {
            if (popcount4(mb) != count_b) continue;
            CrossFamilyCueSpec spec;
            spec.n_feat = n_feat;
            spec.group_a = group_a;
            spec.group_b = group_b;
            for (int i = 0; i < kFeaturesPerSignatureGroup; ++i) {
                if (ma & (1u << static_cast<unsigned>(i))) spec.features_a.push_back(base_a + i);
                if (mb & (1u << static_cast<unsigned>(i))) spec.features_b.push_back(base_b + i);
            }
            CrossFamilyCue cue;
            e = buildCrossFamilyCue(spec, &cue);
            if (e != CueBuildError::Ok) {
                out->clear();
                return e;
            }
            out->push_back(cue);
        }
    }
    // Masks scan ascending by bit pattern, which is not lexicographic on the
    // resulting feature list (e.g. {0,3} precedes {1,2} as a mask but follows
    // it lexicographically). Sort so that the documented order holds exactly.
    std::sort(out->begin(), out->end(),
              [](const CrossFamilyCue& a, const CrossFamilyCue& b) { return a.features < b.features; });
    return CueBuildError::Ok;
}

} // namespace l11
} // namespace learning
