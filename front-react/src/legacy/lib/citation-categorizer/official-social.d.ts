// Type-only snapshot; no database or server implementation is included.
/** 한 계정을 가리키는 매칭 규칙 하나. */
export interface OfficialSocialMatcher {
    /**
     * 정규화된 `"<registrable domain>/<path>"` 프리픽스 — 전부 소문자.
     * (정규화 정의는 이 파일의 `citationPathKeyOf`. SQL 쌍둥이는
     * `lib/db/repositories/citation-group-key.ts`.)
     */
    prefix: string;
    /**
     * `true`  — 프리픽스 뒤가 `/` 이거나 문자열 끝이어야 매칭(세그먼트 경계).
     *           쿼리·프래그먼트는 정규화 단계에서 이미 잘려나가므로 `?`·`#` 는
     *           여기서 따질 필요가 없다.
     *           예) `instagram.com/hyundai` 는 `/hyundaiindia` 를 잡지 않는다.
     * `false` — 프리픽스가 **자기 구분자를 이미 포함**한 경우(경계 검사 불필요).
     *           LinkedIn 게시물 URL 은 `/posts/<handle>_<슬러그>` 형태라 핸들의
     *           끝을 표시하는 것이 `_` 자신이다. 여기에 세그먼트 경계를 요구하면
     *           게시물이 하나도 안 잡힌다.
     */
    boundary: boolean;
}
/** 그룹 키 하나 = 공식 소셜 계정 하나. */
export interface OfficialSocialAccount {
    /**
     * 화면·집계에 실리는 **그룹 키**(= 표시값). 표기용 대소문자를 그대로 쓴다.
     * `/` 를 포함하므로 registrable domain 과 절대 충돌하지 않는다.
     */
    key: string;
    /** 이 키가 속한 registrable domain — 경로 정규화를 켤지 정하는 게이트. */
    domain: string;
    /** 이 계정으로 접을 URL 매칭 규칙(하나 이상). */
    matchers: readonly OfficialSocialMatcher[];
}
/**
 * 공식 HMG 소셜 계정 목록 — SQL·JS 공용 정본.
 *
 * ⚠️ 이 배열을 고치면 **양쪽 읽기 경로가 함께** 바뀐다(그것이 설계 의도다).
 * 한쪽에만 목록을 복제하면 live/mirror 패리티가 깨진다 — 이 리포의 핵심
 * 불변식이며 `official-social.parity.test.ts` 가 이를 강제한다.
 *
 * 각 항목의 실측치는 2026-08-28 프로덕션 미러(scope_citations 2,461,479행) 기준.
 */
export declare const OFFICIAL_SOCIAL_ACCOUNTS: readonly OfficialSocialAccount[];
/**
 * 경로 정규화를 켤 registrable domain 집합.
 *
 * **성능 게이트다.** 인용 미러는 240만 행이고 URL 정규화는 행당 문자열 연산
 * 여러 번이다. 이 집합에 든 도메인(약 5.7만 행)에서만 정규화를 돌리고 나머지는
 * 도메인을 그대로 통과시킨다 — SQL 쪽도 같은 게이트를 바깥 CASE 로 두어
 * 동일하게 단락(short-circuit)시킨다(`citationOwnedBaseSql` 이 owned 후보
 * 도메인에만 정규화를 거는 것과 같은 수법).
 */
export declare const OFFICIAL_SOCIAL_DOMAINS: ReadonlySet<string>;
/**
 * 인용 URL → 매칭용 정규화 문자열 `"<registrable domain><경로>"`.
 *
 * **SQL 쌍둥이와 문자 단위로 같아야 한다** (`citationPathKeyExprSql`,
 * `scripts/scope/verify-citation-group-key.ts` 가 실 DB 로 강제).
 * 단계 정의 — 순서가 계약이다:
 *   1. url 트림 → 소문자
 *   2. 선행 `https://`·`http://` 제거
 *   3. **첫 `/` 부터**를 경로로 취한다(없으면 경로 없음). 호스트를 이렇게
 *      통째로 버리기 때문에 `www.` 든 `kr.` 든 `m.` 든 서브도메인이 알아서
 *      접힌다 — 그리고 앞에 붙이는 것은 미러가 이미 계산해 둔 **registrable
 *      domain** 이라 `kr.linkedin.com/…` 도 `linkedin.com/…` 과 같은 키가 된다.
 *      (2026-08-28 실측: 서브도메인을 접지 않으면 linkedin 공식 계정 317건 중
 *      95건이 누락된다.)
 *   4. 쿼리(`?…`)·프래그먼트(`#…`) 절단 → 그래서 경계 문자는 `/` 와 끝뿐이다
 *   5. `%40` → `@` (Threads 가 `@` 를 인코딩해 보낸다)
 */
export declare function citationPathKeyOf(domain: string | null | undefined, url: string | null | undefined): string;
/**
 * 이 인용이 공식 HMG 소셜 계정의 것이면 그 **그룹 키**, 아니면 null.
 * 목록에 없는 도메인은 문자열 연산 없이 즉시 빠진다(위 성능 게이트).
 */
export declare function officialSocialKeyOf(domain: string | null | undefined, url: string | null | undefined): string | null;
/**
 * 인용 한 건의 **그룹 키** — 공식 소셜 계정이면 `도메인+계정경로`,
 * 아니면 종전과 동일한 lowercase registrable domain.
 *
 * 라이브(result-adapter) 경로가 부르는 진입점이고, 미러(SQL) 경로는
 * `citationGroupKeySql` 이 같은 배열로 같은 값을 만든다.
 */
export declare function citationGroupKey(domain: string | null | undefined, url: string | null | undefined): string;
/**
 * 주어진 값이 공식 소셜 계정 그룹 키인가 (대소문자 무시).
 * `categorizeDomain` 이 host+path 키를 `Official (HMG)` 로 판정하는 데 쓴다 —
 * 이 키는 도메인 정규화·seed·rules 어디에도 걸리지 않기 때문이다.
 */
export declare function isOfficialSocialKey(value: string | null | undefined): boolean;
