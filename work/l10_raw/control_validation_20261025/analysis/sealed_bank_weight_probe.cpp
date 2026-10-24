#include "learning/ContextConditionedMemory.h"
#include <iostream>
#include <cmath>
using namespace learning;
static double delta(const CCAgent& ag,const std::vector<std::vector<std::vector<double>>>& w0,int k){
  auto w1=ccBankWeights(ag); double d=0; for(size_t a=0;a<w1[k].size();++a) for(size_t b=0;b<w1[k][a].size();++b) d+=std::fabs(w1[k][a][b]-w0[k][a][b]); return d;}
int main(){
  CCConfig cfg; cfg.lr.n_ids=6; cfg.lr.n_chan=2; cfg.lr.n_ctx=2; cfg.n_banks=3; cfg.n_feat=12;
  cfg.lr.softmax_T=1.0/std::sqrt(2.0)/2.0;
  unsigned seed=424242u; LRMapping m0=makeLRMapping(seed+0u,6,2);
  for(int sealed=0;sealed<2;++sealed){
    CCAgent ag=makeCCAgent(cfg,true); ag.bank_state[0]=CC_ACTIVE;
    auto a=makeLRTrials(cfg.lr,m0,80,0,seed);
    for(const auto&t:a){ CCTrialSchedule s; s.lr=t; s.cue={0,1}; runCCTrial(ag,s,m0,-1,CC_LEARNED,t.single,false,0); }
    if(sealed) ag.bank_state[0]=CC_SEALED;        // seal before the selection block
    auto w0=ccBankWeights(ag);
    auto b=makeLRTrials(cfg.lr,m0,0,40,seed+1u);
    int singles=0;
    for(const auto&t:b){ CCTrialSchedule s; s.lr=t; s.cue={0,1}; runCCTrial(ag,s,m0,-1,CC_LEARNED,true,false,0); }
    auto ev=makeLRTrials(cfg.lr,m0,0,20,seed+700u);
    int ok=0,n=0; for(const auto&t:ev){ CCTrialSchedule s; s.lr=t; s.cue={0,1};
      CCResult r=runCCTrial(ag,s,m0,-1,CC_LEARNED,false,false,0); ++n; if(r.choice==m0.perm[r.queried])++ok;}
    std::cout<<(sealed?"sealed  bank0":"active  bank0")<<": |dW| during 240 selection trials = "
             <<delta(ag,w0,0)<<"  eval acc="<<double(ok)/n<<"\n";
  }
}
