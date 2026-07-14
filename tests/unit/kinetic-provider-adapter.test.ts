import { describe,expect,it } from "vitest";
import { normalizeKineticResponse } from "../../server/kineticProviderAdapter";

describe("Kinetic provider normalization",()=>{
  it("maps only explicit Kinetic fields and retains the raw response",()=>{
    const raw={kineticAddressId:"KA-42",sequentialId:42,address:"100 Main St",city:"Lexington",state:"nc",zip:"27292",latitude:35.8,longitude:-80.25,exchangeId:"LEX",techType:"FIBER",maxQual:2000,estimatedCompletionDate:"2026-08-01",isLive:true,isComingSoon:false,copperUpgradeCandidate:false};
    const result=normalizeKineticResponse(raw);
    expect(result).toMatchObject({kineticAddressId:"KA-42",sequentialId:42,state:"NC",technologyType:"FIBER",maximumQualification:2000,isLive:true,isComingSoon:false,isCopperUpgradeCandidate:false,rawResponse:raw});
    expect(result.responseHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not infer live service from householdSegmentType",()=>{
    const result=normalizeKineticResponse({sequentialId:9,householdSegmentType:"NEW FIBER"});
    expect(result.isLive).toBeNull();expect(result.technologyType).toBeNull();expect(result.sequentialId).toBe(9);
  });
  it("supports an explicit configurable response mapping",()=>{
    const result=normalizeKineticResponse({payload:{id:"A1",seq:17,flags:{live:1}}},{root:"payload",kineticAddressId:"id",sequentialId:"seq",isLive:"flags.live"});
    expect(result).toMatchObject({kineticAddressId:"A1",sequentialId:17,isLive:true});
  });
});
