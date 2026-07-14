import { rawDb } from "./db";
import { KINETIC_ENVIRONMENTS, type KineticEnvironment } from "@shared/kineticFootprint";

export interface NationalCnsFrontier {
  environment: string;
  states: string;
  enabled: boolean;
  nextCns: number;
  upperLimit: number;
  lastWindowStart: number | null;
  lastWindowEnd: number | null;
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastStatus: string;
  lastError: string | null;
  totalChecked: number;
  totalHits: number;
  totalConfirmed: number;
}

export function seedNationalCnsFrontiers(): void {
  const insert = rawDb.prepare(`INSERT INTO cns_national_frontiers
    (environment,states_json,enabled,next_cns,upper_limit,last_status)
    VALUES (?,?,1,?,?,'ready') ON CONFLICT(environment) DO UPDATE SET
      states_json=excluded.states_json,upper_limit=MAX(cns_national_frontiers.upper_limit,excluded.upper_limit),
      updated_at=datetime('now')`);
  const tx = rawDb.transaction((envs: KineticEnvironment[]) => {
    for (const env of envs) insert.run(env.code, JSON.stringify(env.stateCodes), env.upperLimit + 1, env.upperLimit);
  });
  tx(KINETIC_ENVIRONMENTS);
  const valid = KINETIC_ENVIRONMENTS.map((env) => env.code);
  if (valid.length) rawDb.prepare(`UPDATE cns_national_frontiers SET enabled=0,last_status='retired',updated_at=datetime('now') WHERE environment NOT IN (${valid.map(() => "?").join(",")})`).run(...valid);
}

export function listNationalCnsFrontiers(): NationalCnsFrontier[] {
  seedNationalCnsFrontiers();
  return (rawDb.prepare(`SELECT environment,states_json AS statesJson,enabled,next_cns AS nextCns,
    upper_limit AS upperLimit,last_window_start AS lastWindowStart,last_window_end AS lastWindowEnd,
    last_run_at AS lastRunAt,last_completed_at AS lastCompletedAt,last_status AS lastStatus,last_error AS lastError,
    total_checked AS totalChecked,total_hits AS totalHits,total_confirmed AS totalConfirmed
    FROM cns_national_frontiers ORDER BY environment`).all() as any[]).map((row) => ({
      ...row, states: (safeJson(row.statesJson) as string[]).join(", "), enabled: !!row.enabled, statesJson: undefined,
    }));
}

export function beginNationalEnvironmentRun(environment: string, startCns: number, endCns: number): void {
  rawDb.prepare(`UPDATE cns_national_frontiers SET last_window_start=?,last_window_end=?,last_run_at=datetime('now'),
    last_status='running',last_error=NULL,updated_at=datetime('now') WHERE environment=?`).run(startCns, endCns, environment);
}

export function completeNationalEnvironmentRun(input: {
  environment: string;
  maxConclusiveCns: number | null;
  checked: number;
  hits: number;
  confirmed: number;
  error?: string | null;
}): void {
  const status = input.error ? "error" : "completed";
  rawDb.prepare(`UPDATE cns_national_frontiers SET
    next_cns=CASE WHEN ? IS NOT NULL AND ?+1>next_cns THEN ?+1 ELSE next_cns END,
    last_completed_at=datetime('now'),last_status=?,last_error=?,
    total_checked=total_checked+?,total_hits=total_hits+?,total_confirmed=total_confirmed+?,updated_at=datetime('now')
    WHERE environment=?`).run(
      input.maxConclusiveCns, input.maxConclusiveCns, input.maxConclusiveCns,
      status, input.error ?? null, input.checked, input.hits, input.confirmed, input.environment,
    );
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return []; }
}
