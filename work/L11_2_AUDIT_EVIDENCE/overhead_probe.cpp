#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"
#include <chrono>
#include <cstdio>
using namespace learning;
int main(){
  const unsigned master=123456789u; const int n=300;
  const char* names[4]={"plain","+ccSerialize","+ccBankWeights+ccRouterWeights","+all three"};
  for(int mode=0;mode<4;++mode){
    auto t0=std::chrono::steady_clock::now();
    CCConfig cfg; CCAgent ag=makeCCAgent(cfg,true);
    LRMapping map=makeLRMapping(master,cfg.lr.n_ids,cfg.lr.n_ctx);
    auto sched=makeLRTrials(cfg.lr,map,0,40,master); ccAllocateNext(ag,false);
    for(int i=0;i<n&&i<(int)sched.size();++i){
      CCTrialSchedule s; s.lr=sched[(size_t)i]; s.cue={0,1};
      runCCTrial(ag,s,map,-1,CC_LEARNED,true,true,-1);
      if(mode==1||mode==3) (void)ccSerialize(ag);
      if(mode==2||mode==3) { (void)ccBankWeights(ag); (void)ccRouterWeights(ag); }
    }
    auto t1=std::chrono::steady_clock::now();
    std::printf("%-32s %.3f ms/trial\n", names[mode], std::chrono::duration<double,std::milli>(t1-t0).count()/n);
  }
  return 0;
}
