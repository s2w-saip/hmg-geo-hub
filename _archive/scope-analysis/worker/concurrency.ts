// 전역 LLM 콜 상한 — **세는 단위는 in-flight LLM 콜**이다(스펙 §8.2).
//
// 턴도 query_run 유닛도 아니다: 유닛으로 세면 턴 내 병렬(P3-A)이나 턴 간 병렬(D1)을 켤 때마다
// 상한을 재보정해야 한다. 콜/유닛 비가 1 을 넘는 순간 유닛 환산이 깨지기 때문이다.
//
// 산술의 기준은 **Little 의 법칙 하나**다(D6 — 초판·2차가 두 산식을 섞어 "360 → 206/분" 같은
// 내부 모순을 남겼다):
//
//     필요 in-flight = 목표 처리율(턴/s) × 턴당 체류시간(s)
//
//   실측 체류 = 430 ÷ (210/60) ≈ 123s (CPU 81% 포화, 2026-09-09 02:45 KST 단일 관측)
//   목표 300턴/분 = 5턴/s  →  필요 615  →  운용 상한 640 (= 16 task × 40 콜/task)
//
// 데드락은 구조적으로 불가하다 — 세마포어는 콜 1개당 슬롯 1개만 잡고, 슬롯을 쥔 채 다른 슬롯을
// 기다리지 않는다(hold-and-wait 없음).

/** 슬롯 대기가 상한을 넘었을 때의 typed 실패. 무한 대기가 아니다(스펙 §8.2 불변식 ③). */
export class CapacityTimeoutError extends Error {
  readonly failureClass = "capacity" as const;
  constructor(waitedMs: number) {
    super(`llm slot acquire timed out after ${waitedMs}ms`);
    this.name = "CapacityTimeoutError";
  }
}

export interface SemaphoreStats {
  limit: number;
  inflight: number;
  waiting: number;
}

/** 공정(FIFO) 카운팅 세마포어. 대기열이 늦게 온 요청에 추월당하지 않게 한다. */
export class Semaphore {
  #limit: number;
  #inflight = 0;
  #waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    this.#limit = limit;
  }

  get stats(): SemaphoreStats {
    return { limit: this.#limit, inflight: this.#inflight, waiting: this.#waiters.length };
  }

  /**
   * 상한을 **런타임에 바꾼다**. 램프(300 → 430 → 525 → 640)를 재배포 없이 밟기 위한 손잡이다.
   * 내리는 쪽은 in-flight 를 강제로 끊지 않는다 — 자연 반납으로 수렴한다.
   */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    this.#limit = limit;
    this.#drain();
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.#inflight < this.#limit) {
      this.#inflight += 1;
      return this.#release();
    }
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null } = {
        resolve,
        reject,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        const i = this.#waiters.indexOf(entry);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new CapacityTimeoutError(Date.now() - startedAt));
      }, timeoutMs);
      // ⚠️ **이 타이머를 `unref()` 하지 않는다.** 슬롯을 기다리는 동안 다른 할 일이 없으면
      //    이벤트 루프가 비어 타이머가 아예 안 돌고, 그러면 **대기가 영원히 끝나지 않는다** —
      //    "건너뛸 수 있는 타임아웃"은 타임아웃이 아니다. 2026-09-12 CI 가 잡았다(node 20:
      //    `Promise resolution is still pending but the event loop has already resolved`;
      //    node 26 로컬에서는 드러나지 않았다). 타이머는 획득·거절 양쪽에서 반드시 clear 되므로
      //    대기보다 오래 살지 않는다.
      this.#waiters.push(entry);
    });
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return; // 이중 반납 방지 — 하나가 두 번 반납하면 상한이 조용히 커진다
      released = true;
      this.#inflight -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#inflight < this.#limit && this.#waiters.length > 0) {
      const w = this.#waiters.shift();
      if (!w) break;
      if (w.timer) clearTimeout(w.timer);
      this.#inflight += 1;
      w.resolve();
    }
  }
}

/**
 * 이 프로세스가 쓸 콜 슬롯 = `floor(가용분 ÷ 현재 워커 수)`.
 *
 * ⚠️ **`ceil` 이 아니다.** 나눗셈이 안 떨어질 때 올림하면 태스크 수를 곱한 합이 전역 상한을
 *    **넘는다**: 예) 가용 100 · 워커 3 → ceil 34 × 3 = 102 > 100. 상한을 세우는 함수가 상한을
 *    깨는 방향으로 반올림하면 그건 상한이 아니다. 잔여(100 − 33×3 = 1)는 버린다 — 전역 상한은
 *    "절대 넘지 않는 선" 이고 그 대가는 슬롯 몇 개의 유휴다(A11 과 같은 방향).
 *
 * ⚠️ **워커 수 조회 실패 시에는 max 워커 수로 나눈다** — 보수적으로 *작은* 슬롯이다.
 * 조회가 죽었을 때 상한이 **커지는 방향**이면 사고다(2026-07-29 Browserless 세마포어 사고와
 * 같은 구조). 판정 A11.
 *
 * `hostingInflight` 는 코어 Hosting 인라인 2경로의 고정 몫이다(스펙 §7.2) — lane 예산에서 뺀다.
 * Hosting 동시 인스턴스 수는 **미확인**(§14-4)이라 확정 전까지 보수적 가정치로 깎는다.
 */
export function computeWorkerCallSlots(args: {
  total: number;
  hostingInflight: number;
  workerCount: number | null;
  maxWorkerCount: number;
}): number {
  const available = Math.max(1, args.total - Math.max(0, args.hostingInflight));
  const divisor =
    args.workerCount !== null && Number.isInteger(args.workerCount) && args.workerCount > 0
      ? args.workerCount
      : Math.max(1, args.maxWorkerCount);
  return Math.max(1, Math.floor(available / divisor));
}
