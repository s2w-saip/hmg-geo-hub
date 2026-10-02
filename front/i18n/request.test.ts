import { describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import u1ko from "@/messages/units/u1.ko.json";
import u1en from "@/messages/units/u1.en.json";
import { HGH_ERROR_KINDS } from "@/lib/hgh/errors";

// getRequestConfig is an identity wrapper in next-intl; keep it so the default export is callable.
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(fn: T) => fn }));

const { deepMergeMessages, isMissingModuleError, loadMessages, UNIT_MESSAGE_FILES } = await import("./request");
const requestConfig = (await import("./request")).default as unknown as (p: {
  requestLocale: Promise<string | undefined>;
}) => Promise<{ locale: string; messages: Record<string, unknown>; timeZone: string }>;

type Tree = { [k: string]: unknown };
function leaves(tree: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    out.set(prefix, tree);
    return out;
  }
  for (const [k, v] of Object.entries(tree as Tree)) {
    for (const [p, leaf] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, leaf);
  }
  return out;
}

describe("deepMergeMessages", () => {
  it("merges objects recursively, replaces leaves and arrays, never mutates inputs", () => {
    const base = { a: { b: "1", c: "2" }, list: ["x"], keep: "k" };
    const overlay = { a: { c: "3", d: "4" }, list: ["y", "z"], extra: { e: "5" } };
    const snapshot = JSON.stringify(base);
    expect(deepMergeMessages(base, overlay)).toEqual({ a: { b: "1", c: "3", d: "4" }, list: ["y", "z"], keep: "k", extra: { e: "5" } });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(overlay.a).toEqual({ c: "3", d: "4" });
  });
});

describe("unit message files", () => {
  it.each([
    ["ko", ko],
    ["en", en],
  ])("%s: every existing message is unchanged after the merge", async (locale, base) => {
    const merged = leaves(await loadMessages(locale));
    const original = leaves(base);
    expect(original.size).toBeGreaterThan(1000);
    for (const [path, value] of original) {
      if (merged.get(path) !== value) throw new Error(`${locale}: ${path} changed`);
    }
  });

  it("u1 only adds keys (no existing key is overridden) and loads through the merge", async () => {
    for (const [base, unit, locale] of [
      [ko, u1ko, "ko"],
      [en, u1en, "en"],
    ] as const) {
      const existing = leaves(base);
      for (const path of leaves(unit).keys()) expect(existing.has(path), `${locale}:${path}`).toBe(false);
      const merged = leaves(await loadMessages(locale));
      for (const [path, value] of leaves(unit)) expect(merged.get(path)).toBe(value);
    }
  });

  it("u1 ko/en have the same keys and cover every API error kind", () => {
    expect([...leaves(u1ko).keys()].sort()).toEqual([...leaves(u1en).keys()].sort());
    for (const kind of HGH_ERROR_KINDS) {
      expect(typeof (u1ko.apiError as Tree)[kind], kind).toBe("string");
      expect(typeof (u1en.apiError as Tree)[kind], kind).toBe("string");
    }
  });

  it("unit list is u1..u12; absent files are skipped, broken ones are not", () => {
    expect(UNIT_MESSAGE_FILES).toEqual(Array.from({ length: 12 }, (_, i) => `u${i + 1}`));
    expect(isMissingModuleError(Object.assign(new Error("Cannot find module './u3.ko.json'"), { code: "MODULE_NOT_FOUND" }))).toBe(true);
    expect(isMissingModuleError(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }))).toBe(true);
    expect(isMissingModuleError(new Error("Unknown variable dynamic import: ../messages/units/u3.ko.json"))).toBe(true);
    expect(isMissingModuleError(new SyntaxError("Unexpected token } in JSON at position 10"))).toBe(false);
  });
});

describe("request config", () => {
  it("resolves the locale and serves merged messages; unknown locale -> ko", async () => {
    const en1 = await requestConfig({ requestLocale: Promise.resolve("en") });
    expect(en1.locale).toBe("en");
    expect((en1.messages.apiError as Tree).session).toBe(u1en.apiError.session);
    expect((en1.messages.dashError as Tree).title).toBe(en.dashError.title);
    expect(en1.timeZone).toBe("Asia/Seoul");
    const fallback = await requestConfig({ requestLocale: Promise.resolve("fr") });
    expect(fallback.locale).toBe("ko");
    expect((fallback.messages.apiError as Tree).session).toBe(u1ko.apiError.session);
  });
});
