// 결합 브랜드 표면 분해 — "삼성·LG", "삼성전자/LG전자", "Samsung/LG" 처럼
// 두 브랜드를 구분자 하나로 병렬 표기한 표면은 하나의 엔티티가 아니라
// **두 브랜드의 언급**이다.
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 2026-08-31 실측(LG 베스트샵 ff22d67c): 답변 원문이 "삼성·LG를 섞어서" 같은
// 결합 표기를 그대로 쓰고, 추출 lane 이 그 표면형을 그대로 엔티티로 만들어
// Brand `삼성·LG`(468 멘션)가 대시보드 순위에 독립 브랜드로 올랐다. 그 언급은
// 사실상 양쪽 브랜드의 언급인데 어느 쪽에도 세어지지 않았다.
//
// ── 설계 원칙: 추측하지 않는다 (split-entity 액션과 같은 규율) ──────────────
// 분해는 **모든 파트가 카탈로그의 서로 다른 Brand 로 유일하게 확인될 때만** 한다.
//   · 파트가 카탈로그에 없으면 → 분해하지 않는다 (원형 유지 → 기존 pending 경로).
//   · 파트가 여러 엔티티에 걸리면(모호) → 분해하지 않는다.
//   · 파트 전부가 같은 엔티티면(중복 표기) → 결합이 아니다.
// 구분자는 단어를 한 토큰으로 붙이는 기호만 쓴다 — 쉼표·접속사("와/과")는
// 문장 나열이라 태거가 이미 개별 표면으로 나눈다.

import type { OntologyCatalogEntity } from "./schema";
import { compactSurface, normalizeSurface } from "./normalize";

/** 두 브랜드명을 한 토큰으로 붙이는 구분자 (앞뒤 공백 허용). */
const COMPOUND_SEPARATOR = /\s*[·ㆍ/／&＆+＋×]\s*/u;

/**
 * 결합 브랜드 표면을 구성 브랜드 표면으로 분해한다.
 * 분해 조건을 전부 만족하면 파트 문자열 배열(원문 그대로, 2개 이상)을,
 * 하나라도 어긋나면 null 을 돌려준다 — null 이면 호출부는 원형을 그대로 쓴다.
 */
export function splitCompoundBrandSurface(
  surfaceText: string,
  catalog: OntologyCatalogEntity[],
): string[] | null {
  const trimmed = surfaceText.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(COMPOUND_SEPARATOR).map((part) => part.trim());
  if (parts.length < 2) return null;
  if (parts.some((part) => part.length < 2)) return null;

  const entityIds = new Set<string>();
  for (const part of parts) {
    const matched = matchBrandEntityIds(part, catalog);
    // 미등재(0)·모호(2+) 파트가 하나라도 있으면 분해하지 않는다.
    if (matched.length !== 1) return null;
    entityIds.add(matched[0]!);
  }
  // 파트 전부가 같은 브랜드면 결합 표기가 아니라 중복 표기다.
  if (entityIds.size < 2) return null;
  return parts;
}

/** 파트 하나가 exact(정규화/압축) 매칭되는 카탈로그 Brand id 목록. */
function matchBrandEntityIds(
  part: string,
  catalog: OntologyCatalogEntity[],
): string[] {
  const norm = normalizeSurface(part);
  const compact = compactSurface(part);
  if (!norm || !compact) return [];
  const ids = new Set<string>();
  for (const entity of catalog) {
    if (entity.type !== "Brand") continue;
    const surfaces = [
      entity.canonicalName,
      ...entity.aliases.map((alias) => alias.alias),
    ];
    for (const surface of surfaces) {
      if (
        normalizeSurface(surface) === norm ||
        compactSurface(surface) === compact
      ) {
        ids.add(entity.id);
        break;
      }
    }
  }
  return [...ids];
}
