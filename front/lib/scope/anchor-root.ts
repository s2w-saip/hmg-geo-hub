/**
 * 앵커 테이블(0077) 표면 판정의 **'standard' 근거** — 해소 정본 한 곳.
 *
 * ── 왜 이 모듈이 있나 (N-4) ─────────────────────────────────────────────────
 * 독립 검증에서 루트 프로젝트 id 해소가 **네 벌**이고 폴백이 서로 달랐다:
 *
 *   | 경로 | 해소 | env 미설정 시 |
 *   | --- | --- | --- |
 *   | 미러 싱크 · swap | `getRootConfig()?.projectId ?? null` | null (게다가 mock 모드면 env 가 있어도 null) |
 *   | `surface-global.ts` | `env ?? "be28fe15-…"` | **하드코딩 uuid** |
 *   | `surface-website.ts` · purge · 백필 | `env ?? null` | null |
 *
 * `surface` 는 upsert 의 변경 감지 술어에 들어 있으므로, 두 writer 가 같은 run 에 서로
 * 다른 표면을 쓰면 **값을 번갈아 뒤집는다**(플래핑). 그래서 해소를 한 곳으로 모은다.
 *
 * ── 정책 ────────────────────────────────────────────────────────────────────
 * `process.env.SCOPE_ROOT_PROJECT_ID` 하나만 읽는다.
 *
 * - **`SCOPE_MODE` 를 보지 않는다.** `getRootConfig()` 는 mock 모드에서 env 가 있어도
 *   null 을 돌려주는데(그쪽은 "scope HTTP 를 부를 수 있는가" 를 묻는 함수다), 앵커
 *   테이블이 보는 것은 **미러에 실제로 들어온 run 의 소속**이라 측정 모드와 무관하다.
 *   mock 모드에서만 표면이 달라지면 개발 환경의 달력이 프로덕션과 다르게 보인다.
 * - **하드코딩 uuid 폴백을 두지 않는다.** env 가 없으면 `null` 이고, 그때 DB 함수는
 *   원장 출력 폴백으로 돌며 `RAISE NOTICE` 로 그 사실을 남긴다(0077 참고). 추측한
 *   uuid 로 표면을 정하는 것보다 "모른다" 가 낫다.
 *
 * ⚠️ `scripts/summary/surface-global.ts::ROOT_PROJECT_ID` 는 이 함수가 아니다 —
 *    그쪽은 생성기가 **scope API·카탈로그**에 쓰는 값이라 의미가 다르다. 앵커 전파
 *    호출에는 반드시 이 함수를 쓴다.
 */
export const ANCHOR_ROOT_ENV = "SCOPE_ROOT_PROJECT_ID";

/** uuid 모양이 아니면 쓰지 않는다 — 잘못된 값으로 표면을 정하지 않는다. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 해소 **결과의 종류**까지 돌려준다 (N-14).
 *
 * "설정 안 함" 과 "설정했는데 형식이 틀림" 은 같은 `null` 이 아니다:
 *
 * | env | 뜻 | 경로별 처리 |
 * | --- | --- | --- |
 * | `ok` | 정상 uuid | 그 값을 쓴다 |
 * | `unset` | 아예 없음 | 종전과 같다 — null 로 두고 DB 함수가 원장 폴백 + NOTICE |
 * | `malformed` | 있는데 uuid 가 아님 | **경로마다 다르게** 처리한다(아래) |
 *
 * `malformed` 를 조용히 `null` 로 떨구면 위험하다. 이 값은 앵커 전파 전용이 아니라
 * 회차 원장의 `surface` 를 정하는 `summary-cycles.ts::surfaceExpr` 에도 들어가므로,
 * null 이 되면 global 팔이 생략되어 **루트 프로젝트의 새 회차가 `surface='project'` 로
 * 기록된다**(그 회차는 `pickGlobalCycle` 에서 빠져 글로벌 대시보드가 폴백한다).
 * 수리 전에는 `'…'::uuid` 바인드가 22P02 로 던져 트랜잭션이 롤백됐고 원장은 무변경이었다 —
 * "아무 일도 안 일어남" 이 "잘못된 값이 기록됨" 으로 바뀌면 안 된다.
 *
 * 그래서 경로별로 나눈다:
 *   · 원장 쓰기(관제·생성기·purge·백필) → `anchorRootProjectIdOrThrow()` 로 **던진다**
 *     (종전과 같은 "쓰지 않음". 관제는 그 예외를 `errors[]` 로 받는다)
 *   · 미러 동기화 → 죽이지 않는다. 앵커 재계산만 건너뛰고 표식을 남긴다
 *     (싱크가 멈추면 미러 전체가 뒤처진다)
 */
export type AnchorRootResolution =
  | { kind: "ok"; projectId: string }
  | { kind: "unset"; projectId: null }
  | { kind: "malformed"; projectId: null; raw: string };

export function resolveAnchorRootProjectId(): AnchorRootResolution {
  const raw = process.env[ANCHOR_ROOT_ENV]?.trim();
  if (!raw) return { kind: "unset", projectId: null };
  if (!UUID_RE.test(raw)) return { kind: "malformed", projectId: null, raw };
  return { kind: "ok", projectId: raw };
}

/**
 * 값만 필요한 읽기·표시 경로용. `malformed` 도 `null` 이 되므로 **원장을 쓰는 경로에서는
 * 쓰지 않는다**(N-14) — 거기서는 아래 `anchorRootProjectIdOrThrow()` 를 쓴다.
 */
export function anchorRootProjectId(): string | null {
  const r = resolveAnchorRootProjectId();
  if (r.kind === "malformed") {
    console.warn(
      `[anchor-root] ${ANCHOR_ROOT_ENV} 가 uuid 모양이 아니다 — 표면 standard 판정을 원장 폴백으로 돌린다.`,
    );
  }
  return r.projectId;
}

/** 형식 오류를 감추지 않는 판. env 미설정(`unset`)은 종전대로 `null` 이다. */
export function anchorRootProjectIdOrThrow(): string | null {
  const r = resolveAnchorRootProjectId();
  if (r.kind === "malformed") {
    throw new Error(
      `${ANCHOR_ROOT_ENV} 가 uuid 형식이 아니다(길이 ${r.raw.length}) — ` +
        "원장 surface 가 잘못 기록되지 않게 이 경로를 중단한다. env 를 고칠 것.",
    );
  }
  return r.projectId;
}
