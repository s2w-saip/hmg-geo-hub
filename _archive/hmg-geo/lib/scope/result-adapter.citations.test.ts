import { describe, it, expect } from "vitest";
import { aggregateCitationsFrom, type StandardFilters } from "./result-adapter";
import type { MeasurementJob, QueryRunView } from "./types";
import { categorizeDomain } from "@/lib/citation-categorizer";

// Pins the local citation-source classification wiring: scope sends NO
// citation category (mirror rows carry null — confirmed 2026-07-02), so the
// aggregation must classify domains via lib/citation-categorizer at rollup
// time. This drives the exact pure function the scope_* mirror path calls
// (aggregateCitationsFromMirror → aggregateCitationsFrom).

const jobs: MeasurementJob[] = [
  {
    job_id: "j1",
    prompt_id: "p1",
    target: "openai",
    region: "IT",
    status: "completed",
    measured_at: "2026-07-01T00:00:00Z",
  },
];
const promptMap = new Map([["p1", { text: "best ev 2026", funnel: null }]]);

function run(
  citations: NonNullable<QueryRunView["result"]>["citations"],
  filters: StandardFilters = {},
) {
  const results: QueryRunView[] = [
    {
      job_id: "j1",
      target: "openai",
      status: "completed",
      result: { answer_text: "", measured_at: "", citations },
    },
  ];
  return aggregateCitationsFrom(jobs, promptMap, results, filters);
}

describe("mirror-path citation categories (null category → local classifier)", () => {
  it("classifies owned / seed / rule / fallback domains and fills the pie", () => {
    const c = run([
      { url: "https://www.kia.com/it/", host: "kia.com" },
      { url: "https://www.caranddriver.com/reviews/x", host: "caranddriver.com" },
      { url: "https://kiaofstreetsboro.com/inventory", host: "kiaofstreetsboro.com" },
      { url: "https://some-unknown-site.io/a", host: "some-unknown-site.io" },
    ]);
    expect(c).not.toBeNull();
    const byDomain = new Map(c!.domains.map((d) => [d.domain, d.category]));
    expect(byDomain.get("kia.com")).toBe("Official (HMG)");
    expect(byDomain.get("caranddriver.com")).toBe("Automotive Media");
    expect(byDomain.get("kiaofstreetsboro.com")).toBe("Dealer & Marketplace");
    expect(byDomain.get("some-unknown-site.io")).toBe("Other");
    // Category pie is populated (previously null → PendingCard).
    const slices = new Map(c!.categories!.map((s) => [s.name, s.value]));
    expect(slices.get("Official (HMG)")).toBe(1);
    expect(slices.get("Automotive Media")).toBe(1);
    expect(slices.get("Dealer & Marketplace")).toBe(1);
    expect(slices.get("Other")).toBe(1);
  });

  // 저장된 category 는 **택소노미 안일 때만** 로컬 분류를 이긴다 (2026-09-04).
  it("a scope-provided category still wins over the local classifier", () => {
    const c = run([
      { url: "https://www.kia.com/it/", host: "kia.com", category: "News & Media" },
    ]);
    expect(c!.domains[0].category).toBe("News & Media");
    expect(c!.categories![0].name).toBe("News & Media");
  });

  it("택소노미 밖 category 는 버려지고 로컬 분류가 쓰인다", () => {
    const c = run([
      { url: "https://www.kia.com/it/", host: "kia.com", category: "브랜드 자산" },
    ]);
    expect(c!.domains[0].category).not.toBe("브랜드 자산");
    expect(c!.domains[0].category).toBe(categorizeDomain("kia.com"));
  });

  it("sourceCategory filter narrows every rollup (totals, domains, pie)", () => {
    const rows = [
      { url: "https://www.kia.com/it/", host: "kia.com" },
      { url: "https://www.caranddriver.com/reviews/x", host: "caranddriver.com" },
      { url: "https://kiaofstreetsboro.com/inventory", host: "kiaofstreetsboro.com" },
    ];
    const c = run(rows, { sourceCategory: ["Automotive Media"] });
    expect(c).not.toBeNull();
    expect(c!.summary.total).toBe(1);
    expect(c!.domains.map((d) => d.domain)).toEqual(["caranddriver.com"]);
    expect(c!.categories!.map((s) => s.name)).toEqual(["Automotive Media"]);
    // Narrowing to zero keeps the empty-but-non-null shape (filter panel stays).
    const empty = run(rows, { sourceCategory: ["Government & Public"] });
    expect(empty).not.toBeNull();
    expect(empty!.summary.total).toBe(0);
  });

  it("rolls up per-engine category composition", () => {
    const c = run([
      { url: "https://www.kia.com/it/", host: "kia.com" },
      { url: "https://www.caranddriver.com/reviews/x", host: "caranddriver.com" },
    ]);
    expect(c!.engineCategories).not.toBeNull();
    const eng = c!.engineCategories![0];
    expect(eng.total).toBe(2);
    expect(eng.byCategory["Official (HMG)"]).toBe(1);
    expect(eng.byCategory["Automotive Media"]).toBe(1);
  });
});
