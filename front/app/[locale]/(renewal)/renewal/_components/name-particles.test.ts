import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";

// A brand or model name in a renewal finding takes no fixed Korean particle after it: '와 · 가 · 은' do not follow every
// name ('Audio System와', 'Škoda Octavia은'); renewal audit step 16, last review 2026-11-02 (F5).

const NAME = /\{(brand|rival|ref|own|worst|model)\}(와|과|가|이|은|는|을|를)(?![가-힣])/;

function strings(o: unknown, path: string[] = []): [string, string][] {
  if (typeof o === "string") return [[path.join("."), o]];
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
}

describe("renewal findings put no fixed particle after a name", () => {
  for (const ns of ["acr", "mention"] as const) {
    it(`renewal.${ns}`, () => {
      expect(strings(ko.renewal[ns], ["renewal", ns]).filter(([, s]) => NAME.test(s)).map(([p]) => p)).toEqual([]);
    });
  }
});
