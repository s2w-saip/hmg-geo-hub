# 인용 출처 분류

도메인·공식 소셜 계정 키를 출처 카테고리로 변환하는 결정론적 분류기입니다. 런타임 LLM을 호출하지 않습니다.

- 공통 분류 순서: 공식 소셜 계정 → geo-catalog 자사 도메인 → `seed.json` → `rules.ts` → Other.
- 공식 계정 정의는 `official-social.ts`, taxonomy는 `taxonomy.ts`를 사용합니다.
- 도메인 접기는 `lib/public-suffix`를 사용하며 SQL/JS 그룹 키를 동일하게 유지합니다.
- 운영자 override는 별도의 DB 경로이므로 분류 함수와 함께 확인합니다.
- 사전 수정 시 인접 테스트와 `scripts/citations/`의 큐레이션·병합 도구를 사용합니다.
