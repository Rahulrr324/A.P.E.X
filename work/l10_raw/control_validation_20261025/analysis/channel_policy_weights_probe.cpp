#include "learning/ContextConditionedMemory.h"
#include <iostream>
#include <cmath>
using namespace learning;
int main(){
  CCConfig cfg; cfg.lr.n_ids=6; cfg.lr.n_chan=2; cfg.lr.n_ctx=2; cfg.n_banks=3; cfg.n_feat=12;
  cfg.lr.softmax_T=1.0/std::sqrt(2.0)/2.0;
  unsigned seed=424242u; LRMapping m0=makeLRMapping(seed+0u,6,2);
  CCAgent ag=makeCCAgent(cfg,true); ag.bank_state[0]=CC_ACTIVE;
  for(const auto&t:makeLRTrials(cfg.lr,m0,80,0,seed)){ CCTrialSchedule s; s.lr=t; s.cue={0,1};
    runCCTrial(ag,s,m0,-1,CC_LEARNED,true,false,0); }
  auto v=[&](const CCAgent&a){ std::vector<double> o; for(auto&row:a.route) for(auto sid:row) o.push_back(a.net.getSynapse(sid).getWeight()); return o; };
  auto wbk=[&](const CCAgent&a){ return ccBankWeights(a); };
  auto v0=v(ag); auto w0=wbk(ag);
  for(const auto&t:makeLRTrials(cfg.lr,m0,0,40,seed+1u)){ CCTrialSchedule s; s.lr=t; s.cue={0,1};
    runCCTrial(ag,s,m0,-1,CC_LEARNED,true,false,0); }
  auto v1=v(ag); auto w1=wbk(ag);
  double dv=0,dw=0;
  for(size_t i=0;i<v0.size();++i) dv+=std::fabs(v1[i]-v0[i]);
  for(size_t k=0;k<w0.size();++k) for(size_t a2=0;a2<w0[k].size();++a2) for(size_t b=0;b<w0[k][a2].size();++b) dw+=std::fabs(w1[k][a2][b]-w0[k][a2][b]);
  std::cout<<"during 240 multi-candidate trials: |d channel-policy v| = "<<dv
           <<"   |d bank S->A| = "<<dw<<"\n";
}
