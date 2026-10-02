import "server-only";
import { ensureAnchorAxis } from "@/lib/period/anchor-axis-state";
import { resolvePeriodCompareShape } from "@/lib/kpi/calendar-month-window";
import {
  resolveComparePeriodShape,
  type ComparePeriodShape,
} from "@/lib/kpi/period-compare-week";
import { hghSource, sourceGroupFor, type HghArea } from "@/lib/hgh/client";
import type { Surface } from "@/lib/hgh/query";

// ════════════════════════════════════════════════════════════════════════════
// 지면의 **비교 모양** 판정 — 앵커 축 on/off 를 여기 한 곳에서 가른다
// ════════════════════════════════════════════════════════════════════════════
//
// 4지면(대시보드·웹사이트·언급·인용)이 **같은 함수**로 판정해야 한다. 2026-09-19
// 프리뷰 실측: 대시보드만 `kind:"window"` 를 박아 두어 같은 URL 이 화면마다 다른
// 수를 냈다(13일 트레일링 +8.6pp vs 달력 월 +6.5pp). 그래서 축 분기도 지면마다
// 쓰지 않고 이 함수가 소유한다.
//
// ── 왜 축 off 에서 주(week) 판정을 하면 안 되는가 ─────────────────────────
//
// `resolveComparePeriodShape` 는 `resolvePeriodCompareShape` 의 **상위 집합**이다:
// 월 판정이 먼저고, 그다음 **달력 주**(lo 가 월요일이고 hi 가 같은 주)를 본다.
// 그래서 축이 꺼진 지금도 `?time=2026-09-07..2026-09-13` 같은 월~일 구간은 판정이
// `window` → `calendarWeek` 로 **바뀐다**. 바뀌면 화면이 따라 바뀐다:
//   · 라벨       — "지난 7일 대비" → "지난주 대비"(`labelKeyOf`)
//   · 억제 규칙  — 누락 30% 임계를 안 건다(`appliesMissingShare`)
//   · 직전 구간  — 부분 주에서 트레일링 7일이 아니라 **직전 주 전체**
// 계약 §4 는 "끄면 종전 동작이 바이트 단위로 같아야 한다" 이므로, 주 판정은 축이
// 켜졌을 때만 켠다. 주 버킷의 근거 자체가 앵커 테이블의 `anchor_week`(= `round_date`
// 가 속한 KST 주의 월요일)라 축 없이 주 비교를 하면 기준이 되는 컬럼이 없다.
//
// ── 반환 타입 ────────────────────────────────────────────────────────────
//
// 축 off 의 `PeriodCompareShape`(`{kind, months?, days}`)는 `ComparePeriodShape`
// (`{kind, months?, weeks?, days}`)에 그대로 들어간다 — `weeks` 가 없을 뿐이다.
// 지면은 한 타입만 알면 된다.

// ── API 원천(U4, 설계 부록 A: "ensureAnchorAxis 는 on 으로 고정") ──────────────
//
// 새 백엔드는 **앵커 축을 전제**한다(기간 = round_date, 주 버킷 = 앵커 주). 그래서 그
// 화면의 원천 스위치(D8, `HGH_SOURCE_<그룹>`)가 api 면 축 판정을 DB 에 묻지 않고 축 on
// 모양(월 → 주 → 창)을 순수하게 낸다. 앵커 축 상태 행(`summary_settings`)·컬럼 프로브를
// 읽지 않는다. 모양과 리더가 같은 축을 봐야 한다는 위 불변식은 그대로다: api 원천의
// 리더(백엔드)도 앵커 축이다. `source` 를 안 넘기거나 legacy 면 종전과 바이트 단위로 같다.

/** 비교 모양을 판정할 화면의 원천 스위치 좌표(sourceGroupFor 규칙). */
export interface ComparePeriodShapeSource {
  area: HghArea;
  surface: Surface;
}

/**
 * 이 요청의 비교 모양. 축 on 이면 월 → 주 → 창, off 면 종전대로 월 → 창.
 *
 * 판정은 `ensureAnchorAxis()` 에서 온다 — 집계층 리더가 보는 **바로 그 상태**이고,
 * throw 하지 않는다(실패 = 종전 축). 모양과 리더가 다른 값을 보면 모양은
 * `kind:"calendarWeek"` 인데 리더는 종전 축이라 구간과 회차 집합이 갈린다.
 *
 * `source` 의 원천이 api 면 DB 조회 없이 축 on 모양이다(위 절).
 */
export async function resolveRequestComparePeriodShape(
  from: string | null | undefined,
  to: string | null | undefined,
  source?: ComparePeriodShapeSource,
): Promise<ComparePeriodShape> {
  if (source && hghSource(sourceGroupFor(source.area, source.surface)) === "api") {
    return resolveComparePeriodShape(from, to);
  }
  if (!(await ensureAnchorAxis())) return resolvePeriodCompareShape(from, to);
  return resolveComparePeriodShape(from, to);
}
