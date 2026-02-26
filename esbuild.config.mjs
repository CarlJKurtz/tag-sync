import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const isProduction = process.argv[2] === "production";
const buildTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const productionOutDir = path.join("build", buildTimestamp, "tag-sync");

const context = await esbuild.context({
  banner: {
    js: "/* Bundled by esbuild for Obsidian */",
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language"],
  format: "cjs",
  target: "es2018",
  sourcemap: !isProduction,
  treeShaking: true,
  outfile: isProduction ? path.join(productionOutDir, "main.js") : "main.js",
  logLevel: "info",
});

if (isProduction) {
  await context.rebuild();
  await mkdir(productionOutDir, { recursive: true });
  await copyFile("manifest.json", path.join(productionOutDir, "manifest.json"));
  await copyFile("versions.json", path.join(productionOutDir, "versions.json"));
  process.exit(0);
}

await context.watch();
