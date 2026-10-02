import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { qaAnswerLocks } from "@/lib/db/schema";
import { acquireLock, heartbeatLock, releaseLock, listLocks } from "./qa-review";

// DB 통합 테스트 — DATABASE_URL 없으면 통째로 건너뛴다(CI 기본).
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("qa 락", () => {
  const job = randomUUID();
  const a = randomUUID();
  const b = randomUUID();

  beforeEach(async () => {
    await getDb().delete(qaAnswerLocks).where(eq(qaAnswerLocks.jobId, job));
  });

  // TTL 을 넘긴 상태를 만든다 — 실제로 3분을 기다릴 수는 없다.
  const expire = () =>
    getDb()
      .update(qaAnswerLocks)
      .set({ heartbeatAt: sql`now() - interval '4 minutes'` })
      .where(eq(qaAnswerLocks.jobId, job));

  it("빈 상태에서 획득한다", async () => {
    const r = await acquireLock(job, a, "검수자A");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.sessionId).toBe(a);
  });

  it("같은 세션은 재획득한다 (새로고침)", async () => {
    await acquireLock(job, a, "검수자A");
    expect((await acquireLock(job, a, "검수자A")).ok).toBe(true);
  });

  it("다른 세션은 거부하고 점유자를 알려준다", async () => {
    await acquireLock(job, a, "검수자A");
    const r = await acquireLock(job, b, "검수자B");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.heldBy.reviewerName).toBe("검수자A");
  });

  it("heartbeat 이 TTL 을 넘기면 다른 세션이 가져간다", async () => {
    await acquireLock(job, a, "검수자A");
    await expire();
    const r = await acquireLock(job, b, "검수자B");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.sessionId).toBe(b);
  });

  it("동시 획득 시도에서 정확히 하나만 성공한다", async () => {
    const results = await Promise.all([
      acquireLock(job, a, "검수자A"),
      acquireLock(job, b, "검수자B"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("heartbeat 은 소유자만 갱신한다", async () => {
    await acquireLock(job, a, "검수자A");
    expect(await heartbeatLock(job, a)).toBe(true);
    expect(await heartbeatLock(job, b)).toBe(false);
  });

  it("해제는 소유자만 가능하다", async () => {
    await acquireLock(job, a, "검수자A");
    await releaseLock(job, b);
    expect(await listLocks([job])).toHaveLength(1);
    await releaseLock(job, a);
    expect(await listLocks([job])).toHaveLength(0);
  });

  it("listLocks 는 만료된 락을 빼고 돌려준다", async () => {
    await acquireLock(job, a, "검수자A");
    expect(await listLocks([job])).toHaveLength(1);
    await expire();
    expect(await listLocks([job])).toHaveLength(0);
  });

  it("빈 jobIds 는 쿼리 없이 빈 배열", async () => {
    expect(await listLocks([])).toEqual([]);
  });
});
