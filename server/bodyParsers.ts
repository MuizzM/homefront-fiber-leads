import express from "express";

// ── Route-scoped body parsers ────────────────────────────────────────────────
// Lives in its own module so a route file can import it without importing
// server/index.ts (which imports the route files — a cycle).
//
// Admin address-dataset uploads (CSV/GeoJSON) are the one surface allowed past
// the global 64 KB API limit. The parser is deliberately NOT mounted with
// app.use: an app-level mount runs during middleware traversal, before any
// route handler and therefore before that route's capability check, so an
// anonymous POST had its 10 MB body buffered and synchronously JSON.parse'd
// before the server ever answered 401. better-sqlite3 makes this a
// single-threaded process, so that parse stalls the event loop for every rep on
// the box — and the global bucket permitted 1200 such requests per IP per 15
// minutes. Passed into the route instead, positioned AFTER requireCapability.
export const discoveryUploadBodyParser = express.json({
  limit: Math.max(
    64 * 1024,
    Math.min(10 * 1024 * 1024, Number(process.env.DISCOVERY_UPLOAD_MAX_BYTES) || 10 * 1024 * 1024),
  ),
  verify: (req, _res, buf) => { req.rawBody = buf; },
});
