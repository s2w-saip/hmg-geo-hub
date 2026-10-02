import "server-only";
import { sql, type SQL } from "drizzle-orm";
import {
  anchorLedgerServableSql,
  anchorNotHiddenSql,
  type AnchorHiddenFamily,
} from "@/lib/db/repositories/scope-answer-anchors";
import { answerAnchorEnabled } from "./anchor-axis-flag";

/**
 * 앵커 축 판정의 **요청 전 확정** — `lib/db/column-availability.ts` 의 계약 ①을
 * 그대로 옮긴 것이다.
 *
 * 왜 필요한가: 기간 술어를 만드는 빌더(`answerWhere`·`latestAnswerIds`·dedup 키)는
 * **동기**인데 판정(`answerAnchorEnabled`)은 비동기다(설정 행 읽기 + 컬럼 프로브).
 * 판정을 빌더 안에서 논블로킹으로 읽으면 **한 렌더 안에서 문장마다 축이 갈린다** —
 * 카드는 앵커 축, 추이는 측정 축이 되어 같은 화면의 모수가 어긋난다. 이 리포가
 * 2026-09-10 에 정확히 그 형태로 값이 흔들린 전례가 있다(콜드 람다의 첫 호출만
 * 다른 술어 → `mirrorCache` 에 2시간 굳음).
 *
 * 그래서 계약이 둘이다:
 *   ① SQL 을 만드는 **async 진입점은 첫 줄에서 `await ensureAnchorAxis()`** 를 부른다.
 *      (`await ensureColumnAvailability()` 바로 옆이 그 자리다.)
 *   ② 동기 빌더는 `anchorAxisKnownEnabled()` 만 읽는다. 미확정이면 **false**
 *      = 종전 축이고, 그 경우 경고를 한 번 남긴다(새 진입점이 ensure 를 빠뜨린 신호).
 *
 * ── 미확정 폴백이 `false` 인 것이 왜 안전한가 ───────────────────────────────
 * column-availability 와 달리 여기 폴백은 "값이 조금 다른 술어"가 아니라 **오늘
 * 프로덕션이 내는 바로 그 술어**다. 즉 최악의 경우도 "축 전환이 안 켜진다"이지
 * 틀린 숫자가 아니다. 그래도 경고를 남기는 이유는, 켰는데 일부 화면만 안 바뀌는
 * 상태가 **화면만 봐서는 안 보이기 때문**이다.
 *
 * ── TTL ────────────────────────────────────────────────────────────────────
 * 화면 키는 `summary_settings` 한 행이고 그 원문 읽기는 이미 30초 메모다. 여기서
 * 같은 주기를 쓰면 "설정을 껐는데 축이 안 돌아온다" 창이 그 이상으로 길어지지 않는다.
 * 확정된 값을 영구 캐시하지 않는 것이 `column-availability` 와 다른 점이다 — 저쪽의
 * true 는 "컬럼이 생겼다"(되돌아가지 않음)이고, 이쪽은 사람이 끄고 켜는 스위치다.
 */

const TTL_MS = 30_000;

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
const NOT_HIDDEN_ALIASES = ["ca", "ca2"] as const;
export type AnchorGateAlias = (typeof NOT_HIDDEN_ALIASES)[number];

/**
 * 미리 만들어 두는 **계열**. 종전에는 `'all'` 하나였는데, 답변 경로의 데이터 술어에도
 * 숨김 게이트를 걸면서(검증 D) 계열이 필요해졌다 — `'all'` 은 회차 **집합** 판정
 * (달력·기간 후보·최신 회차 선택)용이고, 데이터 술어는 화면 계열을 따라야 한다.
 */
const NOT_HIDDEN_FAMILIES = ["mentions", "citations", "all"] as const;

type AxisState = {
  value: boolean;
  /** `[계열][별칭]` — ensure 시점에 6개를 한 번에 만들어 둔다. */
  notHidden: Record<AnchorHiddenFamily, Record<AnchorGateAlias, SQL>>;
  /**
   * 별칭별 **함대 게이트**(원장이 서빙을 허락한 회차인가). 계열과 무관하다 —
   * 숨김은 계열을 보지만 발행·`fleet_visible` 은 안 본다.
   */
  ledgerServable: Record<AnchorGateAlias, SQL>;
  expiresAt: number;
};

let state: AxisState | null = null;
let inflight: Promise<boolean> | null = null;
let warned = false;

/** 판정이 아직 없을 때의 자리표시자 — 실제로 읽히는 경로가 없어야 한다. */
const unresolvedNotHidden = (): Record<AnchorHiddenFamily, Record<AnchorGateAlias, SQL>> =>
  Object.fromEntries(
    NOT_HIDDEN_FAMILIES.map((f) => [
      f,
      Object.fromEntries(NOT_HIDDEN_ALIASES.map((a) => [a, sql`true`])),
    ]),
  ) as Record<AnchorHiddenFamily, Record<AnchorGateAlias, SQL>>;

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function resetAnchorAxisForTests(): void {
  state = null;
  inflight = null;
  warned = false;
}

/**
 * 테스트 전용 — DB 없이 판정값을 고정한다(축이 켜진 경로의 SQL 형태 검증용).
 *
 * 숨김 조각은 `notHidden` 으로 주입할 수 있다. 생략하면 0070 미적용과 같은 `true` 라
 * SQL 텍스트가 짧아진다(컬럼 있는 배포의 형태를 보려면 명시할 것).
 */
export function setAnchorAxisForTests(
  value: boolean,
  /** 별칭별 조각. 계열을 안 적으면 **전 계열**에 같은 값을 넣는다(종전 호출부 호환). */
  notHidden?: Partial<Record<AnchorGateAlias, SQL>>,
  /**
   * 계열별 조각 — 계열 라우팅을 텍스트로 구분해야 하는 테스트용. `notHidden` 위에
   * 덮어쓴다(전 계열 공통값을 깐 뒤 특정 계열만 갈아 끼우는 순서).
   */
  perFamily?: Partial<Record<AnchorHiddenFamily, Partial<Record<AnchorGateAlias, SQL>>>>,
  /** 함대 게이트 조각 — 원장 술어가 SQL 에 붙는지 보는 테스트용. */
  ledgerOverride?: Partial<Record<AnchorGateAlias, SQL>>,
): void {
  const base = unresolvedNotHidden();
  if (notHidden) {
    for (const f of NOT_HIDDEN_FAMILIES) base[f] = { ...base[f], ...notHidden };
  }
  if (perFamily) {
    for (const f of NOT_HIDDEN_FAMILIES) {
      if (perFamily[f]) base[f] = { ...base[f], ...perFamily[f] };
    }
  }
  state = {
    value,
    notHidden: base,
    ledgerServable: Object.fromEntries(
      NOT_HIDDEN_ALIASES.map((a) => [a, ledgerOverride?.[a] ?? sql`true`]),
    ) as Record<AnchorGateAlias, SQL>,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  inflight = null;
}

/**
 * 판정을 **확정**한다. 이미 확정돼 있으면 왕복이 없고, 동시에 여러 진입점이 불러도
 * 발사는 1회다. 절대 throw 하지 않는다 — 판정 실패가 화면 장애가 되면 안 되고,
 * 실패의 의미는 "종전 축"이라 값이 틀릴 방향이 없다.
 */
export async function ensureAnchorAxis(): Promise<boolean> {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await answerAnchorEnabled();
      // 축이 꺼져 있으면 숨김 조각은 쓰이지 않는다 — 프로브를 더 쏘지 않는다.
      const notHidden = value
        ? ((Object.fromEntries(
            await Promise.all(
              NOT_HIDDEN_FAMILIES.map(async (f) => [
                f,
                Object.fromEntries(
                  await Promise.all(
                    NOT_HIDDEN_ALIASES.map(async (a) => [a, await anchorNotHiddenSql(f, a)]),
                  ),
                ),
              ]),
            ),
          ) as Record<AnchorHiddenFamily, Record<AnchorGateAlias, SQL>>))
        : unresolvedNotHidden();
      // 함대 게이트(원장 발행·fleet_visible·노출·숨김). 축이 꺼져 있으면 안 만든다.
      const ledgerServable = value
        ? ((Object.fromEntries(
            await Promise.all(
              NOT_HIDDEN_ALIASES.map(async (a) => [a, await anchorLedgerServableSql(a)]),
            ),
          ) as Record<AnchorGateAlias, SQL>))
        : (Object.fromEntries(
            NOT_HIDDEN_ALIASES.map((a) => [a, sql`true`]),
          ) as Record<AnchorGateAlias, SQL>);
      state = { value, notHidden, ledgerServable, expiresAt: Date.now() + TTL_MS };
      return value;
    } catch (e) {
      console.error("[anchor-axis] 판정 실패 — 종전 축으로 간다", e);
      state = {
        value: false,
        notHidden: unresolvedNotHidden(),
        ledgerServable: Object.fromEntries(
          NOT_HIDDEN_ALIASES.map((a) => [a, sql`true`]),
        ) as Record<AnchorGateAlias, SQL>,
        expiresAt: Date.now() + TTL_MS,
      };
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 동기 빌더가 읽는 **숨김 게이트 조각**(계열 `'all'`). `ensureAnchorAxis()` 이후에만
 * 의미가 있고, 미확정이면 `true` 다 — 다만 그때는 `anchorAxisKnownEnabled()` 도 false 라
 * 이 값을 읽는 경로에 도달하지 않는다(그 성질을 테스트가 고정한다).
 */
export function anchorNotHiddenKnownSql(
  alias: AnchorGateAlias,
  /**
   * 지표 계열. 기본값이 `'all'` 인 이유: 이 함수의 원래 소비처가 **회차 집합 판정**
   * (최신 회차를 고르는 스칼라 서브쿼리)이고, 그 자리는 계열과 무관하게 전부
   * 제외하는 것이 맞다(0071 COMMENT). 데이터 술어는 계열을 **명시**한다.
   */
  family: AnchorHiddenFamily = "all",
): SQL {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.notHidden[family][alias];
  return sql`true`;
}

/**
 * 동기 빌더가 읽는 **함대 게이트 조각** — "원장이 이 회차를 지금 서빙해도 된다고
 * 말하는가". 집계층(`pickWebsiteCycles`)이 카드의 기준 회차를 고르는 규칙과 같은 술어다.
 * 미확정이면 `true`(제약 없음)이고, 그때는 축도 꺼져 있어 이 값이 SQL 에 안 붙는다.
 */
export function anchorLedgerServableKnownSql(alias: AnchorGateAlias): SQL {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.ledgerServable[alias];
  return sql`true`;
}

/**
 * 동기 빌더가 읽는 판정값. **호출 전에 `ensureAnchorAxis()` 가 await 돼 있어야 한다.**
 * 미확정이면 종전 축(false)으로 나가고 프로세스당 한 번 경고한다.
 */
export function anchorAxisKnownEnabled(): boolean {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.value;
  if (!warned) {
    warned = true;
    console.warn(
      "[anchor-axis] 판정 전에 동기 SQL 빌더가 호출됐다 — 이번 호출은 종전 축으로 " +
        "나간다. 그 진입점에 `await ensureAnchorAxis()` 를 추가하라.",
    );
  }
  return false;
}
