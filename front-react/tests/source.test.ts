import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function sourceFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "react-source-check-"));
  fixtures.push(dir);
  const react = path.join(dir, "front-react");
  const front = path.join(dir, "front");
  const tracked = "app/[locale]/(renewal)/renewal/dashboard/page.tsx";
  const source = "export default function Page() { return null; }\n";
  mkdirSync(path.join(react, "scripts"), { recursive: true });
  mkdirSync(path.dirname(path.join(front, tracked)), { recursive: true });
  writeFileSync(path.join(front, tracked), source);
  writeFileSync(path.join(react, "source-manifest.json"), JSON.stringify({ files: [{ source: tracked, sha256: createHash("sha256").update(source).digest("hex") }] }));
  copyFileSync(new URL("../scripts/check-source.mjs", import.meta.url), path.join(react, "scripts/check-source.mjs"));
  return { front, check: () => spawnSync(process.execPath, [path.join(react, "scripts/check-source.mjs")], { encoding: "utf8" }) };
}
it("reports a new renewal page instead of passing the old manifest", () => {
  const { front, check } = sourceFixture();
  expect(check().status).toBe(0);
  const added = "app/[locale]/(renewal)/renewal/new-analysis/page.tsx";
  mkdirSync(path.dirname(path.join(front, added)), { recursive: true });
  writeFileSync(path.join(front, added), "export default function NewPage() { return null; }");
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(added);
});
it("continues to report changes and deletions of tracked source", () => {
  const { front, check } = sourceFixture();
  const tracked = "app/[locale]/(renewal)/renewal/dashboard/page.tsx";
  writeFileSync(path.join(front, tracked), "changed");
  expect(check().status).toBe(1);
  rmSync(path.join(front, tracked));
  expect(check().status).toBe(1);
});
