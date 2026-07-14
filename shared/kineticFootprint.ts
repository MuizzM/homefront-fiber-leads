export const KINETIC_FOOTPRINT_STATES = [
  "AL", "AR", "FL", "GA", "IA", "KY", "MN", "MS", "MO",
  "NE", "NM", "NY", "NC", "OH", "OK", "PA", "SC", "TX",
] as const;

export type KineticFootprintState = typeof KINETIC_FOOTPRINT_STATES[number];

export interface KineticEnvironment {
  code: string;
  label: string;
  states: string;
  stateCodes: KineticFootprintState[];
  upperLimit: number;
  prefix: string;
}

/**
 * Provider index partitions observed by the scanner. The state membership is the
 * official 18-state Kinetic residential footprint; upper limits are conservative
 * starting frontiers and are advanced from conclusive observations at runtime.
 */
export const KINETIC_ENVIRONMENTS: KineticEnvironment[] = [
  { code: "MS", label: "Carolinas", states: "NC, SC", stateCodes: ["NC", "SC"], upperLimit: 3_062_552, prefix: "MS" },
  { code: "PA", label: "Pennsylvania", states: "PA", stateCodes: ["PA"], upperLimit: 573_208, prefix: "PA" },
  { code: "AL", label: "Southeast", states: "AL, FL, GA, MS", stateCodes: ["AL", "FL", "GA", "MS"], upperLimit: 800_000, prefix: "AL" },
  { code: "OH", label: "Ohio / Kentucky", states: "KY, OH", stateCodes: ["KY", "OH"], upperLimit: 500_000, prefix: "OH" },
  { code: "TX", label: "Southwest", states: "NM, OK, TX", stateCodes: ["NM", "OK", "TX"], upperLimit: 600_000, prefix: "TX" },
  { code: "MO", label: "Central Midwest", states: "IA, MN, MO, NE", stateCodes: ["IA", "MN", "MO", "NE"], upperLimit: 700_000, prefix: "MO" },
  { code: "NY", label: "New York", states: "NY", stateCodes: ["NY"], upperLimit: 400_000, prefix: "NY" },
  { code: "AR", label: "Arkansas", states: "AR", stateCodes: ["AR"], upperLimit: 300_000, prefix: "AR" },
];

const stateSet = new Set<string>(KINETIC_FOOTPRINT_STATES);

export function isKineticFootprintState(value: unknown): value is KineticFootprintState {
  return stateSet.has(String(value ?? "").trim().toUpperCase());
}

export function allocateEnvironmentBudget(total: number, environmentCount = KINETIC_ENVIRONMENTS.length): number[] {
  const count = Math.max(1, Math.floor(environmentCount));
  const safeTotal = Math.max(count, Math.floor(total));
  const base = Math.floor(safeTotal / count);
  const remainder = safeTotal % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function planEnvironmentWindow(input: {
  cursor: number;
  dailyBudget: number;
  overlap: number;
}): { startCns: number; endCns: number; overlap: number; newCandidates: number } {
  const budget = Math.max(1, Math.floor(input.dailyBudget));
  const overlap = Math.min(Math.max(0, Math.floor(input.overlap)), Math.max(0, budget - 1));
  const cursor = Math.max(1, Math.floor(input.cursor));
  const startCns = Math.max(1, cursor - overlap);
  const endCns = cursor + (budget - overlap) - 1;
  return { startCns, endCns, overlap: cursor - startCns, newCandidates: endCns - cursor + 1 };
}
