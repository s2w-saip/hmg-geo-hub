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
if (!changed.length) console.log(`${manifest.files.length} original source files match the preparation baseline.`);
else {
  console.log("Review upstream changes before connecting the React project:");
  changed.forEach(entry => console.log(`  ${entry.source}`));
  process.exitCode = 1;
}
