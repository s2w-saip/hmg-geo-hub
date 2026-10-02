"""ingest.ecat: 허브 엔티티 카탈로그(ecat)의 적재 쪽 DB 부분(E2).

설계 정본: notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md 2-1절(원천 층 ing.hub_match), 8절 E2.
순수 매처는 app.core.ecat(DB 없음), 여기는 그 매처를 저장 본문에 돌려 ing.hub_match·ing.hub_match_scan 에 쓰고 읽는 층이다.

- scan     재스캔(CLI `python -m ingest.cli ecat-scan`)·적재 훅(on_load)·leaf 준비. 쓰기 = ing.hub_match·ing.hub_match_scan·ing.load(자기 load 1행)
- rematch  투영·미리보기(E1·E4)가 쓰는 읽기 계약: 켜진 add 표면의 유효 적중 + 같은 턴 Scope 발생 → 겹침 제거 → 재매칭 언급 행
"""
