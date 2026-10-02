// 인용 도메인 큐레이션 목록의 **공유 정본** — 관리 화면(리포지토리 경유)과
// ops 스크립트(scripts/citations/seed-curation.ts)가 같은 모수·같은 판정을 쓰게
// 한다. 순수 모듈이다: DB 클라이언트도, `server-only` 도 import 하지 않는다
// (스크립트는 tsx 로 도는데 `server-only` 는 Next/vitest 에서만 해석된다).

import { categorizeDomain, type CitationCategory, type CitationOverrideMap } from "./index";
import {
  classificationSource,
  overrideShadowsOwned,
  type ClassificationSource,
} from "./source";

/**
 * 가중치 상위 인용 도메인 쿼리(LIMIT 없이). 도메인은 **정규화**해서 GROUP BY 한다
 * (lower + 선행 www. 제거) — 오버라이드 PK 와 같은 키여야 화면에서 고른 도메인이
 * 실제 분류에 반영된다. 종전 스크립트는 raw domain 으로 묶어 `www.x.com` 과
 * `x.com` 이 두 행으로 갈렸다.
 */
export const CITATION_DOMAIN_WEIGHT_SQL = `
  SELECT regexp_replace(lower(c.domain), '^www\\.', '') AS domain,
         count(*)::int AS citations
  FROM scope_citations c
  WHERE c.domain IS NOT NULL AND c.domain <> ''
  GROUP BY 1
  ORDER BY citations DESC, domain ASC`;

/** 큐레이션 화면 한 행 — 인용 가중치 + 현재 분류 + 분류 출처. */
export interface CitationDomainCurationRow {
  /** 정규화된 registrable domain (오버라이드 PK 와 동일 키). */
  domain: string;
  /** 미러(scope_citations) 인용 행 수 — 가중치. */
  citations: number;
  /** 현재 유효 분류 (오버라이드 반영). */
  category: CitationCategory;
  /** 이 분류를 만든 계층 — UI 배지. */
  source: ClassificationSource;
  /** 오버라이드가 카탈로그 owned 도메인을 덮고 있는가 — UI 경고 배지. */
  shadowsOwned: boolean;
  /** 오버라이드 행이 있을 때만 채워진다. */
  overrideNote: string | null;
  overrideUpdatedBy: string | null;
  overrideUpdatedAt: string | null; // ISO
}

export interface CurationOverrideMeta {
  category: CitationCategory;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** 도메인 하나 → 큐레이션 행. 분류·출처 판정은 전부 분류기 정본을 통과한다. */
export function buildCurationRow(
  domain: string,
  citations: number,
  overrides: CitationOverrideMap,
  meta?: CurationOverrideMeta | null,
): CitationDomainCurationRow {
  return {
    domain,
    citations,
    category: categorizeDomain(domain, overrides),
    source: classificationSource(domain, overrides),
    shadowsOwned: overrideShadowsOwned(domain, overrides),
    overrideNote: meta?.note ?? null,
    overrideUpdatedBy: meta?.updatedBy ?? null,
    overrideUpdatedAt: meta?.updatedAt ?? null,
  };
}

/**
 * 인용수 맵 + 오버라이드 메타 → 정렬된 큐레이션 목록.
 * 오버라이드가 있는 도메인은 인용수가 0이거나 상위 N 밖이어도 **반드시 남긴다** —
 * 안 그러면 한 번 교정한 롱테일 도메인을 화면에서 다시 찾아 원복할 방법이 사라진다.
 */
export function buildCurationRows(
  counts: ReadonlyMap<string, number>,
  overrideMeta: ReadonlyMap<string, CurationOverrideMeta>,
): CitationDomainCurationRow[] {
  const overrides: CitationOverrideMap = new Map(
    [...overrideMeta.entries()].map(([d, m]) => [d, m.category] as const),
  );
  const domains = new Set<string>([...counts.keys(), ...overrideMeta.keys()]);
  return [...domains]
    .map((d) => buildCurationRow(d, counts.get(d) ?? 0, overrides, overrideMeta.get(d)))
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));
}
