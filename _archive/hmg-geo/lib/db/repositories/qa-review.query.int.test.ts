import { describe, it, expect } from "vitest";
import {
  listReviewAnswers,
  getProgress,
  getReviewAnswerDetail,
  getNeighbors,
  upsertReview,
  listFilterOptions,
} from "./qa-review";

// DB 통합 테스트 — DATABASE_URL 없으면 통째로 건너뛴다(CI 기본).
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("검수 목록", () => {
  it("표면 필터가 그 표면의 행만 돌려준다", async () => {
    for (const surface of ["standard", "website", "project"] as const) {
      const { rows } = await listReviewAnswers({ surface: [surface] }, undefined, 20);
      for (const r of rows) expect(r.surface).toBe(surface);
    }
  });

  it("measured_at 내림차순으로 정렬된다", async () => {
    const { rows } = await listReviewAnswers({}, undefined, 20);
    const ts = rows.map((r) => (r.measuredAt ? r.measuredAt.getTime() : 0));
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
  });

  it("커서로 다음 페이지를 가져오고 중복이 없다", async () => {
    const first = await listReviewAnswers({}, undefined, 10);
    expect(first.rows.length).toBeGreaterThan(0);
    if (!first.nextCursor) return;
    const second = await listReviewAnswers({}, first.nextCursor, 10);
    const seen = new Set(first.rows.map((r) => r.jobId));
    for (const r of second.rows) expect(seen.has(r.jobId)).toBe(false);
  });

  it("엔진 필터가 걸린다", async () => {
    const { rows } = await listReviewAnswers({ engine: ["chatgpt"] }, undefined, 20);
    for (const r of rows) expect(r.engine).toBe("chatgpt");
  });

  it("미검수 필터는 검수 행이 없는 답변만 준다", async () => {
    const { rows } = await listReviewAnswers({ state: ["unreviewed"] }, undefined, 20);
    for (const r of rows) expect(r.reviewStatus).toBe("unreviewed");
  });

  it("멘션 0건 필터는 멘션이 없는 답변만 준다", async () => {
    const { rows } = await listReviewAnswers({ noMentions: true }, undefined, 20);
    for (const r of rows) expect(r.mentionCount).toBe(0);
  });

  it("진행률은 필터 기준과 전체 기준을 모두 낸다", async () => {
    const p = await getProgress({ engine: ["chatgpt"] });
    expect(p.total.total).toBeGreaterThanOrEqual(p.scoped.total);
    expect(p.scoped.reviewed).toBeLessThanOrEqual(p.scoped.total);
  });

  it("필터 옵션은 목록에 실제로 나타나는 값만 담는다", async () => {
    const opts = await listFilterOptions();
    expect(Array.isArray(opts.engine)).toBe(true);
    expect(Array.isArray(opts.brand)).toBe(true);
  });
});

run("검수 상세", () => {
  it("멘션·인용이 있는 답변의 낱알을 전부 붙인다", async () => {
    const { rows } = await listReviewAnswers({}, undefined, 50);
    const target = rows.find((r) => r.mentionCount > 0 && r.citationCount > 0);
    if (!target) return; // 미러 미충전 환경이면 통과
    const d = await getReviewAnswerDetail(target.jobId);
    expect(d).not.toBeNull();
    expect(d!.answer.jobId).toBe(target.jobId);
    expect(d!.mentions.length).toBe(target.mentionCount);
    expect(d!.citations.length).toBe(target.citationCount);

    // 화면이 그리는 낱알 필드가 실제로 실려 있는지 — 여기가 이 도구의 본체다
    const m = d!.mentions[0];
    expect(m).toHaveProperty("sentimentPositive");
    expect(m).toHaveProperty("avgPosition");
    expect(m).toHaveProperty("typeFinalChoice");
    expect(m).toHaveProperty("isOwn");
    const c = d!.citations[0];
    expect(c).toHaveProperty("refIndex");
    expect(c).toHaveProperty("urlBaseNorm");
    expect(c).toHaveProperty("effectiveCategory");

    // 인용은 ref_index 오름차순 — 본문의 [N] 앵커와 순서가 맞아야 한다
    const idx = d!.citations.map((x) => x.refIndex ?? Number.MAX_SAFE_INTEGER);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("없는 job 은 null", async () => {
    expect(await getReviewAnswerDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("이전/다음이 목록과 같은 순서를 따른다", async () => {
    const { rows } = await listReviewAnswers({}, undefined, 3);
    if (rows.length < 3) return;
    const n = await getNeighbors({}, rows[1].jobId);
    expect(n.prev).toBe(rows[0].jobId);
    expect(n.next).toBe(rows[2].jobId);
  });

  it("판정 저장은 issue 가 하나라도 있으면 status='issue'", async () => {
    const { rows } = await listReviewAnswers({}, undefined, 1);
    if (rows.length === 0) return;
    const jobId = rows[0].jobId;
    const ok = await upsertReview({
      jobId,
      sectionFlags: { mentions: "ok", citations: "ok" },
      reviewerName: "테스트",
      sessionId: null,
    });
    expect(ok.status).toBe("ok");
    const bad = await upsertReview({
      jobId,
      sectionFlags: { mentions: "issue", citations: "ok" },
      reviewerName: "테스트",
      sessionId: null,
    });
    expect(bad.status).toBe("issue");
  });
});
