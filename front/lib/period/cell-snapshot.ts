import { sql, type SQL } from "drizzle-orm";
import { ANCHOR_ALIAS, anchorMeasuredOrigSql, anchorRoundDateSql } from "./anchor-axis";

/**
 * **"셀당 최신 1건" dedup 키의 단일 정본.**
 *
 * 셀 = 프롬프트 × 엔진(`target`) × 지역(`region`). 같은 셀이 한 창 안에서 여러 번
 * 측정되면 최신 1건만 남기는 dedup 키가 이 리포에 **아홉 벌** 있었고, 벌마다
 * ① 키 개수(3키 vs 4키) ② 키 **순서**(버킷이 앞이냐 뒤냐) ③ 버킷 식이 달랐다.
 * 같은 기간·같은 필터인데 카드와 추이의 모수가 갈리는 사고가 여기서 나온다.
 *
 * 아홉 번째는 `DISTINCT ON` 을 직접 적지 않고 `withAnswerSet` 의 `dedupe.on`/`order`
 * 로 넘기는 형태라 첫 정리에서 빠졌다(2026-09-19 독립 검증 지적 ③ 으로 회수).
 * **수기 사본은 이제 0곳이다** — 새로 생기면 `scope-aggregates.trend-bucket-snapshot.test.ts`
 * 의 ② 가 잡는다(dedup 자리가 빌더 키를 쓰는지 본다).
 *
 * ── 왜 `CASE` 가 아니라 **키 조각**만 내는가 ────────────────────────────────
 * Postgres 는 `DISTINCT ON` 의 식과 `ORDER BY` 선두가 **문자 그대로 같을 것**을
 * 요구한다(바인드가 두 번 들어가면 "must match initial ORDER BY" 로 거부한다).
 * 그래서 진짜 위험한 것은 문장 골격이 아니라 **그 두 자리가 갈리는 것**이다.
 * 이 모듈은 그 두 자리에 넣을 키 목록을 한 번만 만들어 준다. 문장 조립(들여쓰기·
 * 줄바꿈·선택 리스트)은 호출부에 남긴다 — 여덟 자리의 서식이 제각각이라 텍스트를
 * 바이트 그대로 보존하려면 그래야 한다.
 *
 * ── 앵커 축(0077)의 dedup — "회차마다 셀당 1건" ────────────────────────────
 * 계약 §3: 기간에 회차가 여럿이면 **회차(`round_date`)마다** 셀당 대표 1건을 고른 뒤
 * 회차 간 **합산**한다. 그 규칙이 이 빌더에서는 두 인자로 표현된다:
 *   · `bucket`   = `ca.round_date`(회차 키. 주 버킷과 **다르다** — 주 버킷은 SELECT 쪽
 *                  `ca.anchor_week` 이고, dedup 은 그보다 잘게 회차 단위다)
 *   · `tieBreak` = `ca.measured_at_orig DESC`(대표 = 원본 측정 시각 최신, 스펙 §2-16)
 * `anchorCellSnapshotKeys()` 가 그 조합을 한 번에 낸다 — 두 인자를 따로 넘기다
 * 한쪽만 바꾸면 "회차마다 1건인데 대표는 접힌 시각 기준" 같은 반쪽 상태가 된다.
 *
 * ⚠️ 종전 축의 `tieBreak`(`<접두>measured_at DESC`)를 앵커 축에 그대로 쓰면 **조용히
 * 틀린다**: 0053 접기가 `measured_at` 의 날짜부를 앵커로 덮어써서 시:분만 비교하게 된다.
 */

/** 컬럼 표기 접두 — 별칭 있는 경로(`a.`·`b.`·`x.`)와 bare 경로(`""`). */
export type CellAliasPrefix = "" | "a." | "b." | "x." | "snap.";

export interface CellSnapshotKeys {
  /** 셀 키만 — `prompt_id, target, region`(접두 포함). */
  cells: SQL;
  /** 버킷 식 — 없으면 `null`. */
  bucket: SQL | null;
  /** `DISTINCT ON (…)` 과 `ORDER BY` 선두에 **같이** 넣는 전체 키 목록. */
  all: SQL;
  /** 동점 처리 — 전 호출부가 `<접두>measured_at DESC` 로 같다. */
  tieBreak: SQL;
}

export function cellSnapshotKeys(
  opts: {
    alias?: CellAliasPrefix;
    /** 버킷 식(주·일 격자, 앵커 축에서는 회차 키). 없으면 3키 dedup. */
    bucket?: SQL | null;
    /** 버킷을 키 **맨 앞**에 둘지. 종전 사본이 두 형태로 갈려 있어 인자로 남겼다. */
    bucketFirst?: boolean;
    /**
     * 동점 처리 식 override. 생략하면 종전 `<접두>measured_at DESC`.
     * 앵커 축은 `ca.measured_at_orig DESC` 를 넘긴다(머리 주석의 ⚠️).
     */
    tieBreak?: SQL;
  } = {},
): CellSnapshotKeys {
  const p = opts.alias ?? "";
  const col = (name: string) => sql.raw(`${p}${name}`); // 고정 리터럴 — 사용자 입력 아님
  const cells = sql`${col("prompt_id")}, ${col("target")}, ${col("region")}`;
  const bucket = opts.bucket ?? null;
  const all = bucket
    ? opts.bucketFirst
      ? sql`${bucket}, ${cells}`
      : sql`${cells}, ${bucket}`
    : cells;
  return {
    cells,
    bucket,
    all,
    tieBreak: opts.tieBreak ?? sql`${col("measured_at")} DESC`,
  };
}

/**
 * 앵커 축의 "회차마다 셀당 대표 1건" 키 — 계약 §3 의 규칙을 **한 번에** 낸다.
 *
 * `all` = `ca.round_date, <접두>prompt_id, <접두>target, <접두>region`
 * `tieBreak` = `ca.measured_at_orig DESC, <접두>job_id DESC`
 *
 * 회차 키를 **맨 앞**에 두는 이유: DATA 스트림의 인덱스가
 * `(project_id, round_date, measured_at_orig DESC)` 라 그 순서가 정렬을 그대로 받는다.
 *
 * ── `job_id DESC` 가 왜 필요한가 (검증 C) ──────────────────────────────────
 * `measured_at_orig` 동률은 **구조적으로 생긴다**: 0077 의
 * `measured_at_orig = COALESCE(source_measured_at, measured_at, anchor_at)` 이고
 * 마지막 폴백이 회차 앵커 시각이라 **한 회차의 모든 답변이 같은 값**이 된다.
 * 거기서 `ORDER BY` 가 끝나면 PostgreSQL 이 임의 행을 고르고, 같은 쿼리가 실행마다
 * 다른 답을 낼 수 있다. JS 짝(`result-adapter.ts::anchorRepresentativeJobIds`)은
 * 동률을 `job_id` 사전식 최대로 깨므로, 그대로 두면 **카드(SQL)와 드릴다운(JS)이
 * 다른 대표를 골라 언급 수가 갈린다.**
 *
 * `uuid DESC` 는 바이트 순이고 canonical 소문자 16진 표기의 사전식 순서와 같다 —
 * JS 의 문자열 비교(`job.job_id > cur.job_id`)와 같은 답을 낸다.
 */
export function anchorCellSnapshotKeys(
  opts: { alias?: CellAliasPrefix; anchorAlias?: string } = {},
): CellSnapshotKeys {
  const ca = opts.anchorAlias ?? ANCHOR_ALIAS;
  const prefix = sql.raw(opts.alias ?? "");
  return cellSnapshotKeys({
    alias: opts.alias,
    bucket: anchorRoundDateSql(ca),
    bucketFirst: true,
    tieBreak: sql`${anchorMeasuredOrigSql(ca)} DESC, ${prefix}job_id DESC`,
  });
}
