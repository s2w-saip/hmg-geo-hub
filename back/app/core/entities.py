"""명부 제외 엔티티(app.entity_registry role='excluded') 표시 규칙: 브랜드·경쟁사 순위·목록·경쟁사 선정에서 뺀다.

현행 근거(hmg-geo 2670a16, #330)
- lib/scope/excluded-brands.ts:1-31 머리 주석: admin 이 '제외'로 등록한 엔티티를 순위와 목록, 경쟁사 선정에서 뺀다. KPI 값(분모 포함)은
  바꾸지 않는다(전체 언급 수·SOV 분모·노출률 분모·우호도 신호 합·버킷 totalMentions·유형 totals·고유 브랜드 수 = 제외 엔티티 포함 그대로).
  자사(isTracked) 행은 이름이 겹쳐도 빼지 않는다(:27, isExcludedBrand :81-89). top-N 캡은 제외 뒤 다시 채운다(recapBrands :100-119:
  "제외가 없었던 것과 같은 결과", lib/scope/server.ts:3364·:3484-3490). GEO 는 행을 빼지 않고 최대 경쟁사·순위 모수에서만 건너뛴다
  (markExcludedGeo :243-256, dashboard/_data/live.ts:140 marketStats·overview-metrics.ts:44 marketMetrics).
- 판정 키(:14-24): 순위 행 = 롤업 엔티티 대표 Brand 표기(라틴 우선 + 사전순)의 정본 표시명. 제외 키 = 제외 엔티티의 대표 Brand 표기
  (lib/db/repositories/entity-registry.ts:52-73 listRoster rank_name) → canonicalBrandDisplayName. 대표 Brand 표기가 없으면 명부 저장
  이름(excluded-brands.ts:66-74 excludedBrandNames).

hub 대응
- 순위 행 키 = rd.dim_brand_name.brand_key(= bare = lower(js_trim(canon(대표 표기))), ingest/project/apply/queries.py PAIRS _ig_pairs).
  Brand 엔티티의 언급은 자기 자신으로 롤업되므로(현행 scope-aggregates.ts trackedRollupIn 주석: Brand 행이면 자기 자신) 그 엔티티의
  rd.dim_entity.brand_key(DIM_ENTITY bk: 그 엔티티 언급의 표기 쌍 → bare 최빈) 가 곧 현행 제외 키의 행이다.
- 원천 = rd.dim_entity.registry_role(app.entity_registry 투영, Q5 반영 지연 수용). 조회는 app 명부 표를 읽지 않는다: 명부 저장 →
  judgment_change 'entity' → 재판정 REGISTRY_ROLE_REFRESH(ingest/project/apply/rejudge.py:171-175·:372) 로 rd 에 반영된 뒤에 보인다.
  rd.dim_entity 는 결과 캐시 추적 표(DB-v2.11 P67)라 반영 순간 데이터 버전이 오른다(새 추적 표 없음).
- entity_type = 'Brand' 만 쓴다. Product 엔티티의 brand_key 는 소속 브랜드 행이라(픽스처: 'Hyundai Creta' → Hyundai) 그대로 쓰면
  모 브랜드 행이 빠진다. 현행은 그 경우 대표 Brand 표기가 없어 명부 저장 이름으로 행 이름과 비교하는데(보통 어느 행과도 같지 않다),
  hub 는 이름 비교 원천(app 명부)을 읽지 않으므로 비-Brand 제외 엔티티는 행을 빼지 않는다(현행 운영 명부 제외 15건 전부 Brand, 2026-09-30).
- HMG 브랜드 행(rd.dim_brand_name.own_bit ≠ 0)은 키에서 뺀다. hub 의 롤업 접기(별칭 _alias_map = 명부 own 별칭 ∪ app.entity_alias,
  HMG 접두 hmg_prefix_id: migration/seed/seed-3x-common.sql §4·PAIRS)는 전부 HMG 정본 엔티티로만 접으므로, 별칭·접두 엔티티('기아' 등)의
  brand_key 는 HMG 행이다. 현행은 그 엔티티 자신의 대표 표기('기아')로 비교해 HMG 행('Kia')과 같지 않아 아무 행도 빼지 않는다. 그래서
  own_bit ≠ 0 키를 빼면 현행과 같다(오등록이 형제 HMG 행을 지우는 사고도 막는다: 현행 :27 안전장치의 취지).
- 자사 보호: 호출부는 관점 브랜드 행(is_own·is_ours)을 이 집합과 무관하게 남긴다(keep).

이 모듈은 조회만 한다(쓰기 없음). 키 집합은 요청 트랜잭션 스냅샷에서 한 문장으로 읽는다(결과 캐시 적중이면 문장 자체가 없다).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from app.core.db import fetch_all

# 제외 엔티티 → 순위 행 키. brand_key 0(이름 없음)·NULL(표기 쌍 없음)은 행이 아니다. HMG 행(own_bit ≠ 0)은 키가 아니다.
EXCLUDED_BRAND_KEYS_SQL = """
SELECT DISTINCT e.brand_key
  FROM rd.dim_entity e
  JOIN rd.dim_brand_name b ON b.brand_key = e.brand_key
 WHERE e.registry_role = 'excluded' AND e.entity_type = 'Brand' AND e.brand_key <> 0 AND b.own_bit = 0
 ORDER BY 1
"""


async def excluded_brand_keys(conn: Any) -> frozenset[int]:
    """명부 제외(Brand) 엔티티가 롤업되는 순위 행 키 집합. 비면 모든 호출부가 종전과 같은 결과를 낸다."""
    return frozenset(int(r["brand_key"]) for r in await fetch_all(conn, EXCLUDED_BRAND_KEYS_SQL))


def keep(brand_key: Any, *, is_own: bool, excluded: frozenset[int]) -> bool:
    """이 행을 순위·목록에 남길 것인가. 관점(자사) 행은 언제나 남긴다(현행 isExcludedBrand: isTracked 면 거짓)."""
    if is_own or not excluded or brand_key is None:
        return True
    return int(brand_key) not in excluded


def drop_excluded(rows: Iterable[Mapping[str, Any]], excluded: frozenset[int], *, key: str = "brand_key",
                  own: str | None = None) -> list[Any]:
    """행 목록에서 제외 행을 뺀다(순서 유지). own = 자사 여부 열 이름(없으면 전부 경쟁 행으로 본다)."""
    return [r for r in rows if keep(r.get(key), is_own=bool(r.get(own)) if own else False, excluded=excluded)]


__all__ = ["EXCLUDED_BRAND_KEYS_SQL", "drop_excluded", "excluded_brand_keys", "keep"]
