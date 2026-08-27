// Compile the vendored anti-slop plugin so Oxlint can load it on Node 20.
//
// WHY THIS EXISTS. Oxlint loads a JS plugin through Node's own ESM loader, and
// the plugin is authored in TypeScript. Native type stripping is not in Node 20
// (it arrives in 22.6 behind a flag), so `import("./index.ts")` fails with
// ERR_UNKNOWN_FILE_EXTENSION. Oxlint's own version check is optimistic here: it
// advertises `^20.19.0` and then hands the file straight to the loader anyway.
//
// This whole project is Node 20 — Dockerfile build stage, Dockerfile runtime,
// CI's setup-node, and local. Raising that to satisfy a linter would change the
// production runtime, which is not a trade a lint change gets to make. So the
// plugin is compiled instead.
//
// The .ts files stay the editable truth. That is the point of vendoring: the
// rules are ours to read and change. This emits a single bundled .mjs beside
// them, gitignored, rebuilt by `npm run lint` so it can never go stale against
// an edited rule.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "anti-slop/index.ts");
const outfile = path.join(here, "anti-slop/index.mjs");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Oxlint supplies this at load time; bundling a second copy would give the
  // plugin a different `definePlugin` identity than the linter is expecting.
  external: ["@oxlint/plugins"],
  logLevel: "warning",
});

console.log(`built ${path.relative(process.cwd(), outfile)}`);
