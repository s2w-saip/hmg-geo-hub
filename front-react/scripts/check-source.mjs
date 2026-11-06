import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = path.resolve(project, "../front");
const manifest = JSON.parse(fs.readFileSync(path.join(project, "source-manifest.json"), "utf8"));
if (!fs.existsSync(upstream)) {
  console.log("Next source is not present. React remains independently buildable; source comparison is skipped.");
  process.exit(0);
}
const changed = manifest.files.filter(entry => {
  const p = path.join(upstream, entry.source);
  return !fs.existsSync(p) || crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== entry.sha256;
});
// A fixed hash list cannot discover new routes. Walk the original renewal route tree as well.
const known = new Set(manifest.files.map(entry => entry.source));
function pages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return pages(file);
    return entry.isFile() && /^page\.[jt]sx?$/.test(entry.name) ? [path.relative(upstream, file).split(path.sep).join("/")] : [];
  });
}
const added = pages(path.join(upstream, "app/[locale]/(renewal)")).filter(file => !known.has(file));
if (!changed.length && !added.length) console.log(`${manifest.files.length} original source files match the preparation baseline; no new renewal pages.`);
else {
  console.log("Review upstream changes before connecting the React project:");
  changed.forEach(entry => console.log(`  ${entry.source}`));
  added.forEach(file => console.log(`  + ${file}`));
  process.exitCode = 1;
}
