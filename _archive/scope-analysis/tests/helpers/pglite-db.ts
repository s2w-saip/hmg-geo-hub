// 테스트용 Db 어댑터 — PGlite(진짜 Postgres 를 WASM 으로 컴파일한 것).
//
// ⚠️ **어댑터가 SQL 을 고쳐 쓰지 않는다.** 라이브(postgres.js)와 **같은 문자열·같은 $n 바인드**가
//    간다. 그래야 "테스트가 통과한 SQL" 과 "라이브가 도는 SQL" 이 같은 것이다(`app/db.ts` 상단).
//    `FOR UPDATE SKIP LOCKED`·부분 인덱스·`make_interval`·advisory lock 전부 실제로 실행된다.
//
// ⚠️ 한계를 정직하게 적는다: PGlite 는 **단일 커넥션**이라 두 워커가 같은 행을 동시에 집으려는
//    진짜 경합은 재현되지 않는다. 여기서 검증되는 것은 **SQL 의 정확성과 상태 전이**이고,
//    동시성 자체는 스테이징 실측(스펙 §9 단계 4~)이 판정한다.
import { PGlite } from "@electric-sql/pglite";

import type { Db, Queryable, Row } from "../../app/db.ts";

export interface TestDb extends Db {
  raw: PGlite;
}

interface PgliteLike {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (text: string) => Promise<Array<{ rows: unknown[] }>>;
}

/**
 * ⚠️ **파라미터가 없으면 simple protocol(`exec`)로 보낸다.**
 * 확장 프로토콜(prepared statement)은 한 요청에 **명령 1개만** 허용해서, 마이그레이션 파일처럼
 * 여러 문장이 든 스크립트가 `cannot insert multiple commands into a prepared statement` 로 죽는다.
 * postgres.js 의 `unsafe()` 도 파라미터가 없으면 simple protocol 을 쓰므로 **라이브와 같은 동작**이다.
 */
function wrap(pg: PgliteLike): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      if (params.length === 0) {
        const results = await pg.exec(text);
        const last = results[results.length - 1];
        return ((last?.rows ?? []) as T[]);
      }
      const res = await pg.query(text, params as unknown[]);
      return (res.rows ?? []) as T[];
    },
  };
}

export async function createPgliteDb(): Promise<TestDb> {
  const pg = new PGlite();
  const base = wrap(pg as unknown as PgliteLike);

  return {
    raw: pg,
    query: base.query,
    async begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // PGlite 의 transaction() 은 콜백이 throw 하면 롤백한다 — postgres.js `sql.begin` 과 같다.
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as PgliteLike))) as Promise<T>;
    },
    async ping(): Promise<boolean> {
      try {
        await pg.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}
