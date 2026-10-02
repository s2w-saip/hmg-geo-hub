## Context

hmg-geo는 scaffold change에서 동작하는 인증 골격을 깔되 신원 저장소를 placeholder로 두었다. 이제
실물 영속성+인증으로 교체한다. 두 제약이 설계를 좌우한다: (1) 추후 HMG 전용 **설치형(on-prem)**
이전 — 따라서 벤더 강결합 회피, 특히 **RLS 미사용**(DB 종속 + 운영 복잡성). (2) RLS를 안 쓰는 대신
보안은 **앱 레이어(BFF)** 가 강제 — 이는 scope 호출에 이미 적용한 서버단 강제(`lib/scope/server.ts`)와
동일 철학이라, hmg-geo 자체 데이터와 scope 데이터가 같은 보안 모델로 통일된다. Supabase는 BaaS가
아니라 **매니지드 Postgres + Auth 제공자**로만 쓴다. 설치형 미래에 대비해 DB·인증을 모두 인터페이스
뒤에 둔다.

## Goals / Non-Goals

**Goals:**
- scaffold의 placeholder 인증을 Supabase Auth 실물로 교체.
- Drizzle로 Postgres 직결 + 코드 기반 스키마/마이그레이션 + repository 인터페이스.
- `profiles`로 유저→역할→허용범위 매핑(사용자 수정 불가).
- RLS 없는 앱-레이어 DB 보안 틀 확립(choke point/AuthContext/default-deny/최소권한/보상통제).
- 모든 것을 인터페이스 뒤에 둬 설치형 이전 시 구현만 교체.

**Non-Goals:**
- 도메인 테이블(projects, 표준프롬프트, jobId 상관, 사용량) — 후속 change.
- scope 분석 읽기 API 연동 — 응답 계약 미정이라 별도 change(ScopeClient 집계는 mock 유지).
- VoC / 구글 키워드 — phase 2.
- 설치형 이전 자체 — 인터페이스로 준비만, 실제 이전은 미래.
- 도메인 데이터의 분석/집계 미러링 — scope 소유, 재구현 금지.

## Decisions

- **Supabase = 매니지드 Postgres + Auth, BaaS 아님.** 브라우저는 Supabase 직접 호출 안 함. 데이터는
  Drizzle로 Postgres 직결, 인증은 Supabase Auth. 대안(클라→Supabase+RLS)은 설치형 이전성과 BFF
  보안 모델에 어긋나 기각.
- **RLS 미사용, 앱 레이어 인가.** RLS는 Postgres/Supabase 종속이고 설치형(엔진이 바뀔 수도) 이전을
  막으며 운영이 복잡하다. 대신 단일 repository choke point가 AuthContext를 강제. RLS의 "자동 안전망"
  상실은 보상통제(역할별 테스트·최소권한 계정·경계 lint·감사)로 메운다.
- **Drizzle (vs Prisma/Kysely).** 설치형 이전(특히 엔진 변경 가능성) 전제에서 가볍고 SQL에 가까우며
  바이너리 엔진/벤더 결합이 없어 선택. Prisma는 무겁고 자기 추상화/엔진 부담, Kysely는 더 유연하나
  수작업이 많아 현 단계엔 과함. 단 진짜 이전성 보험은 도구가 아니라 repository 인터페이스다.
- **Supabase Auth를 인터페이스 뒤로 격리.** auth.users는 Supabase가 관리, `profiles`가 그 id를 참조해
  역할/범위 보유. 역할은 user_metadata(클라 수정 가능)에 두지 않고 profiles(서버 read)에 둔다.
  설치형에선 인증 구현만 HMG SSO로 교체.
- **신원 출처만 교체, 강제 레이어는 유지.** `scope-policy`(역할→범위)와 `scope/server`(서버 강제)는
  그대로 두고, 세션/역할 출처를 DEV_USERS → Supabase+profiles로 바꾼다. 같은 `deriveScopeFilter`가
  scope 호출과 자체 DB 쿼리 양쪽의 범위 필터 단일 출처가 된다.
- **연결 문자열은 풀러(pooled)** 를 서버리스 친화적으로 사용, 서버 전용 env로 보관.

## Risks / Trade-offs

- **RLS 안전망 상실 → 코드 한 곳이라도 필터 누락 시 유출** → choke point + AuthContext 타입 강제 +
  default-deny로 구조적 차단, 역할별 격리 테스트를 CI에 포함해 회귀 방지.
- **Supabase "RLS off" 기본 위험(PostgREST+anon 노출)** → anon/authenticated 테이블 권한 차단 +
  클라에 anon 키 미탑재(이중 차단).
- **신원 출처 교체가 인증·미들웨어·세션 경로를 광범위하게 건드림** → 세션을 인터페이스로 감싸고
  scaffold의 가드/미들웨어 구조를 보존, 점진 교체.
- **Drizzle가 가정한 Postgres와 설치형 엔진이 다를 수 있음(Oracle/Tibero 가능성)** → repository
  인터페이스가 흡수, 최악의 경우 그 한 겹만 재작성.
- **service role 키 오·노출** → 서버 전용, 앱 상시 동작은 최소권한 계정 사용, 키 로테이션 계획.

## Migration Plan

- env 추가(DATABASE_URL/SUPABASE_URL/ANON/SERVICE_ROLE) 및 Supabase에서 anon 테이블 권한 차단.
- Drizzle + `profiles` 마이그레이션 적용, 초기 사용자/역할 시드.
- 인증을 Supabase 세션으로 교체하고 DEV_USERS·쿠키 id 세션·커스텀 login action 제거(BREAKING:
  데모 로그인 사라짐).
- 롤백: env를 mock 모드로 되돌리면 scope 연동은 영향 없음. 인증 교체는 커밋 단위로 되돌릴 수 있게 분리.

## Open Questions

- `profiles`의 역할/범위 시드·관리 UI는 이번 범위 밖(관리자 콘솔 후속)에서 어떻게 채우나?
- 설치형 시 인증 대상(HMG SSO/LDAP 종류)과 마이그레이션 경로 — 추후 확정.
- 최소권한 DB 계정을 처음부터 둘지, service_role로 시작 후 좁힐지(초기 속도 trade-off).
