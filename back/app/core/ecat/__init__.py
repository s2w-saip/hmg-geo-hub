"""허브 엔티티 카탈로그(ecat) 코어: 순수 함수만 둔다(DB·네트워크·설정 읽기 없음).

설계 정본: notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md (1-2절 매처 규칙, 3절 ② 린트, 8절 E2·E3).

- text     표면·본문 정규화(NFKC + casefold, 원문 코드포인트 오프셋 대응표)와 문자 체계 인지 단어 경계
- matcher  저장 본문에서 추가 표면을 찾는 결정적 매처(표면별 독립 스캔 = ing.hub_match 1행 단위), 겹침 제거, 재매칭 언급 속성
- lint     버전 초안 린트 L1(차단)·L2(경고·확인)·L3(구조 차단)과 자사(추적) 엔티티 에스컬레이션. 허용 목록·일반어 사전은 테넌트
           설정(LintConfig)으로 주입받는다: 코어에 HMG 값이 없다.
"""
