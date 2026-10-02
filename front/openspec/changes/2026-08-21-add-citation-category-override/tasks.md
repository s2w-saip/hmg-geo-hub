## 1. 데이터·분류기 (core)

- [x] 1.1 `lib/db/schema.ts` 에 `citationDomainOverrides` 테이블 + 타입 export
- [x] 1.2 ~~`npm run db:generate`~~ → 손작성 `0043_citation_domain_overrides.sql` (generate 불가: 스냅샷 0002 에서 멈춰 rename 대화형 프롬프트로 죽음 — 0021+ 관행대로 멱등 SQL 손작성)
- [x] 1.3 `lib/db/repositories/citation-overrides.ts` — list/upsert/remove (repository 경계 룰 준수)
- [x] 1.4 `lib/citation-categorizer/index.ts` — `categorizeDomain(domain, overrides?)`, 우선순위 override 최상위
- [x] 1.5 `lib/citation-categorizer/source.ts`(신규) — `classificationSource(domain, overrides?)` → `"override"|"owned"|"seed"|"rule"|"fallback"` (UI 배지용)
- [x] 1.6 `lib/citation-categorizer/overrides-loader.ts` — `loadCitationOverrides()`: unstable_cache + 전용 태그 export
- [x] 1.7 동기 집계 5곳에 `overrides?` 파라미터 추가, async 진입점 3곳에서 로드·주입

## 2. 액션·화면 (ui)

- [x] 2.1 `app/[locale]/(dash)/admin/standards/citation-sources/_actions.ts` — requireAdmin + upsert/remove, 저장 시 두 태그 revalidateTag, `ActionResult` 패턴
- [x] 2.2 목록 데이터 소스 — 쿼리·행 조립을 `lib/citation-categorizer/curation.ts`(순수 공유 정본)로 승격, `citationOverrideRepository.listDomainCuration()` + seed-curation 스크립트가 함께 사용 (스크립트는 tsx 라 `server-only` 리포지터리를 직접 못 씀)
- [x] 2.3 `page.tsx` + `_components/domain-list.tsx` — 검색·카테고리 필터·"Other 만" 토글·인라인 셀렉트·원복·출처 배지·owned 경고
- [x] 2.4 i18n — `messages/{ko,en}.json` 문구 추가, `npm run check:strings` 통과
- [x] 2.5 진입 링크 — `/admin/standards` 는 prompts 로 redirect 하는 페이지라 카드가 들어갈 자리가 없다. 실제 진입점인 SNB(`components/dash/sidebar.tsx` ADMIN_SUB_ITEMS 자식) + `ROUTES` 등재로 대체

## 3. 검증

- [x] 3.1 우선순위 단위 테스트(override > owned > seed > rule > fallback)
- [x] 3.2 파라미터 생략 시 기존 `lib/citation-categorizer/index.test.ts` 전량 그대로 통과
- [x] 3.3 패리티 — live(`aggregateCitationsFromPublic`)·mirror(`foldCitationsLive`) 양 경로에 같은 오버라이드 주입 시 동일 결과
- [x] 3.4 오버라이드 0행일 때 산출물이 현행과 동일(회귀 기준)
- [x] 3.5 비-admin 액션 → `UnauthorizedError`
- [x] 3.6 저장 시 두 태그 revalidateTag 호출
- [x] 3.7 `npm test`(807 pass) · `npm run lint`(Error 0) · `npm run check:strings` · `npm run build` 통과
