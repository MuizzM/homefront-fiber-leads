import {describe,expect,it} from "vitest";
import {formatCnsIdentifier,planCnsRange} from "@shared/cnsRange";

describe("CNS range planning",()=>{
  it("counts inclusive ranges without the historical off-by-one",()=>{
    expect(planCnsRange({start:2,end:10_000,upperLimit:573_208,jobSizeLimit:100_000})).toMatchObject({valid:true,candidateCount:9_999});
    expect(planCnsRange({start:7,end:7,upperLimit:100,jobSizeLimit:100})).toMatchObject({valid:true,candidateCount:1});
  });
  it("counts end-exclusive ranges",()=>expect(planCnsRange({start:2,end:10_000,inclusive:false,upperLimit:573_208,jobSizeLimit:100_000}).candidateCount).toBe(9_998));
  it("enforces environment and job limits",()=>{
    expect(planCnsRange({start:1,end:100_001,upperLimit:573_208,jobSizeLimit:100_000}).error).toBe("job_limit");
    expect(planCnsRange({start:1,end:573_209,upperLimit:573_208,jobSizeLimit:1_000_000}).error).toBe("above_upper_limit");
  });
  it("formats zero-padded identifiers",()=>expect(formatCnsIdentifier("pa",12345)).toBe("PA0012345"));
});
