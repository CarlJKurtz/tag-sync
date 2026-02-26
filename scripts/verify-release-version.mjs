import fs from "node:fs";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const rawTag = process.argv[2];
if (!rawTag) {
  fail("Missing tag argument. Usage: node scripts/verify-release-version.mjs <tag>");
}

if (rawTag.startsWith("v")) {
  fail(
    `Invalid tag: "${rawTag}". Use plain semantic version tags in x.y.z format (no 'v' prefix).`,
  );
}

if (!/^\d+\.\d+\.\d+$/.test(rawTag)) {
  fail(`Invalid tag: "${rawTag}". Expected semantic version format x.y.z.`);
}
const tagVersion = rawTag;

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");

if (manifest.version !== tagVersion) {
  fail(
    `Version mismatch: manifest.json has "${manifest.version}" but release tag is "${tagVersion}"`,
  );
}

if (pkg.version !== tagVersion) {
  fail(
    `Version mismatch: package.json has "${pkg.version}" but release tag is "${tagVersion}"`,
  );
}

if (!(tagVersion in versions)) {
  fail(`Version mismatch: versions.json does not contain key "${tagVersion}"`);
}

if (versions[tagVersion] !== manifest.minAppVersion) {
  fail(
    `Version mismatch: versions.json["${tagVersion}"] is "${versions[tagVersion]}", expected "${manifest.minAppVersion}"`,
  );
}

console.log(`Release version check passed for ${tagVersion}`);
