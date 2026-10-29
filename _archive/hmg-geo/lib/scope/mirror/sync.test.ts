import { describe, expect, it } from "vitest";
import {
  canonicalizeResolvedMentions,
  MIRROR_JOB_MAX_PAGES,
  MIRROR_RUN_MAX_PAGES,
  mergeRotationKeys,
  orderSyncTargets,
  shouldSkipResyncedRun,
} from "./sync";
import { PROMPT_MAX_PAGES } from "../paging";

describe("canonicalizeResolvedMentions", () => {
  const canonicalizer = {
    canonicalizeBrand(mention: {
      entity_type: string | null;
      display_name: string | null;
    }) {
      if (mention.entity_type === "Brand") {
        if (mention.display_name === "테슬라") {
          return { ...mention, display_name: "Tesla" };
        }
      }
      if (mention.entity_type === "Product") {
        if (mention.display_name === "투싼" || mention.display_name === "Toucan") {
          return { ...mention, display_name: "Tucson" };
        }
      }
      return mention;
    },
    canonicalizeProduct(mention: {
      entity_type: string | null;
      display_name: string | null;
    }) {
      if (mention.entity_type === "Product") {
        if (mention.display_name === "투싼" || mention.display_name === "Toucan") {
          return { ...mention, display_name: "Tucson" };
        }
      }
      return mention;
    },
  };

  it("merges alias mentions into one canonical brand/model row", () => {
    const rows = canonicalizeResolvedMentions(
      [
        {
          entity_id: "b1",
          entity_type: "Brand",
          display_name: "Tesla",
          rollups: { product_entity_id: null, brand_entity_id: "b1", company_entity_id: null },
          surfaces: ["Tesla"],
          mention_count: 1,
          sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 },
          avg_position: 4,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "b2",
          entity_type: "Brand",
          display_name: "테슬라",
          rollups: { product_entity_id: null, brand_entity_id: "b2", company_entity_id: null },
          surfaces: ["테슬라"],
          mention_count: 2,
          sentiment: { positive: 0, neutral: 1, negative: 1, mixed: 0 },
          avg_position: 2,
          type_breakdown: { mention: 1, recommendation: 1, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "p1",
          entity_type: "Product",
          display_name: "Tucson",
          rollups: { product_entity_id: "p1", brand_entity_id: "hb1", company_entity_id: null },
          surfaces: ["Tucson"],
          mention_count: 1,
          sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 },
          avg_position: 5,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "p2",
          entity_type: "Product",
          display_name: "Toucan",
          rollups: { product_entity_id: "p2", brand_entity_id: "hb1", company_entity_id: null },
          surfaces: ["Toucan", "투싼"],
          mention_count: 2,
          sentiment: { positive: 0, neutral: 2, negative: 0, mixed: 0 },
          avg_position: 3,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 1, definition: 0, final_choice: 0 },
        },
      ],
      canonicalizer as never,
    );

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          display_name: "Tesla",
          mention_count: 3,
          avg_position: 2,
          surfaces: ["Tesla", "테슬라"],
          sentiment: { positive: 1, neutral: 1, negative: 1, mixed: 0 },
        }),
        expect.objectContaining({
          display_name: "Tucson",
          mention_count: 3,
          avg_position: 3,
          surfaces: ["Tucson", "Toucan", "투싼"],
          sentiment: { positive: 1, neutral: 2, negative: 0, mixed: 0 },
        }),
      ]),
    );
  });

  it("does not merge same alias models across different brands", () => {
    const rows = canonicalizeResolvedMentions(
      [
        {
          entity_id: "b1",
          entity_type: "Brand",
          display_name: "Hyundai",
          rollups: { product_entity_id: null, brand_entity_id: "hb1", company_entity_id: null },
          surfaces: ["Hyundai"],
          mention_count: 1,
          sentiment: { positive: 0, neutral: 1, negative: 0, mixed: 0 },
          avg_position: 1,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "b2",
          entity_type: "Brand",
          display_name: "Kia",
          rollups: { product_entity_id: null, brand_entity_id: "kb1", company_entity_id: null },
          surfaces: ["Kia"],
          mention_count: 1,
          sentiment: { positive: 0, neutral: 1, negative: 0, mixed: 0 },
          avg_position: 1,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "p1",
          entity_type: "Product",
          display_name: "EV3",
          rollups: { product_entity_id: "p1", brand_entity_id: "hb1", company_entity_id: null },
          surfaces: ["EV3"],
          mention_count: 1,
          sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 },
          avg_position: 2,
          type_breakdown: { mention: 1, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
        },
        {
          entity_id: "p2",
          entity_type: "Product",
          display_name: "EV3",
          rollups: { product_entity_id: "p2", brand_entity_id: "kb1", company_entity_id: null },
          surfaces: ["EV3"],
          mention_count: 2,
          sentiment: { positive: 0, neutral: 2, negative: 0, mixed: 0 },
          avg_position: 3,
          type_breakdown: { mention: 1, recommendation: 1, comparison: 0, definition: 0, final_choice: 0 },
        },
      ],
      {
        canonicalizeBrand: canonicalizer.canonicalizeBrand,
        canonicalizeProduct: (mention) => mention,
      } as never,
    );

    const productRows = rows.filter((row) => row.entity_type === "Product");
    expect(productRows).toHaveLength(2);
    expect(productRows.map((row) => row.mention_count).sort()).toEqual([1, 2]);
  });
});

describe("collectAcrRollups", () => {
  const mention = (
    entityId: string,
    name: string,
    brandRollup: string,
    type = "Brand",
  ) => ({
    entity_id: entityId,
    entity_type: type,
    display_name: name,
    rollups: { product_entity_id: null, brand_entity_id: brandRollup, company_entity_id: null },
    surfaces: [name],
    mention_count: 1,
  });

  const acrRow = (entityId: string, over: Record<string, unknown> = {}) => ({
    rollupLevel: "brand" as const,
    entityId,
    plannedIterations: 10,
    validTurn1Iterations: 10,
    validAcrIterations: 10,
    appearanceCount: 8,
    choiceCount: 3,
    conditionalChoiceCount: 0,
    appearanceRate: 0.8,
    acr: 0.375,
    overallChoiceShare: 0.3,
    offShortlistChoiceCount: 0,
    unresolvedChoiceCount: 0,
    genericChoiceCount: 0,
    choiceOutcomeBreakdown: { single_entity: 3 },
    ...over,
  });

  it("dedups identical acr_summary across a prompt-run's iteration jobs", async () => {
    const { collectAcrRollups } = await import("./sync");
    const summary = { prompt_run_id: "pr-1", rows: [acrRow("e-hyundai")] };
    const jobs = [1, 2, 3].map((i) => ({
      job_id: `j${i}`,
      prompt_id: "prompt-1",
      target: "chatgpt",
      region: "KR",
      status: "completed",
      measured_at: "2026-07-01T00:00:00.000Z",
      analysis: {
        status: "completed" as const,
        resolved_mentions: [mention("e-hyundai", "Hyundai", "e-hyundai")],
        acr_summary: summary,
      },
    }));

    const rollups = collectAcrRollups(jobs as never, "run-1");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      promptRunId: "pr-1",
      entityId: "e-hyundai",
      runId: "run-1",
      promptId: "prompt-1",
      target: "chatgpt",
      region: "KR",
      brand: "Hyundai",
      parentBrand: "Hyundai",
      appearanceCount: 8,
      choiceCount: 3,
      coSingleEntity: 3,
    });
  });

  it("resolves product parent brand from the run-wide name map", async () => {
    const { collectAcrRollups } = await import("./sync");
    const jobs = [
      {
        job_id: "j1",
        prompt_id: "prompt-1",
        target: "gemini",
        region: "US",
        status: "completed",
        measured_at: "2026-07-01T00:00:00.000Z",
        analysis: {
          status: "completed" as const,
          // 이름 사전은 run 전체에서 모인다 — 브랜드 엔티티가 다른 job에 있어도 OK
          resolved_mentions: [
            mention("e-ioniq5", "Ioniq 5", "e-hyundai", "Product"),
            mention("e-hyundai", "Hyundai", "e-hyundai"),
          ],
          acr_summary: {
            prompt_run_id: "pr-2",
            rows: [acrRow("e-ioniq5", { rollupLevel: "product" })],
          },
        },
      },
    ];

    const rollups = collectAcrRollups(jobs as never, "run-2");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      entityId: "e-ioniq5",
      rollupLevel: "product",
      brand: "Ioniq 5",
      parentBrand: "Hyundai",
      brandRollupEntityId: "e-hyundai",
    });
  });

  it("skips jobs without acr_summary (single prompts)", async () => {
    const { collectAcrRollups } = await import("./sync");
    const jobs = [
      {
        job_id: "j1",
        prompt_id: "prompt-1",
        target: "chatgpt",
        region: null,
        status: "completed",
        measured_at: "2026-07-01T00:00:00.000Z",
        analysis: {
          status: "completed" as const,
          resolved_mentions: [mention("e-kia", "Kia", "e-kia")],
        },
      },
    ];
    expect(collectAcrRollups(jobs as never, "run-3")).toHaveLength(0);
  });

  // ── 2026-09-13 미러 정지 사고 (최초 관측 2026-09-09 회차 7) ──────────────
  // scope 는 같은 엔티티를 brand·product 두 rollupLevel 로 함께 돌려줄 수 있다.
  // 미러 PK 는 (prompt_run_id, entity_id) 뿐이라 그대로 넣으면 23505 가 나고,
  // `replaceRun` 이 단일 트랜잭션이라 그 run 의 answers·mentions·citations·
  // scope_runs upsert 까지 **통째로 롤백**된다. run 행이 안 써지니 워터마크도
  // 안 생겨 다음 패스가 같은 run 에서 또 죽는다 = 그 프로젝트 싱크 영구 정지.
  it("★ 같은 엔티티가 여러 rollup_level 로 오면 1행으로 접는다 (PK 23505 방지)", async () => {
    const { collectAcrRollups } = await import("./sync");
    const jobs = [
      {
        job_id: "j1",
        prompt_id: "prompt-1",
        target: "chatgpt",
        region: "KR",
        status: "completed",
        measured_at: "2026-09-13T00:00:00.000Z",
        analysis: {
          status: "completed" as const,
          resolved_mentions: [mention("e-genesis", "Genesis", "e-genesis")],
          acr_summary: {
            prompt_run_id: "pr-dup",
            rows: [
              acrRow("e-genesis", { rollupLevel: "product", choiceCount: 1 }),
              acrRow("e-genesis", { rollupLevel: "brand", choiceCount: 9 }),
            ],
          },
        },
      },
    ];

    const rollups = collectAcrRollups(jobs as never, "run-dup");
    expect(rollups).toHaveLength(1);
    // brand 레벨이 이긴다 — 임의 선택이면 패스마다 KPI 가 떤다.
    expect(rollups[0]).toMatchObject({
      entityId: "e-genesis",
      rollupLevel: "brand",
      choiceCount: 9,
    });
  });

  it("행 순서가 뒤집혀도 같은 행이 남는다 — 결정적이어야 KPI 가 안 흔들린다", async () => {
    const { collectAcrRollups } = await import("./sync");
    const build = (rows: unknown[]) => [
      {
        job_id: "j1",
        prompt_id: "prompt-1",
        target: "chatgpt",
        region: "KR",
        status: "completed",
        measured_at: "2026-09-13T00:00:00.000Z",
        analysis: {
          status: "completed" as const,
          resolved_mentions: [mention("e-kia", "Kia", "e-kia")],
          acr_summary: { prompt_run_id: "pr-order", rows },
        },
      },
    ];
    const a = collectAcrRollups(
      build([acrRow("e-kia", { rollupLevel: "brand" }), acrRow("e-kia", { rollupLevel: "product" })]) as never,
      "run-x",
    );
    const b = collectAcrRollups(
      build([acrRow("e-kia", { rollupLevel: "product" }), acrRow("e-kia", { rollupLevel: "brand" })]) as never,
      "run-x",
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].rollupLevel).toBe("brand");
    expect(b[0].rollupLevel).toBe("brand");
  });

  it("서로 다른 엔티티는 접지 않는다 — 과잉 dedup 회귀 방지", async () => {
    const { collectAcrRollups } = await import("./sync");
    const jobs = [
      {
        job_id: "j1",
        prompt_id: "prompt-1",
        target: "chatgpt",
        region: "KR",
        status: "completed",
        measured_at: "2026-09-13T00:00:00.000Z",
        analysis: {
          status: "completed" as const,
          resolved_mentions: [mention("e-hyundai", "Hyundai", "e-hyundai")],
          acr_summary: {
            prompt_run_id: "pr-multi",
            rows: [acrRow("e-hyundai"), acrRow("e-kia"), acrRow("e-genesis")],
          },
        },
      },
    ];
    expect(collectAcrRollups(jobs as never, "run-multi")).toHaveLength(3);
  });
});

describe("dedupeAcrRowsByEntity — 엔티티당 1행 (미러 PK 제약)", () => {
  it("brand 레벨이 이긴다", async () => {
    const { dedupeAcrRowsByEntity } = await import("./sync");
    const out = dedupeAcrRowsByEntity([
      { entityId: "e1", rollupLevel: "product" },
      { entityId: "e1", rollupLevel: "brand" },
    ]);
    expect(out).toEqual([{ entityId: "e1", rollupLevel: "brand" }]);
  });

  it("brand 가 없으면 먼저 온 행을 남긴다", async () => {
    const { dedupeAcrRowsByEntity } = await import("./sync");
    const out = dedupeAcrRowsByEntity([
      { entityId: "e1", rollupLevel: "product" },
      { entityId: "e1", rollupLevel: "company" },
    ]);
    expect(out).toEqual([{ entityId: "e1", rollupLevel: "product" }]);
  });

  it("중복이 없으면 입력을 그대로(순서 포함) 낸다", async () => {
    const { dedupeAcrRowsByEntity } = await import("./sync");
    const rows = [
      { entityId: "a", rollupLevel: "brand" },
      { entityId: "b", rollupLevel: "product" },
    ];
    expect(dedupeAcrRowsByEntity(rows)).toEqual(rows);
  });

  it("빈 배열은 빈 배열", async () => {
    const { dedupeAcrRowsByEntity } = await import("./sync");
    expect(dedupeAcrRowsByEntity([])).toEqual([]);
  });
});

describe("describeSyncError — 커서에 남길 에러 (2026-09-13 253KB 덤프)", () => {
  it("PG 사유를 **맨 앞**에 둔다 — drizzle 파라미터 덤프에 묻히면 진단이 안 된다", async () => {
    const { describeSyncError } = await import("./sync");
    const err = new Error(`Failed query: insert into "scope_acr_rollups" ${"$1, ".repeat(20_000)}`);
    (err as Error & { cause: unknown }).cause = {
      code: "23505",
      constraint_name: "scope_acr_rollups_pkey",
      message: "duplicate key value violates unique constraint",
      detail: "Key (prompt_run_id, entity_id)=(pr-1, e-1) already exists.",
    };
    const msg = describeSyncError(err);
    expect(msg.startsWith("code=23505")).toBe(true);
    expect(msg).toContain("scope_acr_rollups_pkey");
    expect(msg).toContain("already exists");
  });

  it("상한을 넘지 않는다 — 커서 행이 250KB 로 붓지 않게", async () => {
    const { describeSyncError, SYNC_ERROR_MAX_CHARS } = await import("./sync");
    const err = new Error("x".repeat(300_000));
    (err as Error & { cause: unknown }).cause = { code: "23505", message: "dup" };
    expect(describeSyncError(err).length).toBeLessThanOrEqual(SYNC_ERROR_MAX_CHARS);
    // cause 가 없는 경로도 잘린다.
    expect(describeSyncError(new Error("y".repeat(300_000))).length).toBeLessThanOrEqual(
      SYNC_ERROR_MAX_CHARS,
    );
  });

  it("cause 가 없으면 message 만 (기존 동작 보존)", async () => {
    const { describeSyncError } = await import("./sync");
    expect(describeSyncError(new Error("scope 404 not_found"))).toBe("scope 404 not_found");
    expect(describeSyncError("plain string")).toBe("plain string");
  });
});

describe("dedupeAcrIterationJobs", () => {
  const acrJob = (
    jobId: string,
    promptRunId: string | null,
    status: string,
    measuredAt: string,
  ) => ({
    job_id: jobId,
    prompt_id: "prompt-1",
    target: "chatgpt",
    region: "KR",
    status,
    measured_at: measuredAt,
    analysis: promptRunId
      ? {
          status: "completed" as const,
          acr_summary: { prompt_run_id: promptRunId, rows: [] },
        }
      : { status: "completed" as const },
  });

  it("keeps one representative job per ACR prompt-run (completed, latest)", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      acrJob("j1", "pr-1", "completed", "2026-07-01T00:00:00Z"),
      acrJob("j2", "pr-1", "completed", "2026-07-01T02:00:00Z"),
      acrJob("j3", "pr-1", "failed", "2026-07-01T03:00:00Z"), // 최신이지만 미완료
      acrJob("j4", "pr-2", "completed", "2026-07-01T01:00:00Z"),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.job_id).sort()).toEqual(["j2", "j4"]);
  });

  it("passes non-ACR jobs through untouched", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      acrJob("s1", null, "completed", "2026-07-01T00:00:00Z"),
      acrJob("s2", null, "completed", "2026-07-01T00:00:00Z"),
      acrJob("j1", "pr-1", "completed", "2026-07-01T00:00:00Z"),
      acrJob("j2", "pr-1", "completed", "2026-07-01T01:00:00Z"),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.job_id).sort()).toEqual(["j1", "j2", "s1", "s2"].filter((id) => id !== "j1"));
  });
});

describe("orderSyncTargets — 싱크 순회 oldest-first 로테이션", () => {
  const ROOT = "root";
  const at = (iso: string) => new Date(iso);

  it("root는 항상 첫 순번이다", () => {
    const out = orderSyncTargets(
      ROOT,
      ["b", ROOT, "a"],
      new Map([
        ["a", at("2026-08-01T00:00:00Z")],
        ["b", at("2026-08-10T00:00:00Z")],
      ]),
    );
    expect(out[0]).toBe(ROOT);
  });

  it("root도 마지막 시도 시각 기준으로 정렬하고, 동률일 때만 첫 순번이다", () => {
    const out = orderSyncTargets(
      ROOT,
      [ROOT, "stale", "fresh"],
      new Map([
        [ROOT, at("2026-08-13T00:00:00Z")],
        ["stale", at("2026-08-01T00:00:00Z")],
        ["fresh", at("2026-08-20T00:00:00Z")],
      ]),
    );
    expect(out).toEqual(["stale", ROOT, "fresh"]);

    const tied = orderSyncTargets(
      ROOT,
      ["zeta", ROOT, "alpha"],
      new Map([
        ["zeta", at("2026-08-01T00:00:00Z")],
        [ROOT, at("2026-08-01T00:00:00Z")],
        ["alpha", at("2026-08-01T00:00:00Z")],
      ]),
    );
    expect(tied).toEqual([ROOT, "alpha", "zeta"]);
  });

  it("한 번도 동기화 안 된 프로젝트가 동기화된 것보다 앞선다", () => {
    const out = orderSyncTargets(
      ROOT,
      [ROOT, "synced", "never"],
      new Map([["synced", at("2026-08-01T00:00:00Z")]]),
    );
    expect(out).toEqual([ROOT, "never", "synced"]);
  });

  it("동기화 시각이 오래된 순으로 정렬된다 (기아 해소의 핵심)", () => {
    const out = orderSyncTargets(
      ROOT,
      [ROOT, "fresh", "stale", "mid"],
      new Map([
        ["fresh", at("2026-08-13T00:00:00Z")],
        ["stale", at("2026-08-01T00:00:00Z")],
        ["mid", at("2026-08-07T00:00:00Z")],
      ]),
    );
    expect(out).toEqual([ROOT, "stale", "mid", "fresh"]);
  });

  it("동률은 id 사전순으로 결정적이다", () => {
    const t = at("2026-08-01T00:00:00Z");
    const out = orderSyncTargets(ROOT, [ROOT, "zeta", "alpha"], new Map([
      ["zeta", t],
      ["alpha", t],
    ]));
    expect(out).toEqual([ROOT, "alpha", "zeta"]);
  });

  it("ids에 root가 없으면 root를 만들어 넣지 않는다", () => {
    const out = orderSyncTargets(ROOT, ["a", "b"], new Map());
    expect(out).toEqual(["a", "b"]);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const ids = ["b", ROOT, "a"];
    orderSyncTargets(ROOT, ids, new Map());
    expect(ids).toEqual(["b", ROOT, "a"]);
  });
});

describe("mergeRotationKeys — 로테이션 키는 '쓰기'가 아니라 '시도'", () => {
  const ROOT = "root";
  const at = (iso: string) => new Date(iso);

  it("시도 커서가 쓰기 시각을 이긴다", () => {
    const merged = mergeRotationKeys(
      new Map([["a", at("2026-08-20T00:00:00Z")]]),
      new Map([["a", at("2026-08-12T00:00:00Z")]]),
    );
    expect(merged.get("a")).toEqual(at("2026-08-20T00:00:00Z"));
  });

  it("커서가 없는 프로젝트는 기존 쓰기 시각으로 폴백한다 (0043 배포 직후)", () => {
    const merged = mergeRotationKeys(
      new Map(),
      new Map([["a", at("2026-08-12T00:00:00Z")]]),
    );
    expect(merged.get("a")).toEqual(at("2026-08-12T00:00:00Z"));
    expect(merged.has("b")).toBe(false);
  });

  it("입력 맵을 변형하지 않는다", () => {
    const writes = new Map([["a", at("2026-08-12T00:00:00Z")]]);
    mergeRotationKeys(new Map([["a", at("2026-08-20T00:00:00Z")]]), writes);
    expect(writes.get("a")).toEqual(at("2026-08-12T00:00:00Z"));
  });

  // 회귀: 2026-08-20 GENESIS GV80 HEV(1.1v) 정지. 쓸 게 없어 아무것도 안 쓴
  // 프로젝트("idle")가 쓰기 시각 기준으로는 매 패스 앞순번에 고착돼, 예산 밖
  // 뒷순번("starved")이 영영 도달하지 못했다. 시도 커서를 쓰면 한 패스 뒤에
  // idle 이 뒤로 밀리고 starved 가 앞순번을 얻는다.
  it("무작업 프로젝트가 한 패스 뒤 뒷순번으로 밀린다 (기아 회귀 방지)", () => {
    const ids = [ROOT, "idle", "starved"];
    // 쓰기 시각만 보면: idle(08-01) → starved(08-12). idle 이 영구히 앞.
    const writes = new Map([
      ["idle", at("2026-08-01T00:00:00Z")],
      ["starved", at("2026-08-12T00:00:00Z")],
    ]);
    const before = orderSyncTargets(ROOT, ids, mergeRotationKeys(new Map(), writes));
    expect(before).toEqual([ROOT, "idle", "starved"]);

    // 1패스: idle 을 시도했지만 새 run 이 없어 쓰기는 0 → 쓰기 시각은 그대로.
    // 시도 커서만 갱신된다.
    const attempts = new Map([["idle", at("2026-08-20T00:00:00Z")]]);
    const after = orderSyncTargets(ROOT, ids, mergeRotationKeys(attempts, writes));
    expect(after).toEqual([ROOT, "starved", "idle"]);
  });

  it("실패한 시도도 순번을 밀어낸다 (삭제된 scope 프로젝트의 상시 404)", () => {
    const ids = [ROOT, "gone404", "starved"];
    const writes = new Map([["starved", at("2026-08-12T00:00:00Z")]]);
    // gone404 는 쓰기 이력이 아예 없어(=키 0) 영구 최우선이었다.
    expect(orderSyncTargets(ROOT, ids, mergeRotationKeys(new Map(), writes))).toEqual([
      ROOT,
      "gone404",
      "starved",
    ]);
    const attempts = new Map([["gone404", at("2026-08-20T00:00:00Z")]]);
    expect(orderSyncTargets(ROOT, ids, mergeRotationKeys(attempts, writes))).toEqual([
      ROOT,
      "starved",
      "gone404",
    ]);
  });
});

describe("dedupeAcrIterationJobs — 실패 반복 폴딩 (2026-08-28 미러 왜곡)", () => {
  const job = (
    jobId: string,
    promptRunId: string | null,
    status: string,
    measuredAt: string,
    over: Partial<{ prompt_id: string | null; region: string | null }> = {},
  ) => ({
    job_id: jobId,
    prompt_id: "prompt-1",
    target: "chatgpt",
    region: "KR",
    status,
    measured_at: measuredAt,
    ...over,
    ...(promptRunId
      ? {
          analysis: {
            status: "completed" as const,
            acr_summary: { prompt_run_id: promptRunId, rows: [] },
          },
        }
      : {}),
  });

  it("분석이 없는 실패 반복 10개를 대표 1개로 접는다", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = Array.from({ length: 10 }, (_, i) =>
      job(`f${i}`, null, "failed", `2026-08-28T03:0${i}:00Z`),
    );
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("failed");
  });

  it("같은 셀의 완주 형제가 있으면 실패 반복은 그 prompt-run 에 합류해 사라진다", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      job("ok1", "pr-1", "completed", "2026-08-28T03:00:00Z"),
      job("f1", null, "failed", "2026-08-28T03:05:00Z"),
      job("f2", null, "failed", "2026-08-28T03:06:00Z"),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.job_id)).toEqual(["ok1"]);
  });

  it("셀이 다르면(리전 다름) 따로 남는다", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      job("de1", null, "failed", "2026-08-28T03:00:00Z", { region: "DE" }),
      job("de2", null, "failed", "2026-08-28T03:01:00Z", { region: "DE" }),
      job("fr1", null, "failed", "2026-08-28T03:00:00Z", { region: "FR" }),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.region).sort()).toEqual(["DE", "FR"]);
  });

  it("완주했지만 acr_summary 가 없는 단발 job 은 접지 않는다", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      job("s1", null, "completed", "2026-08-28T03:00:00Z"),
      job("s2", null, "completed", "2026-08-28T03:01:00Z"),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.job_id).sort()).toEqual(["s1", "s2"]);
  });

  it("prompt_id 가 없는 실패 job 은 구분 불가라 그대로 통과한다", async () => {
    const { dedupeAcrIterationJobs } = await import("./sync");
    const jobs = [
      job("n1", null, "failed", "2026-08-28T03:00:00Z", { prompt_id: null }),
      job("n2", null, "failed", "2026-08-28T03:01:00Z", { prompt_id: null }),
    ];
    const out = dedupeAcrIterationJobs(jobs as never);
    expect(out.map((j) => j.job_id).sort()).toEqual(["n1", "n2"]);
  });
});

describe("shouldSkipMirroredRun — terminal 워터마크", () => {
  it("미러에 없는 run 은 항상 당긴다", async () => {
    const { shouldSkipMirroredRun } = await import("./sync");
    expect(shouldSkipMirroredRun(undefined, "completed")).toBe(false);
  });

  it("scope 가 보고하는 status 가 달라지면 다시 당긴다", async () => {
    const { shouldSkipMirroredRun } = await import("./sync");
    expect(
      shouldSkipMirroredRun(
        { status: "failed", hasUnresolved: true, recheckable: true },
        "completed",
      ),
    ).toBe(false);
  });

  it("status 가 같아도 미완 답변이 남아 있고 창 안이면 다시 당긴다 (partial_failed 회수)", async () => {
    const { shouldSkipMirroredRun } = await import("./sync");
    expect(
      shouldSkipMirroredRun(
        { status: "partial_failed", hasUnresolved: true, recheckable: true },
        "partial_failed",
      ),
    ).toBe(false);
  });

  it("전부 완주한 run 은 건너뛴다", async () => {
    const { shouldSkipMirroredRun } = await import("./sync");
    expect(
      shouldSkipMirroredRun(
        { status: "completed", hasUnresolved: false, recheckable: true },
        "completed",
      ),
    ).toBe(true);
  });

  it("재확인 창을 지난 오래된 run 은 미완이 남아도 건너뛴다", async () => {
    const { shouldSkipMirroredRun } = await import("./sync");
    expect(
      shouldSkipMirroredRun(
        { status: "failed", hasUnresolved: true, recheckable: false },
        "failed",
      ),
    ).toBe(true);
  });
});

describe("미러 페이지 상한 — 프롬프트와 같이 올리지 않는다", () => {
  it("runs·jobs 상한은 프롬프트와 따로 관리된다 (뭉뚱그리지 않는다)", () => {
    // 2026-08-30: 프롬프트 상한을 300 으로 올렸다가 크론 300s 타임아웃으로
    // 되돌렸다(paging.ts 헤더). 지금은 셋 다 50 이지만 **값이 같은 것과 축이
    // 같은 것은 다르다** — 각각 독립 상수여서 한쪽만 조정할 수 있어야 한다.
    expect(MIRROR_RUN_MAX_PAGES).toBe(50);
    expect(MIRROR_JOB_MAX_PAGES).toBe(50);
    expect(typeof PROMPT_MAX_PAGES).toBe("number");
  });
});

describe("shouldSkipResyncedRun — 강제 재싱크 워터마크 (2026-08-30 멱등 사고)", () => {
  const T = new Date("2026-08-30T09:40:00Z");
  const at = (iso: string) => ({ syncedAt: new Date(iso) });

  it("워터마크가 없으면 아무것도 건너뛰지 않는다 — 기존 force 동작 보존", () => {
    expect(shouldSkipResyncedRun(at("2026-08-30T10:00:00Z"), undefined)).toBe(false);
    expect(shouldSkipResyncedRun(undefined, undefined)).toBe(false);
  });

  it("기준 시각 이후 이미 재싱크된 run 은 건너뛴다 — 이게 패스를 전진시킨다", () => {
    expect(shouldSkipResyncedRun(at("2026-08-30T09:56:17Z"), T)).toBe(true);
  });

  it("기준 시각 이전에 싱크된 run 은 재풀 대상이다", () => {
    expect(shouldSkipResyncedRun(at("2026-07-01T13:47:32Z"), T)).toBe(false);
  });

  it("경계는 포함이다 — 정확히 같은 시각이면 이미 처리된 것으로 본다", () => {
    expect(shouldSkipResyncedRun({ syncedAt: T }, T)).toBe(true);
  });

  it("미러에 없는 run 은 절대 건너뛰지 않는다 — 신규 데이터가 밀리면 안 된다", () => {
    expect(shouldSkipResyncedRun(undefined, T)).toBe(false);
  });

  it("syncedAt 이 null 이면 건너뛰지 않는다 — 기록이 없으면 재풀이 안전 쪽이다", () => {
    expect(shouldSkipResyncedRun({ syncedAt: null }, T)).toBe(false);
  });

  it("반복 패스 시뮬레이션 — 워터마크 없이는 진도가 0, 있으면 단조 전진", () => {
    // 실측 재현: force 는 목록 앞에서부터 N 개를 매번 다시 집는다.
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      syncedAt: null as Date | null,
    }));
    const N = 2;

    const pass = (watermark: Date | undefined) => {
      let pulled = 0;
      for (const r of runs) {
        if (pulled >= N) break;
        if (shouldSkipResyncedRun({ syncedAt: r.syncedAt }, watermark)) continue;
        r.syncedAt = new Date("2026-08-30T10:00:00Z"); // 재싱크 스탬프
        pulled++;
      }
      return runs.filter((r) => r.syncedAt !== null).length;
    };

    // 워터마크 없음: 3패스를 돌려도 앞의 2개만 반복해서 다시 쓴다.
    expect(pass(undefined)).toBe(2);
    expect(pass(undefined)).toBe(2);
    expect(pass(undefined)).toBe(2);

    // 워터마크 있음: 이미 스탬프된 것을 건너뛰고 뒤로 전진한다.
    expect(pass(T)).toBe(4);
    expect(pass(T)).toBe(5);
  });
});
