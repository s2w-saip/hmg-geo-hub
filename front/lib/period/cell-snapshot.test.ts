import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { cellSnapshotKeys } from "./cell-snapshot";

// 이 빌더가 내는 키 목록은 종전 **아홉** 사본의 인라인 키 목록과 글자가 같아야 한다.
// 아래 기대 문자열은 리팩터 직전 소스(`8d26487`)에서 그대로 옮긴 것이다 — 호출부는
// 그 자리를 `${k.all}` 로 치환했을 뿐이므로, 이 단언이 곧 그 자리들의 바이트 동일성
// 증명이다.
//
// ── 스냅샷(`period-axis.snapshot.test.ts`)이 못 보는 자리 (2026-09-19 검증 지적 ④) ──
// dedup 사본 중 5곳이 DB 를 타는 async 함수 안이라 컴파일 대상이 아니다:
//   readCitationDomainDayCounts · aggregateCitationAccuracyTrend ·
//   aggregateWebsiteCitationAccuracyTrend · KPI_TAB_CELL_SNAPSHOT ·
//   aggregateStandardTrendFromMirror(withAnswerSet 의 dedupe)
// 같은 리팩터가 **dedup 이 아닌 자리**도 넷 건드렸고 그쪽도 스냅샷 밖이다(해당 증명은
// `sql-day.test.ts` 의 조각 텍스트 단언):
//   trendWeekKey(measured 분기) · aggregateStandardTrendFromMirror 의 `bkt` ·
//   getMirrorStatus 의 distinct_weeks · listMeasuredAcrLanguages 의 루트 id 분기
// 즉 스냅샷 밖은 총 **9곳**(dedup 5 + 비-dedup 4)이고, 이 파일과 sql-day.test.ts 가
// 그 둘을 각각 문자열로 붙잡는다.

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;
const BKT = sql`date_trunc('week', a.measured_at)`;

describe("cellSnapshotKeys — 종전 사본별 키 목록", () => {
  it("① latestAnswerIds — 3키, 별칭 a.", () => {
    const k = cellSnapshotKeys({ alias: "a." });
    expect(text(k.all)).toBe("a.prompt_id, a.target, a.region");
    expect(text(k.tieBreak)).toBe("a.measured_at DESC");
  });

  it("② rootFullCycleAnswerIds — 3키, 별칭 b.", () => {
    const k = cellSnapshotKeys({ alias: "b." });
    expect(text(k.all)).toBe("b.prompt_id, b.target, b.region");
    expect(text(k.tieBreak)).toBe("b.measured_at DESC");
  });

  it("③ latestAcrPromptRunIds — 3키, 별칭 x.", () => {
    const k = cellSnapshotKeys({ alias: "x." });
    expect(text(k.all)).toBe("x.prompt_id, x.target, x.region");
    expect(text(k.tieBreak)).toBe("x.measured_at DESC");
  });

  it("④⑤ 주 격자 스냅샷 — 4키, 버킷 뒤", () => {
    const k = cellSnapshotKeys({ alias: "a.", bucket: BKT });
    expect(text(k.all)).toBe(
      "a.prompt_id, a.target, a.region, date_trunc('week', a.measured_at)",
    );
  });

  it("⑥⑦ 인용 정확도 추이 — 4키, 버킷 **앞**", () => {
    const k = cellSnapshotKeys({ alias: "a.", bucket: BKT, bucketFirst: true });
    expect(text(k.all)).toBe(
      "date_trunc('week', a.measured_at), a.prompt_id, a.target, a.region",
    );
    // ⑦ 은 ORDER BY 가 두 줄로 쪼개져 있어 셀 키만 따로 쓴다 — 줄바꿈 보존용.
    expect(text(k.cells)).toBe("a.prompt_id, a.target, a.region");
  });

  it("⑧ KPI_TAB_CELL_SNAPSHOT — 4키 bare, 버킷 뒤", () => {
    const k = cellSnapshotKeys({ alias: "", bucket: sql`bucket` });
    expect(text(k.all)).toBe("prompt_id, target, region, bucket");
    expect(text(k.tieBreak)).toBe("measured_at DESC");
  });

  it("⑨ aggregateStandardTrendFromMirror — withAnswerSet 의 dedupe (버킷 앞)", () => {
    // 종전 원문(8d26487):
    //   on:    sql`${bkt}, a.prompt_id, a.target, a.region`
    //   order: sql`${bkt}, a.prompt_id, a.target, a.region, a.measured_at DESC`
    // `bkt` 은 `date_trunc('<week|day>', a.measured_at)` 이다.
    for (const unit of ["week", "day"] as const) {
      const bkt = sql`date_trunc(${sql.raw(`'${unit}'`)}, a.measured_at)`;
      const k = cellSnapshotKeys({ alias: "a.", bucket: bkt, bucketFirst: true });
      expect(text(k.all)).toBe(
        `date_trunc('${unit}', a.measured_at), a.prompt_id, a.target, a.region`,
      );
      expect(text(sql`${k.all}, ${k.tieBreak}`)).toBe(
        `date_trunc('${unit}', a.measured_at), a.prompt_id, a.target, a.region, a.measured_at DESC`,
      );
    }
  });

  it("키 목록에는 바인드가 없다 (DISTINCT ON ↔ ORDER BY 일치 제약)", () => {
    const k = cellSnapshotKeys({ alias: "a.", bucket: BKT });
    expect(dialect.sqlToQuery(k.all).params).toEqual([]);
  });
});
