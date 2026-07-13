export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One-line JSON logs are machine-queryable in Docker/journald and avoid
 * accidentally concatenating response bodies or lead PII into log messages.
 */
export function structuredLog(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
  level: LogLevel = "info",
): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  }));
}
