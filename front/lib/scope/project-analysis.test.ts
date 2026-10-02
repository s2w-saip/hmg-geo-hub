import { describe, it, expect } from "vitest";
import { MockScopeClient } from "./mock";
import {
  aggregateMentionsFromPublic,
  aggregateCitationsFromPublic,
} from "./result-adapter";

// Per-project answer analysis reads scope's PUBLIC, project-scoped surface
// (/projects/{id}/brand-mentions, /projects/{id}/citations) — NOT the internal
// /results·/measurements feeds. These tests drive the adapters with the rows the
// MockScopeClient returns, proving the public path yields non-empty mention +
// citation views for any project id.
describe("per-project answer analysis (public surface)", () => {
  const client = new MockScopeClient();
  const projectId = "proj-test-1";

  it("brand-mentions rows → MentionsLive with brands + per-prompt drilldown", async () => {
    const rows = (await client.listBrandMentions(projectId)).data;
    const m = aggregateMentionsFromPublic(rows);
    expect(m).not.toBeNull();
    const brands = m!.brands.map((b) => b.brand);
    expect(brands).toContain("Hyundai");
    expect(brands).toContain("Kia");
    expect(m!.brands.find((b) => b.brand === "Hyundai")?.isTracked).toBe(true);
    expect(m!.summary.total).toBeGreaterThan(0);
    // per-prompt drilldown reconstructs from prompt_id/prompt_text
    expect(Object.keys(m!.perBrandPrompts)).toContain("Hyundai");
    const firstAnswer = m!.perBrandPrompts["Hyundai"][0].answers[0];
    expect(firstAnswer).toBeDefined();
    // A-3: answer ref carries the brand's mention position (from mention_position)
    expect(typeof firstAnswer.position).toBe("number");
  });

  it("citation rows → CitationsLive domains + category (flat, no /results)", async () => {
    const rows = (await client.listCitations(projectId)).data;
    const c = aggregateCitationsFromPublic(rows);
    expect(c).not.toBeNull();
    const domains = c!.domains.map((d) => d.domain);
    expect(domains).toContain("hyundai.com");
    expect(domains).toContain("motorgraph.com");
    expect(c!.domains.find((d) => d.domain === "hyundai.com")?.category).toBe("Official (HMG)");
    expect(c!.summary.total).toBeGreaterThan(0);
  });

  it("region filter narrows mention rows", async () => {
    const rows = (await client.listBrandMentions(projectId)).data;
    const us = aggregateMentionsFromPublic(rows, { region: ["US"] });
    const kr = aggregateMentionsFromPublic(rows, { region: ["KR"] });
    // synthetic data: p3(US) only Hyundai/Genesis; KR has Kia/Toyota/Tesla too
    expect(us!.brands.map((b) => b.brand)).not.toContain("Toyota");
    expect(kr!.brands.map((b) => b.brand)).toContain("Toyota");
  });

  it("empty rows → null (EmptyState)", () => {
    expect(aggregateMentionsFromPublic([])).toBeNull();
    expect(aggregateCitationsFromPublic([])).toBeNull();
  });

  it("deterministic across calls", async () => {
    const a = aggregateMentionsFromPublic((await client.listBrandMentions(projectId)).data);
    const b = aggregateMentionsFromPublic((await client.listBrandMentions(projectId)).data);
    expect(a!.summary.total).toBe(b!.summary.total);
  });
});
