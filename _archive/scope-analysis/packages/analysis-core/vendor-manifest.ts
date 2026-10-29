// 벤더링 대상 목록 — **코어 리포 기준 상대 경로**다. 이 목록이 핀의 모수이고,
// `scripts/sync-analysis-core.ts`(복사)와 `scripts/check-analysis-core-pin.ts`(검증)가
// 같은 목록을 읽는다.
//
// ── 목록이 손으로 적혀 있는 이유
//
//   "pure 그래프"를 자동 추적하면 코어가 import 를 하나 늘릴 때 벤더 집합이 **조용히**
//   커진다. 그건 lane 이 코어의 어떤 코드를 실행하는지가 리뷰 없이 바뀐다는 뜻이다.
//   목록을 고정하고, 그래프가 목록 밖으로 나가면 **동기화가 실패**하게 만든다
//   (`sync-analysis-core.ts --verify-graph`).
//
// ── 이 목록은 esbuild metafile 로 확정했다 (2026-09-12, 코어 c522cf86)
//
//   진입점 `pure/index.ts` + `citation-classify.ts` + `llm.ts` + 픽스처 빌더를 번들해
//   **값 그래프**를 뽑았다(`--alias:@=.`). 결과 39 모듈 중 `lib/log/*` 13개를 뺀 26개가
//   여기 있다. `lib/log` 는 파일 스필·AsyncLocalStorage·링버퍼를 가진 코어 운영 인프라라
//   lane 이 그대로 돌릴 대상이 아니다 → `shims/log.ts` 로 **alias 매핑**한다(소스 무수정).
//
//   ⚠️ `answer-body.ts` 는 그래프에 **없다**(persist 쪽에서만 쓰인다) — 넣지 않는다.
//   ⚠️ `llm.ts` 는 `pure/` 가 **타입으로만** 참조하지만 lane 은 **값으로** 쓴다
//      (프롬프트 조립·파서가 거기 있다). 그래서 진입점에 포함해 그래프를 뽑았다.

/**
 * 골든 자산이 아닌 벤더 모듈 — 즉 **lane 의 런타임 그래프에 속하는 것**.
 *
 * ⚠️ "전부 실행되는 코드" 라는 뜻은 아니다. `pure/deps.ts` 는 **타입 선언만** 있는 파일이고
 *    (인터페이스 4개 + `import type`), 컴파일 후 방출되는 값이 0 이라 런타임에 실행되지 않는다.
 *    그래도 여기 있어야 하는 이유는 둘이다: ① 핀의 모수여서 코어가 `AnalysisLlmDeps` 를 바꾸면
 *    재동기 없이는 sha256 이 어긋나 CI 가 죽는다(주입 계약의 드리프트 알람) ② 벤더 그래프
 *    검증(`verifyGraph`)이 `pure/analyze-turn.ts:23` → `"./deps"` 간선을 목록 밖 참조로 잡는다
 *    (그 검증은 `import type` 도 일반 import 와 똑같이 센다). 타입 전용이라고 목록에서 빼면
 *    그래프 검증이 그 자리에서 실패한다 — 빼지 마라.
 */
export const RUNTIME_FILES = [
  "lib/brand-grouping/lineage.ts",
  "lib/brand-grouping/types.ts",
  "lib/llm/token-estimate.ts",
  "lib/measurement-analysis/catalog-projection.ts",
  "lib/measurement-analysis/citation-classify.ts",
  "lib/measurement-analysis/compound-brand.ts",
  "lib/measurement-analysis/core.ts",
  "lib/measurement-analysis/industry-context.ts",
  "lib/measurement-analysis/llm.ts",
  "lib/measurement-analysis/normalize.ts",
  "lib/measurement-analysis/offsets.ts",
  "lib/measurement-analysis/pure/analyze-turn.ts",
  "lib/measurement-analysis/pure/deps.ts",
  "lib/measurement-analysis/pure/filters.ts",
  "lib/measurement-analysis/pure/index.ts",
  "lib/measurement-analysis/pure/llm-mention-layer.ts",
  "lib/measurement-analysis/pure/mention-classify.ts",
  "lib/measurement-analysis/pure/resolver-layer.ts",
  "lib/measurement-analysis/pure/rollups.ts",
  // 답변 단위 브랜드 스탠스(WU6 재동기, 코어 6a5e67a9) — 대상 브랜드 선별·결정적 정렬 +
  // 모델 응답 매칭·증거 검증(`matchAndVerifyStances`). `analyze-turn.ts` 와 `pure/index.ts`
  // 가 **다중행 import** 로 참조한다.
  "lib/measurement-analysis/pure/stance-targets.ts",
  "lib/measurement-analysis/pure/surface-identity.ts",
  "lib/measurement-analysis/quality.ts",
  "lib/measurement-analysis/schema.ts",
  "lib/measurement-analysis/surface-match.ts",
  "lib/measurement-analysis/tracked-brand-augment.ts",
  "lib/public-suffix/data.ts",
  "lib/public-suffix/index.ts",
] as const;

/**
 * 골든 게이트 자산 — 코어 `analyze-turn.equivalence.test.ts` 가 쓰는 것과 **같은 파일**이다.
 * 기대 출력(13 JSON)이 lane 쪽에서도 바이트 동일해야 "이식 = 복사"가 증명된다(스펙 §6 A1).
 * 픽스처 빌더는 상대 import(`../llm`·`./analyze-turn`)를 쓰므로 **코어와 같은 자리**에 둔다.
 */
export const GOLDEN_FILES = [
  "lib/measurement-analysis/pure/analyze-turn.fixtures.ts",
  "lib/measurement-analysis/__fixtures__/pure/a-deterministic-only.json",
  "lib/measurement-analysis/__fixtures__/pure/a-deterministic-only-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/b-extract-merge.json",
  "lib/measurement-analysis/__fixtures__/pure/b-extract-merge-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/c-resolver-branches.json",
  "lib/measurement-analysis/__fixtures__/pure/c-resolver-branches-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/d-tracked-augment.json",
  "lib/measurement-analysis/__fixtures__/pure/d-tracked-augment-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/e-semantics-merge.json",
  "lib/measurement-analysis/__fixtures__/pure/e-semantics-merge-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/f-failure-paths.json",
  "lib/measurement-analysis/__fixtures__/pure/f-failure-paths-astral.json",
  "lib/measurement-analysis/__fixtures__/pure/g-invalid-quality.json",
] as const;

export const VENDOR_FILES = [...RUNTIME_FILES, ...GOLDEN_FILES] as const;

/** `@/…` 를 lane 에서 받아 주는 자리. vendor 가 아닌 것은 **둘뿐**이고 둘 다 shim 이다. */
export const SHIMMED_SPECIFIERS = ["@/lib/log", "@/lib/llm/invoke"] as const;
