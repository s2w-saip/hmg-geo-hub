// Type-only snapshot; no database or server implementation is included.
import { type SQL } from "drizzle-orm";
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
export declare function websiteOwnedUnitCte(units: readonly WebsiteOwnedUnit[], name?: string): SQL;
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
export declare function websiteUnitOwnedClause(norm: SQL, alias: string): SQL;
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
export declare function websiteUnitOwnedTargetClause(baseNorm: SQL, trackedNorm: SQL, alias: string): SQL;
