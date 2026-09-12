// Uses only a new temporary SQLite database and a loopback HTTP server.
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type StorageModule = typeof import('../../server/storage');
let storage: StorageModule['storage'];
let Storage: StorageModule['Storage'];
let rawDb: import('better-sqlite3').Database;
let server: Server;
let base: string;
const NOW = Date.parse('2026-09-05T16:00:00.000Z');
const MIDNIGHT = '2026-09-05T04:00:00.000Z';
const TAG = 'kinetic_build_2026';
const fx: Record<string, { id: number; session: string; name: string }> = {};
let otherTenant: number;
let bumpTenantConfigVersion: () => void;
let seq = 0;
const realFetch = globalThis.fetch;

function person(name: string, role: string, tenantId = 1, reportsToId: number | null = null, active = true) {
  const email = `${name.toLowerCase().replaceAll(' ', '.')}@readmodels.test`;
  const member = storage.createTeamMember({ name, email, role, tenantId, reportsToId, active });
  const user = storage.createUser({ name, email, role, tenantId, teamMemberId: member.id, active });
  return { id: member.id, session: storage.createSession(user.id).id, name };
}
function lead(over: Partial<Parameters<StorageModule['storage']['createLead']>[0]> = {}) {
  return storage.createLead({ address: `${++seq} Audit Ave`, city: 'Example', state: 'NC', zip: '28000',
    lat: 33, lng: -81, tenantId: 1, leadStatus: 'prospect', ...over });
}
function knock(leadId: number, repId: number, at: string, outcome = 'not_home', tenant = 1, superseded = 0) {
  rawDb.prepare(`INSERT INTO knock_log (lead_id,rep_id,outcome,was_home,knocked_at,tenant_id,pass_number,superseded)
    VALUES (?,?,?,1,?,?,1,?)`).run(leadId, repId, outcome, at, tenant, superseded);
}
const req = (path: string, session = fx.admin.session, headers: Record<string, string> = {}) =>
  realFetch(`${base}${path}`, { headers: { 'x-session-id': session, ...headers } });
function upload(csv: string, session: string) {
  const boundary = '----backend-read-model-fixture';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="leads.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
  return realFetch(`${base}/api/leads/import/preview`, { method: 'POST', headers: {
    'x-session-id': session, 'x-csrf-token': session,
    'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length),
  }, body });
}
function aggregateCount(spy: { mock: { calls: ReadonlyArray<readonly unknown[]> } }) {
  return spy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('GROUP BY k.rep_id')).length;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hf-backend-read-models-'));
  process.env.NODE_ENV = 'test';
  const mod = await import('../../server/storage');
  mod.runMigrations(); storage = mod.storage; Storage = mod.Storage; bumpTenantConfigVersion = mod.bumpTenantConfigVersion;
  rawDb = (await import('../../server/db')).rawDb;
  otherTenant = storage.createTenant({ slug: 'read-model-other', companyName: 'Other', ownerName: 'Other', ownerEmail: 'other@readmodels.test', brandName: 'Other' }).id;
  fx.admin = person('Audit Admin', 'admin');
  fx.lead = person('Audit Lead', 'team_lead');
  fx.inside = person('Inside Rep', 'rep', 1, fx.lead.id);
  fx.outside = person('Outside Rep', 'rep');
  fx.inactive = person('Inactive Rep', 'rep', 1, fx.lead.id, false);
  fx.other = person('Other Tenant Rep', 'rep', otherTenant);
  fx.unlinked = person('Unlinked Lead', 'team_lead');
  rawDb.prepare('UPDATE users SET team_member_id = NULL WHERE team_member_id = ?').run(fx.unlinked.id);
  const { registerRoutes, registerSaasRoutes } = await import('../../server/routes');
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });

describe('leaderboard query and cache contracts', () => {
  it('keeps corrections outside a requested historical range and member-tenant ownership', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rep = person('Range Rep', 'rep');
    const cancelled = lead({ leadStatus: 'sold' });
    knock(cancelled.id, rep.id, '2026-09-04T12:00:00.000Z', 'sold');
    knock(cancelled.id, rep.id, '2026-09-05T12:00:00.000Z', 'not_home');
    const memberOwned = lead({ leadStatus: 'sold', tenantId: otherTenant });
    knock(memberOwned.id, rep.id, MIDNIGHT, 'sold', otherTenant);
    const probe = new Storage();
    const spy = vi.spyOn(rawDb, 'prepare');
    const row = probe.getLeaderboard({ since: '2026-09-04T00:00:00.000Z', until: '2026-09-04T23:59:59.999Z' }, 1).find(r => r.rep.id === rep.id);
    expect(row).toMatchObject({ knocks: 1, sales: 0, knocksToday: 2, salesToday: 1 });
    const query = spy.mock.calls.map(([sql]: [string]) => sql).find((sql: string) => sql.includes('GROUP BY k.rep_id'))!;
    expect(query).toContain('AND k.knocked_at >= @lowerBound');
    expect(query.slice(query.indexOf('SELECT 1 FROM knock_log kn'), query.indexOf(') AS sales'))).not.toContain('kn.knocked_at >= @lowerBound');
  });

  it('keeps Today counters when the selected range starts later than org midnight', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rep = person('Later Range Rep', 'rep');
    const a = lead(); knock(a.id, rep.id, MIDNIGHT);
    const b = lead(); knock(b.id, rep.id, '2026-09-05T08:00:00.000Z');
    const row = new Storage().getLeaderboard({ since: '2026-09-05T07:00:00.000Z' }, 1).find(r => r.rep.id === rep.id);
    expect(row).toMatchObject({ knocks: 1, knocksToday: 2 });
  });

  it('uses an indexable tenant equality for all-time without changing global reads', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const spy = vi.spyOn(rawDb, 'prepare');
    const probe = new Storage();
    const tenant = probe.getLeaderboard(undefined, 1);
    const all = probe.getLeaderboard();
    expect(tenant.some(r => r.rep.id === fx.other.id)).toBe(false);
    expect(all.some(r => r.rep.id === fx.other.id)).toBe(true);
    const queries = spy.mock.calls.map(([sql]: [string]) => sql).filter((sql: string) => sql.includes('GROUP BY k.rep_id'));
    expect(queries[0]).toContain('AND t.tenant_id = @tenantId');
    expect(queries[0]).not.toContain('@tenantId IS NULL');
    expect(queries[1]).toContain('@tenantId IS NULL');
  });

  it.each(['7d', '30d', '1y'] as const)('reuses %s across moving cutoffs only within the existing TTL', preset => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const probe = new Storage();
    const sql = vi.spyOn(rawDb, 'prepare');
    const days = { '7d': 7, '30d': 30, '1y': 365 }[preset];
    const cutoffMs = NOW - days * 86_400_000;
    const cutoff = new Date(cutoffMs).toISOString();
    const first = probe.getLeaderboard({ since: cutoff, preset }, 1);
    clock.mockReturnValue(NOW + 9_999);
    expect(probe.getLeaderboard({ since: new Date(cutoffMs + 9_999).toISOString(), preset }, 1)).toBe(first);
    expect(aggregateCount(sql)).toBe(1);
    clock.mockReturnValue(NOW + 10_000);
    expect(probe.getLeaderboard({ since: new Date(cutoffMs + 10_000).toISOString(), preset }, 1)).not.toBe(first);
    expect(aggregateCount(sql)).toBe(2);
  });

  it('shares moving preset computations through the actual HTTP route', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    // This request's historical clock must agree with its session lifetime.
    const lifetime = rawDb.prepare('SELECT created_at,expires_at FROM sessions WHERE id=?').get(fx.admin.session) as { created_at: string; expires_at: string };
    rawDb.prepare('UPDATE sessions SET created_at=?,expires_at=? WHERE id=?').run(new Date(NOW - 3_600_000).toISOString(), new Date(NOW + 3_600_000).toISOString(), fx.admin.session);
    try {
      const sql = vi.spyOn(rawDb, 'prepare');
      const first = await req('/api/leaderboard?range=7d');
      expect(first.status).toBe(200); const rows = await first.json();
      clock.mockReturnValue(NOW + 1_000);
      const second = await req('/api/leaderboard?range=7d');
      expect(second.status).toBe(200); expect(await second.json()).toEqual(rows);
      expect(aggregateCount(sql)).toBe(1);
    } finally {
      rawDb.prepare('UPDATE sessions SET created_at=?,expires_at=? WHERE id=?').run(lifetime.created_at, lifetime.expires_at, fx.admin.session);
    }
  });

  it('does not merge distinct custom cutoffs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const probe = new Storage();
    const a = probe.getLeaderboard({ since: '2026-09-04T00:00:00.000Z' }, 1);
    const b = probe.getLeaderboard({ since: '2026-09-04T00:00:00.001Z' }, 1);
    expect(b).not.toBe(a);
  });

  it('busts a preset at org midnight even within two milliseconds', () => {
    const rep = person('Midnight Rep', 'rep');
    const door = lead(); knock(door.id, rep.id, '2026-09-05T22:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T03:59:59.999Z'));
    const probe = new Storage();
    const a = probe.getLeaderboard({ since: '2026-08-30T03:59:59.999Z', preset: '7d' }, 1);
    expect(a.find(r => r.rep.id === rep.id)?.knocksToday).toBe(1);
    clock.mockReturnValue(Date.parse('2026-09-06T04:00:00.001Z'));
    const b = probe.getLeaderboard({ since: '2026-08-30T04:00:00.001Z', preset: '7d' }, 1);
    expect(b).not.toBe(a);
    expect(b.find(r => r.rep.id === rep.id)).toMatchObject({ knocks: 1, knocksToday: 0 });
  });

  it('busts a reused preset after a manager changes the sold disposition', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rep = person('Epoch Rep', 'rep');
    const door = lead({ leadStatus: 'sold' }); knock(door.id, rep.id, MIDNIGHT, 'sold');
    const probe = new Storage();
    const window = { since: '2026-08-29T16:00:00.000Z', preset: '7d' } as const;
    const a = probe.getLeaderboard(window, 1);
    expect(a.find(r => r.rep.id === rep.id)?.sales).toBe(1);
    storage.updateLead(door.id, { leadStatus: 'not_interested' });
    const b = probe.getLeaderboard(window, 1);
    expect(b).not.toBe(a);
    expect(b.find(r => r.rep.id === rep.id)?.sales).toBe(0);
  });
});

describe('map conditional and bounded-read contracts', () => {
  it('keeps all, latest, and kinetic_2026 validators distinct in both wire formats', async () => {
    lead({ lat: 35.4, lng: -80.6, leadTag: TAG });
    lead({ lat: 35.4, lng: -80.6, leadTag: 'fcc_fiber_d25' });
    lead({ lat: 35.4, lng: -80.6, leadTag: null });
    for (const format of ['object', 'packed']) {
      const paths = ['', '&view=latest', '&view=kinetic_2026'].map(view => `/api/leads/map?format=${format}${view}`);
      const tags: string[] = [];
      for (const path of paths) { const response = await req(path); expect(response.status).toBe(200); tags.push(response.headers.get('etag')!); await response.arrayBuffer(); }
      expect(new Set(tags).size).toBe(3);
      for (let i = 0; i < paths.length; i++) {
        expect((await req(paths[i], fx.admin.session, { 'if-none-match': tags[i] })).status).toBe(304);
        const wrong = await req(paths[i], fx.admin.session, { 'if-none-match': tags[(i + 1) % tags.length] });
        expect(wrong.status).toBe(200); await wrong.arrayBuffer();
      }
    }
  });

  it('retains exact under-cap tenant/rep/lens scope and open-field eligibility', async () => {
    rawDb.prepare('UPDATE tenants SET open_field_enabled = 1 WHERE id = 1').run();
    bumpTenantConfigVersion();
    const own = lead({ lat: 35.41, lng: -80.61, leadTag: TAG, assignedRepId: fx.inside.id });
    const open = lead({ lat: 35.41, lng: -80.61, leadTag: TAG });
    lead({ lat: 35.41, lng: -80.61, leadTag: TAG, assignedRepId: fx.outside.id });
    lead({ lat: 35.41, lng: -80.61, leadTag: TAG, tenantId: otherTenant });
    const count = vi.spyOn(storage, 'getLeadsMapWindowCount');
    const pins = vi.spyOn(storage, 'getLeadsForMap');
    const response = await req('/api/leads/map?nosample=1&view=kinetic_2026&tag=kinetic&bbox=-80.62,35.405,-80.60,35.415', fx.inside.session);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pins.map((p: { id: number }) => p.id).sort((a: number, b: number) => a - b)).toEqual([own.id, open.id]);
    expect(body.truncated).toBe(false); expect(body.windowCount).toBeUndefined();
    expect(count).toHaveBeenCalledTimes(1); expect(pins).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0].slice(0, 2)).toEqual(pins.mock.calls[0].slice(0, 2));
  });

  it('skips wide pin/visit hydration for a real over-cap nosample window', async () => {
    const add = rawDb.prepare(`INSERT INTO leads (address,city,state,zip,lat,lng,tenant_id,lead_status,lead_tag,created_at,updated_at)
      VALUES (?, 'Dense', 'NC', '28000', 35.55, -80.55, 1, 'prospect', ?, datetime('now'), datetime('now'))`);
    rawDb.transaction(() => { for (let i = 0; i < 25_001; i++) add.run(`Dense ${i}`, TAG); })();
    const pins = vi.spyOn(storage, 'getLeadsForMap');
    const count = vi.spyOn(storage, 'getLeadsMapWindowCount');
    const response = await req('/api/leads/map?nosample=1&view=kinetic_2026&bbox=-80.56,35.54,-80.54,35.56');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pins: [], total: 0, truncated: true, windowCount: 25_001 });
    expect(count).toHaveBeenCalledTimes(1); expect(pins).not.toHaveBeenCalled();
  });

  it('preserves the legacy deterministic sample and query order', async () => {
    const count = vi.spyOn(storage, 'getLeadsMapWindowCount');
    const pins = vi.spyOn(storage, 'getLeadsForMap');
    const response = await req('/api/leads/map?view=kinetic_2026&bbox=-80.56,35.54,-80.54,35.56');
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.truncated).toBe(true); expect(body.windowCount).toBe(25_001);
    expect(body.pins.length).toBeGreaterThan(0); expect(body.pins.length).toBeLessThanOrEqual(25_000);
    const ids = body.pins.map((p: { id: number }) => p.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
    expect(ids.every((id: number) => id % 2 === 0)).toBe(true);
    expect(count).toHaveBeenCalledTimes(1); expect(pins).toHaveBeenCalledTimes(2);
    expect(pins.mock.invocationCallOrder[0]).toBeLessThan(count.mock.invocationCallOrder[0]);
    expect(pins.mock.calls[1][2]).toMatchObject({ limit: 25_000, sampleStep: 2 });
  });

  it('recounts if capped hydration crosses an initially under-cap count', async () => {
    const original = storage.getLeadsMapWindowCount.bind(storage);
    const count = vi.spyOn(storage, 'getLeadsMapWindowCount').mockImplementationOnce(() => 25_000).mockImplementation(original);
    const pins = vi.spyOn(storage, 'getLeadsForMap');
    const response = await req('/api/leads/map?nosample=1&view=kinetic_2026&bbox=-80.56,35.54,-80.54,35.56');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pins: [], total: 0, truncated: true, windowCount: 25_001 });
    expect(count).toHaveBeenCalledTimes(2); expect(pins).toHaveBeenCalledTimes(1);
  });
});

describe('import request-local roster scope', () => {
  const csv = () => ['Address,City,State,Assigned rep',
    `1 Import St,Example,NC,${fx.inside.name}`, `2 Import St,Example,NC,${fx.outside.name}`,
    `3 Import St,Example,NC,${fx.other.name}`, `4 Import St,Example,NC,${fx.inactive.name}`,
  ].join('\n');
  it('loads the team once and excludes inactive, outside-team, and other-tenant names', async () => {
    const roster = vi.spyOn(storage, 'getTeamMembers');
    const member = vi.spyOn(storage, 'getTeamMemberById');
    const response = await upload(csv(), fx.lead.session); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.unknownReps.sort()).toEqual([fx.outside.name, fx.other.name, fx.inactive.name].sort());
    expect(roster).toHaveBeenCalledTimes(1); expect(member).not.toHaveBeenCalled();
  });
  it('keeps missing team linkage fail-closed', async () => {
    const response = await upload(csv(), fx.unlinked.session); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.unknownReps.sort()).toEqual([fx.inside.name, fx.outside.name, fx.other.name, fx.inactive.name].sort());
  });
  it('recomputes scope on the next request after a reporting-line edit', async () => {
    storage.updateTeamMember(fx.outside.id, { reportsToId: fx.lead.id });
    const roster = vi.spyOn(storage, 'getTeamMembers');
    const response = await upload(csv(), fx.lead.session); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.unknownReps.sort()).toEqual([fx.other.name, fx.inactive.name].sort());
    expect(roster).toHaveBeenCalledTimes(1);
  });
});

describe('ranking preserves exact density reason counts', () => {
  it('preserves the exact 800m threshold for nearby-pair counts', async () => {
    const { rankLeads } = await import('../../server/leadRanking');
    const rep = person('Boundary Density Rep', 'rep');
    const point = (meters: number) => lead({ lat: 35 + meters / 6_371_000 * 180 / Math.PI, lng: -80,
      assignedRepId: rep.id, freshConfirmedAt: '2026-09-05T12:00:00.000Z' });
    const a = point(0), b = point(799.99), c = point(800.01);
    const rows = rankLeads(1, 500, NOW, [rep.id]);
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.id === a.id)?.reasons).toContain('1 fresh lead within 800m');
    expect(rows.find(r => r.id === b.id)?.reasons).toContain('2 fresh leads within 800m');
    expect(rows.find(r => r.id === c.id)?.reasons).toContain('1 fresh lead within 800m');
  });

  it('counts every owned neighbor beyond score saturation and omits other scopes', async () => {
    const { rankLeads } = await import('../../server/leadRanking');
    const rep = person('Density Rep', 'rep');
    const fresh = '2026-09-05T12:00:00.000Z';
    const owned = Array.from({ length: 21 }, () => lead({ lat: 35.7, lng: -80.7, assignedRepId: rep.id, freshConfirmedAt: fresh }));
    lead({ lat: 35.7, lng: -80.7, assignedRepId: fx.outside.id, freshConfirmedAt: fresh });
    const isolated = lead({ lat: 36, lng: -81, assignedRepId: rep.id, freshConfirmedAt: fresh });
    const unlocated = lead({ lat: null, lng: null, assignedRepId: rep.id, freshConfirmedAt: fresh });
    const rows = rankLeads(1, 500, NOW, [rep.id]);
    expect(rows).toHaveLength(23);
    for (const door of owned) expect(rows.find(r => r.id === door.id)?.reasons).toContain('20 fresh leads within 800m');
    for (const id of [isolated.id, unlocated.id]) expect(rows.find(r => r.id === id)?.reasons.some(r => r.includes('within 800m'))).toBe(false);
  });
});
