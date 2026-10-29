import { describe, expect, it } from "vitest";
import { canonicalizeResolvedMentions, occurrenceRowsFor } from "./sync";
import type { ResolvedMention } from "@/lib/scope/types";

// 발생 배열 → 미러 행 매핑 계약. 지키는 것:
//  ① occurrences 가 없으면 행 0 (과거 회차·include 미지정 응답).
//  ② 있으면 1:1 로 행이 나오고 entity/brand rollup 이 부모 멘션에서 온다.
//  ③ descriptors/criteria 가 배열이 아니면 빈 배열(jsonb 방어).
const base: ResolvedMention = {
  entity_id: "e-genesis",
  entity_type: "Brand",
  display_name: "Genesis",
  rollups: { product_entity_id: null, brand_entity_id: "e-genesis", company_entity_id: null },
  surfaces: ["Genesis"],
  mention_count: 1,
};

describe("occurrenceRowsFor", () => {
  it("occurrences 가 없으면 빈 배열", () => {
    expect(occurrenceRowsFor("job-1", base)).toEqual([]);
  });

  it("발생마다 행 하나, rollup 은 부모에서", () => {
    const rows = occurrenceRowsFor("job-1", {
      ...base,
      occurrences: [
        {
          source_start: 2, source_end: 9, surface_text: "Genesis", sentiment: "positive",
          mention_role: "primary", assertion: "recommend", context_snippet: "Genesis 는 좋다",
          descriptors: ["정숙성"], criteria: [], turn_index: 1,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId: "job-1", entityId: "e-genesis", brandRollupEntityId: "e-genesis",
      sourceStart: 2, sourceEnd: 9, sentiment: "positive", assertion: "recommend",
      descriptors: ["정숙성"], criteria: [], turnIndex: 1,
    });
  });

  it("descriptors/criteria 가 배열이 아니면 빈 배열", () => {
    const rows = occurrenceRowsFor("job-1", {
      ...base,
      occurrences: [{
        source_start: 0, source_end: 1, surface_text: "G", sentiment: "neutral",
        mention_role: null, assertion: null, context_snippet: null,
        descriptors: "x" as unknown as string[], criteria: null as unknown as string[], turn_index: null,
      }],
    });
    expect(rows[0]!.descriptors).toEqual([]);
    expect(rows[0]!.criteria).toEqual([]);
  });
});

// canonical 접힘에서 발생 배열이 살아남는가(리뷰 I1). "Genesis"/"제네시스" 처럼 서로
// 다른 entity_id 가 같은 canonical 로 접히면 mergeMentionBucket 이 도는데, 여기서
// occurrences 를 안 이어 붙이면 **뒤 엔티티의 발생이 미러에 영원히 도달하지 않는다**
// — 밑줄도 캡션도 안 나오고, 화면에서는 "감성이 원래 없는 답변"으로 보인다.
describe("canonicalizeResolvedMentions — 접힌 멘션의 occurrences 보존", () => {
  const canonicalizer = {
    canonicalizeBrand(m: { entity_type: string | null; display_name: string | null }) {
      return m.display_name === "제네시스" ? { ...m, display_name: "Genesis" } : m;
    },
    canonicalizeProduct(m: unknown) {
      return m;
    },
  };
  const occ = (start: number, surface: string) => ({
    source_start: start, source_end: start + surface.length, surface_text: surface,
    sentiment: "positive", mention_role: null, assertion: null, context_snippet: null,
    descriptors: [], criteria: [], turn_index: null,
  });

  it("두 별칭 멘션이 하나로 접혀도 양쪽 발생이 모두 남는다", () => {
    const rows = canonicalizeResolvedMentions(
      [
        {
          entity_id: "b1", entity_type: "Brand", display_name: "Genesis",
          rollups: { product_entity_id: null, brand_entity_id: "b1", company_entity_id: null },
          surfaces: ["Genesis"], mention_count: 1, occurrences: [occ(0, "Genesis")],
        },
        {
          entity_id: "b2", entity_type: "Brand", display_name: "제네시스",
          rollups: { product_entity_id: null, brand_entity_id: "b1", company_entity_id: null },
          surfaces: ["제네시스"], mention_count: 1, occurrences: [occ(40, "제네시스")],
        },
      ] as unknown as Parameters<typeof canonicalizeResolvedMentions>[0],
      canonicalizer as unknown as Parameters<typeof canonicalizeResolvedMentions>[1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toHaveLength(2);
    expect(rows[0]!.occurrences!.map((o) => o.surface_text)).toEqual(["Genesis", "제네시스"]);
    // 미러 행까지 내려가도 둘 다 나오고, entity/rollup 은 살아남은 부모 것을 쓴다.
    const mirrored = occurrenceRowsFor("job-1", rows[0]!);
    expect(mirrored).toHaveLength(2);
    expect(mirrored.every((r) => r.entityId === "b1")).toBe(true);
  });
});
