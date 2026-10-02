import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { cellSnapshotKeys } from "@/lib/period/cell-snapshot";

// 회귀 가드 — 추이(시계열) 읽기가 "버킷별 셀 최신 1건" 규칙에서 이탈하지 않게.
//
// 2026-09-01 이전: KPI 추이(①~⑤)와 ⑥ 인용 정확도 추이는 allRuns 로 그 기간의 **전
// 답변**을 셌다. 카드는 스냅샷(셀당 최신 1건)이라, 한 주에 재측정된 셀이 추이에서만
// 이중 계상돼 같은 화면의 카드와 그래프 호버가 어긋났다(실측 Kia·KR 웹사이트:
// 카드 300답변/1,930인용 vs 마지막 주 버킷 497답변/1,950인용 → ⑤·⑥ 0.1~0.2%p).
// 답변분석 추이(readCitationDomainDayCounts)는 2026-08-12 결정으로 이미 이 규칙을
// 쓰고 있었고, 남아 있던 KPI 추이 3곳을 맞춘 것이다.
//
// ── 2026-09-19 개정 (dedup 키 통합 A4) ──────────────────────────────────────
// 종전 이 파일은 함수 **소스를 grep** 해 `prompt_id`·`a.target`·`a.region` 리터럴을
// 찾았다. 셀 키가 `lib/period/cell-snapshot.ts::cellSnapshotKeys` 한 곳으로 모이면서
// 그 리터럴이 호출부에서 사라졌다 — **컴파일 SQL 은 바이트 동일**이고(그 모듈 테스트가
// 키 목록 문자열을 통째로 단언한다), 깨진 것은 이 가드의 탐지 방식뿐이다.
//
// 지키려는 명제는 그대로다: "버킷 + 셀 3축으로 dedup, 동점은 최신". 두 겹으로 건다.
//   ① 정본 빌더가 **실제로 내는 값**이 셀 3축 + `measured_at DESC` 동점 규칙이다.
//   ② 각 추이 함수가 그 빌더(또는 빌더로 만든 공용 CTE)를 쓰고, 버킷을 키에 넣는다.
// 호출부가 키를 인라인으로 다시 적으면(사본 부활) ②에서 걸린다.
//
// ⚠️ **① 은 소스 grep 이면 안 된다**(2026-09-19 독립 검증 지적). 종전 판은
// `cell-snapshot.ts` **전문**을 `toContain("region")` 으로 훑어서, 셀 키에서 `region` 을
// 지워도 머리 주석("셀 = 프롬프트 × 엔진(`target`) × 지역(`region`)")이 단언을 먹여
// 살렸다 — 검증자 변이 M2 에서 이 파일만 통과했다. 같은 이유로 `/measured_at.*DESC/`
// 도 주석이 통과시켰다. 그래서 ① 은 빌더를 **실행해 컴파일한 텍스트**를 단언한다.
const SRC = readFileSync(
  fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
  "utf8",
);

const dialect = new PgDialect();
const compiled = (q: SQL) => dialect.sqlToQuery(q).sql;

// 함수 본문만 잘라낸다 — 다음 최상위 export 선언 직전까지.
function bodyOf(name: string): string {
  // 일부는 모듈 내부 헬퍼라 export 가 없다(readCitationDomainDayCounts).
  const start = SRC.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  expect(start, `${name} 를 찾지 못했다`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/^(export )?(async function|interface|const|type) /m);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

const TREND_FNS = [
  "aggregateStandardTrendFromMirror", // KPI 추이 ①~⑤ (표준·웹사이트 공용)
  "aggregateCitationAccuracyTrend", // ⑥ 프로젝트
  "aggregateWebsiteCitationAccuracyTrend", // ⑥ 웹사이트
  "readCitationDomainDayCounts", // 답변분석 인용 추이 (2026-08-12 선례)
];

describe("추이 = 버킷별 스냅샷 (카드와 같은 단위)", () => {
  it("① 셀 키 정본이 프롬프트 × 엔진 × 지역 + 최신 동점 규칙을 **낸다**", () => {
    const bucket = sql`date_trunc('week', a.measured_at)`;
    const k = cellSnapshotKeys({ alias: "a.", bucket });
    // 주석이 아니라 컴파일 결과를 본다 — 키를 하나 빼면 여기서 바로 깨진다.
    expect(compiled(k.cells)).toBe("a.prompt_id, a.target, a.region");
    expect(compiled(k.all)).toBe(
      "a.prompt_id, a.target, a.region, date_trunc('week', a.measured_at)",
    );
    expect(compiled(k.tieBreak)).toBe("a.measured_at DESC");
    // 버킷을 안 주면 3키 — 그때도 셀 3축은 그대로여야 한다.
    expect(compiled(cellSnapshotKeys({ alias: "a." }).all)).toBe(
      "a.prompt_id, a.target, a.region",
    );
  });

  it("② KPI 탭 공용 dedup CTE 가 빌더 키를 쓴다", () => {
    const from = SRC.indexOf("const KPI_TAB_CELL_KEYS");
    expect(from, "KPI_TAB_CELL_KEYS 를 찾지 못했다").toBeGreaterThan(-1);
    // 축 라우터가 들어오면서 키 상수가 둘(종전·앵커)이고 CTE 는 함수가 됐다 —
    // 두 상수 모두 빌더 경유여야 하고, DISTINCT ON 과 ORDER BY 는 **고른 그 하나**의
    // `.all`/`.tieBreak` 를 써야 한다(두 자리가 갈리면 Postgres 가 런타임에 거부한다).
    const cte = SRC.slice(from, from + 1400);
    const keyDecls = cte.match(/cellSnapshotKeys\(\{[^}]*bucket:/g) ?? [];
    expect(keyDecls.length, "버킷 있는 빌더 키 선언이 둘이 아니다").toBe(2);
    expect(cte).toMatch(/DISTINCT ON \(\$\{k\.all\}\)/);
    expect(cte).toMatch(/ORDER BY \$\{k\.all\}, \$\{k\.tieBreak\}/);
    // 앵커 판의 동점 처리는 접힌 measured_at 이 아니라 원본 측정 시각이어야 하고,
    // 동률이면 `job_id` 로 결정적으로 깬다(검증 C — JS 짝과 같은 규칙).
    expect(cte).toMatch(/tieBreak: sql\.raw\("measured_at_orig DESC, job_id DESC"\)/);
  });

  it.each(TREND_FNS)("%s 는 버킷+셀 단위로 DISTINCT ON 한다", (name) => {
    const body = bodyOf(name);
    expect(body).toMatch(/DISTINCT ON/);
    const usesBuilder = /cellSnapshotKeys\(/.test(body);
    // KPI 탭 추이는 자기 문장에 DISTINCT ON 을 적지 않고 공용 CTE(위 ②)를 경유한다.
    const usesSharedCte = /withAnswerSet\(/.test(body);
    expect(usesBuilder || usesSharedCte, `${name}: dedup 키 정본을 안 쓴다`).toBe(true);
    if (usesBuilder) {
      // 버킷이 키에 안 들어가면 전 기간에서 1건만 남아 시계열이 붕괴한다.
      // 앵커 축 판은 `anchorCellSnapshotKeys(...)` 로 회차 키를 **빌더가** 맨 앞에
      // 박으므로 `bucket:` 인자가 없다 — 그 이름도 버킷 있는 키로 인정한다.
      expect(body, `${name}: dedup 키에 버킷이 없다`).toMatch(
        /cellSnapshotKeys\(\{[^}]*bucket:|anchorCellSnapshotKeys\(/,
      );
      // 빌더가 만든 **전체 키 목록**이 dedup 자리에 그대로 들어가야 한다. 경로는 둘 —
      // 자기 문장의 `DISTINCT ON (…)` 이거나, `withAnswerSet` 의 `dedupe.on` 이다
      // (`aggregateStandardTrendFromMirror` 가 후자. 2026-09-19 검증 지적 ③ 로 흡수).
      expect(body, `${name}: dedup 자리에 빌더 키(.all)를 안 쓴다`).toMatch(
        /DISTINCT ON \(\s*\$\{\w+\.all\}|\bon: \w+\.all\b/,
      );
      // 최신 1건 — 동점 처리는 빌더의 tieBreak(= <별칭>measured_at DESC).
      expect(body, `${name}: 동점 처리가 tieBreak 가 아니다`).toMatch(/\$\{\w+\.tieBreak\}/);
    }
    // 버킷 식은 조각 빌더 경유다. 앵커 축 전환 이후 그 자리가
    // `periodBucketSql(...)`(축 라우터 — off 면 `sessionTzBucketSql` 에 그대로 위임)
    // 로 바뀐 함수가 있으므로 둘 다 받는다. 인라인 `date_trunc(` 는 여전히 불합격이다.
    // 2026-09-28(main #300 병합): 축 off 의 주 키가 표면별 조각(`mirrorWeekKey` — 글로벌 =
    // 회차 앵커의 KST 주, 그 외 = 종전 식 문자 그대로)으로 뽑힌 리더는 그 조각을 쓴다.
    // 조각 자체의 형태·값은 `scope-aggregates.global-week-kst.test.ts` 가 고정한다.
    expect(body, `${name}: 버킷 식이 빌더 경유가 아니다`).toMatch(
      /sessionTzBucketSql\(|periodBucketSql\(|mirrorWeekKey\(/,
    );
  });

  it("DISTINCT ON 식은 바인드 파라미터가 아니라 리터럴 버킷을 쓴다", () => {
    // Postgres 는 DISTINCT ON 식이 ORDER BY 선두와 **문자적으로** 같기를 요구한다.
    // date_trunc(${field}, …) 처럼 파라미터로 넣으면 두 자리가 $1/$2 로 갈려
    // "SELECT DISTINCT ON expressions must match initial ORDER BY expressions" 로
    // 런타임에 죽는다(유닛 테스트는 SQL 을 실행하지 않아 못 잡는다).
    //
    // 버킷 식이 빌더 경유가 된 뒤에도 같은 위험이 남는다 — 그래서 빌더가 단위를
    // **리터럴로 굳히는지**를 여기서 본다.
    const tz = readFileSync(
      fileURLToPath(new URL("../../period/sql-day.ts", import.meta.url)),
      "utf8",
    );
    expect(tz, "sessionTzBucketSql 이 단위를 리터럴로 굳히지 않는다").toMatch(
      /sql\.raw\(`'\$\{unit\}'`\)/,
    );
    for (const name of TREND_FNS) {
      const body = bodyOf(name);
      if (!/DISTINCT ON/.test(body)) continue;
      expect(body, `${name}: 버킷 식에 바인드 파라미터가 쓰였다`).not.toMatch(
        /DISTINCT ON \([^)]*date_trunc\(\$\{field\}/,
      );
    }
  });
});
