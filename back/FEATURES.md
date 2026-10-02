# 기능 분류 체계(대분류 → 도메인 → 최소 기능)

기능 72개 · 엔드포인트 187개. 정본 `taxonomy.json`.

## 분석 조회 `analytics`
- **필터** `filters`: 필터 옵션 `options`(1) · 선택 가능 날짜·기준일 `dates`(1)
- **KPI** `kpi`: 요약 카드 `summary`(1) · 기간 비교 Δ `compare`(1) · 엔진별 서브 지표 `engines`(1)
- **추이** `trend`: 지표 추이 `series`(1)
- **언급** `mentions`: 브랜드·경쟁사 비교 `brands`(1) · 언급 유형·태도 `types`(1) · 프롬프트별 언급 `prompts`(1)
- **인용** `citations`: 인용 도메인 순위 `domains`(1) · 도메인 드릴다운 `domain_detail`(1) · 출처 카테고리 `sources`(2) · 답변 톤별 인용 `tone`(1) · 프롬프트별 인용 `prompts`(1) · 타겟·자사 URL 인용률 `targets`(1)
- **국가별** `geo`: 국가별 현황 `markets`(1)
- **답변 드릴다운** `answers`: 답변 목록 `list`(1) · 답변 상세 `detail`(1)
- **AI 퍼널** `funnel`: AI 선택률(ACR) `acr`(1) · AI 유입·전환(GA4) `conversion`(1)

## 프롬프트 카탈로그 `catalog`
- **프롬프트** `prompts`: 카탈로그·측정 메타 `catalog`(3) · 변경 이력 `history`(1)

## 프로젝트 `projects`
- **프로젝트** `project`: 프로젝트 CRUD `core`(5)
- **멤버** `members`: 멤버 목록·역할 `roster`(4) · 초대 수락·거절 `invites`(3) · 멤버 감사 `audit`(1)
- **프로젝트 프롬프트** `prompts`: 후보 풀 `candidates`(4) · 프롬프트 CRUD `crud`(4) · 일시정지·재개·삭제 영향 `lifecycle`(4) · 측정 실행 `execute`(1) · 가져오기·내보내기 `io`(2) · 커스텀 필드 `fields`(8)
- **프로젝트 설정** `settings`: 설정 묶음 `overview`(1) · AI 엔진 `engines`(2) · 소유 베이스 URL `owned_bases`(2) · 추적 URL `tracked_urls`(5) · 추적 대상(별칭·경쟁사·차종) `tracked_targets`(6) · Scope 연결 진단 `scope_link`(1)

## 고객 관심 `intent`
- **키워드** `keywords`: 추적 키워드 `tracked`(3) · 인사이트·연관어·조회·표준 키워드 목록 `research`(4) · 수집 요청(비동기) `fetches`(2) · SERP 프롬프트 초안 `serp_drafts`(1)
- **후보 풀** `candidates`: 후보 등록(공용) `submit`(1)
- **소셜·컨텍스트 맵** `social`: 컨텍스트 맵 조회·내보내기 `context_map`(6) · 생성 프롬프트 `prompts`(3)

## 운영 관리 `admin`
- **표준 카탈로그** `catalog`: 표준 프롬프트 CRUD `prompts`(9) · 일괄 편집·가져오기·내보내기 `bulk`(4) · 택소노미·시장 `reference`(2)
- **고객 관심 원천** `interest`: 표준 키워드 `keywords`(4) · 표준 출처 `sources`(4)
- **엔티티** `entities`: 엔티티 레지스트리 `registry`(2)
- **인용 출처** `citation_sources`: 도메인 카테고리 오버라이드 `overrides`(5)
- **회차 운영** `cycles`: 회차 숨김·마감·노출일 `cycles`(6) · 측정 앵커 고정·드롭 `jobs`(3)
- **계정·권한** `accounts`: 계정 CRUD·감사 `users`(6)
- **외부 연동** `integrations`: GA4 속성·대기 시장 `ga4`(10) · 키워드 도구 `keyword_tools`(3)
- **변경 요청 큐** `changes`: 재판정·운영 요청 조회 `queue`(2)

## 검수 콘솔 `qa`
- **검수 대상** `answers`: 목록·진행률·이웃·필터 `list`(4) · 검수 상세 `detail`(1)
- **판정** `review`: 판정 저장 `verdict`(2) · 답변 락 `lock`(3) · 검수 세션 `sessions`(3) · 변경 알림 `deltas`(1)
- **노트** `notes`: 노트 작성·조회·내보내기 `notes`(7)

## 플랫폼 `platform`
- **인증** `auth`: 세션·스코프 `session`(1)

## 적재 파이프라인(워커) `ingest`
- **Scope pull·쓰기 스키마** `pull`: 20분 pull·CLI `sync`(2) · 적재 운영 조회 `ops`(3)
- **판정·읽기 투영** `project`: 판정·투영·재판정 `apply`(1)
- **회차·큐·아웃박스** `cycles`: 회차 귀속·재평가 `ledger`(1) · cycles_tick·queue·outbox·dfs_fetch `workers`(1) · 감시 태스크 `watch`(1)

## 제외

- AD-5 POST /v1/admin/users/{user_id}/reset-password: Q16: 비밀번호 재발급 미도입
- CM-1 (흡수) /v1/context-map/* → /v1/intent/social/context-map/*: intent.social.context_map 으로 흡수
- WG-1 (없음) (엔드포인트 없음): Q14: 소비자 0, S3 보관 후 제외
