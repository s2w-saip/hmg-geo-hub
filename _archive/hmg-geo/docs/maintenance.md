# 유지보수 기준

## 인증·권한

Supabase는 Auth와 DB를 제공합니다. 애플리케이션 데이터 접근은 서버의 Drizzle/SQL 경로이며 권한은 앱 계층에서 강제합니다.
조회·서버 액션을 추가할 때 `lib/auth/session.ts`, `scope-policy.ts`, `route-policy.ts`와 `lib/db/scoped.ts`의 권한 경계를 유지합니다.
브랜드·권역·국가 범위와 프로젝트 membership을 함께 확인합니다. vendor는 active membership 기준입니다.
일반 계정은 명시적 전체 범위 또는 담당 범위가 필요하며 완전 미배정 상태를 전체 접근으로 처리하지 않습니다.
service key·Scope API key를 브라우저에 노출하지 않습니다. Raw Data QA는 별도 전역 접근 콘솔이므로 기본 비활성 상태를 유지하고, 사용할 때 명시적 비밀번호와 서명 키를 함께 설정합니다.

## DB 변경

`lib/db/schema.ts`와 `lib/db/migrations/`가 개발 기준입니다. 실제 운영 적용 여부는 DB와 대조해야 합니다.
`db:migrate`는 과거 SQL 재실행을 막기 위해 차단되어 있습니다. 일반 Drizzle migrate로 대체하지 않습니다.

1. `schema.ts` 수정 후 `npm run db:generate`로 초안을 생성합니다.
2. SQL의 데이터 영향·멱등성·대상 환경을 검토합니다.
3. 인수측 테스트 DB에서 `npm run db:apply -- <파일번호 또는 전체파일명>`으로 필요한 파일만 적용합니다.
4. `npm run db:drift`, `npm run db:verify -- --application-only`와 관련 테스트로 확인한 뒤 운영 변경 절차를 진행합니다.

동일 번호 파일이 있으면 전체 파일명을 지정합니다. migration에는 direct/session 연결을 사용합니다.
`db:apply`는 `.env.local`의 `DATABASE_URL`에 즉시 쓰며 dry-run이나 확인 단계가 없습니다. `--dry-run`을 붙여도 무시됩니다. README의 운영 연결 설정을 그대로 쓰지 말고, 적용 전 `.env.local`을 별도 테스트 DB로 전환한 뒤 `npm run setup:doctor -- --connect`로 연결 설정을 검증합니다.
기존 운영 DB에 bootstrap·reset·demo seed를 실행하지 않습니다.

## 측정값·집계 변경

| 항목 | 유지할 규칙·코드 |
| --- | --- |
| 분모·필터 | 프로젝트/웹사이트/글로벌 화면은 집계 범위가 다릅니다. 기간·회차·엔진·브랜드·국가·언어와 계산 단위를 함께 대조합니다. `lib/db/repositories/scope-aggregates.ts`, `summary-*-aggregates.ts` 및 인접 테스트가 구현 기준입니다. |
| 인용 귀속 | 질문을 수집한 국가와 인용 URL의 소유 사이트는 다른 축입니다. 도메인만으로 국가/언어 경로를 합치지 않습니다. 웹사이트는 prompt의 `owned_base_url`과 summary의 자사 인용 매핑을 유지합니다. |
| URL 정규화 | `lib/scope/url-match.ts`와 SQL의 정규화 규칙을 맞춥니다. 프로젝트 domain의 경로는 집계에 사용하고, Scope 동기화에는 호스트를 파생합니다. 타겟 URL 매칭의 query string 보존 규칙을 변경하지 않습니다. |
| 회차 앵커 | `measured_at`은 회차 앵커를 반영할 수 있습니다. `scope_answer_anchors`와 `scope_answer_drops`를 재싱크 때 다시 적용하는 구조를 유지합니다. 미러 행만 직접 수정하면 재싱크 시 되돌아갑니다. |
| 미러·summary | `lib/db/repositories/scope-mirror.ts`와 summary의 활성 generation·publish 규칙을 함께 확인합니다. 부분 적재 또는 빈 세부층을 정상 집계로 공개하지 않습니다. |
| 출처 분류 | `lib/citation-categorizer/`와 `lib/public-suffix/`의 공통 함수·사전을 사용합니다. 공식 소셜 계정 그룹 키와 SQL/JS 결과의 일치를 유지합니다. |

수치 변경은 동일한 프로젝트·기간·필터로 분자·분모를 비교하고, SQL/JS 및 미러/summary 경로의 회귀 테스트를 함께 확인합니다.
웹사이트 타겟 URL 인용률의 분모는 전체 답변이 아닌 자사 URL을 인용한 답변 수입니다. 분모가 0인 상태와 측정 결과 0%를 구분합니다.
닫힌 회차의 run 모수, 활성 generation, 주 단위 파티션을 유지합니다. `summary_settings`의 읽기 스위치와 `lib/summary/read/`의 화면별 gate를 바꾸면 데이터 창과 표시 수치도 바뀔 수 있으므로 관련 집계를 함께 검증합니다.
카탈로그의 지리 권역과 권한의 영업권역 코드는 다릅니다. 국가/권역 목록을 화면별로 복제하지 않습니다.

## 운영 확인 지점

- `vercel.json`: sync-mirror·GA4 cron. 일반 Node 실행에는 스케줄러가 포함되지 않습니다.
- `ops/summary-runner/`: summary 생성·mirror consumer. 웹 배포와 별도 프로세스입니다.
- `CRON_SECRET`, `HMG_INTERNAL_BASE_URL`: 배치 후 캐시 갱신·내부 인증.
- 로그인 장애: Auth 사용자와 `profiles.id`, 연결 프로젝트, 담당 범위를 먼저 확인합니다.
- 수치 불일치: Scope 매핑 → 미러 적재 → 앵커/드롭 → 활성 summary generation → 캐시 순으로 확인합니다.
