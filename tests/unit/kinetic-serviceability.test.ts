import { describe,expect,it } from "vitest";
import { classifyKineticServiceability,decideKineticServiceability } from "../../shared/kineticServiceability";

const first={previousState:null,lastNonFiberAtMs:null,openCandidate:false,confirmationCount:0} as const;

describe("Kinetic serviceability transition truth",()=>{
  it("never calls the first fiber result fresh",()=>{
    expect(decideKineticServiceability(first,{isLive:true,technologyType:"FTTH Fiber",observedAtMs:1000})).toMatchObject({action:"BASELINE",discoveryState:"BASELINE_FIBER",fresh:false});
  });
  it("requires explicit fiber technology for a positive result",()=>{
    expect(classifyKineticServiceability({isLive:true,technologyType:"DSL",observedAtMs:1000})).toBe("UNKNOWN");
  });
  it("opens then verifies a non-fiber to fiber transition",()=>{
    const candidate=decideKineticServiceability({previousState:"NON_FIBER",lastNonFiberAtMs:1000,openCandidate:false,confirmationCount:0},{isLive:true,technologyType:"Fiber",observedAtMs:2000},2);
    expect(candidate).toMatchObject({action:"OPEN_CANDIDATE",discoveryState:"CANDIDATE_FRESH",fresh:false,verificationCount:1,detectionWindow:{fromMs:1000,toMs:2000}});
    expect(decideKineticServiceability({previousState:"FIBER_LIVE",lastNonFiberAtMs:1000,openCandidate:true,confirmationCount:1},{isLive:true,technologyType:"Fiber",observedAtMs:3000},2)).toMatchObject({action:"VERIFY",discoveryState:"VERIFIED_FRESH",fresh:true,verificationCount:2});
  });
  it("does not mutate truth on an inconclusive response",()=>{
    expect(decideKineticServiceability({previousState:"NON_FIBER",lastNonFiberAtMs:1000,openCandidate:false,confirmationCount:0},{isLive:null,technologyType:null,observedAtMs:2000,conclusive:false})).toMatchObject({action:"NO_CHANGE_FAILURE",changesCurrentState:false,fresh:false});
  });
  it("regresses and closes a candidate on a conclusive non-fiber result",()=>{
    expect(decideKineticServiceability({previousState:"FIBER_LIVE",lastNonFiberAtMs:1000,openCandidate:true,confirmationCount:1},{isLive:false,technologyType:"Copper",observedAtMs:4000})).toMatchObject({action:"REGRESS",discoveryState:"REGRESSED",fresh:false,verificationCount:0});
  });
  it("preserves verified-fresh truth on later steady fiber checks",()=>{
    expect(decideKineticServiceability({previousState:"FIBER_LIVE",previousDiscoveryState:"VERIFIED_FRESH",lastNonFiberAtMs:1000,openCandidate:false,confirmationCount:2},{isLive:true,technologyType:"Fiber",observedAtMs:5000})).toMatchObject({action:"NO_CHANGE",discoveryState:"VERIFIED_FRESH",fresh:true});
  });
});
