## Why

scaffold change는 동작하는 인증 골격을 깔되, 신원 저장소를 placeholder(`lib/auth/users.ts`의
데모 사용자 + 쿠키에 user id만 담는 세션)로 두었다. 이제 이를 실물로 교체할 차례다. 동시에
hmg-geo의 자체 데이터(유저·역할·범위)를 담을 영속성 계층이 필요한데, 두 가지 제약을 토대에
박아야 한다: (1) 이 프로젝트는 추후 **HMG 전용 설치형(on-prem)** 으로 이전될 예정이므로,
DB·인증이 특정 벤더에 강결합되면 안 된다 — 특히 **RLS는 쓰지 않는다**(DB 종속 + 운영 복잡성).
(2) RLS를 안 쓰는 대신 보안은 **앱 레이어(BFF)** 가 책임지며, 이는 우리가 scope 호출에 이미 적용한
서버단 강제와 동일한 철학이다.

## What Changes

- Supabase를 **매니지드 Postgres + Auth 제공자**로 도입한다(BaaS로 쓰지 않음). 브라우저는 Supabase를
  직접 호출하지 않으며, 모든 DB 접근은 Next 서버를 경유한다.
- **Drizzle**을 DB 접근 도구로 추가한다 — Postgres 연결 문자열로 직결(supabase-js 데이터 쿼리 미사용),
  스키마는 코드+마이그레이션으로 관리, repository 인터페이스 뒤에 둔다.
- **Supabase Auth**(`@supabase/ssr`)로 실제 로그인/세션을 구현하고, 인터페이스 뒤에 격리해
  scaffold의 placeholder 인증(DEV_USERS·쿠키 id)을 **대체**한다. **BREAKING**: 데모 로그인 제거.
- `profiles` 테이블을 추가해 유저 → 역할(HQ/권역/국가/관리자) + 허용 범위(브랜드/권역/국가)를 매핑한다.
  역할/범위는 사용자가 수정 불가한 곳(profiles, 서버 read)에 둔다.
- **RLS 없는 앱-레이어 DB 보안 틀**을 세운다: 단일 repository choke point, 모든 scoped 쿼리에
  AuthContext 강제, 역할 기반 범위 필터 서버 주입, default-deny, anon/PostgREST 노출 차단,
  최소권한 DB 접속, 보상통제(역할별 테스트·"repo 밖 DB import 금지" lint·감사 로그).
- 전부 인터페이스 뒤에 둬서 추후 설치형 이전 시 DB/인증 구현만 교체하면 되도록 한다.

## Capabilities

### New Capabilities
- `persistence-foundation`: Supabase Postgres 연결 + Drizzle(스키마=코드, 마이그레이션) + repository
  인터페이스 + `profiles` 테이블. hmg-geo 자체 데이터의 영속성 토대.
- `data-access-security`: RLS를 쓰지 않고 앱 레이어에서 데이터 인가를 강제하는 보안 틀(연결 위상,
  choke point, AuthContext, default-deny, 최소권한, 보상통제).

### Modified Capabilities
- `access-control`: 인증 메커니즘을 자체 placeholder → Supabase Auth로, 역할/범위 출처를
  데모 테이블 → `profiles`(사용자 수정 불가)로 변경.

## Impact

- 신규 의존성: `drizzle-orm`, `drizzle-kit`, Postgres 드라이버(`postgres`), `@supabase/supabase-js`,
  `@supabase/ssr`.
- 신규 파일: `lib/db/**`(Drizzle 스키마/연결/repository), `lib/auth/**` 재작성(Supabase 세션),
  `drizzle.config.ts`, 마이그레이션, `profiles` 스키마.
- 교체/제거: `lib/auth/users.ts`(DEV_USERS), 쿠키 id 세션, 커스텀 login action → Supabase 기반.
  `lib/auth/scope-policy.ts`, `lib/scope/server.ts`(서버 강제 레이어)는 **유지**, 신원 출처만 교체.
- 신규 env: `DATABASE_URL`(서버 전용, 풀러), `SUPABASE_URL`, `SUPABASE_ANON_KEY`(서버 전용 사용),
  `SUPABASE_SERVICE_ROLE_KEY`(서버 전용).
- 신규 PR 차단 컨벤션: repository 레이어 밖에서 DB 클라이언트 import 금지.
- scope 연동은 변경 없음 — `ScopeClient`는 mock 유지(query/results만 실제), 분석 집계 메서드는
  계약 확정 전까지 mock.
