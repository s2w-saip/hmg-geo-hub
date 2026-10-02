import "server-only";
import { cache } from "react";
import { kpiDegrade } from "./kpi-tab-budget";
import { describeHghError, isHghApiError } from "@/lib/hgh/errors";

// ════════════════════════════════════════════════════════════════════════════
// degrade 표식 — "이 위젯은 값이 없는 게 아니라 **예산에 걸렸다**" (E-2)
// ════════════════════════════════════════════════════════════════════════════
//
// `kpiDegrade` 는 시간 초과를 `null` 로 내린다. 대부분의 페처는 그것으로 충분하다 —
// 그 필드의 `null` 이 곧 degrade 라서 화면이 바로 "시간 안에 끝나지 않았습니다" 를
// 그린다(`citations-standard-view.tsx:397` 이 그 형태다).
//
// 그런데 `fetchStandardCitations` 의 `null` 은 **두 뜻**이다:
//   ① 스코프 없음 / 이 필터에 데이터 없음  → "데이터 없음"
//   ② 예산 초과                            → "일부 위젯 지연 · 다시 시도"
// 둘을 값으로 구분할 방법이 없어(둘 다 `null`) 화면이 ②를 ①로 오독한다.
//
// 그래서 **요청 스코프의 표식**을 둔다. 추가 조회가 없고(이미 끝난 판정을 기록만 한다),
// 값 계약(`CitationsLive | null`)도 안 바꾼다 — 화면은 원하면 읽고, 안 읽으면 종전 그대로다.
//
// 범위: React `cache()` — 요청 하나 안에서만 공유된다(인자 0개라 참조 동일성 문제 없음,
// `lib/request-dedupe.ts` 머리 주석과 같은 근거). 서버 컴포넌트 렌더 밖(스크립트·테스트)
// 에서는 그냥 빈 집합이라 아무 일도 일어나지 않는다.

const store = cache((): Set<string> => new Set<string>());

/** 이 요청에서 `label` 위젯이 예산에 걸렸는가. */
export function wasDegraded(label: string): boolean {
  try {
    return store().has(label);
  } catch {
    // 요청 스코프 밖(스크립트·단위 테스트) — 표식이 없다.
    return false;
  }
}

/** 이 요청에서 degrade 된 위젯 전부 — 진단·로그용. */
export function degradedLabels(): string[] {
  try {
    return [...store()];
  } catch {
    return [];
  }
}

/**
 * `kpiDegrade` + 표식. 시간 초과만 삼키는 규칙은 그대로다(권한·연결·문법은 재throw).
 *
 * ⚠️ **캐시 바깥**에서 감싸라. 안쪽에서 감싸면 degrade 결과가 `unstable_cache` 에
 *    저장돼 TTL 동안 굳는다(`kpi-tab-budget.ts::DegradedResultUncached` 머리 주석이
 *    같은 함정을 다룬다). 바깥에서 감싸면 예외가 캐시를 지나쳐 저장이 일어나지 않고,
 *    다음 요청은 캐시 MISS 라 **다시 시도**한다.
 */
export async function degradeAware<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  let degraded = true;
  const out = await kpiDegrade(label, async () => {
    const v = await run();
    degraded = false;
    return v;
  });
  if (degraded) {
    try {
      store().add(label);
    } catch {
      // 요청 스코프 밖 — 기록할 곳이 없다. degrade 자체는 그대로 동작한다.
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// API 경로의 같은 표식 (U4, 설계 부록 A R-degrade)
// ════════════════════════════════════════════════════════════════════════════
//
// 새 백엔드 API(lib/hgh)에는 "예산" 개념이 없다. 대신 **일시 실패**(5xx·시간 초과·
// 연결 실패·중단)가 옛 예산 초과와 같은 자리에 온다: 값이 없는 게 아니라 이번 요청이
// 제때 끝나지 못했다. 그래서 같은 라벨을 기록하고 null 을 돌려준다. 화면은 지금처럼
// `wasDegraded(label)` 만 읽으면 되고 문구("시간 안에 끝나지 않았습니다")도 그대로다.
//
// 4xx 는 기록하지 않고 그대로 던진다. 권한(401·403)·없음(404)·필터 버그(422)를
// "지연"으로 위장하면 안 된다(위 degradeAware 가 권한·연결·문법을 재throw 하는 것과
// 같은 자세). 위 함수들의 동작은 바뀌지 않는다: 아래는 추가만이다.

/** 이 요청에서 `label` 위젯을 degrade 로 기록한다. 요청 스코프 밖이면 아무 일도 없다. */
export function markDegraded(label: string): void {
  try {
    store().add(label);
  } catch {
    // 요청 스코프 밖(스크립트·단위 테스트): 기록할 곳이 없다.
  }
}

/** 중단(AbortSignal)으로 끝난 fetch 인가. */
function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * degrade 로 볼 API 실패인가: 백엔드 5xx, 로컬 시간 초과(504 timeout)·연결 실패
 * (502 network_error)·비 JSON 응답, 그리고 중단. 4xx·그 밖의 예외는 아니다.
 */
export function isDegradableApiFailure(e: unknown): boolean {
  if (isAbortError(e)) return true;
  return isHghApiError(e) && e.status >= 500;
}

/**
 * `degradeAware` 의 API 판: `run()` 이 degrade 대상 실패로 끝나면 `label` 을 기록하고
 * 로그 한 줄(코드·상태·요청 id, 본문 없음)을 남긴 뒤 null. 그 밖의 실패는 그대로 던진다.
 */
export async function degradeOnApiFailure<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (!isDegradableApiFailure(e)) throw e;
    markDegraded(label);
    console.warn(
      isHghApiError(e) ? `${describeHghError(e)} degraded=${label}` : `[hgh] aborted degraded=${label}`,
    );
    return null;
  }
}
