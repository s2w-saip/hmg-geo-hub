import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 답변 축 스탠스 분포 집계의 **단위 계약** (검증자 F2).
 *
 * 지켜야 하는 명제는 하나다: **4계열 합 = pairs = (답변 × 브랜드) 쌍 수.**
 * 미러 행의 단위는 (답변 × **턴** × 브랜드)이고 2턴 답변(ACR 후속 선택)이 라이브의
 * 8.2%(52,698/642,521)라, 턴을 접지 않으면 그 답변들이 두 번 계상되어 지표의 정의가
 * 깨진다. 카드 문구("답변 × 브랜드 N건")도 같이 거짓이 된다.
 *
 * DB 없이 고정할 수 있는 것은 둘이다:
 *   ① **SQL 의 형태** — 턴 접기(DISTINCT ON)·대표 턴 규칙(ORDER BY turn_index)·
 *      어휘 필터가 실제로 문장에 있는가. 아래 소스 대조가 그것이다.
 *   ② **규칙의 산술** — 같은 규칙을 JS 로 적용했을 때 등식이 성립하는가. 다중 턴
 *      픽스처로 확인한다. ①이 SQL 이 그 규칙을 구현했음을, ②가 그 규칙이 등식을
 *      만족함을 각각 담당한다.
 * 실제 SQL 실행 대조는 0072 적용 후 스테이징 SQL 로 한다(PR 본문 검증 절차).
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"),
  "utf8",
);
const FN = SRC.slice(
  SRC.indexOf("export async function aggregateAnswerStanceDistributionFromMirror"),
  SRC.indexOf("export async function aggregateBrandCitationsFromMirror"),
);

describe("aggregateAnswerStanceDistributionFromMirror — SQL 형태", () => {
  it("턴을 접는다 — DISTINCT ON (job_id, entity_id)", () => {
    expect(FN).toMatch(/DISTINCT ON \(s\.job_id, s\.entity_id\)/);
  });

  it("대표 턴은 가장 낮은 turn_index — ORDER BY 가 그 규칙의 정본", () => {
    // Postgres 는 DISTINCT ON 식이 ORDER BY 선두와 일치할 것을 요구한다. 뒤에 오는
    // turn_index 가 곧 "누가 대표인가"이고, 빼면 대표가 플랜에 따라 임의로 뽑힌다.
    expect(FN).toMatch(/ORDER BY s\.job_id, s\.entity_id, s\.turn_index/);
  });

  it("어휘 밖 stance 를 버린다 — 이 필터가 있어야 등식이 무조건 성립한다", () => {
    expect(FN).toMatch(/sx\.stance IN \('positive', 'negative', 'mixed', 'neutral'\)/);
  });

  it("pairs 는 접힌 집합의 count(*) — 4계열과 같은 모집단에서 센다", () => {
    // count(*) 가 4개 FILTER 카운트와 **같은 FROM/WHERE** 를 보는 형태여야 등식이 산다.
    expect(FN).toMatch(/count\(\*\)::int AS pairs/);
    for (const k of ["positive", "neutral", "mixed", "negative"]) {
      expect(FN).toMatch(
        new RegExp(`count\\(\\*\\) FILTER \\(WHERE sx\\.stance = '${k}'\\)::int\\s+AS ${k}`),
      );
    }
  });

  it("당사 판정은 미러 is_tracked 가 아니라 단일 정본 술어를 쓴다", () => {
    expect(FN).toContain('trackedRollupPredicate(filters, "sx")');
    expect(FN).not.toMatch(/is_tracked/);
  });

  it("예산(문장 상한·마감)을 받는다 — 없으면 kpiDegrade 가 못 삼킨다 (F7)", () => {
    expect(FN).toMatch(/opts: \{ statementTimeoutMs\?: number; budgetMs\?: number \}/);
    expect(FN).toMatch(/budgetedReader\(budget, "stanceDist"/);
    expect(FN).toMatch(/deadlineAt: opts\.budgetMs \? Date\.now\(\) \+ opts\.budgetMs : undefined/);
  });
});

// ── 규칙의 산술 ─────────────────────────────────────────────────────────────
// SQL 이 구현한 규칙(= 가장 낮은 턴 대표 + 어휘 필터)을 JS 로 그대로 적용한다.
type Row = { jobId: string; turnIndex: number; entityId: string; stance: string };
const VOCAB = new Set(["positive", "negative", "mixed", "neutral"]);

function fold(rows: Row[]) {
  const rep = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.jobId}|${r.entityId}`;
    const cur = rep.get(k);
    if (!cur || r.turnIndex < cur.turnIndex) rep.set(k, r);
  }
  const kept = [...rep.values()].filter((r) => VOCAB.has(r.stance));
  const count = (s: string) => kept.filter((r) => r.stance === s).length;
  return {
    positive: count("positive"),
    neutral: count("neutral"),
    mixed: count("mixed"),
    negative: count("negative"),
    pairs: kept.length,
  };
}

describe("턴 접기 규칙 — 4계열 합 = pairs", () => {
  it("2턴 답변이 섞여도 등식이 성립하고, 답변×브랜드 수와 같다", () => {
    // job-A: 1턴 · 브랜드 2개 → 쌍 2
    // job-B: 2턴 · 같은 브랜드 2개가 두 턴에 모두 등장 → 쌍 2 (4행이 아니다)
    const rows: Row[] = [
      { jobId: "A", turnIndex: 0, entityId: "h", stance: "positive" },
      { jobId: "A", turnIndex: 0, entityId: "k", stance: "neutral" },
      { jobId: "B", turnIndex: 0, entityId: "h", stance: "mixed" },
      { jobId: "B", turnIndex: 1, entityId: "h", stance: "negative" },
      { jobId: "B", turnIndex: 0, entityId: "k", stance: "positive" },
      { jobId: "B", turnIndex: 1, entityId: "k", stance: "negative" },
    ];
    const d = fold(rows);
    expect(d.pairs).toBe(4); // 행은 6개인데 (답변 × 브랜드) 쌍은 4개다
    expect(d.positive + d.neutral + d.mixed + d.negative).toBe(d.pairs);
    // 대표는 **턴 0** — 접지 않았다면 negative 2 가 더 들어왔을 것이다.
    expect(d).toMatchObject({ positive: 2, neutral: 1, mixed: 1, negative: 0 });
  });

  it("턴이 역순으로 들어와도 대표는 가장 낮은 턴 (결정적)", () => {
    const rows: Row[] = [
      { jobId: "B", turnIndex: 2, entityId: "h", stance: "negative" },
      { jobId: "B", turnIndex: 1, entityId: "h", stance: "neutral" },
      { jobId: "B", turnIndex: 0, entityId: "h", stance: "positive" },
    ];
    expect(fold(rows)).toMatchObject({ positive: 1, pairs: 1 });
  });

  it("대표 턴의 값이 어휘 밖이면 그 쌍이 통째로 빠진다 — 등식은 그래도 성립", () => {
    const rows: Row[] = [
      { jobId: "A", turnIndex: 0, entityId: "h", stance: "very_positive" },
      { jobId: "A", turnIndex: 1, entityId: "h", stance: "positive" },
      { jobId: "A", turnIndex: 0, entityId: "k", stance: "mixed" },
    ];
    const d = fold(rows);
    expect(d.pairs).toBe(1);
    expect(d.positive + d.neutral + d.mixed + d.negative).toBe(d.pairs);
  });
});
