import { sql, type SQL } from "drizzle-orm";

// ── website 자사 판정 · **유닛 단위**(per-row) ───────────────────────────────
//
// 문제: website 표면은 자사 base 집합을 `websiteDeclaredOwnedBases` 가 화면 스코프
// 전 사이트의 `website_prompts.owned_base_url` 을 **DISTINCT 평면 합집합**으로 만들어
// (무필터 함대면 약 170개) 모든 프롬프트에 같은 집합을 적용했다. 그래서 Kia Greece 의
// 프롬프트가 `hyundaiusa.com` 을 인용해도 자사로 잡혔다. 게다가 무필터에서는
// `prefixes` 와 `universe` 가 같아져 `ownedBasePrefixClause` 의 longerSiblings(형제 제외)
// 가 **공집합으로 꺼지고**, 루트 홈 규칙도 flat 호스트 전체에 걸린다.
//
// 실측(미러 9/11 회차, 메인 실행 — notes/hmg-anchor-table/website-citation-parity/
// W6-owned-per-site.{sql,csv}):
//   · 리포트 '완료' 13개(u 038·051·052·053·054·066·069·107·108·128·129·139·140)
//     flat 882/966 = 91.30% vs **유닛 775/966 = 80.23%** = 리포트와 정수까지 동일.
//     13개 사이트 전부 사이트별로도 리포트 co 와 일치했다.
//   · 최대 왜곡 Hyundai Middle East EN 7 → 38, AR 2 → 36.
//   · 전체 flat 9,006/9,982 = 90.22% vs 유닛 7,848/9,982 = 78.62%.
//
// 정본은 리포트 추출기(`scripts/reports/extract-citation-data.mts` 의 OWNED)와 집계
// 사실표(`scripts/summary/surface-website.ts::unitOwnedSql`, 머리 주석 "정본 엑셀의
// 자사=1 과 같은 술어")다. 둘 다 같은 함수 `ownedBasePrefixClause` 를 쓰되 base 를
// **그 프롬프트가 속한 유닛 하나**로 좁혀 넘긴다. 이 모듈은 그것을 대시보드에서도
// 할 수 있게, base 를 리터럴이 아니라 **컬럼**으로 받는 판정식을 만든다.
//
// ⚠️ `ownedBasePrefixClause`(scope-aggregates.ts:681)와 **같은 판정**이어야 한다.
//    `[base]` + `[base, ...sibs]` 를 넘긴 그 함수와 아래 식이 같은 답을 내는지
//    `website-owned-unit.pglite.test.ts` 가 실행으로 대조한다. 두 구현이 갈리면
//    화면과 리포트·사실표가 다시 어긋난다.
//
// ⚠️ 판정 입력은 **base NORM**(쿼리 제거, `citation_url_base_norm` / `url_base_norm`)이다.
//    tracked NORM(쿼리 보존)으로 옮겨 적었다가 엑셀 대비 11 job·13건이 적게 잡힌
//    전례가 있다(surface-website.ts:216). ⑥ 경로만 tracked NORM 을 쓴다 — 그쪽은
//    비교 상대(`n`)가 tracked 라 같은 종류끼리 맞춘 것이다.

/** 한 측정 유닛(사이트 × file_seq)의 자사 판정 입력. 화면 필터와 무관한 고유값이다. */
export type WebsiteOwnedUnit = {
  /** `website_sites.id` */
  siteId: string;
  /** `website_prompts.file_seq` — 리포트 u 의 정본(surface-website.ts:115). */
  fileSeq: number;
  /**
   * 이 유닛의 자사 base. **`ownedBasePrefixFromUrl` 을 이미 거친 프리픽스 형태**다
   * (`ownedBasePrefixClause` 가 리터럴에 그 변환을 거는 자리를 여기서 미리 한다).
   */
  base: string;
  /** 같은 호스트의 **더 긴 선언 base**(다른 유닛 자산) — 자사에서 뺀다. 프리픽스 형태. */
  sibs: string[];
  /** 사이트 루트 홈 = 자사. 공유 글로벌 호스트면 `null`(그 규칙에서 제외). */
  homeHost: string | null;
};

/** 유닛 행을 `VALUES` CTE 로. 함대 전체라도 수백 행이라 문장에 그대로 싣는다. */
export function websiteOwnedUnitCte(units: readonly WebsiteOwnedUnit[], name = "wu"): SQL {
  const cols = sql.raw(`${name}(site_id, file_seq, unit_base, unit_sibs, unit_home_host)`);
  if (units.length === 0) {
    // 빈 유닛 목록에서도 컬럼 타입이 잡혀야 조인이 42P18 로 죽지 않는다.
    return sql`${cols} AS (
      SELECT NULL::uuid, NULL::int, NULL::text, NULL::text[], NULL::text WHERE false
    )`;
  }
  return sql`${cols} AS (VALUES ${sql.join(
    units.map(
      (u) => sql`(${u.siteId}::uuid, ${u.fileSeq}::int, ${u.base}::text,
                  ${sql.param(u.sibs)}::text[], ${u.homeHost}::text)`,
    ),
    sql`, `,
  )})`;
}

/**
 * per-row 자사 판정. `norm` 은 인용의 정규화 값(자사 계열이면 base NORM),
 * `alias` 는 `unit_base`·`unit_sibs`·`unit_home_host` 를 들고 있는 행의 별칭이다.
 *
 * `ownedBasePrefixClause(norm, [base], [base, ...sibs])` 와 단계가 1:1 대응한다:
 *   ① 호스트 사전필터            `split_part(norm,'/',1) = split_part(base,'/',1)`
 *   ② 접두 매칭 + `.html` 동치   `norm = b OR norm LIKE b||'/%' OR norm = b||'.html'`
 *   ③ 형제(더 긴 선언) 제외      ②를 형제 배열에 돌려 하나라도 맞으면 탈락
 *   ④ 루트 홈 = 자사             `rtrim(split_part(norm,'?',1),'/') = home_host`
 * 유닛이 없거나 base 가 비면 `false`(그 함수의 `prefixes.length === 0` 분기와 같다).
 */
export function websiteUnitOwnedClause(norm: SQL, alias: string): SQL {
  const a = (col: string) => sql.raw(`${alias}.${col}`);
  const base = a("unit_base");
  const m = (p: SQL) => sql`(${norm} = ${p} OR ${norm} LIKE ${p} || '/%' OR ${norm} = ${p} || '.html')`;
  const sibHit = sql`EXISTS (SELECT 1 FROM unnest(${a("unit_sibs")}) AS s(p) WHERE ${m(sql.raw("s.p"))})`;
  const rootHome = sql`(${a("unit_home_host")} IS NOT NULL
      AND rtrim(split_part(${norm}, '?', 1), '/') = ${a("unit_home_host")})`;
  return sql`(coalesce(${base}, '') <> ''
      AND split_part(${norm}, '/', 1) = split_part(${base}, '/', 1)
      AND ((${m(base)} AND NOT ${sibHit}) OR ${rootHome}))`;
}

/**
 * 유닛 자사 판정의 **완전형** — base 항 + **"타겟 ⊂ 자사"** 항.
 *
 * ── 정본은 리포트 추출기다 (2026-09-20 검증 F 수리) ──────────────────────────
 * `scripts/reports/extract-citation-data.mts:83`
 * ```
 * OWNED(a) = ((under(a, BASE) AND NOT sib) OR a.tn IN (SELECT turl FROM tset) OR rootHome(a.bn))
 *   bn   = base NORM(쿼리 제거)        ← base 항의 입력
 *   tn   = tracked NORM(쿼리 보존)     ← 타겟 항의 입력
 *   tset = DISTINCT tracked NORM(target_url) over **그 유닛의 프롬프트 전체**(lp)
 * ```
 * 즉 타겟 항은 ① **tracked NORM** 으로 비교하고 ② 범위가 **그 프롬프트 하나가 아니라
 * 유닛 전체**다. 초판은 이 둘을 각각 틀렸고(⑤ 계열 = base NORM·프롬프트 하나, 카드 =
 * tracked NORM·프롬프트 하나) 그래서 한 리포에 정의가 **세 벌**이었다. 이 함수 하나로
 * 모은다 — 비교 상대 `unit_turls` 는 `wup` CTE 가 싣는 그 유닛의 tset 이다.
 *
 * ⚠️ 입력이 **둘**인 것이 핵심이다: `baseNorm` 은 base 항에, `trackedNorm` 은 타겟 항에.
 *    한쪽으로 몰면 갈린다 — base NORM 으로 타겟을 비교하면 쿼리가 붙은 타겟
 *    (`…/ev6?trim=gt`)이 쿼리 없는 인용과 잘못 일치하고, tracked NORM 으로 base 를
 *    비교하면 쿼리가 붙은 인용이 base 밖으로 떨어진다(surface-website.ts:216 의 11 job 전례).
 *
 * `= ANY(coalesce(…, ARRAY[]::text[]))` — 유닛이 없거나 타겟이 없는 행에서 `= ANY(NULL)`
 * 이 NULL 로 새지 않게 빈 배열로 접는다(소비처가 `FILTER`·`bool_or` 라 NULL 은 "아님"
 * 으로 접히지만, 판정식이 NULL 을 내지 않는 편이 읽기·디버깅에 안전하다).
 */
export function websiteUnitOwnedTargetClause(
  baseNorm: SQL,
  trackedNorm: SQL,
  alias: string,
): SQL {
  const turls = sql.raw(`${alias}.unit_turls`);
  return sql`(${websiteUnitOwnedClause(baseNorm, alias)}
      OR ${trackedNorm} = ANY(coalesce(${turls}, ARRAY[]::text[])))`;
}
