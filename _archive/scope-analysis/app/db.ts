// DB 어댑터 — **드라이버를 큐 로직에서 떼어낸다.**
//
// 이유: 큐·리스·리퍼 SQL 이 이 lane 의 정확성 핵심인데, 그것을 검증하려면 진짜 Postgres 가
// 필요하다. postgres.js 는 소켓을 쓰고 pglite 는 WASM in-process 다. 둘을 같은 `Queryable`
// 인터페이스 뒤에 두면 **같은 SQL 을 테스트가 pglite 로 실제 실행**할 수 있다
// (`tests/queue-lease.test.ts`) — Docker·colima 기동 없이.
//
// ⚠️ 어댑터가 SQL 을 고쳐 쓰지 않는다. 두 드라이버에 같은 문자열·같은 $n 바인드가 간다.
//    어댑터가 방언을 번역하기 시작하면 "테스트가 통과한 SQL" 과 "라이브가 도는 SQL" 이 갈린다.
//
// ── jsonb 바인딩 규약: **객체를 그대로 넘긴다. `JSON.stringify` 하지 않는다.** (2026-09-13)
//
//   초판 규약은 반대였다("jsonb 는 JSON 문자열 + `::jsonb` 캐스트"). 그 규약이 **라이브를
//   전량 죽였다** — pglite 는 통과하고 postgres.js 만 깨지는, 테스트가 구조적으로 못 보는 결함:
//
//     postgres.js(3.4.9)는 파라미터가 있으면 `prepare:false` 라도 **먼저 Describe 한다**
//     (`src/connection.js:238` `describeFirst = parameters.length && !q.prepared`). 서버가
//     `$n::jsonb` 로 해소한 OID(3802)를 `ParameterDescription` 으로 돌려주고, Bind 는 그 OID 의
//     직렬화기를 탄다(`src/connection.js:959` → `types.json.serialize` = `JSON.stringify`,
//     `src/types.js:16-21` 의 `from:[114,3802]`). 즉 **이미 JSON 문자열인 값을 한 번 더**
//     직렬화한다 → 컬럼에는 jsonb 객체가 아니라 **문자열 스칼라**가 들어간다.
//
//     실측(실 PG + postgres.js 3.4.9): `select jsonb_typeof($1::jsonb)`
//       · 문자열 파라미터 → `string`   ← 이중 인코딩
//       · 객체   파라미터 → `object`
//     실측(PGlite 0.2.17, 같은 SQL): 문자열·객체 **둘 다** `object` — 그래서 테스트가 통과했다.
//
//   객체를 넘기면 두 드라이버가 같은 결과를 낸다(postgres.js 는 Bind 에서 1회 직렬화, PGlite 는
//   자체 직렬화). 그래서 어댑터가 드라이버별 분기를 둘 필요가 없다 — 위 "SQL 을 고쳐 쓰지
//   않는다" 원칙을 그대로 지킨다. 캐스트(`::jsonb`)는 유지한다(컬럼 추론에 기대지 않는다).
//
//   읽기는 `fromJsonb()` 를 쓴다 — 라이브에 이미 이중 인코딩으로 저장된 행이 있기 때문이다.

export type Row = Record<string, unknown>;

/**
 * jsonb 컬럼 **읽기** 정규화 — 이중 인코딩으로 저장된 과거 행을 객체로 되돌린다.
 *
 * 정상 행이면 드라이버가 이미 객체를 준다(무동작). 결함 기간에 저장된 행은 jsonb **문자열
 * 스칼라**라 드라이버가 string 을 주고, 그대로 쓰면 `AnalysisTicketRequestSchema.parse` 가
 * `expected object, received string` 으로 죽는다(라이브 워커 전량 실패의 그 지점).
 *
 * ⚠️ `JSON.parse` 가 실패하면 **원값을 그대로 돌려준다**. 진짜 JSON 문자열 스칼라였다는 뜻이고,
 *    그 판정은 이 헬퍼가 아니라 하류의 zod 가 해야 한다 — 여기서 던지면 읽기 경로 전체가
 *    깨져 "무엇이 잘못됐는지" 가 오히려 안 보인다.
 */
export function fromJsonb<T = unknown>(v: unknown): T {
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return v as T;
  }
}

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** 한 트랜잭션. 콜백이 throw 하면 롤백한다. */
  begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPostgresDb(dsn: string, opts: { max?: number } = {}): Db {
  // 동적 import 로 미룬다 — pglite 로만 도는 테스트가 postgres.js 를 적재하지 않게.
  type PgSql = {
    unsafe: (text: string, params?: readonly unknown[]) => Promise<unknown> & { values?: unknown };
    begin: <T>(fn: (sql: PgSql) => Promise<T>) => Promise<T>;
    end: (o?: { timeout?: number }) => Promise<void>;
  };
  let sqlPromise: Promise<PgSql> | null = null;

  async function sql(): Promise<PgSql> {
    if (!sqlPromise) {
      sqlPromise = import("postgres").then((m) => {
        const factory = (m.default ?? m) as unknown as (dsn: string, o: Record<string, unknown>) => PgSql;
        return factory(dsn, {
          max: opts.max ?? 10,
          // ⚠️ `prepare: false` — RDS Proxy·pgbouncer 뒤에서 prepared statement 가 세션에 묶이면
          //    커넥션 재사용이 조용히 깨진다. lane 은 자체 RDS 지만 Proxy 를 앞에 둘 수 있으므로
          //    처음부터 끈다(측정 lane 이 advisory lock 피닝으로 같은 종류의 값을 치렀다).
          prepare: false,
          onnotice: () => {},
          transform: { undefined: null },
        });
      });
    }
    return sqlPromise;
  }

  const wrap = (s: PgSql): Queryable => ({
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = (await s.unsafe(text, params)) as unknown as T[];
      return Array.from(rows ?? []);
    },
  });

  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return wrap(await sql()).query<T>(text, params);
    },
    async begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const s = await sql();
      return s.begin(async (tx) => fn(wrap(tx)));
    },
    async ping(): Promise<boolean> {
      try {
        const rows = await this.query<{ ok: number }>("SELECT 1 AS ok");
        return rows.length === 1;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      if (sqlPromise) {
        const s = await sqlPromise;
        await s.end({ timeout: 5 });
        sqlPromise = null;
      }
    },
  };
}

/**
 * 상태 없는 헬퍼 — 한 행만 기대하는 곳에서 `rows[0]` 의 `undefined` 를 매번 다루지 않게.
 * 0행이면 null 을 준다(측정 `fetchone()` 관례).
 */
export function one<T extends Row>(rows: T[]): T | null {
  return rows.length > 0 ? (rows[0] as T) : null;
}
