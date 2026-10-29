/**
 * 생성기 코어 — 실행 컨텍스트(런타임)와 표면 공통 판정식 빌더.
 *
 * 경계는 `types.ts` 머리 주석 참고: 테넌트 상수는 **인자로만** 들어온다.
 */
import { execFileSync } from "node:child_process";
import { sql, type SQL } from "drizzle-orm";
import {
  canonBrandNameSql,
  canonRollupSql,
  citationNormExpr,
  excludeNonCompetitorBrandsSql,
} from "@/lib/db/repositories/scope-aggregates";
import { citationGroupKeySql } from "@/lib/db/repositories/citation-group-key";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { GenerationTimings, GeneratorDb } from "./types";

export type { GeneratorDb };

/**
 * 빌드 sha — `generator_version` 의 뒷자리.
 *
 * 우선순위: `HMG_GIT_SHA`(env) → `git rev-parse --short HEAD` → `"unknown"`.
 *
 * env 를 먼저 보는 이유(2026-09-10 러너 실측): 러너 릴리스는 `git archive` 번들이라
 * `/opt/hmg-runner/current` 에 **`.git` 이 없다**. 그러면 `git rev-parse` 가
 * `fatal: not a git repository` 를 stderr 로 뱉고 버전이 `…-v1+unknown` 으로 찍혀,
 * `summary_generations.generator_version` 만으로는 **프로덕션 행이 어느 코드에서 나왔는지
 * 추적할 수 없게 된다**. 배포 스크립트가 릴리스 디렉토리명(`<UTC>-<sha>`)에서 sha 를 떼어
 * 이 env 로 넣어 준다.
 *
 * `stdio` 로 stderr 를 버리는 이유: `.git` 이 없는 환경에서 실패는 **정상 경로**인데,
 * 그 fatal 이 러너 로그(journald)에 매 틱 쌓이면 진짜 오류 신호가 묻힌다.
 */
export function gitShortSha(): string {
  const injected = process.env.HMG_GIT_SHA?.trim();
  if (injected) return injected;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** `<prefix>+<sha>` — 규칙 코드의 버전(§7-8). */
export function generatorVersion(prefix: string): string {
  return `${prefix}+${gitShortSha()}`;
}

export const num = (v: unknown) => Number(v ?? 0);

/**
 * 생성기 런타임 — db 핸들·로그·문장 실행·표별 소요 계측을 한 묶음으로 넘긴다.
 * 표면 어댑터가 `db` 를 직접 잡지 않게 해서, 커넥션 정책(풀 크기·세션 설정)을 한 곳에서 본다.
 */
export type GeneratorRuntime = {
  db: GeneratorDb;
  version: string;
  log: (...a: unknown[]) => void;
  rows: <T>(q: SQL) => Promise<T[]>;
  exec: (q: SQL) => Promise<void>;
  /** 무거운 문장은 자기 tx 안에서 — `SET LOCAL` 이 그 커넥션에만 걸린다(§7-1 다중 tx). */
  heavy: (q: SQL) => Promise<void>;
  heavyRows: <T>(q: SQL) => Promise<T[]>;
  /** 표별 소요(ms) 누적. 키는 `TIMING_KEYS`. */
  timings: GenerationTimings;
  time: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
};

export function createRuntime(opts: {
  db: GeneratorDb;
  version: string;
  /** 무거운 문장의 `SET LOCAL statement_timeout`. 기존 글로벌 생성기와 같은 값이 기본. */
  heavyTimeout?: string;
  /**
   * 주면 `heavy()` 가 `SET LOCAL lock_timeout` 도 함께 건다.
   * 기본값을 두지 않는 이유: 레거시 회차 스크립트의 발행 SQL 이 바뀌면
   * `generator-sql-snapshot.test.ts` 게이트가 깨진다 — 켜는 쪽이 명시한다.
   */
  heavyLockTimeout?: string;
  /**
   * `exec()` 를 `heavy()` 로 태운다 — 모든 쓰기 문장이 자기 tx 안에서 GUC 를 달고 돈다.
   * 세션 GUC 는 풀의 **그 커넥션에만** 걸려 `max>1` 이면 보장이 안 되므로, 라이브 고객 DB
   * 위에서 도는 러너(T9 CLI)는 이쪽을 쓴다. 왕복이 문장당 1 → 4 로 늘어난다.
   */
  execViaHeavy?: boolean;
  logger?: (...a: unknown[]) => void;
}): GeneratorRuntime {
  const db = opts.db;
  const t0 = Date.now();
  const sink = opts.logger ?? ((...a: unknown[]) => console.log(...a));
  const log = (...a: unknown[]) => sink(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const rows = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
  const exec = async (q: SQL): Promise<void> => {
    if (opts.execViaHeavy) return heavy(q);
    await db.execute(q);
  };
  const timeout = opts.heavyTimeout ?? "600s";
  const guards = async (tx: { execute: (q: SQL) => Promise<unknown> }) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${timeout}'`)}`);
    if (opts.heavyLockTimeout) {
      await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${opts.heavyLockTimeout}'`)}`);
    }
  };
  const heavy = async (q: SQL): Promise<void> => {
    await db.transaction(async (tx) => {
      await guards(tx);
      await tx.execute(q);
    });
  };
  const heavyRows = async <T>(q: SQL): Promise<T[]> =>
    (await db.transaction(async (tx) => {
      await guards(tx);
      return (await tx.execute(q)) as unknown as T[];
    })) as unknown as T[];
  const timings: GenerationTimings = {};
  const time = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] = (timings[key] ?? 0) + (Date.now() - started);
    }
  };
  return { db, version: opts.version, log, rows, exec, heavy, heavyRows, timings, time };
}

/** 자사 명부(entity_registry role='own') — 두 표면이 같은 문장을 쓴다. */
export const OWN_ROSTER_SQL = sql`SELECT entity_id, name FROM entity_registry WHERE role = 'own' ORDER BY name`;

/** 오늘의 브랜드 판정 3종을 mention 행(별칭 m, names 별칭 n)에 건다. */
export function brandExprs(filters: StandardFilters) {
  const rollup = canonRollupSql(filters, "m");
  const rawName = sql`COALESCE(n.brand, m.brand)`;
  const brandName = canonBrandNameSql(rawName);
  return {
    rollup,
    rawName,
    brandName,
    // 비경쟁 제외 통과 여부 — bare 판정 + BARE_ONLY 되살리기(ownCol = m.brand)
    isCompetitor: excludeNonCompetitorBrandsSql(brandName, sql`m.brand`),
  };
}

export type BrandExprs = ReturnType<typeof brandExprs>;

/**
 * universe 안에서 정규화 URL 에 매칭되는 **가장 긴 base** (없으면 NULL) — §3-5.
 * `ownedBasePrefixClause`(SA:436-480) 의 "선택된 base 아래 선택되지 않은 더 긴 형제가
 * 있으면 그쪽이 정본" 규칙을 "universe 위 최장 일치" 로 재표현한 것. 조회 시점 판정은
 * `matched_base = ANY($선택된 base)` 로 환원된다(읽기 경로 `ownedCitationClause`).
 * 세 분기(정확 일치 · `/` 접두 · `.html` 동치)는 `matchesOwnedBasePrefix` 의 SQL 쌍둥이.
 *
 * `tiebreak` — 길이 동률에서 base 문자열로 한 번 더 정렬한다. 글로벌 표면이 켜고 있고,
 * 웹사이트는 유닛 base 가 유닛당 하나라 동률이 나지 않아 꺼 둔 상태다. **끄고 켜는 것이
 * 발행 SQL 을 바꾸므로**(스냅샷 게이트가 잡는다) 표면 기본값을 임의로 통일하지 않는다.
 */
export function longestBase(normExpr: SQL, bases: string[], tiebreak = false): SQL {
  const order = tiebreak
    ? sql`ORDER BY length(b.base) DESC, b.base LIMIT 1`
    : sql`ORDER BY length(b.base) DESC LIMIT 1`;
  return sql`(
    SELECT b.base FROM unnest(${sql.param(bases)}::text[]) AS b(base)
    WHERE ${normExpr} IS NOT NULL
      AND split_part(${normExpr}, '/', 1) = split_part(b.base, '/', 1)
      AND (${normExpr} = b.base OR ${normExpr} LIKE b.base || '/%' OR ${normExpr} = b.base || '.html')
    ${order}
  )`;
}

/**
 * 사이트 루트 홈(#216) 귀속 — prefix 로는 안 잡히는 호스트 루트 인용에 **그 호스트의
 * 최단 base** 를 붙인다. JS 정본 `ownedBaseEntryForUrl`(owned.ts)의 2단계(짧은 순으로
 * `isSiteRootHome` 검사)와 같은 선택이고, 술어는 `ownedBasePrefixClause` 의 `rootHome`
 * 분기와 문자적으로 같다.
 *
 * `sharedGlobalHosts` 는 **테넌트 값**이라 인자로 받는다(코어는 그 목록을 모른다).
 */
export function rootHomeBase(normExpr: SQL, bases: string[], sharedGlobalHosts: string[]): SQL {
  return sql`(
    SELECT b.base FROM unnest(${sql.param(bases)}::text[]) AS b(base)
    WHERE ${normExpr} IS NOT NULL
      AND split_part(b.base, '/', 1) <> ALL(${sql.param(sharedGlobalHosts)}::text[])
      AND rtrim(split_part(${normExpr}, '?', 1), '/') = split_part(b.base, '/', 1)
    ORDER BY length(b.base) ASC, b.base LIMIT 1
  )`;
}

export type CitationCteOptions = {
  /** 자사 판정 universe(정규화된 base prefix 목록). */
  bases: string[];
  /** tracked NORM(쿼리 보존) 열을 함께 만든다 — ⑥ 타겟 판정을 쓰는 웹사이트 표면. */
  tracked: boolean;
  /** `longestBase` 동률 tiebreak. */
  tiebreak?: boolean;
  /** 주면 최장 일치 실패 시 사이트 루트 홈으로 폴백한다(글로벌 표면). */
  rootHomeHosts?: string[];
};

/**
 * 인용 CTE (§3-5) — 정규화·최장일치 판정을 DISTINCT url 당 1회만. `jb` 를 전제로 한다.
 *
 * `domain` NULL 행은 그룹키가 NULL 이 된다(group_key NOT NULL). '' 로 접는다 — ⑤ 분모는
 * domain NULL 인용도 세고(§6-4), 도넛은 읽기 쪽에서 거른다.
 */
export function citationCtes(opts: CitationCteOptions): SQL {
  const baseNorm = citationNormExpr("base", sql`nullif(uk, '')`, sql`max(bk)`);
  const selNk = opts.tracked ? sql`, c.url_norm AS nk` : sql``;
  const unTrk = opts.tracked
    ? sql`, ${citationNormExpr("tracked", sql`nullif(uk, '')`, sql`max(nk)`)} AS trk`
    : sql``;
  const ubTrk = opts.tracked ? sql`, un.trk` : sql``;
  const longest = longestBase(sql`un.base`, opts.bases, opts.tiebreak);
  const matched = opts.rootHomeHosts
    ? sql`COALESCE(${longest},
                      ${rootHomeBase(sql`un.base`, opts.bases, opts.rootHomeHosts)})`
    : longest;
  const matchedTracked = opts.tracked
    ? sql`,
             ${longestBase(sql`un.trk`, opts.bases, opts.tiebreak)} AS matched_base_tracked`
    : sql``;
  return sql`
    c2 AS MATERIALIZED (
      SELECT c.job_id, COALESCE(c.url, '') AS uk, c.domain,
             COALESCE(${citationGroupKeySql(sql`c.domain`, sql`c.url`)}, '') AS gk,
             c.url_base_norm AS bk${selNk}
      FROM scope_citations c JOIN jb ON jb.job_id = c.job_id
    ),
    un AS MATERIALIZED (
      SELECT uk, ${baseNorm} AS base${unTrk} FROM c2 GROUP BY uk
    ),
    ub AS MATERIALIZED (
      SELECT un.uk, un.base${ubTrk},
             ${matched} AS matched_base${matchedTracked}
      FROM un
    )`;
}
