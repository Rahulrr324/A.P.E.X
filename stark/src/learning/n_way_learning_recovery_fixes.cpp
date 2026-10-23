// STARK-L8: N-way learning recovery fix testing.
// Tests F1-F2 variants vs unchanged L7 baseline. Reports STARK-L8-1.
#include "learning/RelevanceRouting.h"
#include "neural/Network.h"
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

static double v(double x) {
    if (x < -1.5) x = -1.5;
    if (x > 1.5) x = 1.5;
    return x;
}
static std::string num(double x) {
    std::ostringstream os; os.setf(std::ios::fixed); os.precision(6); os << x; return os.str();
}

struct DiagOutcome {
    int correct=0, n=0;
    int sel_n=0, sel_ok=0;
    int fp=0, miss=0, mech_n=0;
    int cond_sel_correct=0, cond_sel_correct_n=0;
    int cond_sel_wrong=0, cond_sel_wrong_n=0;
    int mapping_correct_ids=0, mapping_n_ids=0;
    double reward_first20=0, reward_last20=0;
    double mean_U=0, mean_I=0;
    double gen_acc=0; int gen_n=0;
};

enum Variant { V_BASE=0, V_F1a_ETA3F, V_F1b_P1COUNT, V_F2a_SOFTMAX, V_F2b_VCLAMP, V_F1F2, V_F1bF2a, V_F1b120F2a, V_N };

static DiagOutcome runDiag(LRConfig cfg, const LRMapping& map, unsigned seed, int arm, Variant var, int p1_count) {
    LRConfig cfg2 = cfg;
    double sN = std::sqrt(double(cfg2.n_chan));
    switch(var){
        case V_F1a_ETA3F: cfg2.eta_3f = 1.2; break;
        case V_F2a_SOFTMAX: cfg2.softmax_T = 1.0/sN/2.0; break;
        case V_F2b_VCLAMP: cfg2.v_clamp = 3.0; break;
        case V_F1F2: cfg2.eta_3f=1.2; cfg2.softmax_T=1.0/sN/2.0; break;
        case V_F1bF2a: cfg2.softmax_T=1.0/sN/2.0; break;
        case V_F1b120F2a: cfg2.softmax_T=1.0/sN/2.0; break;
        default: break;
    }
    cfg = cfg2;
    LRAgent ag = makeLRAgent(cfg, true);
    DiagOutcome o;
    auto p1 = makeLRTrials(cfg, map, p1_count, 0, seed);
    double sf=0, sl=0, sumU=0, sumI=0;
    for(size_t t=0;t<p1.size();++t){
        auto w0=lrWeights(ag);
        LRTrialResult r=runLRTrial(ag,cfg,p1[t],map,arm,true);
        auto w1=lrWeights(ag);
        double U=0,I=0;
        for(int i=0;i<cfg.n_ids;++i) for(int rr=0;rr<cfg.n_ids;++rr){
            double d=std::fabs(w1[size_t(i)][size_t(rr)]-w0[size_t(i)][size_t(rr)]);
            if(i==r.queried) I+=d; else U+=d;
        }
        sumU+=U; sumI+=I;
        if(t<20) sf+=r.reward; if(t+20>=int(p1.size())) sl+=r.reward;
    }
    o.mean_U = p1.size()? sumU/double(p1.size()):0.0;
    o.mean_I = p1.size()? sumI/double(p1.size()):0.0;
    o.reward_first20 = p1.size()>=20? sf/20.0:0.0;
    o.reward_last20 = p1.size()>=20? sl/20.0:0.0;
    auto p2 = makeLRTrials(cfg, map, 0, 40, seed+1);
    for(size_t t=0;t<p2.size();++t) runLRTrial(ag,cfg,p2[t],map,arm,true);
    auto w = lrWeights(ag);
    for(int i=0;i<cfg.n_ids;++i){
        int best=-1; double bv=-1e9;
        for(int rr=0;rr<cfg.n_ids;++rr) if(w[size_t(i)][size_t(rr)]>bv){ bv=w[size_t(i)][size_t(rr)]; best=rr; }
        if(best==map.perm[size_t(i)]) ++o.mapping_correct_ids;
        ++o.mapping_n_ids;
    }
    auto evA = makeLRTrials(cfg, map, 0, 20, seed+2);
    for(const auto& s: evA){
        LRTrialResult r=runLRTrial(ag,cfg,s,map,arm,false);
        ++o.n;
        if(r.choice==map.perm[size_t(r.queried)]) ++o.correct;
        if(r.sel_slot>=0){
            ++o.sel_n;
            if(r.sel_slot==r.queried_slot) ++o.sel_ok;
            if(r.fp_gate) ++o.fp; if(r.miss_gate) ++o.miss; ++o.mech_n;
            bool sel_correct = (r.sel_slot==r.queried_slot);
            bool choice_correct = (r.choice==map.perm[size_t(r.queried)]);
            if(sel_correct){ ++o.cond_sel_correct_n; if(choice_correct) ++o.cond_sel_correct; }
            else { ++o.cond_sel_wrong_n; if(choice_correct) ++o.cond_sel_wrong; }
        }
    }
    std::string tmp="build/dev_bin/reload_L8_N"+std::to_string(cfg.n_chan)+".bin";
    ag.net.save(tmp);
    LRAgent ag2=makeLRAgent(cfg,true); ag2.net.load(tmp);
    LRMapping map2=makeLRMapping(seed+31,cfg.n_ids,cfg.n_ctx); map2.phi=map.phi;
    auto p1p=makeLRTrials(cfg,map2,p1_count,0,seed+3);
    for(const auto& s: p1p) runLRTrial(ag2,cfg,s,map2,arm,true);
    auto evB=makeLRTrials(cfg,map2,0,20,seed+4);
    int gc=0, gn=0;
    for(const auto& s: evB){
        LRTrialResult r=runLRTrial(ag2,cfg,s,map2,arm,false);
        ++gn;
        if(r.choice==map2.perm[size_t(r.queried)]) ++gc;
    }
    o.gen_acc = gn? double(gc)/gn : 0.0;
    o.gen_n = gn;
    return o;
}

int main(int argc, char** argv) {
    const int kSeeds[3] = {123456789, 218213831, 171473193};
    const std::vector<int> NS = {2,4,8};
    const int kSeedsN=3;
    const char *kVarNames[V_N] = {"BASE","F1a_eta3f1.2","F1b_p1count80","F2a_softmax_half","F2b_vclamp3.0","F1F2_eta3f+softmax","F1bF2a_p1count80+softmax","F1b120F2a_p1count120+softmax"};
    (void)argc;(void)argv;
    struct VR { double acc, gen, sel, orc, map, cond, fp; };
    std::map<std::pair<int,int>, VR> res;
    std::map<std::pair<int,int>, std::map<int,std::pair<double,double>>> perseed;
    for(int N:NS){
        LRConfig cfg; cfg.n_chan=N; cfg.n_ids=N+4; cfg.n_ctx=N;
        for(int si=0;si<kSeedsN;++si){
            int master=kSeeds[si];
            LRMapping m=makeLRMapping(master,cfg.n_ids,cfg.n_ctx);
            for(int v=0;v<V_N;++v){
                int p1c = (v==V_F1b_P1COUNT||v==V_F1bF2a)?80:((v==V_F1b120F2a)?120:40);
                DiagOutcome o = runDiag(cfg,m,unsigned(master),LR_LEARNED,Variant(v),p1c);
                DiagOutcome orc = runDiag(cfg,m,unsigned(master),LR_ORACLE,Variant(v),p1c);
                auto key=std::make_pair(N,v);
                res[key].acc += o.n? double(o.correct)/o.n:0;
                res[key].gen += o.gen_n? o.gen_acc:0;
                res[key].sel += o.sel_n? double(o.sel_ok)/o.sel_n:0;
                res[key].map += o.mapping_n_ids? double(o.mapping_correct_ids)/o.mapping_n_ids:0;
                res[key].cond += o.cond_sel_correct_n? double(o.cond_sel_correct)/o.cond_sel_correct_n:0;
                res[key].fp += o.mech_n? double(o.fp)/o.mech_n:0;
                res[key].orc += orc.n? double(orc.correct)/orc.n:0;
                if(v==V_BASE||v==V_F1bF2a||v==V_F1b120F2a){
                    perseed[std::make_pair(N,v)][si] = std::make_pair(o.n?double(o.correct)/o.n:0, o.gen_n?o.gen_acc:0);
                }
            }
        }
        for(int v=0;v<V_N;++v){
            auto key=std::make_pair(N,v);
            VR &r=res[key];
            r.acc/=kSeedsN; r.gen/=kSeedsN; r.sel/=kSeedsN; r.map/=kSeedsN;
            r.cond/=kSeedsN; r.fp/=kSeedsN; r.orc/=kSeedsN;
        }
    }
    std::string js="{\n";
    js+="  \"schema\": \"STARK-L8-1\",\n";
    js+="  \"design\": \"N-way learning recovery fix testing (F1-F2)\",\n";
    js+="  \"baseline_commit\": \"75a039a\",\n";
    js+="  \"variants\": [\"BASE\",\"F1a_eta3f1.2\",\"F1b_p1count80\",\"F2a_softmax_half\",\"F2b_vclamp3.0\",\"F1F2_eta3f+softmax\",\"F1bF2a_p1count80+softmax\",\"F1b120F2a_p1count120+softmax\"],\n";
    js+="  \"ns\": [2,4,8],\n";
    js+="  \"masters\": [123456789,218213831,171473193],\n";
    js+="  \"results\": {\n";
    for(size_t nn=0;nn<NS.size();++nn){
        int N=NS[nn];
        js+="    \"N="+std::to_string(N)+"\": [\n";
        for(int v=0;v<V_N;++v){
            VR &r=res[std::make_pair(N,v)];
            js+="      { \"variant\": \""+std::string(kVarNames[v])+"\",\n";
            js+="        \"learned_acc\": "+num(r.acc)+", \"heldout_gen\": "+num(r.gen)+",\n";
            js+="        \"sel_acc\": "+num(r.sel)+", \"oracle_acc\": "+num(r.orc)+",\n";
            js+="        \"mapping_acc\": "+num(r.map)+", \"cond_act_correct\": "+num(r.cond)+",\n";
            js+="        \"fp_rate\": "+num(r.fp)+" }";
            if(v<V_N-1) js+=",";
            js+="\n";
        }
        js+="    ]";
        if(nn<NS.size()-1) js+=",";
        js+="\n";
    }
    js+="  },\n";
    js+="  \"per_seed\": [\n";
    bool firstps=true;
    for(int N:NS) for(int v=0;v<V_N;++v){
        if(perseed.count(std::make_pair(N,v))==0) continue;
        if(!firstps) js+=",\n";
        firstps=false;
        js+="    { \"n\": "+std::to_string(N)+", \"variant\": \""+std::string(kVarNames[v])+"\", \"seeds\": [";
        for(int si=0;si<kSeedsN;++si){
            js+="{ \"master\": "+std::to_string(kSeeds[si])+", \"acc\": "+num(perseed[std::make_pair(N,v)][si].first)+", \"gen\": "+num(perseed[std::make_pair(N,v)][si].second)+" }";
            if(si<kSeedsN-1) js+=",";
        }
        js+="] }";
    }
    js+="\n  ],\n";
    js+="  \"verdict\": \"fix testing complete\"\n";
    js+="}\n";
    std::ofstream f("work/dev_n_way_learning_recovery_fixes_STARK-L8-1.json");
    if(!f){ std::cerr<<"cannot open fixes report\n"; return 1; }
    f<<js; f.close();
    std::cerr<<"wrote work/dev_n_way_learning_recovery_fixes_STARK-L8-1.json\n";
    std::cout<<"fixes report: work/dev_n_way_learning_recovery_fixes_STARK-L8-1.json\n";
    return 0;
}
