# DB 설계 v2 DDL 실행 검증 (2026-09-27)

빈 PostgreSQL 17 컨테이너(고객 데이터 없음, 합성 행만)에 [DB-v2.sql](DB-v2.sql)을 적용하고 [smoke.sql](smoke.sql)을 돌린 기록이다. 하네스: [ddl-check.sh](ddl-check.sh) (`up` → `apply DB-v2.sql` → 스모크 → `down`). 원자료: [ddl-apply-v2.txt](ddl-apply-v2.txt) · [smoke-result-v2.txt](smoke-result-v2.txt).

## 결론

- **적용**: 오류 0. 표 141(일반 115 + 파티션 부모 26), 인덱스 문장 73, 함수 6, 뷰 5. 문서의 "문서형 뷰 6개"는 실제 5개이고, 인용 원문 목록은 뷰 없이 `rd.citation ⋈ rd.dim_url` 이다.
- **스모크**: 깨끗한 DB 에서 OK 12 / FAIL 0. 기대된 오류 1건(아래 미결 1)만 남았다.

## 검증자 통합안(DB-보정.sql) 대비 수리 4건

| # | 결함 | 재현 | 수리 |
| --- | --- | --- | --- |
| 1 | §10 롤·권한이 주석뿐이라 GRANT 가 하나도 없음 | 적용 후 롤 6개 전부 스키마 USAGE 없음 | 실행 문장으로 구현. 소유자 `hmg_owner` 일원화, api_ro 읽기 전용, api_rw app 쓰기·큐 INSERT 만, 뷰 소유자 loader_ro. T5·T6 7항목 통과 |
| 2 | `rd.ensure_leaf` 를 적재기가 호출하는데 파티션 생성은 부모 소유자만 가능 | invoker 로 `permission denied`, 파티션 소유자 누락 시 definer 로도 `must be owner of table answer_g` | SECURITY DEFINER + 파티션(하위 파티션 부모 포함)까지 소유자 지정. 12개월 leaf 생성 확인 |
| 3 | 월 범위 파티션 부모 9개(ing 5·ga4 2·접근 감사·DataForSEO)에 leaf 생성 경로 없음 | leaf 0 상태로 INSERT 불가 | `rd.ensure_month_leaf(regclass, date)` 신설(허용 목록·UTC 월 경계). 9 부모 생성·목록 밖 거부 확인 |
| 4 | `propagate_answer_gates` 가 `answer_key = ANY` 로 rd.answer 를 찾아 모든 leaf 의 PK 인덱스를 끝까지 훑음 | 24만 행·12 leaf 에서 4.45ms vs rd.job 경유 0.028ms(행 수에 비례해 증가) | rd.job 에서 파티션 좌표를 얻어 등치 조인. 일치 leaf 만 실행(나머지 never executed). 위치 불일치 단언 추가(T9 에서 재투영 누락 흉내를 잡음) |

## 확인된 설계 성질

- 게이트 전파: 답변 elig=false → 자식 3표 사본 맞춤(3행), 재호출 0행(멱등).
- R08: 완료 100·결손 3 → `analysis_done_ratio` 0.97(완료 비율, 역전 없음).
- 문서형 뷰: api_ro 가 ing 직접 읽기는 거부되고 뷰 경유 본문 조회는 된다(소유자 loader_ro, security_barrier).

## 미결 (설계 결정 필요)

1. **접근 감사 로그 쓰기 주체 없음**: `app.access_audit_log`(kind `api_read`·`data_access`)는 읽기 API 가 남겨야 하는데 api_ro 는 읽기 전용 트랜잭션이고 loader 는 app 쓰기 권한이 없다(스모크에서 거부 확인). 안: 읽기 API 가 감사만 api_rw 풀로 따로 쓰거나, 감사 전용 롤(INSERT 만)을 둔다.
2. **answer_key 전역 유일성은 DB 제약으로 보장 불가**: 파티션 표 PK 는 파티션 키(round_date)를 포함해야 한다. 스모크 합성 데이터에서 같은 answer_key 가 다른 월 leaf 에 20,000건 중복 삽입됐다. rd.job(answer_key PK)이 유일한 위치 원장이고, 야간 감사 `SELECT answer_key FROM rd.answer GROUP BY 1 HAVING count(*) > 1` = 0 을 단언해야 한다(자식 표 동일).
3. **leaf 스왑(재구축) 함수 없음**: 설계는 규칙 버전 변경 시 leaf 재구축·ATTACH 를 말하지만 ATTACH·DETACH 도 부모 소유자 권한이다. ensure_leaf 와 같은 SECURITY DEFINER 스왑 함수가 필요하다.
4. 성능: 이 검증은 기능 확인이며 성능 근거가 아니다(합성 24만 행). 성능은 RDS 구축 후 실측 게이트(G-02·G-17·G-25·G-26).
