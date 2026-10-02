import {
  COLLECTION_ERROR_GAP,
  NOT_PUBLISHED_GAP,
  NO_VALUE_GAP,
  type TrendGap,
} from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// 공용 추이 격자의 **화면쪽 계약** — 순수 모듈(서버 전용 아님)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md` §7.
//
// `lib/period/trend-grid.ts` 는 `server-only` 라 클라이언트 컴포넌트가 import 하는
// view-model(`kpi-view.ts`)이나 리포지터리 타입 파일이 그것을 직접 참조할 수 없다.
// 그래서 **두 쪽이 공유하는 것만** 여기 둔다: 사유 어휘 · 화면으로 내려보내는 자리 ·
// 그 둘을 이어 주는 순수 함수. 값을 읽거나 DB 를 부르는 것은 하나도 없다.

/**
 * 자리가 비는 **사유**. 화면은 셋을 같은 음영으로 그려도 되지만 데이터에는 실린다
 * (설계 §7-1).
 *
 *   `hidden-collection-error` (a) 수집 오류로 숨긴 회차. 오늘 화면이 음영을 그리는 유일한 사유.
 *   `not-published`           (b) 미발행·완결성 미달. 회차는 있는데 서빙 가능한 것이 없다.
 *   `no-value`                (c) 자리는 서빙 가능한데 **그 지면의 값이 없다**.
 *
 * ⚠️ 설계 §7-1 초안의 `no-cycle` 은 **어휘에서 뺐다**. "회차가 없는 자리"는 갭이 아니라
 *    ③(아무것도 안 그린다)이고, 자리 자체가 안 만들어지므로 사유를 실을 대상이 없다.
 *
 * ⚠️ viz 쪽 어휘(`TrendGapReason`)와 **철자가 다르다**(kebab 대 snake). 일부러다 —
 *    둘은 다른 층의 어휘이고, 변환은 아래 `trendGridGapMarker` 한 곳에서만 일어난다.
 */
export type TrendGridGapReason =
  | "hidden-collection-error"
  | "not-published"
  | "no-value";

/**
 * 화면으로 내려가는 자리 하나 — **직렬화 가능한 값만**.
 *
 * 서버 타입(`TrendSlot`)에서 `cycleIds`·`completionRatio` 를 뺀 것이다. 화면은 자리
 * 키와 사유만 쓰고, 나머지를 실어 보내면 RSC 페이로드가 회차 수만큼 커진다.
 */
export interface TrendGridSlotView {
  /** 자리 키이자 라벨(KST `YYYY-MM-DD`). */
  roundDate: string;
  /** 그 자리가 속한 KST 주의 월요일. **미러 주 격자 값과 맞추는 데만** 쓴다. */
  anchorWeek: string;
  /** 점이면 `null`. */
  gapReason: TrendGridGapReason | null;
}

/** 격자 사유 → viz 마커. 변환은 여기 한 곳뿐이다(어휘가 두 벌이 되지 않게). */
export function trendGridGapMarker(reason: TrendGridGapReason): TrendGap {
  switch (reason) {
    case "hidden-collection-error":
      return COLLECTION_ERROR_GAP;
    case "not-published":
      return NOT_PUBLISHED_GAP;
    case "no-value":
      return NO_VALUE_GAP;
  }
}

/**
 * **가장 최신의 렌더 가능한 자리 뒤에 있는 미발행 자리를 잘라 낸다**(메인 결정 2026-09-20).
 *
 * 왜: 미러 실측에서 website `2026-09-18` 자리는 회차 101개·서빙 가능 0 이다 — 지금
 * **진행 중인** 회차다. 그것을 추이 끝의 갭으로 두면 "마지막 점 == 카드 기준일(09-11)"
 * 이 깨지고, 고객은 **측정이 멈춘 것처럼** 읽는다. 아직 열리지 않은 자리는 결측이 아니다.
 *
 * 자르는 것은 **끝의 `not-published` 뿐**이다:
 *   · 중간의 `not-published`(글로벌 07-13·07-20·07-27)는 **갭으로 남긴다** — 그 자리는
 *     이미 지나갔고 열리지 않은 것이 사실이다. 지우면 07-06 과 08-03 이 곧장 붙어
 *     "그 주가 없었던 것처럼" 보인다(0070 이 고친 것과 같은 거짓말).
 *   · 끝의 `hidden-collection-error` 도 **남긴다** — 숨긴 회차는 음영으로 보여 준다는
 *     기존 정책이고(0070), "아직 안 열렸다"와 "열렸는데 깨졌다"는 다른 사실이다.
 *
 * 입력은 오름차순이고 출력도 그렇다. 자를 것이 없으면 **입력 배열을 그대로** 돌려준다.
 */
export function trimTrailingUnpublished<
  T extends { gapReason: TrendGridGapReason | null; renderable?: boolean },
>(slots: readonly T[]): readonly T[] {
  let end = slots.length;
  while (end > 0 && slots[end - 1].gapReason === "not-published") end -= 1;
  return end === slots.length ? slots : slots.slice(0, end);
}

/**
 * **같은 주의 자리를 하나로 접는다** — 값의 그레인이 주이기 때문이다(검증 C2, 2026-09-20).
 *
 * ── 무엇이 문제였나 ────────────────────────────────────────────────────────
 *
 * 프로젝트 표면은 정규 요일이 없어 자리 키가 앵커 일자다. 미러 실측: `anchor_week`
 * 09-14 에 프로젝트 42개·자리 88개이고 **한 프로젝트가 한 주에 최대 3자리**를 갖는다
 * (07-20·07-27 도 최대 2자리). 그런데 그 지면의 **값은 전부 주 단위**다:
 *
 *   주별 Top-N   행 키 = `ca.anchor_week` (`mentionBrandDayCountsQuery`)
 *   메인 추이     버킷 = `ca.anchor_week`, 라벨 = `to_char(max(round_date))` = `round_label`
 *   인용 정확도 ⑥ 같은 주 버킷
 *
 * 즉 값 하나가 그 주 **세 회차의 합**이다. 자리를 셋으로 두면 어떻게 해도 틀린다:
 *   · 한 자리에 붙이면 → 주 합계를 한 회차의 값인 것처럼 말한다(오귀속).
 *   · 안 붙이면(N8 의 선택) → 그 주가 **통째로 빈다**(데이터 소실).
 *
 * ── 그래서 자리를 값의 그레인에 맞춘다 ────────────────────────────────────
 *
 * 한 주의 자리들을 **한 자리로 접고 키를 그 주의 서빙 가능한 마지막 귀속 날짜**로 둔다
 * (서빙 가능한 자리가 없으면 전체 최대 — 그 자리는 갭이다). 소실 0 · 오귀속 0 이고,
 * 화면에 보이는 점 개수는 **오늘과 같다**(오늘도 그 주는 한 점이다).
 *
 * 그 키가 값 쪽 라벨(`round_label`)과 다를 수 있는 것은 **전제가 아니라 허용**이다 —
 * 조인이 2단이라(라벨 → 주 키) 어긋나도 값이 사라지지 않는다. 라벨을 원장에서 뽑는 이유는
 * 카드 기준일·달력과 같은 규칙을 쓰기 위해서다(`round_label` 은 필터를 켜고 끌 때마다
 * 움직인다).
 *
 * 글로벌(월요일)·website(금요일)에서는 한 주에 자리가 하나뿐이라 **무동작**이다 —
 * 표면을 가려 분기하지 않는 이유가 그것이다(규칙 하나, 분기 없음).
 *
 * 접힌 자리의 속성: 회차 id 는 합집합, 서빙 가능은 **하나라도** 되면 참(`renderable` 의
 * 정의 그대로), 사유는 수집 오류 우선, 완결성은 최대값(자리 값이 회차 합이므로).
 */
export function collapseSameWeekSlots<
  T extends {
    roundDate: string;
    anchorWeek: string;
    gapReason: TrendGridGapReason | null;
    renderable?: boolean;
    cycleIds?: string[];
    completionRatio?: number | null;
  },
>(slots: readonly T[]): T[] {
  const byWeek = new Map<string, T[]>();
  for (const s of slots) {
    const g = byWeek.get(s.anchorWeek);
    if (g) g.push(s);
    else byWeek.set(s.anchorWeek, [s]);
  }
  const out: T[] = [];
  for (const group of byWeek.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // ── 키는 그 주의 **서빙 가능한 마지막** 귀속 날짜 (검증 D1, 2026-09-20) ──
    //
    // 초판은 `max(roundDate)` 였다. 그러면 09-15 가 서빙 가능하고 09-17 이 미발행인 주에서
    // **아무것도 발행된 적 없는 09-17 이 마지막 점의 라벨**이 된다(`renderable` 은 `some`
    // 이라 참이므로 `trimTrailingUnpublished` 도 안 자른다). 값은 맞고 날짜만 틀리지만,
    // 그 날짜가 곧 "마지막으로 그려지는 점" 이라 **카드 기준일 규칙(노출 가능한 최신
    // 회차)과 다른 날**을 가리킨다.
    //
    // 그래서 서빙 가능한 자리만 후보로 본다. 하나도 없는 주는 종전대로 전체 최대를 쓴다 —
    // 그 자리는 어차피 갭이고, 갭 자리의 날짜는 "그 주에 열렸어야 할 마지막 날" 이 맞다.
    //
    // ⚠️ 이 키가 값 쪽 `round_label`(필터된 답변셋의 `max`)과 **더 자주 어긋날 수 있다.**
    //    괜찮다 — 조인은 이미 2단이다(라벨 실패 시 주 키로 재시도,
    //    `trend-grid-buckets.ts::applyTrendGridToBuckets`). 접은 뒤에는 주당 자리가 하나라
    //    주 키 해소가 모호하지 않으므로 라벨을 바꿔도 값이 사라지지 않는다.
    const sorted = [...group].sort((a, b) => a.roundDate.localeCompare(b.roundDate));
    const servable = sorted.filter((s) => s.renderable === true);
    const renderable = servable.length > 0;
    const candidates = renderable ? servable : sorted;
    const last = candidates[candidates.length - 1];
    const ratios = group
      .map((s) => s.completionRatio)
      .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
    out.push({
      ...last,
      roundDate: last.roundDate,
      renderable,
      gapReason: renderable
        ? null
        : group.some((s) => s.gapReason === "hidden-collection-error")
          ? "hidden-collection-error"
          : "not-published",
      ...(group.some((s) => s.cycleIds)
        ? { cycleIds: [...new Set(group.flatMap((s) => s.cycleIds ?? []))].sort() }
        : {}),
      ...(last.completionRatio !== undefined
        ? { completionRatio: ratios.length > 0 ? Math.max(...ratios) : null }
        : {}),
    });
  }
  return out.sort((a, b) => a.roundDate.localeCompare(b.roundDate));
}

/**
 * 값 버킷의 키 → **자리 키**. 자리가 없으면 입력 키를 그대로 돌려준다(= 병합기가
 * `droppedKeys` 로 흘린다).
 *
 * 별칭을 받는 이유: 같은 지면이라도 **경로마다 버킷 키가 다르다.**
 *
 *   집계층 경로  버킷 키 = 귀속 날짜(`round_date`)            → `roundDate` 로 맞는다
 *   미러 주 격자 버킷 키 = 그 회차가 속한 **주의 월요일**      → `anchorWeek` 로 맞는다
 *
 * 그래서 두 키를 **둘 다** 그 자리로 보낸다. `roundDate` 가 우선이고, `anchorWeek` 는
 * 이미 임자가 있는 키를 빼앗지 않는다(글로벌은 둘이 같은 날이라 애초에 충돌이 없고,
 * website 는 금요일 자리라 둘이 4일 다르다).
 *
 * ⚠️ 이것이 병합기(`mergeTrendGrid`)의 "`anchorWeek` 를 키로 쓰지 않는다" 규칙을 어기는
 *    것이 아니다. 저 규칙은 **자리 키를 anchorWeek 로 바꾸지 마라**는 뜻이고(그러면
 *    website 의 모든 점이 4일 어긋나 전멸한다), 여기서는 자리 키를 그대로 둔 채 **주
 *    격자로 들어온 값도 그 자리를 찾게** 해 줄 뿐이다.
 *
 * ⚠️ **한 주에 자리가 둘이면 그 주의 별칭은 만들지 않는다**(2026-09-20 검증 N8).
 *    프로젝트 표면은 정규 요일이 없어 같은 `anchorWeek` 에 자리가 여럿일 수 있다
 *    (예: 09-15·09-17). 먼저 온 자리가 이기는 규칙이면 **앞 자리가 그 주 값을 통째로
 *    먹고 뒤 자리는 결측**이 된다 — 조용히 틀린 자리에 값을 붙이는 것이라 화면으로는
 *    안 보인다. 모호하면 별칭을 안 만들어 그 키가 **버려지고 로그에 남게** 한다
 *    (값이 사라지는 쪽이지만, 그 사실이 드러난다).
 *
 *    실제로 손실이 나는가: 프로젝트 표면의 버킷은 축 on 에서 `roundDate` 를 싣고 오므로
 *    (`aggregateStandardTrendFromMirror` 의 `round_label`) 별칭을 탈 일이 없다. 별칭은
 *    `roundDate` 가 없는 경로의 보험이고, 그 보험이 **틀린 자리를 고르면 안 된다**.
 */
export function trendGridKeyResolver(
  slots: readonly TrendGridSlotView[],
): (bucketKey: string) => string {
  const byAlias = new Map<string, string>();
  for (const s of slots) byAlias.set(s.roundDate, s.roundDate);
  // 주별 자리 수를 먼저 센다 — 둘 이상이면 그 주는 별칭 대상이 아니다.
  const perWeek = new Map<string, number>();
  for (const s of slots) perWeek.set(s.anchorWeek, (perWeek.get(s.anchorWeek) ?? 0) + 1);
  for (const s of slots) {
    if (perWeek.get(s.anchorWeek) !== 1) continue;
    if (!byAlias.has(s.anchorWeek)) byAlias.set(s.anchorWeek, s.roundDate);
  }
  return (bucketKey: string) => byAlias.get(bucketKey) ?? bucketKey;
}

/**
 * 이 배열이 **격자로 만들어진 것인가**. 판정은 데이터에 실린 표식이지 스위치가 아니다.
 *
 * ── 왜 플래그(`trendGridKnownEnabled()`)로 물으면 안 되나 (검증 B2) ─────────
 *
 * 그 함수는 "키가 켜졌나"를 답하지 "이 시리즈에 격자를 얹었나"를 답하지 않는다. 키가
 * 켜져 있어도 격자를 **안 얹는** 경로가 둘 있다:
 *   ① **일 버킷** — `unit !== "week"` 면 자리를 만들지 않는다(Δ 칩 30일·프로젝트 일 추이).
 *      같은 요청의 주 추이가 이미 플래그를 true 로 확정해 두므로, 플래그로 물으면
 *      **일 격자 채움이 통째로 사라진다**.
 *   ② **자리를 못 세운 경우**(`buildTrendGrid` 가 `null`) — 원장 조회 실패·유효 프로젝트
 *      id 없음. 문서화된 계약이 "격자를 못 세웠다 → 종전 경로" 인데 플래그는 여전히 true 다.
 *
 * `every` 인 이유는 `isCycleBucketed` 와 같다: 두 경로가 한 배열에 섞이면 전제가 이미
 * 깨진 것이라 **종전 채움을 쓰는 쪽**이 안전하다.
 */
export function isTrendGridApplied(
  rows: readonly { gridSlot?: boolean }[],
): boolean {
  return rows.length > 0 && rows.every((r) => r.gridSlot === true);
}
