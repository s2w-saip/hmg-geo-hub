import "server-only";
import { answerCycleAnchorsAvailable } from "@/lib/db/column-availability";
import { summaryScreenAllowed } from "@/lib/summary/read/screens";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축(0077 `scope_answer_cycle_anchors`)의 on/off — 화면 키 `X.answerAnchor`
// + **프리뷰 전용** env `ANSWER_ANCHOR_FORCE` + 테이블 존재 capability
// ════════════════════════════════════════════════════════════════════════════
//
// 정본 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §4,
// 스펙 `internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md` §5.
//
// ── 기본은 off 이고, 끄면 **바이트 동일** ─────────────────────────────────────
//
// 이 판정이 false 면 리더는 종전 축(`started_at`·`measured_at`·앵커 UTC 일자)을
// 그대로 쓴다. 선행 리팩터(A1~A7)가 만든 SQL 스냅샷 78건이 **수정 없이** 통과하는
// 것이 그 성질의 증거다 — 고쳐야만 통과한다면 그 커밋은 축 전환이 아니라 회귀다.
//
// ── 판정이 **세 겹**인 이유 ─────────────────────────────────────────────────
//
//   ① capability  — 테이블이 없는 DB 에서는 켜져 있어도 종전 경로로 간다.
//      이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이 따로 적용한다
//      (`db:apply`). 0077 이 아직 안 붙은 DB 에 코드가 먼저 가면 `ca.round_date`
//      가 42703 으로 죽어 대시보드 전 화면이 장애가 된다. 프로브는 **읽기만**
//      한다(`column-availability.ts` 는 DATA 스트림 소유).
//   ② env        — 프리뷰에서 먼저 보기 위한 경로. 화면 키는 `summary_settings`
//      한 행에서 오는데 프리뷰와 프로덕션이 같은 DB 를 읽는지 미확인이라
//      (기간 비교 Δ 설계 §11-2), 키를 켜는 순간 프로덕션에도 켜질 수 있다.
//   ③ 화면 키    — 운영 스위치. `SUMMARY_SCREEN_OPT_IN` 이라 `screens all`(= `'[]'`)
//      로는 켜지지 않는다. 축 전환은 **고객이 보는 숫자를 바꾼다**(기간 술어·주
//      버킷·dedup·측정 기준일이 전부 움직인다) — 성능 스위치로 켜지면 안 된다.
//
// ── 순서가 계약이다: **스위치 먼저, capability 나중** ───────────────────────
//
// 처음에는 capability 를 맨 앞에 뒀다. "테이블 없는 배포에서 매 요청 `read_screens`
// 를 읽는 것"을 피하려는 것이었는데, 실제 대가는 반대쪽이 훨씬 컸다(독립 검증
// 주의 A-1): `answerCycleAnchorsAvailable()` 은 `ensureColumnAvailability()` 의
// **배치 문장에 없는 별도 statement** 라, 축이 꺼진 오늘도 콜드 요청마다 DB 왕복이
// 하나 늘고 60초(`PROBE_RETRY_MS`)마다 반복된다. 그 배치 주석이
// (`column-availability.ts`) "콜드에 커넥션·왕복을 더 여는 것 자체가 위험"이라고
// 못 박은 자리다.
//
// 지금 순서의 비용은 그 반대다:
//   · 스위치 off(=오늘 전 배포) → **DB 왕복 0**. env 는 순수 조회이고 화면 키는
//     `summary_settings` 한 행인데 이미 30초 메모돼 있으며, 이 판정 자체도
//     `anchor-axis-state.ts` 가 30초 캐시한다.
//   · 스위치 on → capability 프로브 1회. true 면 영구 캐시라 그 뒤로 공짜다.
// 즉 "테이블 없는데 스위치를 켠" 조합에서만 설정 읽기가 늘고, 그 조합은 전환
// 기간의 프리뷰뿐이다.
//
// ⚠️ capability 를 **떼면 안 된다**. 스위치가 켜졌는데 테이블이 없으면
// `ca.round_date` 가 42703 으로 죽어 대시보드 전 화면이 장애가 된다 — 순서만 바꾼
// 것이고 가드는 그대로다.
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 이 값은 서버에서만 읽힌다.

/** 축 전환을 켜는 화면 키. 계약 §4 에서 이름이 고정돼 있다. */
export const ANSWER_ANCHOR_SCREEN_KEY = "X.answerAnchor" as const;

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export function answerAnchorOverrideAllowedHere(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function answerAnchorForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return answerAnchorOverrideAllowedHere(env) && env.ANSWER_ANCHOR_FORCE === "1";
}

/**
 * 이 요청에서 기간 축을 **회차 귀속 날짜**(`ca.round_date`)로 읽는가.
 *
 * 한 요청 안에서 **같은 값**이어야 한다 — 카드가 앵커 축인데 추이가 측정 축이면
 * 같은 화면에서 모수가 갈린다. 호출부는 진입점에서 한 번 await 해서 아래로
 * 내려보낸다(`periodCompareEnabled` 와 같은 자세).
 */
export async function answerAnchorEnabled(): Promise<boolean> {
  // ① 스위치 — env 는 왕복 0, 화면 키는 30초 메모된 설정 한 행(머리 주석).
  const switchedOn =
    answerAnchorForced() || (await summaryScreenAllowed(ANSWER_ANCHOR_SCREEN_KEY));
  if (!switchedOn) return false;
  // ② capability — 켜졌을 때만 프로브를 쏜다. 테이블이 없으면 종전 경로다.
  return answerCycleAnchorsAvailable();
}
