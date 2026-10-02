import "server-only";
import { cache } from "react";
import { createHash } from "node:crypto";
import { summaryScreenAllowed } from "@/lib/summary/read/screens";
import { readPreCatalogCycleIds } from "@/lib/db/repositories/summary-pre-catalog-cycles";
import { ensureAnchorAxis } from "./anchor-axis-state";

// ════════════════════════════════════════════════════════════════════════════
// 추이 격자(`X.trendGrid`)의 on/off — 화면 키 + **프리뷰 전용** env
// `TREND_GRID_FORCE` + 선행 조건 `X.answerAnchor`
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md`
// §4(D2 = A) · §7(D5 추이 축 통일) · §9-1(옵트인 키 3층) · §11 W1·W3·W4.
//
// ── 이 키 하나가 켜는 것 둘 ─────────────────────────────────────────────────
//
// 설계가 PR①·PR② 로 나눈 두 변경이 **같은 키**에 묶여 있다(설계 §9-2 의 "옵트인은
// 기존 `S1.dashboard` 안에 두지 않고 `X.trendGrid` 에 묶는다"). 되돌릴 때도 한 줄이다.
//
//   ① **값**(PR①) — 추이 축에서 `in_full_cycle` 게이트를 걸지 않는다(설계 §4-A).
//      그 게이트는 미러의 7일 롤링 창 스냅샷을 위해 만들어진 것이고, 회차 축에서는
//      전제가 두 번 깨진다(회차 자체가 한 번의 측정 주기다 · 분모가 생성 시점의
//      미러 이력에 의존한다).
//      **값 영향(2026-09-20 미러 실측, `verify/out/G1c-…csv` 사다리, 함대 대표 기준)**:
//      08-17 332 → **1,539**(4.6배) · 08-10 742 → 1,259(1.7배) · 08-03 2,602 → 2,640
//      (1.015배) · 08-24 18,662 → 18,716 · 08-31 무변화.
//      ⚠️ 초판 주석의 "10~20배 회복" 은 **틀렸다** — W0 의 "창 안 셀/기대 셀" 비를
//      분모 회복 배수로 읽은 오류다. 과거 분모를 실제로 지배하는 것은 이 게이트가
//      아니라 지역 스코핑·카탈로그 게이트이고, 그쪽은 ③ 이 정렬한다.
//      대신 **회차 완결성**(원장 `completion_ratio`)이 임계 미만인 자리를 갭으로
//      낸다(`lib/summary/read/cycle-completion.ts`).
//   ② **모양**(PR②) — 자리 목록(원장이 낸다) · 창(날짜가 아니라 **자리 개수** N=13) ·
//      갭 정책. 격자 자체는 `lib/period/trend-grid.ts` 다.
//   ③ **미러 폴백의 모수**(PR④) — 사실표가 없는 자리에서 미러가 대신 그릴 때도 같은
//      정의를 쓴다: 루트 지역 스코핑 2종(한국어 비-KR · 시장 태그) + 함대 대표 게이트
//      + 회차 `summary_prompt_dim` 스냅샷 판정. 정의·근거·실측은
//      `scope-aggregates.ts::trendAlignedRootPreds` 머리 주석이 정본이다.
//      **이 몫이 ①보다 훨씬 크다**: 08-03 미러 8,386 → 2,640 · 08-17 6,706 → 1,539.
//
// **안 바꾸는 것: 값의 원천.** 집계층이냐 미러냐는 `S*.…` 키들이 정한다.
// **스냅샷 카드도 안 바꾼다** — 카드는 "가장 최신 회차의 상태" 이고 그 자리에서는 완전
// 커버 요구가 여전히 합리적이다(설계 §4-2 의 부작용 문단). 읽는 자리는 둘로 갈린다:
//   · 사실표 추이 리더 셋 — `readGlobalTrendCore`·`readGlobalBrandSnapshot`·
//     `readGlobalBrandSeries`(카드 리더 `summary-global-aggregates.ts` 는 import 하지 않는다).
//   · 미러 추이 술어 — `scope-aggregates.ts` 의 `allRuns` 분기 **한 곳**
//     (`trendAlignedRootPreds`). 스냅샷·누적 분기는 타지 않는다.
//
// 키를 셋으로 나누는 이유(설계 §9-1): 축(`X.answerAnchor`)·격자(`X.trendGrid`)·
// 원천(`S1.dashboard` 등)은 **독립적으로 되돌릴 수 있어야 한다**. 격자를 켰는데 점
// 개수가 이상하면 격자만 끄고 원천은 유지할 수 있어야 하고, 반대도 마찬가지다.
//
// ── 선행 조건: 축이 꺼져 있으면 격자도 꺼진다 ───────────────────────────────
//
// 자리 키가 **회차 귀속 날짜**(`round_date`)이므로, 축이 꺼진 배포에는 그 값 자체가
// 없다(0077 앵커 표 미적용이면 컬럼도 없다). 그 상태에서 격자만 켜면 자리 목록이
// 앵커 UTC 일자로 서고 데이터 점은 종전 키로 서서 **모든 점이 갭이 된다** — 값이
// 사라지는 방향이라 화면만 봐서는 원인을 못 찾는다. 완결성 갭도 같은 이유로 엉뚱한
// 날에 끼워진다. 그래서 게이트가 막는다.
// `ensureAnchorAxis()` 를 쓰는 이유는 그것이 축 판정의 **요청 단위 확정본**이기
// 때문이다(30초 메모 + capability 프로브 포함). 여기서 다시 프로브하지 않는다.
//
// ── 끄면 **바이트 동일** ────────────────────────────────────────────────────
//
//   · SQL    — `trendWhere` 는 `scope.trendGrid` 가 없으면 종전 조건 배열을 그대로 만든다.
//   · 회차   — `judgeCycleRange` 가 `completionRatio` 를 **싣지 않는다**(캐시 키 불변).
//   · 갭     — 자리 목록이 비므로 `insertCompletionGapBuckets` 가 입력 배열을 그대로 돌려준다.
//   · 격자   — `buildTrendGrid` 가 `null` 을 내고 DB 를 건드리지 않는다. 호출부는 종전
//              채움 경로(`fillGaps`·`fillTrendGaps`)를 그대로 쓴다.
//   기간 SQL 스냅샷 78건·fold-probe 테스트가 무수정으로 통과하는 것이 그 성질의 증거다.
//
// ⚠️ **"이 브랜치 전체가 무변경" 은 아니다**(2026-09-20 검증 지적). 같은 브랜치가
//    `1910e33` 을 싣고 있고, 그것이 축 on 의 함대 게이트에서 `AND sc.hidden_reason IS NULL`
//    **한 항**을 뺀다(계열별 숨김 술어 `anchorNotHiddenSql(family)` 로 대체 — 의도된 변경).
//    그래서 정확한 명제는 **"격자 off · 축 on 에서 8c9b3e7 대비 바뀌는 것은 그 한 항뿐"**
//    이고, `lib/db/repositories/trend-aligned-preds.test.ts` 가 8c9b3e7 시점 텍스트를
//    고정 스냅샷(`__fixtures__/grid-off-8c9b3e7.json`)으로 박아 그 한 항만 다른지 단언한다.
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 이 값은 서버에서만 읽힌다.

/** 격자 전환을 켜는 화면 키. 설계 §9-1 에서 이름이 고정돼 있다. */
export const TREND_GRID_SCREEN_KEY = "X.trendGrid" as const;

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가(`anchor-axis-flag.ts` 와 같은 규칙). */
export function trendGridOverrideAllowedHere(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function trendGridForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return trendGridOverrideAllowedHere(env) && env.TREND_GRID_FORCE === "1";
}

/**
 * 이 요청에서 추이가 **격자 판본**을 쓰는가. 판정은 두 겹이고 **둘 다** 참이어야 한다.
 *
 * 순서가 계약이다: ① 스위치(env 는 왕복 0, 화면 키는 30초 메모) → ② 선행 축.
 * 스위치가 꺼져 있으면 축 판정을 **건드리지 않는다** — 오늘 프로덕션(키 off)에서 이
 * 모듈 때문에 늘어나는 일이 0 이어야 하기 때문이다. 반대로 축이 꺼져 있으면 스위치가
 * 무엇이든 false 다(위 머리 주석의 선행 조건).
 */
export async function trendGridEnabled(): Promise<boolean> {
  const switchedOn =
    trendGridForced() || (await summaryScreenAllowed(TREND_GRID_SCREEN_KEY));
  if (!switchedOn) return false;
  // 축이 꺼져 있으면 자리 키(`round_date`)가 없다 — 머리 주석의 선행 조건.
  return ensureAnchorAxis();
}

// ── 요청 단위 확정 (`anchor-axis-state.ts` 의 계약 ①을 그대로 옮긴 것) ───────
//
// 한 렌더가 추이를 여러 번 부른다(카드 스파크·히어로·브랜드·순위). 판정이 문장마다
// 갈리면 같은 화면에서 축의 자리 개수가 달라지고, 점들이 서로 다른 게이트로 계산된다.
// 그래서 진입점에서 한 번 확정하고 아래로 내려보낸다. TTL 은 축과 같은 30초다 —
// 두 스위치의 반영 시차가 "축은 켜졌는데 격자는 아직" 상태를 만들지 않게 하기 위해서다.

const TTL_MS = 30_000;

/**
 * **판정과 목록이 한 객체다**(2026-09-20 독립 검증 A2-3 수리).
 *
 * 초판은 목록 메모를 리포지터리가 따로 들어 만료 시점이 둘이었다. 목록이 먼저 만료된
 * 구간에서 `ensureTrendGrid()` 는 캐시된 `true` 를 즉시 돌려주고 목록은 빈 채로 남아,
 * 그 순간 시작된 요청이 **6월이 닫힌 값**을 미러 셀에 굳혔다. 만료가 하나면 그 구간이
 * 존재하지 않는다.
 *
 * `preCatalog: null` = **판정 실패**(프로세스 메모에 굳히지 않는다). **다음 요청**의
 * `ensureTrendGrid()` 가 격자 값은 메모에서 쓰고 목록만 다시 읽는다 — 실패를 30초
 * 굳히지 않기 위해서다.
 *
 * ⚠️ **재시도는 요청 경계에서만 일어난다**(2026-09-20 독립 검증 N1). 재시도를 호출마다
 *    하면 한 요청 안에서 소비처 A 는 빈 목록, B 는 목록을 보는 분기가 생긴다
 *    (`mirrorCache` 의 `routed` 가 셀마다 `ensureTrendGrid()` 를 부른다). 그래서 아래
 *    `requestState` 가 React `cache` 로 **요청당 한 번만** 해소하고, 같은 요청의 나머지
 *    호출은 그 결과를 그대로 받는다 — 성공이든 실패든 한 요청 안에서는 값이 하나다.
 */
let state: {
  value: boolean;
  preCatalog: readonly string[] | null;
  expiresAt: number;
} | null = null;
let inflight: Promise<boolean> | null = null;
let warned = false;
let listWarned = false;

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function resetTrendGridForTests(): void {
  state = null;
  inflight = null;
  warned = false;
  listWarned = false;
}

/**
 * 테스트 전용 — DB 없이 판정값을 고정한다.
 * `preCatalog` 를 생략하면 **빈 목록**(= 종전 게이트)이다.
 */
export function setTrendGridForTests(
  value: boolean,
  preCatalog: readonly string[] = [],
): void {
  state = { value, preCatalog: [...preCatalog], expiresAt: Number.MAX_SAFE_INTEGER };
  inflight = null;
}

/**
 * 판정을 **확정**한다. 이미 확정돼 있으면 왕복이 없고, 동시에 여러 진입점이 불러도
 * 발사는 1회다. 절대 throw 하지 않는다 — 판정 실패의 의미는 "종전 추이" 이고, 그
 * 방향으로는 값이 틀릴 수 없다(오늘 프로덕션이 내는 바로 그 값이다).
 */
/**
 * **요청 단위 확정본**(N1). React `cache` 는 요청마다 새 메모라, 첫 해소가 그 요청의
 * 정답이 된다. 실패해도 같은 요청 안에서는 재시도하지 않는다 = 소비처들이 같은 값을 본다.
 *
 * 요청 컨텍스트 밖(테스트·스크립트)에서는 프로세스 전역 메모처럼 동작하지만, 그쪽은
 * `setTrendGridForTests` 로 상태를 고정하므로 판정이 흔들리지 않는다.
 */
const requestState = cache(async (): Promise<boolean> => resolveTrendGrid());

export function ensureTrendGrid(): Promise<boolean> {
  return requestState();
}

async function resolveTrendGrid(): Promise<boolean> {
  // **확정 조건이 둘이다**: 만료 전 + 목록이 실패(`null`)가 아닐 것. 실패는 프로세스
  // 메모에 안 굳히므로(A2-2) 목록이 `null` 이면 만료 전이어도 다시 읽는다.
  // 같은 요청 안에서는 위 `requestState` 가 여기를 한 번만 부른다.
  const cached = state && state.expiresAt > Date.now() ? state : null;
  if (cached && cached.preCatalog !== null) return cached.value;
  if (inflight) return inflight;
  const cachedValue = cached?.value;
  inflight = (async () => {
    try {
      // 격자 값은 메모가 살아 있으면 재판정하지 않는다 — 목록만 실패했을 때
      // 화면 키를 다시 묻지 않기 위해서다(위 `state` 주석).
      const value = cachedValue ?? (await trendGridEnabled());
      // 카탈로그 도입 전 회차 목록을 **같은 확정 단위**에서 세운다(제품 책임자 2026-09-20 ①).
      // 사실표 리더와 미러 폴백이 그 목록을 각자 읽으므로, 확정 시점이 갈리면 한
      // 경로만 6월을 그리는 상태가 만들어진다. 꺼져 있으면 왕복이 없다(종전과 동일).
      state = {
        value,
        preCatalog: value ? await readListOrNull() : [],
        expiresAt: Date.now() + TTL_MS,
      };
      return value;
    } catch (e) {
      console.error("[trend-grid] 판정 실패 — 종전 추이로 간다", e);
      state = { value: false, preCatalog: [], expiresAt: Date.now() + TTL_MS };
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 목록 1회 읽기. 실패는 **`null`**(= 캐시하지 않는다) + 경고 1회.
 * `[]` 와 `null` 을 가르는 것이 요점이다: `[]` 는 "카탈로그 전 회차가 없다"(정상),
 * `null` 은 "모른다"(재시도). 소비자는 둘 다 빈 목록으로 보지만(둘 다 닫힘, 두 경로가
 * 같은 값을 쓴다) 재시도 여부가 다르다.
 */
async function readListOrNull(): Promise<readonly string[] | null> {
  try {
    return await readPreCatalogCycleIds();
  } catch (e) {
    if (!listWarned) {
      listWarned = true;
      console.error(
        "[trend-grid] 카탈로그 전 회차 판정 실패 — 이번 요청은 종전 게이트로 가고 " +
          "결과를 캐시하지 않는다(다음 요청이 재시도).",
        e,
      );
    }
    return null;
  }
}

/**
 * 동기 SQL 빌더가 읽는 **카탈로그 도입 전 회차 목록**.
 *
 * 격자 판정과 **같은 state·같은 만료**에서 나온다 — 그래서 "격자는 켜졌는데 목록만
 * 비어 있는" 구간이 없다. 미확정·판정 실패는 둘 다 `[]`(= 종전 게이트)이고, 그 값을
 * **두 소비처가 같이** 본다(사실표 `trendWhere` · 미러 `withPreCatalogEscape`).
 */
export function preCatalogCycleIdsKnown(): readonly string[] {
  if (state && state.expiresAt > Date.now()) return state.preCatalog ?? EMPTY_LIST;
  if (!listWarned) {
    listWarned = true;
    console.warn(
      "[trend-grid] 판정 전에 카탈로그 전 회차 목록이 조회됐다 — 이번 호출은 종전 " +
        "게이트로 나간다. 그 진입점에 `await ensureTrendGrid()` 를 추가하라.",
    );
  }
  return EMPTY_LIST;
}

const EMPTY_LIST: readonly string[] = [];

/** 캐시 키 조각용 — 목록의 **안정 해시**. 비면 빈 문자열(격자 off 키와 같은 자세). */
export function preCatalogCacheSlot(): string {
  const ids = preCatalogCycleIdsKnown();
  if (ids.length === 0) return "";
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 8);
}

/**
 * 동기 코드가 읽는 판정값. **호출 전에 `ensureTrendGrid()` 가 await 돼 있어야 한다.**
 *
 * 미확정이면 종전(false)이고 프로세스당 한 번 경고한다 — PR④ 가 이 값을 **동기 SQL
 * 빌더**(`scope-aggregates.ts::trendAlignedRootPreds`)에서 읽기 시작했기 때문이다.
 * 미확정 폴백은 값이 틀릴 방향이 없지만("종전 추이"), **켰는데 일부 경로만 안 바뀌는
 * 상태는 화면만 봐서는 안 보인다** — 그래서 새 진입점이 ensure 를 빠뜨린 것을 로그로
 * 드러낸다(`anchor-axis-state.ts::anchorAxisKnownEnabled` 과 같은 계약).
 */
export function trendGridKnownEnabled(): boolean {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.value;
  if (!warned) {
    warned = true;
    console.warn(
      "[trend-grid] 판정 전에 동기 SQL 빌더가 호출됐다 — 이번 호출은 종전 추이로 " +
        "나간다. 그 진입점에 `await ensureTrendGrid()` 를 추가하라.",
    );
  }
  return false;
}
