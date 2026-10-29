import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { citationDomainOverrides } from "@/lib/db/schema";
import {
  isCitationCategory,
  normalizeCitationDomain,
  type CitationCategory,
  type CitationOverrideMap,
} from "@/lib/citation-categorizer";
import {
  CITATION_DOMAIN_WEIGHT_SQL,
  buildCurationRows,
  type CitationDomainCurationRow,
  type CurationOverrideMeta,
} from "@/lib/citation-categorizer/curation";

// 인용 출처 카테고리 오버라이드(citation_domain_overrides) 리포지토리.
//
// 분류 자체는 read-time 순수 함수(lib/citation-categorizer)라 이 테이블은 "그 위의
// 교정층"일 뿐이다 — 행이 생기면 백필 없이 전 이력이 재분류되고, 행을 지우면 기본
// 분류로 원복된다. 그래서 여기엔 이력/백필/역동기화가 없다.
//
// ⚠️ 키 정규화: PK 는 **정규화된 registrable domain**(lowercase + 선행 www. 제거).
// 읽기(categorizeDomain)가 조회 전에 같은 정규화를 하므로, 쓰기에서 정규화를 빼면
// 오버라이드가 에러 없이 조용히 무시된다. 그래서 normalizeCitationDomain() 을
// 쓰기·읽기 양쪽에서 강제한다.

export interface CitationOverrideRow {
  domain: string;
  category: CitationCategory;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

export type { CitationDomainCurationRow } from "@/lib/citation-categorizer/curation";

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

function toRow(r: {
  domain: string;
  category: string;
  note: string | null;
  updatedBy: string | null;
  updatedAt: unknown;
}): CitationOverrideRow | null {
  // 택소노미 밖 값(코드가 카테고리를 지운 뒤 남은 행 등)은 드롭 — seed 로더와 동일
  // 방침. 파이/필터에 미지의 카테고리를 흘리지 않는다.
  if (!isCitationCategory(r.category)) return null;
  return {
    domain: r.domain,
    category: r.category,
    note: r.note,
    updatedBy: r.updatedBy,
    updatedAt: toIso(r.updatedAt),
  };
}

export const citationOverrideRepository = {
  /** 전체 오버라이드 행 (최근 수정 순). 관리 화면·감사용. */
  async list(): Promise<CitationOverrideRow[]> {
    const rows = await getDb()
      .select()
      .from(citationDomainOverrides)
      .orderBy(desc(citationDomainOverrides.updatedAt));
    return rows.map(toRow).filter((r): r is CitationOverrideRow => r !== null);
  },

  /**
   * 분류기 주입용 맵 (정규화 도메인 → 카테고리). 읽기 경로가 유일하게 쓰는 형태.
   * loadCitationOverrides() 가 이 위에 캐시를 씌운다.
   */
  async loadMap(): Promise<CitationOverrideMap> {
    const rows = await this.list();
    return new Map(rows.map((r) => [r.domain, r.category] as const));
  },

  /**
   * 도메인 하나의 분류를 저장(있으면 교체). 도메인은 정규화되고, 택소노미 밖
   * 카테고리는 거부한다(호출부가 잘못된 값을 넣는 것을 여기서 끊는다).
   */
  async upsert(input: {
    domain: string;
    category: string;
    note?: string | null;
    updatedBy?: string | null;
  }): Promise<CitationOverrideRow> {
    const domain = normalizeCitationDomain(input.domain);
    if (!domain) throw new Error("citation override: empty domain");
    if (!isCitationCategory(input.category)) {
      throw new Error(`citation override: unknown category "${input.category}"`);
    }
    const values = {
      domain,
      category: input.category,
      note: input.note?.trim() ? input.note.trim() : null,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date(),
    };
    const [row] = await getDb()
      .insert(citationDomainOverrides)
      .values(values)
      .onConflictDoUpdate({
        target: citationDomainOverrides.domain,
        set: {
          category: values.category,
          note: values.note,
          updatedBy: values.updatedBy,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    const out = row ? toRow(row) : null;
    if (!out) throw new Error("citation override: upsert returned no row");
    return out;
  },

  /** 오버라이드 삭제 = 기본 분류로 원복. 없는 행이면 false. */
  async remove(domain: string): Promise<boolean> {
    const d = normalizeCitationDomain(domain);
    if (!d) return false;
    const deleted = await getDb()
      .delete(citationDomainOverrides)
      .where(eq(citationDomainOverrides.domain, d))
      .returning({ domain: citationDomainOverrides.domain });
    return deleted.length > 0;
  },

  /**
   * 큐레이션 목록 — 미러(scope_citations) 인용 가중치 상위 도메인 + 현재 분류 +
   * 분류 출처. 쿼리와 행 조립은 lib/citation-categorizer/curation.ts 가 정본이라
   * 관리 화면과 scripts/citations/seed-curation.ts 가 같은 모수·같은 판정을 본다.
   */
  async listDomainCuration(limit = 500): Promise<CitationDomainCurationRow[]> {
    const cap = Math.max(1, Math.min(5000, Math.trunc(limit)));
    const db = getDb();
    const rows = (await db.execute(
      sql`${sql.raw(CITATION_DOMAIN_WEIGHT_SQL)} LIMIT ${cap}`,
    )) as unknown as Array<{ domain: string; citations: number | string }>;

    const counts = new Map<string, number>(
      rows.map((r) => [r.domain, Number(r.citations) || 0] as const),
    );

    const overrides = await this.list();
    const meta = new Map<string, CurationOverrideMeta>(
      overrides.map((o) => [
        o.domain,
        { category: o.category, note: o.note, updatedBy: o.updatedBy, updatedAt: o.updatedAt },
      ] as const),
    );

    // 상위 N 밖으로 밀려난 오버라이드 도메인의 실제 인용수는 별도 집계로 채운다
    // (buildCurationRows 는 없으면 0 으로 남긴다). 개수가 오버라이드 행 수로
    // bound 되므로 쿼리 비용이 통제된다.
    const missing = [...meta.keys()].filter((d) => !counts.has(d));
    if (missing.length > 0) {
      const list = sql.join(missing.map((d) => sql`${d}`), sql`, `);
      const extra = (await db.execute(sql`
        SELECT regexp_replace(lower(c.domain), '^www\\.', '') AS domain,
               count(*)::int AS citations
        FROM scope_citations c
        WHERE c.domain IS NOT NULL AND c.domain <> ''
          AND regexp_replace(lower(c.domain), '^www\\.', '') IN (${list})
        GROUP BY 1
      `)) as unknown as Array<{ domain: string; citations: number | string }>;
      for (const e of extra) counts.set(e.domain, Number(e.citations) || 0);
    }

    return buildCurationRows(counts, meta);
  },
};
