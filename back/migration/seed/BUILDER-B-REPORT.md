# 시드 빌더 B 보고 요약 (ing → rd 투영, 2026-09-28)

## 검증
- 합성 규칙 테스트 78/78 PASS(`test-b/run.sh` 재현). 오염 주입 시 체커 FAIL 3/3, 당사 열 산식 변조 시 seed-40 불변식 롤백, 재실행 지문 동일(18표).
- 현행 TS(7639b9e) 대조: 카테고리 1,599·출처 순번 1,586·공식 도메인 1,598·경쟁사 1,598·그룹 키 794·HMG 접두 314·비경쟁 976 불일치 0. owner 793 중 37 불일치 = `https://호스트.html` 합성 형태(현행 TS·SQL 이 원래 갈림, SQL 을 따름).
- 규모(답변 10만·언급 56만·인용 47만): seed-30 2.7초, seed-40 23초. 전파 직전 트랜잭션 내 ANALYZE 필수(없으면 5만 청크 10분+, 있으면 1.3초) → IG-2 적재기 동일 적용.

## A4 고지 대상(현행과 달라지는 정의)
1. 소프트삭제 카탈로그 행 제외(현행은 거르지 않음, scope-aggregates.ts:6180)
2. 대소문자·공백만 다른 표시명 병합(dim_brand_name.bare UNIQUE)
3. 자사 판정 = 표시 브랜드 수준(G-20, 현행 rid 기준) — seed-40 진단 줄로 갈린 행 수 출력
4. ACR: 표시명 별칭 정본화, acr_in 에 카탈로그·시장 게이트
5. 웹 프롬프트 축 1행 고정((file_seq, site_id) 첫 행)
6. pin 을 원장 회차에 못 붙이면 run 귀속 유지 + WARNING
7. 동률 정렬 키 answer_key DESC(현행 job_id DESC)
8. owner_key 판정 루트 홈 우선(실 URL 대조 결과 동일)
9. 빈 표기 브랜드 행 brand_key 0·competitive false
10. has_cit·tgt_cited·own_url_cited 는 호스트 있는 인용만(G-21 a)
11. Hyundai N 표시명 own_bit 1

## stg 실행 순서
1. DB-v2.1 적용 + 빌더 A seed-00-fn·seed-10-app·seed-20-ing 완료
2. 같은 폴더: seed-00-fn.sql(A)·seed-3x-rules.sql·seed-3x-common.sql·seed-30-dims.sql·seed-40-facts.sql(`\ir`)
3. 롤: rd.ensure_leaf·rd.propagate_answer_gates EXECUTE(A 가 ensure_month_leaf 쓴 롤), app·ing SELECT, rd DML, ing.load 쓰기, TEMP
4. `psql -v ON_ERROR_STOP=1 -f seed-30-dims.sql` → `-f seed-40-facts.sql`(기본 work_mem 512MB). seed-30 재실행 시 seed-40 필수 재실행
5. 확인: 요약, WARNING(pin 미해소·발행값 충돌·유닛 충돌), 진단 "own_bit(표시) <> rid_bit(현행)" 건수
- 미투영: rd.ga4_*·rd.kw_*(ing 원천 없음)
