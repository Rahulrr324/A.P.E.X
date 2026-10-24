// STARK-L11.10: deterministic construction of cross-family (2:1 / 3:1) cues.
//
// Scope -- stimulus construction only.
//
// This module builds the *stimulus* required by the frozen L11 cue table
// (stark/design/l11_cross_signature_compositional_generalization.md §3):
//
//     AMBIG11  1 feature from group A + 1 from group B   (2 features, ratio 1:1)
//     CROSS21  2 features from group A + 1 from group B  (3 features, ratio 2:1)
//     CROSS31  3 features from group A + 1 from group B  (4 features, ratio 3:1)
//
// It performs NO routing, NO retrieval, NO scoring, NO reward computation and
// NO learning. It has no dependency on CCAgent, CCBankMode, LRMapping or the
// network, and it does not know that memory banks exist.
//
// What it deliberately does NOT contain:
//
//   * no task index, bank index, expected answer, queried identity or
//     evaluation label -- not as an input and not as an output field;
//   * no random number generator and no static/global state;
//   * no sampling policy. Which features of a group are used, and which group
//     is paired with which, are CALLER inputs. The frozen table fixes the
//     ratio and the group membership but not the particular feature
//     identities, so choosing them here would invent a scientifically
//     consequential policy (features inside one signature group are not
//     interchangeable: of the four within-group features, feature +0 occurs in
//     three of the four training pairs and feature +3 in one).
//
// Determinism contract: buildCrossFamilyCue() and enumerateCrossFamilyCues()
// are pure functions of their arguments. Identical arguments always produce
// identical output, independent of call order, of any global state, and of the
// number of signature groups in the environment.
//
// Canonical representation: a cue is an ordered vector of distinct feature
// indices. Ordering is canonical -- group A's features ascending, then group
// B's features ascending -- so that two specifications describing the same
// multiset always produce a bit-identical vector. (Cue order does not change
// any property of the frozen design; it is fixed here only so that downstream
// floating-point summation in the router sees one well-defined order.)

#ifndef STARK_LEARNING_L11_CUE_CONSTRUCTION_H
#define STARK_LEARNING_L11_CUE_CONSTRUCTION_H

#include <string>
#include <vector>

namespace learning {
namespace l11 {

/// Features per signature group in the frozen L10/L11 task construction
/// (`const int b = 4 * t; signature = {b+0, b+1, b+2, b+3}`).
constexpr int kFeaturesPerSignatureGroup = 4;

/// Signature group owning `feature`, or -1 if `feature` is outside
/// [0, n_feat) or `n_feat` is not a positive multiple of 4.
int signatureGroupOfFeature(int feature, int n_feat);

/// The three cross-family cue categories in the frozen L11 cue table.
enum class CrossFamilyCategory {
    AMBIG11 = 0,  // 1:1 -- no majority exists; carries no accuracy claim
    CROSS21 = 1,  // 2:1 -- primary composition test
    CROSS31 = 2,  // 3:1 -- monotonicity check
};

const char* crossFamilyCategoryName(CrossFamilyCategory c);

/// Frozen cue-table code ("AMBIG11" / "CROSS21" / "CROSS31").
const char* crossFamilyCategoryCode(CrossFamilyCategory c);

/// Reasons a specification can be rejected. Every rejection is deterministic
/// and reported without partial output.
enum class CueBuildError {
    Ok = 0,
    InvalidFeatureSpace,     // n_feat <= 0 or not a multiple of 4
    TooFewSignatureGroups,   // fewer than 2 groups: no cross-family cue exists
    GroupOutOfRange,         // a group index outside [0, n_feat / 4)
    GroupsNotDistinct,       // group A == group B
    UnsupportedMultiplicity, // (count_a, count_b) not one of {1,1},{2,1},{3,1}
    FeatureCountMismatch,    // features_a/b size differs from the declared count
    FeatureOutOfRange,       // a feature index outside [0, n_feat)
    DuplicateFeature,        // the same feature index appears twice in the cue
    FeatureGroupMismatch,    // a feature does not belong to its declared group
};

/// Human-readable, stable description of an error code.
const char* cueBuildErrorMessage(CueBuildError e);

/// Caller-supplied construction input. `count_a`/`count_b` are implied by the
/// sizes of `features_a`/`features_b`; they are accepted with either order
/// (a 1:2 request is a valid 2:1 cue whose majority is group B).
struct CrossFamilyCueSpec {
    int n_feat = 0;                 // observable feature space size (12 for T = 3)
    int group_a = -1;               // signature group of features_a
    int group_b = -1;               // signature group of features_b
    std::vector<int> features_a;    // any order; must all belong to group_a
    std::vector<int> features_b;    // any order; must all belong to group_b
};

/// Validated, canonical stimulus. Descriptive metadata only: feature
/// identities, their group membership, multiplicities and the derived ratio.
/// It carries no bank, no answer and no task identity.
struct CrossFamilyCue {
    CrossFamilyCategory category = CrossFamilyCategory::AMBIG11;
    int n_feat = 0;
    int group_a = -1;
    int group_b = -1;
    int count_a = 0;
    int count_b = 0;
    int majority_count = 0;         // max(count_a, count_b)
    int minority_count = 0;         // min(count_a, count_b)
    int majority_group = -1;        // -1 when count_a == count_b (AMBIG11: no majority)
    std::vector<int> features;      // canonical order: group A ascending, then group B ascending
};

/// Validate `spec` and write the canonical cue to `*out`.
///
/// On any error `*out` is left untouched and the returned code says why.
/// `*out` must be non-null.
CueBuildError buildCrossFamilyCue(const CrossFamilyCueSpec& spec, CrossFamilyCue* out);

/// Enumerate every distinct cue for a fixed (group_a, group_b, count_a,
/// count_b) specification, in a deterministic lexicographic order.
///
/// This is the only helper that supplies feature identities, and it supplies
/// ALL of them -- the (seeded) choice of which cue to present belongs to the
/// evaluation driver, not to construction. `*out` is cleared first and left
/// empty on error.
CueBuildError enumerateCrossFamilyCues(int n_feat, int group_a, int group_b,
                                       int count_a, int count_b,
                                       std::vector<CrossFamilyCue>* out);

} // namespace l11
} // namespace learning

#endif // STARK_LEARNING_L11_CUE_CONSTRUCTION_H
