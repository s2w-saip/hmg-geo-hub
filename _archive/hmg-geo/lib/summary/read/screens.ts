import "server-only";
import { readScreensRaw } from "@/lib/db/repositories/summary-settings";

// 사실표 조회 킬스위치의 **화면 입도** — 설계 v4.1 §8-4 / PR① A5.
//
// `read_enabled` 는 표면 전체를 한 번에 내린다. 패리티가 한 화면에서만 어긋났을 때
// 나머지 화면까지 미러로 되돌리는 것은 과잉이라, `summary_settings.read_screens`
// (JSON 문자열 배열)로 "이 화면들만 사실표" 를 지정할 수 있게 한다.
//
// ── 키 어휘: `<표면>.<화면>` ────────────────────────────────────────────────
// 키가 가리키는 것은 **화면(페이지)** 이 아니라 그 화면을 만드는 **읽기 계열**이다.
// 패리티 격자가 읽기 계열 단위로 측정되기 때문 — "S5.mention 을 끈다" = 웹사이트
// Sub KPI 읽기를 미러로 되돌린다는 뜻이고, 그 값이 대시보드 카드에도 나온다면
// 거기서도 함께 되돌아간다. 틀린 값을 한 화면에서만 숨기는 것은 목적이 아니다.
//
//   S1.dashboard / S2.mention / S3.citation  = 글로벌(표준 루트) 표면
//   S4.dashboard / S4.subkpi / S5.mention / S6.citation = 웹사이트 표면
//   P.dashboard                              = 프로젝트 표면(예약 — 아직 사실표 경로 없음)
//
// ── `S4.subkpi` 는 위 "읽기 계열" 규칙의 **명시적 예외**다 (PR③-a B6, 2026-09-11) ──
//
// 같은 리포지터리 함수(`summaryWebsiteSubKpis`)를 두 화면이 부르는데 **요구 의미론이
// 다르다**:
//   · S4 대시보드의 엔진 일관성 배지 — 같은 카드의 ①~⑤ 가 **회차 스냅샷**(집계층)이라
//     배지도 같은 회차여야 카드가 내부적으로 일관된다.
//   · S5 언급 화면 — 화면 전체가 미러 누적 의미론이고, 그 전환은 T8·GGMD 확인이
//     끝나야 한다(§6-2 가 S5 를 off 로 둔 이유).
//
// 그래서 "값이 틀리면 두 화면이 함께 되돌아간다" 는 원칙을 여기서는 **화면별 의미론이
// 애초에 다르다** 로 대체한다.
//
// ── 이 키를 켜면 배지 숫자가 바뀐다 (독립 재실측, 2026-09-11) ────────────────
//
// **이 파일이 그 수치의 유일한 정본이다.** 다른 곳(read-switch.ts·PR 본문)은 여기를
// 가리키기만 한다 — 같은 수치를 두 곳에 적으면 갈린다.
//
// admin 무필터, published 95 회차, **케이스 합계**(엔진 합산) 기준:
//
//   | 필드 | 미러 | 집계층 |
//   | --- | --- | --- |
//   | answers            | 25,169 | **19,530** |
//   | tracked            | 16,009 | **18,113** |
//   | totalMentions      | 210,978 | **286,176** |
//   | citOwned           | 69,523 | **40,377** |
//   | promptsWithoutBrand| 4,106 | **312** |
//
// ⚠️ 그레인을 섞지 마라 — 위 값은 전부 **케이스 합계**다. 엔진 단독(chatgpt/gemini)
//    수치와 섞으면 재현되지 않는다(초판 주석이 그 오류로 재작성됐다).
//
// ── 차이의 원인: 대부분 **창·모수**, 판정 차이는 하나뿐 ─────────────────────
//
//   · `answers`·`tracked`·언급·프롬프트 — **창·모수 차이**다. 미러의 판정 SQL 을
//     사실표 행집합 위에 그대로 얹으면 집계층 값이 **100% 재현된다**. 즉 tracked 가
//     반대 방향으로 움직이는 것은 판정이 달라서가 아니라 두 창이 다른 답변 집합을
//     덮기 때문이다(미러 = 전 이력 · 집계층 = 회차 + 유닛 게이트).
//   · `citOwned` **하나만** 판정 차이다. 그리고 그것은 의도된 것이다 — 0060 유닛
//     판정(`unitFlags`)이 발행 리포트 v2.4 와 같은 base 로 자사를 가른다.
//     끄면 55,924 로 미러 쪽에 가까워진다(= 유닛 판정이 값을 바꾼 몫).
//   · 미러 쪽 값은 **시점 의존**이다: 10분 간격 재측정에서 tracked 16,009 → 14,787,
//     9/10 답변 13,194건 중 mentions 는 646건뿐(분석 지연), 국가 CA 필터에서는
//     tracked 0. 미러를 "정답" 으로 놓고 집계층을 재는 대조는 성립하지 않는다.
//
// → 그러므로 이 키를 켜는 것은 성능 변경이 아니라 **고객이 보는 숫자의 변경**이고,
//   승인 대상이다. **off 로 머지**한다. 켜는 것은 설정 한 줄이다:
//   `read-switch.ts screens '["S4.dashboard","S1.dashboard","S3.citation","S6.citation","S4.subkpi"]'`
//
// ✅ PR③ 통합(2026-09-11): 이 키는 **`SUMMARY_SCREEN_OPT_IN` 에 합류했다**. 그래서
//    `read-switch.ts screens all`(= `'[]'`)은 이 키를 **켜지 않는다** — 켜려면 위처럼
//    배열에 이름을 적어야 한다. (초판 주석의 "`all` 을 쓰지 마라" 임시 제약은 해제됐다.)

export const SUMMARY_SCREEN_KEYS = [
  "S1.dashboard",
  "S2.mention",
  "S3.citation",
  "S4.dashboard",
  // S4 카드의 엔진 일관성 배지 — S5 와 의미론이 달라 따로 켠다(위 예외 블록).
  "S4.subkpi",
  "S5.mention",
  "S6.citation",
  "P.dashboard",
  // PR③ 신설 — 글로벌 추이 중 **산식이 바뀌는 둘**. 아래 `SUMMARY_SCREEN_OPT_IN` 참고.
  "S1.brandTrend",
  "S1.firstPosition",
  // PR④ 신설 — 대시보드 KPI 카드 **경쟁사 행**(값 + Δ). 아래 `SUMMARY_SCREEN_OPT_IN` 참고.
  "S1.competitors",
] as const;

export type SummaryScreenKey = (typeof SUMMARY_SCREEN_KEYS)[number];

const KNOWN = new Set<string>(SUMMARY_SCREEN_KEYS);

/** 파싱 결과. `allowAll` 이면 목록은 무의미하다(제한 없음). */
export type ScreenAllowlist =
  | { allowAll: true }
  | { allowAll: false; screens: ReadonlySet<SummaryScreenKey> };

const ALLOW_ALL: ScreenAllowlist = { allowAll: true };
/** 전 화면 차단 — 빈 allowlist. 모든 화면이 미러로 폴백한다. */
const BLOCK_ALL: ScreenAllowlist = { allowAll: false, screens: new Set<SummaryScreenKey>() };

/**
 * `read_screens` 원문 → allowlist. **순수 함수**(테스트가 여기부터 본다).
 *
 * - 전 화면 **허용**: 행 없음 · 빈 문자열(공백만 포함) · `'[]'` — 그 셋뿐이다.
 * - 전 화면 **차단**(빈 allowlist = 미러 폴백): 파싱 불가 · 배열 아님 ·
 *   알려진 키가 하나도 없는 배열. `warn` 을 함께 돌려준다.
 * - 알려진 키가 있으면 그 목록으로 제한하고, 섞여 있던 미지 키만 무시한다(+`warn`).
 *
 * 로깅은 여기서 하지 않는다(순수성) — 호출부가 `warn` 으로 1줄 남긴다.
 */
export function parseScreenAllowlist(raw: string | null | undefined): {
  list: ScreenAllowlist;
  warn: string | null;
} {
  const text = (raw ?? "").trim();
  if (text === "" || text === "[]") return { list: ALLOW_ALL, warn: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { list: BLOCK_ALL, warn: "not JSON" };
  }
  if (!Array.isArray(parsed)) return { list: BLOCK_ALL, warn: "not a JSON array" };

  const screens = new Set<SummaryScreenKey>();
  const unknown: string[] = [];
  for (const v of parsed) {
    const k = typeof v === "string" ? v.trim() : "";
    if (KNOWN.has(k)) screens.add(k as SummaryScreenKey);
    else unknown.push(typeof v === "string" ? v : JSON.stringify(v));
  }
  // 알려진 키가 하나도 없으면 의도를 읽을 수 없다 → 전 화면 차단(fail-closed).
  // 하나라도 알아들었으면 그 목록이 곧 의도다.
  if (screens.size === 0) {
    return { list: BLOCK_ALL, warn: `no known screen key (unknown: ${unknown.join(",")})` };
  }
  return {
    list: { allowAll: false, screens },
    warn: unknown.length ? `unknown screen key ignored: ${unknown.join(",")}` : null,
  };
}

// ── 원문 → allowlist (원문 읽기·30초 메모는 리포지터리가 쥔다) ─────────────
// 파싱은 싸지만 **경고 로그**는 싸지 않다 — 한 렌더에서 위젯 6개가 게이트를 부르므로
// 원문이 바뀔 때만 1줄 남기도록 마지막 원문을 기억한다.
let lastRaw: string | null | undefined;
let lastList: ScreenAllowlist = ALLOW_ALL;

/** 테스트 전용 — 파싱 메모 초기화. */
export function resetSummaryScreensForTests(): void {
  lastRaw = undefined;
  lastList = ALLOW_ALL;
}

/** 경고 1줄에 붙일 **결과**(원인만 적으면 무슨 일이 벌어졌는지 안 읽힌다). */
function outcomeOf(list: ScreenAllowlist): string {
  if (list.allowAll) return "allowing all screens";
  return list.screens.size === 0
    ? "blocking all screens (mirror fallback)"
    : `restricting to ${[...list.screens].join(",")}`;
}

function toAllowlist(raw: string | null): ScreenAllowlist {
  if (lastRaw === raw) return lastList;
  const { list, warn } = parseScreenAllowlist(raw);
  if (warn) console.warn(`summary read_screens: ${warn} — ${outcomeOf(list)}`);
  lastRaw = raw;
  lastList = list;
  return list;
}

/**
 * **기본 허용에서 빠지는 화면** — `read_screens` 에 이름이 **명시**돼 있을 때만 켜진다
 * (빈 배열 = 전 화면 허용이 이들에게는 적용되지 않는다).
 *
 * 왜 예외를 두는가: 이 둘은 x축만 바뀌는 것이 아니라 **값의 산식이 바뀐다**.
 *   · `S1.brandTrend`   — 시리즈 cap 의 모집단이 "창 전체 언급 합" → "최신 회차"
 *     (13회차 브랜드 축을 통째로 읽지 않으려는 2단 조회의 대가, PR③ 플랜 §3-4).
 *   · `S1.firstPosition` — `avgPosition` 의 **축이 미러와 다르다**. 미러는 답변 안
 *     **경쟁 순위**(`(name, job)` min 위의 `rank()` — `scope-aggregates.ts:3326-3331`)이고,
 *     집계층 이 화면은 `(job, brand_id)` 서수(`rank_sum / ranked_answers`)다.
 *     ⚠️ 종전 여기 적혀 있던 "미러는 `(name,job)` **avg** 이중평균 → min ≤ avg 라 값이
 *        체계적으로 좋아진다(19.4 → 16.4)" 는 **더 이상 사실이 아니다**(PR④-b 검증자 F2).
 *        미러가 2026-09-06 에 `rank()` 로 옮겼고, 0069 이 그 축을 집계층에도 굳혔다.
 *        두 축은 크기 자체가 다르다(같은 회차 Hyundai 서수 16.4 vs 경쟁 순위 3.3 —
 *        정본표는 `0069_summary_trend_brands_comp_rank.sql` 헤더). "좋아진다"가 아니라
 *        **다른 양**이다.
 *     → 그레인도 갈린다(미러 = 표시명 접기 · 이 화면 = `brand_id` 행). 그래서 이 키를
 *        켜려면 `toFirstPosition(…, positionAxis: "comp")` 로 **축을 먼저 옮겨야** 한다.
 *        PR④-b 는 경쟁사 행(`S1.competitors`)만 comp 축으로 옮기고 이 키는 서수 축
 *        그대로 두었다(`server.ts::fetchStandardKpiFirstPosition`) — 지금 켜면
 *        같은 대시보드에서 `S1.competitors` 와 축이 다르다.
 *   · `S4.subkpi`       — S4 카드 배지의 Sub-KPI(위 "이 키를 켜면 배지 숫자가 바뀐다" 표).
 *     창·모수가 다르고 `citOwned` 는 유닛 판정 차이라, 켜면 배지 숫자가 바뀐다.
 *   · `S2.mention`·`S5.mention` — T8 의 **누적 → 회차 집합 SUM**. 화면의 "고유 프롬프트"
 *     계열 지표가 회차 합으로 바뀌는 의도적 화면 변경이고, 켜는 조건이 코드가 아니라
 *     **GGMD 확인**(P-5)이다. 코드는 머지하되 켜지 않는 것이 플랜 §6-2 의 계약인데,
 *     `read_screens='[]'`(전 화면 허용)가 그 계약을 조용히 깨고 있었다(F2) — 지금은
 *     `screens all` 로도 안 켜진다.
 * 고객이 보는 숫자가 달라지므로 스위치 없이 켜지면 안 된다 — 켜는 것은 운영 결정이다.
 * (x축만 바뀌는 `fetchStandardTrend` 는 D-4 해제로 승인된 변경이라 `S1.dashboard` 를 탄다.)
 */
export const SUMMARY_SCREEN_OPT_IN: ReadonlySet<SummaryScreenKey> = new Set<SummaryScreenKey>([
  "S1.brandTrend",
  "S1.firstPosition",
  // PR③-a B6 합류(#235 D6) — 이 키도 **고객이 보는 숫자**를 바꾼다(위 표: answers
  // 25,169 → 19,530 등). 성능 스위치(`all`)가 값 변경을 켜지 못하게 같은 자리에 둔다.
  "S4.subkpi",
  // T8(누적 → 회차 집합 SUM) — P-5 GGMD 확인 전까지는 어떤 스위치로도 켜지지 않는다(F2).
  "S2.mention",
  "S5.mention",
  // PR④ B1·B2 (2026-09-10, 운영 결정 D1 (1)) — 대시보드 카드 하단 **경쟁사 행**을
  // 카드 ①~⑤ 와 같은 **회차 스냅샷**으로 통일한다. 위 `S4.subkpi` 와 같은 "화면별
  // 의미론" 예외이고, **S2 언급 화면(`S2.mention`)은 건드리지 않는다** — 그쪽은
  // T8·GGMD 대기다. 이 키를 켜면 세 가지가 바뀐다:
  //   ① 값의 창·모수 — 미러의 **누적 전 이력** → 카드와 같은 **회차 스냅샷**.
  //      경쟁사 값·순위가 바뀐다(노출률·점유율·우호도).
  //   ② `avgPosition` — **0069(PR④-b)에서 축을 미러와 맞췄다. 더 이상 축 변경이 아니다.**
  //      아래는 그 결정에 이른 경위이고, 지금 코드는 마지막 ✅ 문단이 정본이다.
  //      · 오늘(미러 `aggregateMentionsFromMirror`) = 답변 **안에서의 경쟁 순위**다:
  //        `pos = (name,job) min(avg_position)` → `rank() OVER (PARTITION BY job_id
  //        ORDER BY tp)` → 그 순위의 평균(`scope-aggregates.ts:3362-3371`).
  //        "그 답변에서 몇 번째로 언급된 브랜드인가" = 카드 ④(`trend_own.rank_sum`)와
  //        **같은 축**이다(`fold.ts:25` — ④는 min(first_rank) 가 아니라 `rank()` 서수다).
  //      · 켜면(집계층 `trend_brands.rank_sum / ranked_answers`) = 본문 **텍스트 내
  //        서수**(`first_rank`)의 평균이 된다. `fold.ts:27-28` 이 두 `rank_sum` 은
  //        **정의가 다르다**고 못박고 있다.
  //      · 실측(2026-09-10, 회차 `74eca7fb`, admin 무필터): 카드 ④ **2.6** ·
  //        경쟁사 행 미러 Tesla **3.8**/Toyota 4.2/BMW 5.1/Mercedes-Benz 5.4 →
  //        집계층 서수 Tesla **19.0**/Toyota 19.6/BMW 23.3/Mercedes-Benz 23.9.
  //      · **창·모수 차이가 아니라 정의 차이임을 같은 행집합 위에서 증명했다** —
  //        `summary_brand_mentions` 의 같은 회차 행에 두 정의를 나란히 얹으면
  //        (raw = `avg(first_rank)` · competitive = `avg(rank() OVER (PARTITION BY
  //        job_id ORDER BY min(first_rank)))`) 브랜드 7개가 전부 갈린다:
  //        Hyundai 서수 **16.4041** vs 경쟁 순위 **3.3469**.
  //        ⭐ 7개 전체 정본표(4자리·스코프 명시)는 마이그레이션
  //           `0069_summary_trend_brands_comp_rank.sql` 헤더 "왜 새 컬럼인가" 에 있다.
  //           여기 복사하지 마라 — 복사본 셋이 서로 다른 값을 들고 있던 것이 F4 다.
  //        즉 두 수는 같은 양의 다른 창이 아니라 **서로 다른 양**이다.
  //      ✅ **해소됨 (2026-09-10, 운영 결정 (1) → 0069 / PR④-b).** 위 문단의 "집계층에는
  //         답변 안 경쟁 순위를 복원할 수 있는 그레인이 없다" 는 **틀렸다** — `trend_brands`
  //         가 job 을 접기는 하지만, 경쟁 순위는 접기 **직전**의 세부층
  //         (`summary_brand_mentions`)에서 job 창 함수로 전부 계산된다. 그래서 세부층은
  //         그대로 두고 집계층에 `comp_rank_sum`·`comp_ranked_answers` 두 칸만 굳혔다
  //         (`fold.ts` 의 `COMP_RANK_GATE`/`COMP_RANK_TP`/`compRankOver` — `trend_own` 과
  //         **문자열까지 공유**한다).
  //         리더(`toCompetitorBrands`)는 이제 그 둘로 나눈다. 실측 대조(같은 회차
  //         `74eca7fb`, 무필터, 접기 SQL 을 세부층 위에서 SELECT 로만 돌려 독립 재계산과
  //         12/12 일치) — 값은 위 정본표(0069 헤더)의 "경쟁 순위" 열이고, 미러 열과
  //         같은 축·같은 값이다.
  //         (Hyundai 만 미러 표기 3.4 와 1틱 다르다: 정확값 **3.3469** 로 반올림 경계
  //          3.35 에서 0.003 아래라, 알려진 답변셋 차이(미러 38,745 vs 집계층 38,748)면
  //          충분히 뒤집히는 폭이다. 축 차이가 아니다.)
  //         ⚠️ 정본표는 **접기 스코프**(게이트 없는 세부층 전수)다. 화면이 내는 값은
  //            조회 게이트가 걸려 소수 둘째 자리부터 다르다(2026-09-11 실측 Hyundai
  //            3.3469 → 게이트 후 3.3566). 표와 화면을 등호로 잇지 마라.
  //         남는 차이는 **창·모수뿐**이다(①) — 그것이 이 키가 여전히 옵트인인 이유다.
  //   ③ Δ 의 x축 — 주 버킷 → **회차**. "직전 회차 대비" 가 된다(`S1.brandTrend` 와 같다).
  //      Δ 의 **단위**도 값과 같은 comp 축이다(PR④-b F1 수리 —
  //      `toFirstPosition(…, positionAxis: "comp")`). 실측 8/31 vs 8/19(무필터):
  //      Toyota +0.0(4.2→4.2) · Tesla +0.6 · BMW +0.7 · Mercedes-Benz +1.0.
  //      서수 축으로 두면 같은 행에서 값 4.2 옆에 Δ +4.5 가 선다(그것이 F1 이었다).
  // ⚠️ `answers`(노출률 분자)에는 **상한 caveat** 가 있다 — 같은 표시명에 `brand_id`
  //    가 둘 이상이면 접기가 id 를 키로 갖는 만큼 겹쳐 센다. 2026-09-10 글로벌 실측
  //    `74eca7fb`: 표시명 1,103개 중 10개, 합계 178,024 vs 177,355 = **+0.38%**
  //    (`summary-trend-aggregates.ts::TrendBrandRow.answers` 주석이 정본).
  "S1.competitors",
]);

/** 이 화면이 사실표 경로를 써도 되는가. 설정 읽기는 요청당 1회(30초 메모). */
export async function summaryScreenAllowed(screen: SummaryScreenKey): Promise<boolean> {
  const list = toAllowlist(await readScreensRaw());
  if (SUMMARY_SCREEN_OPT_IN.has(screen)) {
    return !list.allowAll && list.screens.has(screen);
  }
  return list.allowAll || list.screens.has(screen);
}
