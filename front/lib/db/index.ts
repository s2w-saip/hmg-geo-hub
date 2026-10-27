import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { localReadOnly } from "@/lib/local-readonly";

// Server-only Postgres connection for Drizzle. Uses the standard connection
// string (DATABASE_URL) — NOT supabase-js / PostgREST. The browser never reaches
// this; all DB access flows through the repository layer (data-access-security).
//
// Lazy: the client is created on first use (not at import) so the module can be
// bundled at build time without DATABASE_URL present. prepare:false is required
// for Supabase's transaction-mode (pooled) connection.
let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

// ── 커넥션 풀 옵션 (2026-09-03) ─────────────────────────────────────────────
// 배경: 섹션 스트리밍(PR #109) 배포 직후부터 프로덕션에 두 지문이 함께 나타났다 —
// 풀러(Supavisor `…pooler.supabase.com:6543`) `CONNECT_TIMEOUT` 다발과
// `TypeError: Cannot read properties of null (reading 'write')`(postgres 3.4.9
// `src/connection.js` — `write()`가 `setImmediate(nextWrite)`로 미룬 쓰기가,
// 그 사이 `closed()`가 `socket = null`로 만든 소켓을 만나는 드라이버 레이스.
// 업스트림 미수정: 3.4.9가 최신이고 가드 PR(#1168·#1209)은 미머지).
// 검토 정본: internal-kb/hmg-geo-streaming-sections-review-2026-09-03.md §2 F1.
//
// 우리가 만질 수 있는 트리거는 "연결이 닫히는 빈도"뿐이므로, 아래 값은 전부
// **풀러 서버 커넥션을 덜·짧게 점유하는 것**만 목표로 한다.
const POOL_OPTIONS = {
  // 인스턴스당 커넥션 상한. 대시보드 콜드 로드 1회가 섹션별 `withAnswerSet`
  // 트랜잭션으로 ≈9~10개를 동시에 점유하므로(각 트랜잭션은 TEMP 테이블 생성~
  // 커밋까지 커넥션을 붙잡는다) 이보다 낮추면 섹션 스트리밍이 직렬화되어
  // `maxDuration`(대시보드 120s) 안에 못 끝날 위험이 커진다. 그래서 한 렌더분인
  // 10을 천장으로 못박는다(= postgres-js 기본값과 동일 — 동시성은 그대로 두고
  // 아래 idle_timeout 으로만 점유를 줄이는 것이 이 변경의 취지다).
  // ⚠️ 더 낮추려면 Supavisor `default_pool_size`(SQL 조회 불가·대시보드 설정)를
  // 먼저 확인해야 한다. Supabase XL(=이 프로젝트, `max_connections` 240)의
  // 풀러 client 상한은 1,000이라 클라이언트 수가 아니라 pool_size 가 병목이다.
  // 로컬 배치 러너(미러 강제 재싱크 등)는 렌더 경로와 달리 워커 수만큼 커넥션이
  // 필요하다. 기본값 10 은 그대로 두고 `DB_POOL_MAX` 로만 올린다(프로덕션 무변경).
  max: Number(process.env.DB_POOL_MAX ?? 10),
  // 서버리스에서 가장 큰 레버. 기본값이 null(무제한)이라 한번 열린 커넥션은
  // max_lifetime 까지 **유휴 상태로도** 풀러 서버 커넥션을 계속 쥔다. Fluid
  // 인스턴스가 여러 개 warm 하게 떠 있으면 이 유휴 점유가 누적돼 신규 연결이
  // CONNECT_TIMEOUT 으로 죽는다. 30초는 한 페이지뷰 안의 연속 조회는 커넥션을
  // 재사용하되, 렌더가 끝나면 곧 반납하는 지점. 트랜잭션 진행 중인 커넥션은
  // 유휴가 아니므로(풀이 `open` 큐 밖으로 옮기며 타이머를 취소한다 —
  // postgres/src/index.js:308-315) 이 값에 영향받지 않는다.
  idle_timeout: 30,
  // 기본값(30s)을 그대로 명시만 한다. **낮추지 않는 것이 의도다** — 풀 포화 시
  // Supavisor 는 클라이언트를 큐에 세우므로(transaction 모드는 분 단위 대기 허용)
  // 상한을 내리면 성공했을 연결까지 CONNECT_TIMEOUT 으로 만들어, 이 변경의
  // 판정 기준(CONNECT_TIMEOUT 감소) 자체를 역행한다.
  connect_timeout: 30,
  // max_lifetime 은 기본값(30~60분 jitter, postgres/src/index.js:515)을 유지한다.
  // 짧게 잡으면 트래픽이 있는(=hot) 커넥션을 굳이 재활용하게 되는데, 쓰기가 오가는
  // 커넥션을 닫는 것이 위 null-socket 레이스가 발생하는 바로 그 상황이다.
  prepare: false, // Supabase transaction-mode pooler 필수
} as const;

export function getDb() {
  if (localReadOnly()) throw new Error("Legacy database access is disabled; read the Gold API");
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (server-only Postgres connection).");
  }
  const client = postgres(url, POOL_OPTIONS);
  cached = drizzle(client, { schema });
  return cached;
}
