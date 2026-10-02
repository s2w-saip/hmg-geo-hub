import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { citationGroupKeySql } from "./citation-group-key";
import {
  OFFICIAL_SOCIAL_ACCOUNTS,
  OFFICIAL_SOCIAL_DOMAINS,
  citationGroupKey,
  citationPathKeyOf,
} from "@/lib/citation-categorizer/official-social";

// 인용 그룹 키 — live(JS) / mirror(SQL) 패리티.
//
// 이 리포의 계약은 "두 목록을 맞춰 놓는다"가 아니라 **두 경로가 같은 배열
// (OFFICIAL_SOCIAL_ACCOUNTS)을 통과한다** 이다. 아래 두 축이 그것을 강제한다:
//
//  A. 파생 — 생성된 SQL 의 리터럴이 공유 배열에서 나온 것과 정확히 일치한다.
//     SQL 쪽이 자체 목록을 갖거나 비우는 순간 깨진다.
//  B. 패리티 — **실 Postgres 가 계산한** 정규화값·그룹 키를 JS 가 그대로
//     재현한다. 픽스처는 프로덕션 미러에서 뽑은 실제 인용 URL 338건이고,
//     그중 89건은 계정 핸들을 포함하지만 매칭되면 안 되는 **근접 실패**다
//     (instagram.com/hyundaiindia, linkedin.com/company/hyundai-motor-group-uk …).
//     JS 쪽 목록·정규화가 어긋나면 깨진다.
//
// 전수(27,455 URL) 대조는 DB 가 필요해 `citation-group-key.parity.int.test.ts`
// 가 담당한다(DATABASE_URL 없으면 skip). 이 파일은 DB 없이 도는 안전망이다.

interface ParityRow {
  domain: string;
  url: string;
  /** 실 Postgres 가 citationGroupKeySql 로 계산한 그룹 키 */
  pgKey: string;
  /** 실 Postgres 가 계산한 정규화 문자열 */
  pgNorm: string;
}

const FIXTURE: ParityRow[] = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "__fixtures__", "citation-group-key-parity.json"),
    "utf8",
  ),
);

describe("A. 생성된 SQL 이 공유 배열에서 파생된다", () => {
  const query = new PgDialect().sqlToQuery(citationGroupKeySql(sql`c.domain`, sql`c.url`));
  const params = query.params.map(String);

  it("게이트 도메인 리터럴 = OFFICIAL_SOCIAL_DOMAINS", () => {
    const gate = params.slice(0, OFFICIAL_SOCIAL_DOMAINS.size);
    expect(new Set(gate)).toEqual(new Set(OFFICIAL_SOCIAL_DOMAINS));
  });

  it("매처·키 리터럴이 배열에서 나온 것과 정확히 일치한다 (SQL 자체 목록 금지)", () => {
    const expected = new Set<string>(OFFICIAL_SOCIAL_DOMAINS);
    for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) {
      expected.add(acc.key);
      for (const m of acc.matchers) {
        // boundary 매처는 `starts_with(norm || '/', prefix || '/')` 한 줄로 접히므로
        // SQL 에 나가는 리터럴은 `prefix + '/'` 뿐이다(빌더 주석 참조).
        expected.add(m.boundary ? `${m.prefix}/` : m.prefix);
      }
    }
    // 여집합 양방향: SQL 에만 있는 리터럴도, 배열에만 있는 리터럴도 없어야 한다.
    expect([...new Set(params)].filter((p) => !expected.has(p))).toEqual([]);
    expect([...expected].filter((e) => !params.includes(e))).toEqual([]);
  });

  it("계정이 하나라도 있으면 CASE 분기가 생긴다", () => {
    expect(OFFICIAL_SOCIAL_ACCOUNTS.length).toBeGreaterThan(0);
    expect(query.sql).toContain("CASE WHEN");
    expect(query.sql).toContain("starts_with");
    // LIKE 는 프리픽스의 `_` 를 와일드카드로 먹는다 — 앵커 규율상 금지.
    expect(query.sql).not.toContain("LIKE");
  });
});

describe("B. JS 가 실 Postgres 의 계산을 그대로 재현한다 (프로덕션 URL 338건)", () => {
  it("픽스처가 매칭·근접실패를 모두 담고 있다", () => {
    const matched = FIXTURE.filter((r) => r.pgKey.includes("/"));
    const nearMiss = FIXTURE.filter((r) => !r.pgKey.includes("/"));
    expect(FIXTURE.length).toBe(338);
    expect(matched.length).toBe(249);
    expect(nearMiss.length).toBe(89);
  });

  it("정규화 문자열이 문자 단위로 같다", () => {
    const bad = FIXTURE.filter((r) => citationPathKeyOf(r.domain, r.url) !== r.pgNorm).map((r) => ({
      url: r.url,
      pg: r.pgNorm,
      js: citationPathKeyOf(r.domain, r.url),
    }));
    expect(bad).toEqual([]);
  });

  it("그룹 키가 같다", () => {
    const bad = FIXTURE.filter((r) => citationGroupKey(r.domain, r.url) !== r.pgKey).map((r) => ({
      url: r.url,
      pg: r.pgKey,
      js: citationGroupKey(r.domain, r.url),
    }));
    expect(bad).toEqual([]);
  });

  it("근접 실패 89건은 도메인 그대로 남는다 (앵커가 실제로 좁힌다)", () => {
    for (const r of FIXTURE.filter((x) => !x.pgKey.includes("/"))) {
      expect(citationGroupKey(r.domain, r.url)).toBe(r.domain);
    }
  });

  it("키별 건수가 실측 기준선과 일치한다 (DISTINCT URL 기준)", () => {
    const counts = new Map<string, number>();
    for (const r of FIXTURE) {
      const k = citationGroupKey(r.domain, r.url);
      if (k.includes("/")) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      "facebook.com/HyundaiCarsIreland": 1,
      "facebook.com/Hyundai.Europe": 12,
      "facebook.com/HyundaiMotorGroupNewsroom": 99,
      "facebook.com/HyundaiMotorGroupTV": 9,
      "instagram.com/hyundai": 3,
      "linkedin.com/genesisworldwide": 29,
      "linkedin.com/hyundai-motor-group": 93,
      "threads.com/@genesis_usa": 1,
      "youtube.com/@hyundai_kor": 2,
    });
  });
});
