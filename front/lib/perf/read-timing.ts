import "server-only";
import { wasDegraded } from "@/lib/scope/degrade-registry";

// ════════════════════════════════════════════════════════════════════════════
// A0 — read 단위 계측 (PR④ §2 A0)
// ════════════════════════════════════════════════════════════════════════════
//
// 왜 필요한가: 스트리밍 경계의 마커(`SectionDoneMarker`)는 `Promise.all` 의
// **최댓값**만 알려 준다. `dashboard:kpi-competitors` 16.5 s 가 넷 중 어느 read 의
// 값인지, 그리고 그 read 가 **예산에 걸려 degrade 로 빠졌는지**(그 경우 화면의
// 경쟁사 Δ 가 통째로 `−` 다) 마커로는 구분되지 않는다. 그 귀속을 한 줄로 남긴다.
//
// 형식은 `x-hmg-summary(...)`(server.ts) 와 같은 계열이다 — 프리픽스가 `x-hmg-` 로
// 시작하는 한 줄 `console.info`, 콜론 뒤에 판정. 로그 수집기가 두 계열을 같은
// 필터로 잡는다.
//
//   x-hmg-read(kpi-competitors/brandTrend): 16412ms degraded:true rows:0
//
// ⚠️ **누출 금지가 이 모듈의 계약이다.** 내보내는 것은 넷뿐이다:
//   · `name`  — 호출부의 **문자열 리터럴**(경계/read 이름). 값이 아니다.
//   · `ms`    — 정수
//   · degrade — `true|false|na`
//   · rows    — 정수(음수·NaN·소수는 정규화)
// 필터·계정·브랜드·국가·URL 은 어느 인자로도 들어오지 않는다. 실패한 read 도
// **메시지를 찍지 않는다**(예외 본문에 필터가 실릴 수 있다) — `rows:err` 로만 남긴다.
//
// 비용: `.then` 하나. **발행 시점을 바꾸지 않는다** — 이 함수는 이미 만들어진
// 프로미스를 받는다(thunk 가 아니다). 호출부에서 `fetchX(...)` 가 먼저 평가되고
// 그 결과가 인자로 들어오므로 read 발행 순서·시각이 종전과 같다.

/** 로그 한 줄의 문법 — 테스트와 공유하는 정본. */
export const READ_TIMING_LINE =
  /^x-hmg-read\([a-zA-Z0-9._/:-]+\): \d+ms degraded:(?:true|false|na) rows:(?:\d+|err)$/;

function emit(name: string, ms: number, degraded: boolean | null, rows: number | null): void {
  const n = Number.isFinite(rows as number) ? Math.max(0, Math.trunc(rows as number)) : null;
  const d = degraded === null ? "na" : degraded ? "true" : "false";
  console.info(
    `x-hmg-read(${name}): ${Math.max(0, Math.round(ms))}ms degraded:${d} rows:${n === null ? "err" : n}`,
  );
}

/**
 * 이미 발행된 read 프로미스 하나를 감싸 도착 시각·degrade·행 수를 한 줄로 남긴다.
 * 값과 거부는 **그대로** 전파한다(관측만 한다).
 *
 * @param name         경계/read 이름 — 반드시 **문자열 리터럴**로 넘긴다.
 * @param degradeLabel `degradeAware` 라벨. 그 보호가 없는 read 는 `null`(→ `degraded:na`).
 * @param p            이미 발행된 read 프로미스.
 * @param rows         결과에서 **정수 하나**를 뽑는 함수. 값을 로그로 흘리지 않는다.
 */
export function timedRead<T>(
  name: string,
  degradeLabel: string | null,
  p: Promise<T>,
  rows: (v: T) => number,
): Promise<T> {
  const startedAt = Date.now();
  const settled = (ok: boolean, v: T | undefined) => {
    // degrade 표식은 read 가 끝난 **뒤에** 읽어야 한다(degradeAware 가 그때 심는다).
    const degraded = degradeLabel === null ? null : wasDegraded(degradeLabel);
    let n: number | null = null;
    if (ok) {
      try {
        n = rows(v as T);
      } catch {
        n = null; // 형태가 예상과 다르면 숫자를 만들지 않는다 — 절대 값을 찍지 않는다.
      }
    }
    emit(name, Date.now() - startedAt, degraded, n);
  };
  return p.then(
    (v) => {
      settled(true, v);
      return v;
    },
    (e: unknown) => {
      settled(false, undefined);
      throw e;
    },
  );
}

/** 배열/`{ rows }`/`{ brands }` 형태에서 행 수를 뽑는 흔한 셋 — 호출부 중복 제거용. */
export const countOf = {
  array: (v: unknown): number => (Array.isArray(v) ? v.length : 0),
  brands: (v: unknown): number =>
    Array.isArray((v as { brands?: unknown[] } | null)?.brands)
      ? ((v as { brands: unknown[] }).brands.length)
      : 0,
  rows: (v: unknown): number =>
    Array.isArray((v as { rows?: unknown[] } | null)?.rows)
      ? ((v as { rows: unknown[] }).rows.length)
      : 0,
  points: (v: unknown): number =>
    Array.isArray((v as { points?: unknown[] } | null)?.points)
      ? ((v as { points: unknown[] }).points.length)
      : 0,
};
