import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "jsonwebtoken",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "stripe",
  "xlsx",
  "zod",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  await stampServiceWorker();
  await precompressStatics();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    sourcemap: false, // hardening: never emit server source maps
    external: externals,
    logLevel: "info",
  });

  // ── Maintenance entry points ────────────────────────────────────────────
  // One-off operational scripts, bundled the same way the server is so they can
  // RUN IN PRODUCTION. The runtime image is `npm ci --omit=dev` and copies only
  // dist/ and deploy/ — script/ never ships and tsx is a devDependency, so
  // `npx tsx script/<x>.ts` on the box cannot work. Bundling them here is what
  // makes `node dist/<x>.cjs` possible inside the running image, against the
  // real /data volume, with no toolchain on the host and no SSH key in anyone's
  // hands (see .github/workflows/reset-areas.yml).
  console.log("building maintenance scripts...");
  for (const entry of ["reset-areas"]) {
    await esbuild({
      entryPoints: [`script/${entry}.ts`],
      platform: "node",
      bundle: true,
      format: "cjs",
      outfile: `dist/${entry}.cjs`,
      define: { "process.env.NODE_ENV": '"production"' },
      // NOT minified: an operator reading a destructive script's stack trace at
      // 9pm should get real function names.
      minify: false,
      sourcemap: false,
      external: externals,
      logLevel: "info",
    });
  }

  // Belt-and-braces hardening: delete any stray source maps from dist.
  // Neither Vite nor esbuild is configured to emit them, but a plugin or
  // config drift could reintroduce them — sweep so prod never ships one.
  const strayMaps = await findMapFiles("dist");
  for (const f of strayMaps) {
    await rm(f, { force: true });
    console.warn(`removed stray source map: ${f}`);
  }
  if (strayMaps.length === 0) console.log("no source maps in dist ✓");

  // Copy GIS address data to dist so server can read it at runtime
  try {
    await copyFile(
      "server/rockwell_gis_addresses.json",
      "dist/rockwell_gis_addresses.json"
    );
    console.log("copied GIS addresses to dist/");
  } catch (e) {
    console.warn("Could not copy GIS addresses:", e);
  }


  // Copy join form directory to dist
  try {
    const { mkdir, copyFile: cp } = await import("fs/promises");
    await mkdir("dist/join-form", { recursive: true });
    await cp("join-form/index.html", "dist/join-form/index.html");
    console.log("copied join form to dist/join-form/");
  } catch (e) {
    console.warn("Could not copy join form:", e);
  }

  // Copy the vendored IRS W-9 template (PAY-A2) so the prod bundle can fill it.
  // FATAL on failure: without this asset every W-9 submission 500s in
  // production, and a build that exits 0 hides it until a rep tries to onboard.
  {
    const { mkdir, copyFile: cp } = await import("fs/promises");
    await mkdir("dist/assets", { recursive: true });
    await cp("server/assets/fw9.pdf", "dist/assets/fw9.pdf");
    // Integrity-pin the copy too — the server refuses any other revision, so a
    // corrupt/substituted asset must break the BUILD, not the first signer.
    const { createHash } = await import("node:crypto");
    const expected = (await readFile("server/w9Pdf.ts", "utf-8")).match(/W9_TEMPLATE_SHA256 = "([0-9a-f]{64})"/)?.[1];
    if (!expected) throw new Error("build: could not read W9_TEMPLATE_SHA256 from server/w9Pdf.ts");
    const actual = createHash("sha256").update(await readFile("dist/assets/fw9.pdf")).digest("hex");
    if (actual !== expected) {
      throw new Error(`build: dist/assets/fw9.pdf sha256 ${actual} does not match the pinned Form W-9 (Rev. 3-2024) hash ${expected}`);
    }
    console.log("copied W-9 template to dist/assets/ (sha256 verified)");
  }
}

// ── Service-worker versioning ────────────────────────────────────────────────
// A browser decides a service worker is NEW by byte-comparing sw.js. The file
// is copied verbatim out of client/public, so with a hardcoded version literal
// every deploy shipped identical bytes: `updatefound` never fired and the
// update prompt in client/src/lib/pwa.ts was dead code. Stamping a digest of
// the build's own asset filenames makes sw.js change exactly when the app
// changes — and not when it doesn't, so an unchanged rebuild won't nag reps to
// reload for nothing.
async function stampServiceWorker() {
  const swPath = path.resolve("dist/public/sw.js");
  let source: string;
  try {
    source = await readFile(swPath, "utf-8");
  } catch {
    throw new Error(`build: dist/public/sw.js is missing — the PWA shell would ship unversioned`);
  }
  if (!source.includes("__SW_BUILD__")) {
    throw new Error("build: dist/public/sw.js has no __SW_BUILD__ token to stamp");
  }
  // Asset filenames are content hashes, so the sorted list is a faithful,
  // reproducible fingerprint of the whole client build.
  const assets = (await readdir(path.resolve("dist/public/assets")).catch(() => [])).sort();
  const digest = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
  await writeFile(swPath, source.replaceAll("__SW_BUILD__", digest), "utf-8");
  console.log(`stamped service worker version: ${digest}`);
}

// ── Precompressed static assets ──────────────────────────────────────────────
// The app gzipped every response on the fly (server/index.ts compression
// middleware), which cost CPU per request AND capped quality at gzip level 6.
// It also made Caddy's `encode zstd gzip` a no-op, because a proxy will not
// re-encode a response that already carries Content-Encoding.
//
// Compressing once here, at brotli quality 11, is strictly better: the bytes
// are smaller than anything an online compressor can afford (measured on this
// build: entry JS 108.5 KB gzip -> 93.8 KB brotli, CSS 26.5 -> 21.0), the
// server just streams a file, and nothing burns CPU per request. A .gz sibling
// is written for the rare client that does not advertise br.
async function precompressStatics() {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const brotli = promisify(zlib.brotliCompress);
  const gzip = promisify(zlib.gzip);

  // index.html is deliberately absent: it is small, it is served by the SPA
  // fallback as well as by express.static, and letting the compression
  // middleware handle it keeps both paths on one code path.
  const COMPRESSIBLE = /\.(js|css|svg|json|webmanifest|txt)$/;
  const MIN_BYTES = 1024; // below this, the header overhead is most of the file

  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (COMPRESSIBLE.test(entry.name)) files.push(full);
    }
  };
  await walk(path.resolve("dist/public"));

  let saved = 0;
  let count = 0;
  for (const file of files) {
    const raw = await readFile(file);
    if (raw.byteLength < MIN_BYTES) continue;
    const br = await brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    });
    const gz = await gzip(raw, { level: 9 });
    await writeFile(`${file}.br`, br);
    await writeFile(`${file}.gz`, gz);
    saved += raw.byteLength - br.byteLength;
    count += 1;
  }
  console.log(`precompressed ${count} assets (br+gz), ${(saved / 1024).toFixed(0)} KB saved on the wire`);
}

async function findMapFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findMapFiles(full)));
    else if (entry.name.endsWith(".map")) out.push(full);
  }
  return out;
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
