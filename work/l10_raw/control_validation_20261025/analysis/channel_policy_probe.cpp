#include "learning/ContextConditionedMemory.h"
#include <iostream>
#include <cmath>
using namespace learning;
static double ev(CCAgent& ag,const LRMapping& m,unsigned seed){
  std::string snap=ccSerialize(ag);
  auto e=makeLRTrials(ag.cfg.lr,m,0,20,seed+700u); int ok=0,n=0;
  for(const auto&t:e){ CCTrialSchedule s; s.lr=t; s.cue={0,1};
    CCResult r=runCCTrial(ag,s,m,-1,CC_LEARNED,false,false,0); ++n; if(r.choice==m.perm[r.queried])++ok; }
  ccDeserialize(ag,snap); return double(ok)/n;
}
static bool sameW(const CCAgent&a,const CCAgent&b){
  auto x=ccBankWeights(a), y=ccBankWeights(b);
  for(size_t k=0;k<x.size();++k) for(size_t i=0;i<x[k].size();++i) for(size_t j=0;j<x[k][i].size();++j)
    if(x[k][i][j]!=y[k][i][j]) return false; return true;}
int main(){
  CCConfig cfg; cfg.lr.n_ids=6; cfg.lr.n_chan=2; cfg.lr.n_ctx=2; cfg.n_banks=3; cfg.n_feat=12;
  cfg.lr.softmax_T=1.0/std::sqrt(2.0)/2.0;
  unsigned seed=424242u; LRMapping m0=makeLRMapping(seed+0u,6,2);
  CCAgent ag=makeCCAgent(cfg,true); ag.bank_state[0]=CC_ACTIVE;
  auto a=makeLRTrials(cfg.lr,m0,80,0,seed);
  for(const auto&t:a){ CCTrialSchedule s; s.lr=t; s.cue={0,1}; runCCTrial(ag,s,m0,-1,CC_LEARNED,true,false,0); }
  std::cout<<"after 480 single:            acc="<<ev(ag,m0,seed)<<"\n";
  CCAgent snap0=ag;  std::string st0=ccSerialize(ag);
  auto b=makeLRTrials(cfg.lr,m0,0,40,seed+1u);
  for(const auto&t:b){ CCTrialSchedule s; s.lr=t; s.cue={0,1}; runCCTrial(ag,s,m0,-1,CC_LEARNED,true,false,0); }
  std::cout<<"after +240 sel (learning ON):acc="<<ev(ag,m0,seed)<<"  weights_equal="<<sameW(ag,snap0)<<"\n";
  CCAgent r=makeCCAgent(cfg,true); ccDeserialize(r,st0);
  std::cout<<"restored 480-single state:   acc="<<ev(r,m0,seed)<<"  state_roundtrip_eq="<<(ccSerialize(r)==st0)<<"\n";
}
