import Database from 'better-sqlite3';
const db = new Database('/Applications/homefront-fiber-full/data.db', {readonly:true});
db.pragma('cache_size=-65536'); db.pragma('mmap_size=268435456');
// Cost-equivalent read of syncMarketState's fresh_flag correlated subquery (one of 7)
const q = db.prepare(`SELECT COUNT(*) n FROM state_fiber_markets m WHERE EXISTS (
  SELECT 1 FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state
    AND COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) >= datetime('now','-30 days'))`);
let t=performance.now(); q.get(); console.log('syncMarketState ONE of 7 subqueries:', (performance.now()-t).toFixed(0)+'ms');
t=performance.now(); q.get(); console.log('again (warm):', (performance.now()-t).toFixed(0)+'ms');
