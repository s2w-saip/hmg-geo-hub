import "server-only";
import { cache } from "react";
import {
  cycleFingerprintErrorCode,
  readCycleFingerprints,
  resetCycleFingerprintCapsForTests,
  type CycleFingerprints,
} from "@/lib/db/repositories/cycle-fingerprint";

// ════════════════════════════════════════════════════════════════════════════
// 현재 노출 회차의 **지문** — 앵커 축 캐시 셀 키의 회차 정체성 조각 (2026-09-27)
// ════════════════════════════════════════════════════════════════════════════
//
// ── 왜 (2026-09-27 프리뷰 실측) ────────────────────────────────────────────
//
// 웹사이트 화면 카드 36개 중 17개가 "측정 기준일 2026-09-25" 라벨 아래 **9/18 회차 값**을
// 냈다. 9/18 값이던 17개는 전부 캐시 히트(3~5초)였고, 콜드(20초+) 9개는 전부 9/25 값이었다.
//
// 앵커 축 셀의 값은 "지금 노출되는 회차"(앵커 표·원장·시계)에 의존하는데 `mirrorCache`
// 키에는 그것이 없었다. 무효화는 미러 싱크(`runs > 0` 또는 **관제** 귀속 > 0 일 때, 크론은
// 프로덕션 배포에서만 돈다)와 요약 발행 라우트의 `revalidateTag` 뿐이라, 그 둘을 거치지 않는
// 변경이 TTL(7,200초) 동안 가려졌다:
//   · 앵커 수동 적재(`refresh_answer_cycle_anchors` 직접 호출) — 9/27 04:47~04:51Z,
//     9/25 website 회차 state 행 95개가 이때 처음 생겼다. 원장은 9/24 부터 서빙 가능이었다.
//   · 시계가 원장 노출 시각·앵커 노출일을 넘는 순간 — 아무도 아무것도 안 쓴다.
//   · 숨김 스크립트(`scripts/summary/hide-cycle.ts`)는 revalidate 를 안내만 한다.
//   · 요약 생성기의 늦은 귀속(`upsertCycleRunsSql`, attributed_by='operator') — 이미 서빙 중인
//     회차에 run 이 붙어도 싱크 무효화를 안 거친다(재검증 V4, 14일 14건). 관제 late 경로의
//     늦은 귀속(서빙 중 global 회차 17건)도 있었다. 지문의
//     서빙 회차 멤버십 성분이 이것을 잡는다.
//
// 지문의 성분·실행 상한은 `lib/db/repositories/cycle-fingerprint.ts` 머리 주석이 정본이다.
//
// ── 메모는 **벽시계 5분 경계**에 정렬한다 (hmg-geo PR #297 검증 C4) ────────────
//
// 초판은 30초 메모였다. 콜드 계산(20~56초)이 메모보다 길어서, 원장 이벤트가 몰리는 구간
// (요약 생성 1시간에 이벤트 213개)에는 계산이 끝나기 전에 키가 바뀌어 적중률이 0 이 됐다.
// 지금은 만료가 **판정 시작 시각의 다음 5분 경계**다 — 인스턴스가 달라도 같은 경계에 다시
// 읽으므로 키가 경계마다 한 번만 넘어간다. 대가: 회차가 바뀐 뒤 최대 **5분 + 조회 상한
// 4초** 동안은 라벨(요청 단위)과 카드(셀)가 갈릴 수 있다(종전 최대 2시간).
//
// ── 실패하면 (옛 셀을 굳히지 않는다) ────────────────────────────────────────
//
// 판정 실패(DB 오류·문장 상한·벽시계 상한 4초 초과)면
//   ① 마지막 성공 지문이 **직전 5분 칸 이후**에 읽은 것이면 그것을 이번 칸 끝까지 재사용한다.
//   ② 아니면 `null` → 슬롯은 5분 버킷(`cycle-unknown:<버킷>`)이다.
// 오래된 지문을 무기한 재사용하지 않는다(최대 약 10분). 고정 폴백 문자열이 없으므로 실패
// 중 채운 셀이 다음 실패 때 되살아나지 않는다. 실패는 5초만 기억해 복구되면 곧 돌아간다.
//
// ── 알려진 한계 (검증 D1·D4·C2) ─────────────────────────────────────────────
//
//   · **행 단위 변경은 못 본다.** 서빙 중 회차의 run 멤버십(어느 run 이 속하는가)은 보지만,
//     이미 노출 중인 회차 안에서 답변 행만 바뀌는 경로
//     (`backfill-answer-cycle-anchors`·`refresh_answer_cycle_anchors` 수동 실행, 대량 미러
//     적재 스크립트, 0054 답변 드롭, state 행 없는 회차의 `round_date` 재배정
//     `reassign-cycle-rounds.ts`)는 지문이 그대로다. 그 경로는 스크립트가 끝에서
//     무효화하거나(`generate-cycle.ts --revalidate-only`) TTL 로 풀린다.
//   · **state 행이 없는 회차**(0078 이전에 채워진 회차, website 380 중 279)는 회차 수준
//     변화도 state 성분에 안 보인다. 원장 성분(서빙·숨김)과 날짜는 보인다.
//   · **행 노출일과 state 노출일의 괴리**(검증 G4, project 9/21 1,825행)는 state 쪽만 본다.
//     날짜 성분(오늘)이 하루 한 번 셀을 갈아 끼우는 것으로 일부만 덮는다.
//   · **되돌림 충돌**(검증 D4) — 숨김 해제처럼 게이트 입력이 이전과 **같은 값**으로
//     돌아가면 지문도 이전과 같아진다. 숨김 구간에 옛 지문 키로 채워진 셀(메모 창 안의
//     경합)이 있으면 그 셀이 TTL 동안 되살아날 수 있다(저확률). 숨김 스크립트가 끝에서
//     무효화해 닫는다.
//   · 0078 미적용 배포에서는 state 성분이 빠진다.
//   · **상한은 지문 조회만 묶는다.** 같은 경로의 `ensureAnchorAxis`·`ensureTrendGrid` 는 상한
//     없이 풀 대기에 묶이므로, 풀 포화·DDL 락이 캐시 적중 요청을 붙잡는 것은 막지 못한다.
//   · 지문이 하나라 website 이벤트가 global·project 셀까지 콜드로 만든다(표면 분리는 후속).

/** 메모 칸 폭 = 판정 실패 버킷 폭. */
export const CYCLE_BUCKET_MS = 300_000;
/** 호환 별칭(실패 버킷). */
export const CYCLE_UNKNOWN_BUCKET_MS = CYCLE_BUCKET_MS;
const FAILURE_RETRY_MS = 5_000;
/** 커넥션 획득 대기를 포함한 벽시계 상한. 문장 상한(2초)보다 넉넉하게. */
export const CYCLE_FINGERPRINT_DEADLINE_MS = 4_000;
/** 키 조각에 싣는 지문 길이(hex). md5 앞 16자 = 64비트. */
const SLOT_HEX = 16;

/** 셀이 어떤 지문을 싣는가 — 대부분 `gate`, 기간 비교만 `ledger`. */
export type CycleKeyMode = "gate" | "ledger";

const bucketStart = (t: number): number => Math.floor(t / CYCLE_BUCKET_MS) * CYCLE_BUCKET_MS;
const nextBoundary = (t: number): number => bucketStart(t) + CYCLE_BUCKET_MS;

type FpState = { fps: CycleFingerprints | null; expiresAt: number };
let state: FpState | null = null;
let lastGood: { fps: CycleFingerprints; at: number } | null = null;
let inflight: Promise<CycleFingerprints | null> | null = null;
let failWarned = false;

/** 벽시계 상한 — 커넥션 획득 대기까지 자른다. 늦게 끝난 원 작업의 거부는 삼킨다. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`deadline ${ms}ms`), { code: "deadline" })),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * 지문 둘 또는 판정 실패 `null`. **절대 throw 하지 않는다.** 성공은 다음 5분 경계까지,
 * 실패는 5초 기억하고 동시 호출은 1회로 접는다.
 */
export async function resolveCycleFingerprints(): Promise<CycleFingerprints | null> {
  if (state && state.expiresAt > Date.now()) return state.fps;
  if (inflight) return inflight;
  inflight = (async () => {
    // 만료·재사용 판정은 **판정 시작 시각** 기준이다(재검증 V3). 경계 직전에 시작해 직후에
    // 끝난 판정의 결과는 경계 이전 DB 상태일 수 있으므로, 그 경계에서 바로 만료시킨다.
    // 끝난 시각 기준이면 다음 칸 5분 전체가 옛 지문으로 채워진다.
    const started = Date.now();
    try {
      const fps = await withDeadline(readCycleFingerprints(), CYCLE_FINGERPRINT_DEADLINE_MS);
      state = { fps, expiresAt: nextBoundary(started) };
      lastGood = { fps, at: started };
      failWarned = false;
      return fps;
    } catch (e) {
      const now = Date.now();
      if (!failWarned) {
        failWarned = true;
        // 비밀값은 싣지 않는다. SQLSTATE 는 drizzle 이 감싼 원인(cause.code)부터 본다(재검증 K4).
        const err = e as { message?: unknown };
        console.error(
          "[cycle-fingerprint] 판정 실패: 직전 칸 지문이 있으면 이번 칸 끝까지 재사용, " +
            "없으면 5분 버킷 키 " +
            `code=${cycleFingerprintErrorCode(e) ?? "none"} ` +
            `msg=${typeof err?.message === "string" ? err.message : String(e)}`,
        );
      }
      // 직전 칸(또는 이번 칸) 안에서 읽은 성공만 재사용한다 — 무기한 재사용 금지.
      const reuse =
        lastGood && lastGood.at >= bucketStart(now) - CYCLE_BUCKET_MS ? lastGood.fps : null;
      state = { fps: reuse, expiresAt: Math.min(now + FAILURE_RETRY_MS, nextBoundary(now)) };
      return reuse;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 키 조각 — `gate` 는 `cycle:<16hex>`, `ledger` 는 `cycle-l:<16hex>`, 판정 실패는
 * `cycle-unknown:<5분 버킷>`. 순수 함수(테스트가 시각을 주입한다).
 */
export function cycleCacheSlotFor(
  fps: CycleFingerprints | null,
  mode: CycleKeyMode = "gate",
  now: number = Date.now(),
): string {
  if (!fps) return `cycle-unknown:${Math.floor(now / CYCLE_BUCKET_MS)}`;
  return mode === "ledger"
    ? `cycle-l:${fps.ledger.slice(0, SLOT_HEX)}`
    : `cycle:${fps.gate.slice(0, SLOT_HEX)}`;
}

/** 요청 단위 확정 — 한 요청의 셀들이 같은 판정(두 모드 포함)을 쓴다. */
const requestFingerprints = cache(
  async (): Promise<{ fps: CycleFingerprints | null; now: number }> => ({
    fps: await resolveCycleFingerprints(),
    now: Date.now(),
  }),
);

/**
 * **요청 단위 확정본**. 메모 만료가 요청 한가운데 걸려도 카드 A 는 옛 지문, 카드 B 는
 * 새 지문인 분기가 생기지 않는다(`trend-grid-flag.ts::requestState` 의 N1 과 같은 이유).
 * 요청 밖(테스트·스크립트)에서는 React `cache` 가 통과 함수라 매번 프로세스 메모를 읽는다.
 *
 * ⚠️ 앵커 축이 **켜진 경로에서만** 부른다. 축 off 의 키·DB 왕복은 종전과 같아야 한다.
 */
export async function ensureCycleCacheSlot(mode: CycleKeyMode = "gate"): Promise<string> {
  const { fps, now } = await requestFingerprints();
  return cycleCacheSlotFor(fps, mode, now);
}

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function resetCycleFingerprintForTests(): void {
  state = null;
  lastGood = null;
  inflight = null;
  failWarned = false;
  resetCycleFingerprintCapsForTests();
}
