import "server-only";
import { unstable_cache } from "next/cache";
import {
  listSelectableAnchorDates,
  type AnchorHiddenFamily,
  type AnchorSurface,
  type SelectableAnchorDateFilters,
} from "@/lib/db/repositories/scope-answer-anchors";
import { ensureCycleCacheSlot } from "@/lib/period/cycle-fingerprint";

// ════════════════════════════════════════════════════════════════════════════
// 달력용 "선택 가능한 회차 날짜" 로더 (스펙 §5.1)
// ════════════════════════════════════════════════════════════════════════════
//
// 지면(서버 컴포넌트) → `DimensionFilterPanel` 의 prop `selectableDates` 로 내려가는
// 값을 만든다. 하는 일은 **얇다**: 리더(`listSelectableAnchorDates`, DATA 소유)를
// 부르고 결과를 그대로 돌려준다. 산식·SQL 은 여기 없다.
//
// ── 캐시 셀에는 직렬화 가능한 값만 ─────────────────────────────────────────
//
// 2026-09-18 실측 사고: `unstable_cache` 셀이 `Map` 을 돌려주게 두었더니 **첫 로드만
// 정상이고 캐시 HIT 부터 세그먼트가 죽었다**(캐시는 반환값을 직렬화해 저장하고
// 되읽을 때 plain object 로 돌려준다). 이 로더의 반환 타입은 `string[]` 하나로
// 못박고, `selectable-anchor-dates.test.ts` 가 JSON 라운드트립으로 그것을 고정한다.
//
// ── 실패는 빈 배열 ────────────────────────────────────────────────────────
//
// 리더 자신이 이미 "테이블 미적용·DB 오류 → 빈 배열"로 접는다. 빈 배열은
// **"선택 가능한 날짜가 없다"가 아니라 "모른다"** 이고, 그때 달력은 종전대로
// 모든 날짜를 열어야 한다. 그 판단은 UI 쪽 계약이다(`selectableDates` prop 주석:
// `undefined` 와 빈 배열이 같은 경로로 간다).

/** 안전망 TTL(초). 회차는 하루 단위로 늘어나므로 짧게 잡을 이유가 없다. */
const SELECTABLE_DATES_TTL = 900;

/** 이 로더 전용 캐시 태그 — 회차 마감·숨김 액션이 무효화 대상으로 쓴다. */
export const SELECTABLE_ANCHOR_DATES_TAG = "selectable-anchor-dates";

// `unstable_cache` 를 **모듈 로드 시점에 호출하지 않는다** — next/cache 를 부분
// mock 하는 테스트가 이 모듈을 간접 import 할 때 통째로 깨지기 때문이다
// (lib/citation-categorizer/overrides-loader.ts 와 같은 lazy 패턴).
function lazyCache<A extends unknown[], R>(
  factory: () => (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let fn: ((...args: A) => Promise<R>) | null = null;
  return (...args: A) => (fn ??= factory())(...args);
}

/**
 * 캐시 키 — 인자가 그대로 키가 되므로 **순서가 고정된 문자열 하나**로 접는다.
 * 배열을 정렬하지 않으면 같은 집합이 다른 키가 되어 캐시가 갈린다.
 */
export function selectableAnchorDatesCacheKey(
  surface: AnchorSurface,
  projectIds: readonly string[],
  filters: SelectableAnchorDateFilters,
  /**
   * ⚠️ **계열이 키에 들어가야 한다.** 언급 화면과 인용 화면의 목록은 다를 수 있다
   * (`hidden_scope='citations'` 회차가 전자에만 남는다). 키에서 빼면 두 화면이 한
   * 셀을 공유해, 먼저 캐시를 채운 쪽의 목록이 다른 쪽에 그대로 나간다.
   */
  family: AnchorHiddenFamily,
): string {
  return JSON.stringify([
    surface,
    [...projectIds].sort(),
    filters.from ?? null,
    filters.to ?? null,
    [...(filters.engines ?? [])].sort(),
    [...(filters.countries ?? [])].sort(),
    family,
  ]);
}

const cachedDates = lazyCache(() =>
  unstable_cache(
    // ⚠️ 반환 타입은 `string[]` 고정 — Map·Date·Set 을 넣지 않는다(위 주석).
    async (
      surface: AnchorSurface,
      projectIds: string[],
      filters: SelectableAnchorDateFilters,
      family: AnchorHiddenFamily,
      _key: string,
      // 회차 지문 조각(2026-09-27) — **값 계산에는 안 쓰이고 키에만 쓰인다.** 목록이
      // 노출 게이트(앵커 노출일·원장·시계)에 의존하므로, 새 회차가 열리면 셀이 갈려야
      // 한다(`lib/period/cycle-fingerprint.ts`). 이 로더는 축 on 에서만 불린다.
      _cycleSlot: string,
    ): Promise<string[]> => listSelectableAnchorDates(surface, projectIds, filters, family),
    ["selectable-anchor-dates-v1"],
    { revalidate: SELECTABLE_DATES_TTL, tags: [SELECTABLE_ANCHOR_DATES_TAG] },
  ),
);

/**
 * 달력이 활성화할 KST 날짜 목록(오름차순 `YYYY-MM-DD`). 직렬화 가능한 `string[]` 뿐이다.
 *
 * 프로젝트가 없거나 리더가 실패하면 **빈 배열**이고, 그때 달력은 종전 동작으로 돌아간다.
 */
export async function loadSelectableAnchorDates(
  surface: AnchorSurface,
  projectIds: readonly string[],
  filters: SelectableAnchorDateFilters = {},
  /** 그 화면의 지표 계열 — 인용 화면만 `'citations'`(리더의 `family` 주석). */
  family: AnchorHiddenFamily = "mentions",
): Promise<string[]> {
  // ⚠️ **정렬까지 해서 셀에 넘긴다**(검증 W7). `unstable_cache` 의 호출 키는 인자 전체의
  // 직렬화라, 같은 프로젝트 집합이라도 순서가 다르면 셀이 갈린다. 키 헬퍼만 정렬하고
  // 인자는 정렬 전 배열을 넘기면 "같은 집합이면 같은 키" 라는 그 헬퍼의 주장이 실제
  // 셀 경계에서는 성립하지 않는다. 정렬은 리더 결과에 영향이 없다(`= ANY(...)`).
  const ids = [...new Set(projectIds)].filter(Boolean).sort();
  if (ids.length === 0) return [];
  try {
    const key = selectableAnchorDatesCacheKey(surface, ids, filters, family);
    // 지문 판정은 throw 하지 않는다(실패 = 직전 칸 지문 재사용 또는 5분 버킷 조각).
    // 달력은 앵커 노출일·숨김·서빙 게이트를 읽으므로 일반 셀과 같은 `gate` 모드다.
    const cycleSlot = await ensureCycleCacheSlot("gate");
    const out = await cachedDates(surface, ids, filters, family, key, cycleSlot);
    // 캐시를 지나온 값이 배열이 아닌 경우는 "모른다"로 접는다(화면을 죽이지 않는다).
    return Array.isArray(out) ? out.filter((d): d is string => typeof d === "string") : [];
  } catch (e) {
    // 구조화 한 줄(앵커 전파 경고와 같은 형식). 비밀값을 싣지 않는다 — 표면·계열·
    // 프로젝트 수·SQLSTATE·메시지만. **빈 배열로 접으면 달력은 종전 입력으로
    // 내려앉는다**(`resolveTimeRangeView` 의 `anchored = dates.length > 0`) — 메뉴가
    // 비지 않는 것이 이 폴백의 요점이다(2026-09-20 프리뷰 차단 결함).
    const err = e as { message?: unknown; code?: unknown };
    console.warn(
      `[calendar] selectable-dates-failed surface=${surface} family=${family} ` +
        `projects=${ids.length} ` +
        `code=${typeof err?.code === "string" ? err.code : "none"} ` +
        `msg=${typeof err?.message === "string" ? err.message : String(e)}`,
    );
    return [];
  }
}
