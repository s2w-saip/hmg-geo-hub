// 비밀번호 시도 제한.
//
// ⚠️ 인스턴스별 in-memory 카운터라 서버리스에서는 **best-effort** 다 — 인스턴스 수만큼
// 배수로 뚫린다. 무차별 대입을 늦출 뿐 막지는 못한다(설계 §3에 명시된 한계).
// 제대로 막으려면 공유 스토어(DB/Redis)가 필요한데, 이 콘솔의 위협 모델에서는
// "비밀번호가 유출되면 끝"이 이미 수용된 리스크라 그 비용을 지불하지 않는다.

const buckets = new Map<string, { count: number; resetAt: number }>();

// 메모리 누수 방지 — 키가 무한히 늘지 않게 만료된 것을 주기적으로 걷어낸다.
const MAX_KEYS = 10_000;

export function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function __resetRateLimit(): void {
  buckets.clear();
}
