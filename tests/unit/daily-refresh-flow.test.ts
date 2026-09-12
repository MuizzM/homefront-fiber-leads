// @vitest-environment node
import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database, harvest: vi.fn(), enqueue: vi.fn(), upsert: vi.fn() }));
vi.mock("../../server/db", () => ({ rawDb: { prepare: (...args: [string]) => fixture.db.prepare(...args) } }));
vi.mock("../../server/storage", () => ({ storage: { upsertScanTargets: fixture.upsert } }));
vi.mock("../../server/overpass", () => ({ getCityAddresses: fixture.harvest }));
vi.mock("../../server/scanService", () => ({ startTargetRun: fixture.enqueue }));
vi.mock("../../server/kineticMarketCatalog", () => ({ KINETIC_MONITORED_STATES: ["NC"] }));
import { runDailyMarketRefresh, getDailyRefreshStatus } from "../../server/dailyMarketRefresh";
beforeEach(() => {
  fixture.db = new Database(":memory:");
  fixture.db.exec(`CREATE TABLE state_fiber_markets(city TEXT,state TEXT,auto_scan_eligible INTEGER);
    INSERT INTO state_fiber_markets VALUES ('Fixture','NC',1);
    CREATE TABLE scan_targets(id INTEGER PRIMARY KEY,tenant_id INTEGER,city TEXT,state TEXT,last_scanned_at TEXT,first_seen_fiber_at TEXT);
    CREATE TABLE leads(tenant_id INTEGER,lead_tag TEXT,created_at TEXT);
    CREATE TABLE kinetic_addresses(tenant_id INTEGER,is_coming_soon INTEGER)`);
  fixture.harvest.mockReset().mockResolvedValue({ addresses: [] }); fixture.enqueue.mockReset(); fixture.upsert.mockReset();
});
afterEach(() => fixture.db.close());
it("coalesces the same tenant and serializes other tenants with separate status", async () => {
  let release!: () => void;
  fixture.harvest.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ addresses: [] }); }));
  const first = runDailyMarketRefresh(1), repeated = runDailyMarketRefresh(1), other = runDailyMarketRefresh(2);
  expect(repeated).toBe(first); await Promise.resolve();
  expect(fixture.harvest).toHaveBeenCalledTimes(1);
  expect(getDailyRefreshStatus(1)).toMatchObject({ running: true, currentCity: "Fixture, NC" });
  expect(getDailyRefreshStatus(2)).toMatchObject({ running: true, currentCity: null });
  const snapshot = getDailyRefreshStatus(1); snapshot.newAddresses = 999;
  expect(getDailyRefreshStatus(1).newAddresses).toBe(0);
  release(); await Promise.all([first, other]);
  expect(fixture.harvest).toHaveBeenCalledTimes(2);
  expect(getDailyRefreshStatus(1).running).toBe(false); expect(getDailyRefreshStatus(2).running).toBe(false);
});
it("enqueues at most 500 per page and freezes the upper ID despite concurrent discovery", async () => {
  const put = fixture.db.prepare("INSERT INTO scan_targets(id,tenant_id,city,state) VALUES (?,?,'Fixture','NC')");
  fixture.db.transaction(() => { for (let id = 1; id <= 1201; id++) put.run(id, 11); put.run(9000, 12); })();
  fixture.enqueue.mockImplementationOnce(() => { put.run(9999, 11); });
  const status = await runDailyMarketRefresh(11);
  expect(fixture.enqueue.mock.calls.map(([input]) => input.targetIds.length)).toEqual([500, 500, 201]);
  const ids = fixture.enqueue.mock.calls.flatMap(([input]) => input.targetIds);
  expect(new Set(ids).size).toBe(1201); expect(ids).not.toContain(9999); expect(ids).not.toContain(9000);
  expect(status).toMatchObject({ newAddresses: 1201, pending: 1202, running: false });
});
it("cleans up status and keeps the next tenant runnable when discovery or counts fail", async () => {
  fixture.db.exec("DROP TABLE state_fiber_markets");
  const first = await runDailyMarketRefresh(21);
  expect(first).toMatchObject({ running: false, currentCity: null }); expect(first.lastError).toContain("state_fiber_markets");
  fixture.db.exec("CREATE TABLE state_fiber_markets(city TEXT,state TEXT,auto_scan_eligible INTEGER); DROP TABLE kinetic_addresses");
  const second = await runDailyMarketRefresh(22);
  expect(second.running).toBe(false); expect(second.lastError).toContain("kinetic_addresses");
  expect(() => runDailyMarketRefresh(0)).toThrow("Tenant required");
});
