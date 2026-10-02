## 1. 계약·타입 재정의 (lib/scope)

- [x] 1.1 `lib/scope/types.ts`: 공개 표면 응답/요청 타입 정의 — `Project`, `CreateProjectInput`, `UpdateProjectInput`, `Prompt`, `CreatePromptInput`, `UpdatePromptInput`, `Overview`, `BrandScorePoint`, `BrandMention`(`co_mentioned_brands` 포함), `Citation`, `CitationByDomain`, `Report`, `Usage`, 공통 `Paginated<T>`(`data`/`next_cursor`), 에러 envelope. scope 필드는 snake_case. `regions` 필드엔 "ISO alpha-2 국가코드(= HMG countries)" 주석. 옛 `QueryRequest`/`QueryResult`/`ResultItem`/`PromptKpi`/`ProjectStatusRow` 제거 또는 대체.
- [x] 1.2 `lib/scope/client.ts`: `ScopeClient` 인터페이스를 역할-무지 공개 표면으로 재정의 — projects/prompts CRUD + 결과 읽기 + usage/health. `ScopeFilter` 인자 전부 제거. `query`/`results` 메서드 제거.

## 2. HTTP 구현 (lib/scope/http.ts)

- [x] 2.1 `/api/v1` prefix 상수 부착, `/v1/...` 제거. base URL 은 호스트까지(`SCOPE_API_BASE`).
- [x] 2.2 모든 메서드를 공개 엔드포인트에 매핑(projects/prompts CRUD, overview/brand-scores/brand-mentions(+단건)/citations(+by-domain)/reports(+단건)/usage/health). `Authorization: Bearer` 헤더 유지, 키는 이 파일에서만 읽음.
- [x] 2.3 페이지네이션(`limit`/`cursor` → `next_cursor`) + 에러 envelope 파싱(비-2xx 시 `{error:{code,message}}` 추출해 throw). `filterParams`/`scopeBody` 제거.
- [x] 2.4 `query()`/`results()`/내부 엔드포인트 호출 코드 완전 삭제.

## 3. Mock 구현 (lib/scope/mock.ts)

- [x] 3.1 새 `ScopeClient` 계약에 맞춰 mock 재작성 — CRUD 는 인메모리 동작(생성→목록 반영), 결과 읽기는 대표 shape 의 샘플(또는 빈 배열) 반환. `SCOPE_MODE` 미설정 시 기본 동작 유지.

## 4. 소비자 재정렬 (BFF route handlers + 서버 진입점)

- [x] 4.1 `lib/scope/server.ts`: 옛 `fetchResults`/`fetchPromptKpis`/`fetchProjectStatus`/`submitQuery` 를 새 계약 기준 함수로 교체. 세션 인증·감사 유지. 역할→프로젝트 게이팅은 이음새(미구현 주석 + open question 참조)만 남기고 구현은 후속.
- [x] 4.2 `app/api/scope/results/route.ts`·`app/api/scope/query/route.ts`: 옛 계약 의존 제거. 측정 트리거(`query`) route 는 삭제. 결과 읽기 route 는 새 공개 메서드로 재정렬(또는 후속까지 최소 stub).
- [x] 4.3 `app/[locale]/(dash)/dashboard/page.tsx`: `fetchResults(10)` 호출을 새 계약에 맞춰 정정(빌드/타입 통과 수준 최소 변경, 화면 변경 없음).
- [x] 4.4 `lib/scope/index.ts`: 재내보내기/`getScopeClient`/`isMockMode` 가 새 타입과 정합되는지 확인.

## 5. live 검증 환경

- [x] 5.1 `.env.local`: `SCOPE_MODE=live`, `SCOPE_API_BASE=https://scope-api.example.com`, `SCOPE_API_KEY=<안전채널 수신 키>`. `.env*.local` gitignore 재확인, 키 평문 커밋 금지.
- [x] 5.2 `scripts/scope/verify-public-api.ts` 작성: `HttpScopeClient` 직접 사용. 흐름 — health(무인증) → project 생성(2xx) → prompt 생성(2xx) → 결과 읽기 7종(200/빈배열 허용) → usage(200) → project soft-delete(정리). reports 404 는 known-failure 로 분류. 각 단계 PASS/FAIL 출력.
- [x] 5.3 `package.json`: npm script 추가(예: `"verify:scope": "tsx --env-file=.env.local scripts/scope/verify-public-api.ts"`).

## 6. 검증

- [x] 6.1 `npm run verify:scope` 실행 → CRUD 2xx, 읽기 200(빈배열), reports known-404 대조. 결과 기록.
- [x] 6.2 `npm run build`(타입체크 포함) 통과 확인 — 계약 변경의 소비자 연쇄가 모두 해소됐는지.
- [x] 6.3 `npm run lint` + `npm test`(역할/스코프 격리 유닛 테스트) 통과 확인. lib/db 경계 규칙 위반 없음.
- [x] 6.4 `SCOPE_MODE=mock` 으로 환원 시 앱이 그대로 동작하는지 확인(롤백 경로).
