// 회차 지문 **소비자**(메모·실패·키 조각)의 계약 (2026-09-27, 검증 C3·C4 반영).
//
//   ① 메모: **다음 벽시계 5분 경계**까지 다시 안 읽는다(인스턴스 간 정렬). 동시 호출은 1회.
//   ② 상한: 벽시계 4초 — 커넥션 획득 대기까지 자른다.
//   ③ 실패: throw 하지 않는다. 직전 칸 이후의 성공 지문이 있으면 이번 칸 끝까지 재사용,
//      없으면 `null`(5분 버킷 조각). 무기한 재사용은 없다. 실패는 5초만 기억한다.
//   ④ 요청 단위: 한 요청의 셀들은 같은 판정(두 모드 포함)을 쓴다(React `cache`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

type Fps = { gate: string; ledger: string };
const readCycleFingerprints = vi.fn<() => Promise<Fps>>();
vi.mock("@/lib/db/repositories/cycle-fingerprint", async (importOriginal) => ({
  // 오류 코드 판독은 **실제 함수**를 쓴다(재검증 K4 — 감싼 오류의 cause.code).
  ...(await importOriginal<Record<string, unknown>>()),
  readCycleFingerprints: () => readCycleFingerprints(),
  resetCycleFingerprintCapsForTests: () => {},
}));

const { withRequestScope } = await import("@/test/request-scope");
const {
  resolveCycleFingerprints,
  cycleCacheSlotFor,
  ensureCycleCacheSlot,
  resetCycleFingerprintForTests,
  CYCLE_BUCKET_MS,
  CYCLE_FINGERPRINT_DEADLINE_MS,
} = await import("./cycle-fingerprint");

const A: Fps = { gate: "0123456789abcdef0123456789abcdef", ledger: "11111111111111112222222222222222" };
const B: Fps = { gate: "fedcba9876543210fedcba9876543210", ledger: "33333333333333334444444444444444" };
/** 5분 칸 시작 + 1분. */
const B0 = Date.UTC(2026, 8, 27, 4, 0, 0);
const T0 = B0 + 60_000;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetCycleFingerprintForTests();
  readCycleFingerprints.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.useRealTimers();
});

describe("① 메모 — 벽시계 5분 경계 정렬", () => {
  it("다음 5분 경계 전에는 다시 읽지 않고, 경계를 넘으면 다시 읽는다", async () => {
    readCycleFingerprints.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    expect(await resolveCycleFingerprints()).toEqual(A);
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS - 1); // 같은 칸의 마지막 ms
    expect(await resolveCycleFingerprints()).toEqual(A);
    expect(readCycleFingerprints).toHaveBeenCalledTimes(1);
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS); // 경계
    expect(await resolveCycleFingerprints()).toEqual(B);
    expect(readCycleFingerprints).toHaveBeenCalledTimes(2);
  });

  it("만료는 읽은 시각 + 고정 폭이 아니라 **경계**다 — 칸 끝 직전에 읽어도 경계에서 만료", async () => {
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS - 1_000);
    readCycleFingerprints.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    await resolveCycleFingerprints();
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 1);
    expect(await resolveCycleFingerprints()).toEqual(B);
  });

  // 재검증 V3 — 경계 직전에 **시작**해 직후 **끝난** 판정이 다음 칸 전체를 옛 지문으로
  // 채우면 안 된다. 만료는 판정 시작 시각의 다음 경계다.
  it("[V3] 경계를 걸친 판정은 그 경계에서 만료된다(다음 칸에서 다시 읽는다)", async () => {
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS - 500);
    let release!: (v: Fps) => void;
    readCycleFingerprints
      .mockReturnValueOnce(new Promise<Fps>((r) => (release = r)))
      .mockResolvedValueOnce(B);
    const p = resolveCycleFingerprints();
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 500); // 판정이 경계를 넘겨 끝난다
    release(A);
    expect(await p).toEqual(A);
    expect(await resolveCycleFingerprints()).toEqual(B);
    expect(readCycleFingerprints).toHaveBeenCalledTimes(2);
  });

  // 재검증 v3 공백 V3b — 재사용 나이도 **판정 시작 시각** 기준이다. 경계 직전에 시작해 직후
  // 끝난 판정을 끝난 시각으로 기록하면, 그 다음 칸의 실패에서 한 칸 더 오래 재사용된다.
  it("[V3b] 경계를 걸친 판정의 지문은 시작 칸 기준으로 나이를 센다(두 칸 뒤 실패에서는 버린다)", async () => {
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS - 500); // 칸 k 끝 직전에 시작
    let release!: (v: Fps) => void;
    readCycleFingerprints
      .mockReturnValueOnce(new Promise<Fps>((r) => (release = r)))
      .mockRejectedValue(new Error("down"));
    const p = resolveCycleFingerprints();
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 500); // 칸 k+1 에서 끝난다
    release(A);
    expect(await p).toEqual(A);
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS * 2 + 10_000); // 칸 k+2 에서 실패
    // 시작 칸(k)은 직전 칸(k+1)보다 오래됐다 → 재사용하지 않는다.
    expect(await resolveCycleFingerprints()).toBeNull();
  });

  it("동시 호출은 한 번만 읽는다", async () => {
    let release!: (v: Fps) => void;
    readCycleFingerprints.mockReturnValueOnce(new Promise<Fps>((r) => (release = r)));
    const all = Promise.all([resolveCycleFingerprints(), resolveCycleFingerprints()]);
    release(A);
    expect(await all).toEqual([A, A]);
    expect(readCycleFingerprints).toHaveBeenCalledTimes(1);
  });
});

describe("② 벽시계 상한", () => {
  it("응답이 4초를 넘으면 실패로 본다(커넥션 대기 포함)", async () => {
    readCycleFingerprints.mockReturnValueOnce(new Promise<Fps>(() => {})); // 영원히 대기
    const p = resolveCycleFingerprints();
    await vi.advanceTimersByTimeAsync(CYCLE_FINGERPRINT_DEADLINE_MS + 1);
    await expect(p).resolves.toBeNull();
    expect(String(errSpy.mock.calls[0][0])).toContain("code=deadline");
  });
});

describe("③ 실패", () => {
  it("성공 이력이 없으면 null(throw 하지 않음), 경고는 연속 실패당 1회", async () => {
    readCycleFingerprints.mockRejectedValue(Object.assign(new Error("boom"), { code: "57014" }));
    await expect(resolveCycleFingerprints()).resolves.toBeNull();
    vi.setSystemTime(T0 + 6_000);
    await expect(resolveCycleFingerprints()).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("code=57014");
  });

  it("[K4] drizzle 이 감싼 오류는 원인의 SQLSTATE(cause.code)를 로그에 남긴다", async () => {
    readCycleFingerprints.mockRejectedValue(
      Object.assign(new Error("Failed query: SELECT …"), { cause: { code: "42P01" } }),
    );
    await resolveCycleFingerprints();
    expect(String(errSpy.mock.calls[0][0])).toContain("code=42P01");
  });

  it("직전 칸에서 읽은 성공 지문은 이번 칸 끝까지 재사용하고, 그 다음 칸에서는 버린다", async () => {
    readCycleFingerprints.mockResolvedValueOnce(A).mockRejectedValue(new Error("down"));
    await resolveCycleFingerprints(); // 칸 0 에서 성공
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 10_000); // 칸 1: 실패 → 재사용
    expect(await resolveCycleFingerprints()).toEqual(A);
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS * 2 - 1_000); // 칸 1 끝 직전: 여전히 재사용
    expect(await resolveCycleFingerprints()).toEqual(A);
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS * 2 + 10_000); // 칸 2: 오래된 지문 → 버린다
    expect(await resolveCycleFingerprints()).toBeNull();
  });

  it("실패는 5초만 기억한다 — 복구되면 곧바로 새 지문으로 돌아간다", async () => {
    readCycleFingerprints.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(A);
    expect(await resolveCycleFingerprints()).toBeNull();
    vi.setSystemTime(T0 + 4_000);
    expect(await resolveCycleFingerprints()).toBeNull();
    expect(readCycleFingerprints).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 5_001);
    expect(await resolveCycleFingerprints()).toEqual(A);
  });

  it("복구 뒤 다시 실패하면 다시 경고한다", async () => {
    readCycleFingerprints
      .mockRejectedValueOnce(new Error("a"))
      .mockResolvedValueOnce(A)
      .mockRejectedValueOnce(new Error("b"));
    await resolveCycleFingerprints();
    vi.setSystemTime(T0 + 6_000);
    await resolveCycleFingerprints();
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 1);
    await resolveCycleFingerprints();
    expect(errSpy).toHaveBeenCalledTimes(2);
  });
});

describe("cycleCacheSlotFor — 키 조각", () => {
  it("gate 는 `cycle:` + gate 앞 16자, ledger 는 `cycle-l:` + ledger 앞 16자", () => {
    expect(cycleCacheSlotFor(A, "gate", T0)).toBe("cycle:0123456789abcdef");
    expect(cycleCacheSlotFor(A, "ledger", T0)).toBe("cycle-l:1111111111111111");
  });

  it("지문이 다르면 조각이 다르다", () => {
    expect(cycleCacheSlotFor(A, "gate", T0)).not.toBe(cycleCacheSlotFor(B, "gate", T0));
    expect(cycleCacheSlotFor(A, "ledger", T0)).not.toBe(cycleCacheSlotFor(B, "ledger", T0));
  });

  it("실패 조각은 고정 문자열이 아니라 5분 버킷이다 — 버킷이 넘어가면 새 키", () => {
    const a = cycleCacheSlotFor(null, "gate", T0);
    expect(a).toBe(`cycle-unknown:${Math.floor(T0 / CYCLE_BUCKET_MS)}`);
    expect(cycleCacheSlotFor(null, "ledger", T0)).toBe(a);
    expect(cycleCacheSlotFor(null, "gate", B0 + CYCLE_BUCKET_MS)).not.toBe(a);
    expect(a.startsWith("cycle:")).toBe(false);
  });

  it("조각은 문자열이다 — 캐시 직렬화(JSON 라운드트립)에 그대로 살아남는다", () => {
    const s = cycleCacheSlotFor(A, "gate", T0);
    expect(JSON.parse(JSON.stringify(s))).toBe(s);
  });
});

describe("④ ensureCycleCacheSlot — 요청 단위", () => {
  it("한 요청 안에서는 메모가 만료돼도 같은 조각이고, 두 모드가 같은 판정에서 나온다", async () => {
    readCycleFingerprints.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    const out = await withRequestScope(async () => {
      const g1 = await ensureCycleCacheSlot("gate");
      vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 1);
      const g2 = await ensureCycleCacheSlot("gate");
      const l = await ensureCycleCacheSlot("ledger");
      return [g1, g2, l];
    });
    expect(out).toEqual(["cycle:0123456789abcdef", "cycle:0123456789abcdef", "cycle-l:1111111111111111"]);
    expect(readCycleFingerprints).toHaveBeenCalledTimes(1);
  });

  it("다음 요청은 경계 뒤 새 지문을 본다", async () => {
    readCycleFingerprints.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    const a = await withRequestScope(() => ensureCycleCacheSlot());
    vi.setSystemTime(B0 + CYCLE_BUCKET_MS + 1);
    const b = await withRequestScope(() => ensureCycleCacheSlot());
    expect(a).toBe("cycle:0123456789abcdef");
    expect(b).toBe("cycle:fedcba9876543210");
  });

  it("판정 실패(성공 이력 없음)면 5분 버킷 조각이다", async () => {
    readCycleFingerprints.mockRejectedValue(new Error("down"));
    const s = await withRequestScope(() => ensureCycleCacheSlot());
    expect(s).toBe(`cycle-unknown:${Math.floor(T0 / CYCLE_BUCKET_MS)}`);
  });
});
