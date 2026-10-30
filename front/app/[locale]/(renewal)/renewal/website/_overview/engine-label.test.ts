import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceText } from "@/test/source-text";

// The Website Overview page is a server component: its 핵심 요약 names the engines itself (website-findings.ts). A
// function taken from a "use client" module is only a client reference there and throws when the page calls it
// (2026-10-31, renewal audit step 2: the page failed for every account once the engine rows had two engines).

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONT = resolve(HERE, "../../../../../..");
const PAGE = resolve(HERE, "../page.tsx");

const moduleFile = (spec: string, from: string): string => {
  const base = spec.startsWith("@/") ? resolve(FRONT, spec.slice(2)) : resolve(dirname(from), spec);
  const file = [".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((f) => existsSync(f));
  if (!file) throw new Error(`cannot resolve ${spec}`);
  return file;
};
const isClient = (file: string) => /^\s*["']use client["']/.test(readSourceText(file));

describe("Website Overview engine labels", () => {
  it("the page names engines with a function of a server-safe module", () => {
    const page = readSourceText(PAGE);
    const spec = page.match(/import\s*{[^}]*\bengineLabel\b[^}]*}\s*from\s*"([^"]+)"/)?.[1];
    expect(spec).toBeDefined();
    const file = moduleFile(spec!, PAGE);
    expect(isClient(file), `${spec} is a "use client" module`).toBe(false);
    // and what it reads its names from is not one either
    for (const m of readSourceText(file).matchAll(/from\s*"([^"]+)"/g)) expect(isClient(moduleFile(m[1], file)), m[1]).toBe(false);
  });

  it("names the engines as the filter panel does", async () => {
    const { engineLabel } = await import("./engine-label");
    expect(["chatgpt", "gemini", "deepseek", "claude-web", "other"].map(engineLabel)).toEqual(["ChatGPT", "Gemini", "DeepSeek", "Claude", "other"]);
  });
});
