import "server-only";
import { websiteOwnedUnitEnabled } from "./website-owned-unit-flag";

/**
 * 유닛 단위 자사 판정의 **요청 전 확정** — `lib/period/anchor-axis-state.ts` 의 계약을
 * 그대로 옮긴 것이다.
 *
 * 왜 필요한가: 자사 술어를 만드는 빌더는 **동기**인데 판정은 비동기다(설정 행 읽기).
 * 판정을 빌더 안에서 논블로킹으로 읽으면 **한 렌더 안에서 문장마다 정의가 갈린다** —
 * 같은 화면에서 ⑤ 는 유닛, 자사 URL 인용률은 flat 이 되어 "자사 42%인데 자사 인용
 * 프롬프트는 90%" 가 나온다. 그래서 계약이 둘이다:
 *   ① SQL 을 만드는 **async 진입점은 `await ensureWebsiteOwnedUnit()`** 를 부른다.
 *   ② 동기 빌더는 `websiteOwnedUnitKnownEnabled()` 만 읽는다. 미확정이면 **false**
 *      = 종전 flat 이고, 그 경우 경고를 한 번 남긴다(ensure 를 빠뜨린 신호).
 *
 * 미확정 폴백이 false 인 것이 안전한 이유: 그 값은 "오늘 프로덕션이 내는 바로 그 술어"
 * 라 최악도 "전환이 안 켜진다"이지 틀린 숫자가 아니다.
 *
 * TTL 은 앵커 축과 같은 30초다 — 원문(`summary_settings` 한 행)이 이미 30초 메모라,
 * "설정을 껐는데 안 돌아온다" 창이 그 이상으로 길어지지 않는다. 사람이 끄고 켜는
 * 스위치이므로 확정값을 영구 캐시하지 않는다.
 */

const TTL_MS = 30_000;

type UnitState = { value: boolean; expiresAt: number };

let state: UnitState | null = null;
let inflight: Promise<boolean> | null = null;
let warned = false;

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function resetWebsiteOwnedUnitForTests(): void {
  state = null;
  inflight = null;
  warned = false;
}

/** 테스트 전용 — DB 없이 판정값을 고정한다(켜진 경로의 SQL 형태 검증용). */
export function setWebsiteOwnedUnitForTests(value: boolean): void {
  state = { value, expiresAt: Number.MAX_SAFE_INTEGER };
  inflight = null;
}

/**
 * 판정을 **확정**한다. 이미 확정돼 있으면 왕복이 없고, 동시에 여러 진입점이 불러도
 * 발사는 1회다. 절대 throw 하지 않는다 — 판정 실패가 화면 장애가 되면 안 되고,
 * 실패의 의미는 "종전 flat"이라 값이 틀릴 방향이 없다.
 */
export async function ensureWebsiteOwnedUnit(): Promise<boolean> {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await websiteOwnedUnitEnabled();
      state = { value, expiresAt: Date.now() + TTL_MS };
      return value;
    } catch (e) {
      console.error("[website-owned-unit] 판정 실패 — 종전 flat 으로 간다", e);
      state = { value: false, expiresAt: Date.now() + TTL_MS };
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 동기 빌더가 읽는 판정값. **호출 전에 `ensureWebsiteOwnedUnit()` 이 await 돼 있어야
 * 한다.** 미확정이면 종전 flat(false)으로 나가고 프로세스당 한 번 경고한다.
 */
export function websiteOwnedUnitKnownEnabled(): boolean {
  const now = Date.now();
  if (state && state.expiresAt > now) return state.value;
  if (!warned) {
    warned = true;
    console.warn(
      "[website-owned-unit] 판정 전에 동기 SQL 빌더가 호출됐다 — 이번 호출은 종전 " +
        "flat 으로 나간다. 그 진입점에 `await ensureWebsiteOwnedUnit()` 을 추가하라.",
    );
  }
  return false;
}
