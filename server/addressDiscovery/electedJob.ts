// Dependency-free classifier: is a discovery job an operator-ELECTED area scan
// (a box drawn on the field map) or a background market/town harvest? Elected
// scans have a drawn geometry, no town name, and are not keyed to a recurring
// market burst; they earn the densest, highest-capped address enumeration.
// Mirrors the client's isBackgroundDiscoveryJob so both ends agree on what
// "the operator elected this" means. Kept dependency-free so it is trivially
// unit-testable without loading the DB/scanner module graph.

export function isElectedAreaJob(job: {
  areaJson?: string | null;
  requestedAreaJson?: string | null;
  idempotencyKey?: string | null;
  townName?: string | null;
}): boolean {
  if (/^(hot|frontier):/i.test(String(job.idempotencyKey ?? ""))) return false;
  const towned = !!(job.townName && String(job.townName).trim());
  const hasGeometry = !!(job.areaJson || job.requestedAreaJson);
  return hasGeometry && !towned;
}
