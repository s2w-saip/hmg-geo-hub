// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
import { type AnchorHiddenFamily } from "@/lib/db/repositories/scope-answer-anchors";
/**
 * 동기 빌더가 쓰는 **숨김 게이트 조각**의 별칭 목록.
 *
 * `anchorNotHiddenSql` 은 컬럼 프로브 때문에 async 인데, "기간 없음 = 최신 회차" 를
 * 고르는 스칼라 서브쿼리는 **동기 빌더 안**에 있다. 숨김을 빼고 최신 회차를 고르면
 * 수집이 깨져 숨긴 회차가 기본 화면의 기준 회차가 된다 — 값이 사라지는 방향이 아니라
 * **틀린 값이 나오는** 방향이라 화면만 봐서는 안 보인다.
 *
 * 그래서 조각을 **ensure 시점에 미리 만들어 둔다**. 정의는 여전히
 * `scope-answer-anchors.ts` 한 곳이고(두 벌 금지), 여기서는 그 결과를 들고만 있다.
 * 별칭 둘뿐인 이유: `ca` = 조인·semi-join 안, `ca2` = 최신 회차 스칼라 서브쿼리 안.
 */
declare const NOT_HIDDEN_ALIASES: readonly ["ca", "ca2"];
export type AnchorGateAlias = (typeof NOT_HIDDEN_ALIASES)[number];
/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export declare function resetAnchorAxisForTests(): void;
/**
 * 테스트 전용 — DB 없이 판정값을 고정한다(축이 켜진 경로의 SQL 형태 검증용).
 *
 * 숨김 조각은 `notHidden` 으로 주입할 수 있다. 생략하면 0070 미적용과 같은 `true` 라
 * SQL 텍스트가 짧아진다(컬럼 있는 배포의 형태를 보려면 명시할 것).
 */
export declare function setAnchorAxisForTests(value: boolean,
/** 별칭별 조각. 계열을 안 적으면 **전 계열**에 같은 값을 넣는다(종전 호출부 호환). */
notHidden?: Partial<Record<AnchorGateAlias, SQL>>,
/**
 * 계열별 조각 — 계열 라우팅을 텍스트로 구분해야 하는 테스트용. `notHidden` 위에
 * 덮어쓴다(전 계열 공통값을 깐 뒤 특정 계열만 갈아 끼우는 순서).
 */
perFamily?: Partial<Record<AnchorHiddenFamily, Partial<Record<AnchorGateAlias, SQL>>>>,
/** 함대 게이트 조각 — 원장 술어가 SQL 에 붙는지 보는 테스트용. */
ledgerOverride?: Partial<Record<AnchorGateAlias, SQL>>): void;
/**
 * 판정을 **확정**한다. 이미 확정돼 있으면 왕복이 없고, 동시에 여러 진입점이 불러도
 * 발사는 1회다. 절대 throw 하지 않는다 — 판정 실패가 화면 장애가 되면 안 되고,
 * 실패의 의미는 "종전 축"이라 값이 틀릴 방향이 없다.
 */
export declare function ensureAnchorAxis(): Promise<boolean>;
/**
 * 동기 빌더가 읽는 **숨김 게이트 조각**(계열 `'all'`). `ensureAnchorAxis()` 이후에만
 * 의미가 있고, 미확정이면 `true` 다 — 다만 그때는 `anchorAxisKnownEnabled()` 도 false 라
 * 이 값을 읽는 경로에 도달하지 않는다(그 성질을 테스트가 고정한다).
 */
export declare function anchorNotHiddenKnownSql(alias: AnchorGateAlias,
/**
 * 지표 계열. 기본값이 `'all'` 인 이유: 이 함수의 원래 소비처가 **회차 집합 판정**
 * (최신 회차를 고르는 스칼라 서브쿼리)이고, 그 자리는 계열과 무관하게 전부
 * 제외하는 것이 맞다(0071 COMMENT). 데이터 술어는 계열을 **명시**한다.
 */
family?: AnchorHiddenFamily): SQL;
/**
 * 동기 빌더가 읽는 **함대 게이트 조각** — "원장이 이 회차를 지금 서빙해도 된다고
 * 말하는가". 집계층(`pickWebsiteCycles`)이 카드의 기준 회차를 고르는 규칙과 같은 술어다.
 * 미확정이면 `true`(제약 없음)이고, 그때는 축도 꺼져 있어 이 값이 SQL 에 안 붙는다.
 */
export declare function anchorLedgerServableKnownSql(alias: AnchorGateAlias): SQL;
/**
 * 동기 빌더가 읽는 판정값. **호출 전에 `ensureAnchorAxis()` 가 await 돼 있어야 한다.**
 * 미확정이면 종전 축(false)으로 나가고 프로세스당 한 번 경고한다.
 */
export declare function anchorAxisKnownEnabled(): boolean;
export {};
