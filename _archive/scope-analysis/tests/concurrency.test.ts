import assert from "node:assert/strict";
import { test } from "node:test";

import { CapacityTimeoutError, Semaphore, computeWorkerCallSlots } from "../worker/concurrency.ts";

test("semaphore enforces the ceiling and is FIFO", async () => {
  const s = new Semaphore(2);
  const r1 = await s.acquire(1000);
  const r2 = await s.acquire(1000);
  assert.equal(s.stats.inflight, 2);

  const order: number[] = [];
  const p3 = s.acquire(1000).then((r) => {
    order.push(3);
    return r;
  });
  const p4 = s.acquire(1000).then((r) => {
    order.push(4);
    return r;
  });
  assert.equal(s.stats.waiting, 2);

  r1();
  (await p3)();
  r2();
  (await p4)();
  assert.deepEqual(order, [3, 4], "late arrivals must not overtake earlier waiters");
  assert.equal(s.stats.inflight, 0);
});

test("slot acquire times out as a typed capacity failure, not an unbounded wait", async () => {
  const s = new Semaphore(1);
  const release = await s.acquire(1000);
  await assert.rejects(() => s.acquire(20), (e) => e instanceof CapacityTimeoutError);
  release();
});

test("double release does not silently raise the ceiling", async () => {
  const s = new Semaphore(1);
  const release = await s.acquire(100);
  release();
  release();
  assert.equal(s.stats.inflight, 0);
  const r2 = await s.acquire(100);
  assert.equal(s.stats.inflight, 1);
  r2();
});

test("setLimit ramps without redeploy and admits waiters immediately", async () => {
  const s = new Semaphore(1);
  const r1 = await s.acquire(1000);
  const p = s.acquire(1000);
  assert.equal(s.stats.waiting, 1);
  s.setLimit(2); // 램프 300 → 430 → 525 → 640 의 손잡이
  (await p)();
  r1();
});

test("worker slot split subtracts the Hosting fixed share (spec 7.2)", () => {
  assert.equal(computeWorkerCallSlots({ total: 640, hostingInflight: 32, workerCount: 16, maxWorkerCount: 16 }), 38);
  assert.equal(computeWorkerCallSlots({ total: 300, hostingInflight: 32, workerCount: 2, maxWorkerCount: 16 }), 134);
});

test("A11: an unknown worker count must shrink the slot, never grow it", () => {
  const known = computeWorkerCallSlots({ total: 640, hostingInflight: 32, workerCount: 2, maxWorkerCount: 16 });
  const unknown = computeWorkerCallSlots({ total: 640, hostingInflight: 32, workerCount: null, maxWorkerCount: 16 });
  assert.ok(unknown < known, "failed worker-count lookup must divide by MAX workers (conservative)");
  assert.equal(unknown, 38);
  // 0·음수·NaN 도 같은 방향으로 닫힌다 — 조회가 죽었을 때 상한이 커지면 그것이 사고다.
  assert.equal(computeWorkerCallSlots({ total: 640, hostingInflight: 32, workerCount: 0, maxWorkerCount: 16 }), 38);
  assert.equal(computeWorkerCallSlots({ total: 640, hostingInflight: 32, workerCount: -3, maxWorkerCount: 16 }), 38);
});

test("slots never drop below 1 even if the Hosting share swallows the budget", () => {
  assert.equal(computeWorkerCallSlots({ total: 10, hostingInflight: 999, workerCount: 4, maxWorkerCount: 16 }), 1);
});

test("the split ROUNDS DOWN — fleet × per-task must never exceed the global ceiling (F11)", () => {
  // ⚠️ 초판은 `ceil` 이었다. 나눗셈이 안 떨어지면 **상한을 세우는 함수가 상한을 깨는 방향**으로
  //    반올림한다: 가용 100 · 워커 3 → ceil 34 × 3 = 102 > 100. 상한 640 은 Little 의 법칙으로
  //    잡은 값이고(D6), 그것을 넘는 것은 곧 공급자 429 와 초과 실비다.
  const cases: Array<[number, number, number]> = [
    // [total, workerCount, expected per-task]  (hostingInflight 0 으로 산술만 본다)
    [100, 3, 33],
    [640, 7, 91], // 640/7 = 91.43 → ceil 92 × 7 = 644 > 640
    [300, 16, 18], // 300/16 = 18.75 → ceil 19 × 16 = 304 > 300
  ];
  for (const [total, workerCount, expected] of cases) {
    const slots = computeWorkerCallSlots({ total, hostingInflight: 0, workerCount, maxWorkerCount: 16 });
    assert.equal(slots, expected, `total=${total} workers=${workerCount}`);
    assert.ok(slots * workerCount <= total, `fleet ceiling breached: ${slots} × ${workerCount} > ${total}`);
  }
});
