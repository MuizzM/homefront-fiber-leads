// @vitest-environment node
import { createRequire } from "node:module";
import { it } from "vitest";
const { check } = createRequire(import.meta.url)("../helpers/liveops-resume-fixture.cjs");
it.each([
  [false,false], [false,true], [true,false], [true,true],
])("reconciles still-fresh Live Ops data once on resume (stream=%s, effectFirst=%s)", async (streaming,effectBeforeOptions)=>{
  await check({streaming,effectBeforeOptions});
});
