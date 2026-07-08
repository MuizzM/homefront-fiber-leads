import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, copyFile, mkdir } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

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
    external: externals,
    logLevel: "info",
  });

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
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
