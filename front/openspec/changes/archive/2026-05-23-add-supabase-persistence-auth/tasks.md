## 1. 의존성 & 환경

- [x] 1.1 의존성 추가: drizzle-orm, drizzle-kit, postgres(드라이버), @supabase/supabase-js, @supabase/ssr
- [x] 1.2 .env.example 갱신: DATABASE_URL(풀러, 서버전용), SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
- [x] 1.3 Supabase에서 anon/authenticated 테이블 권한 차단 — scripts/db/lockdown.sql 작성 + README 문서화
        ↳ 실제 적용(psql 실행)은 creds 필요 (아래 5.2와 함께)

## 2. Drizzle & 영속성 토대

- [x] 2.1 drizzle.config.ts + lib/db/index(서버 전용 Postgres 직결, lazy, 풀러) 구성
- [x] 2.2 lib/db/schema에 profiles 테이블 정의(유저 id, role, 허용범위: 브랜드/권역/국가)
- [x] 2.3 첫 마이그레이션 생성·적용 + 초기 사용자/역할 시드 — drizzle-kit migrate ✓, 시드 4명 ✓
- [x] 2.4 repository 인터페이스 정의 + Drizzle 구현(profiles 조회), 호출측은 인터페이스만 의존

## 3. RLS 없는 데이터 보안 틀

- [x] 3.1 AuthContext(=인증 User: 역할·허용범위) + 세션→컨텍스트 도출(lib/auth/session, 서버)
- [x] 3.2 repository를 choke point로: scoped 접근은 scopeWhere 경유, unscoped 우회 메서드 미제공
- [x] 3.3 default-deny + 역할 기반 범위 필터 서버 주입(lib/db/scoped + scope-policy 재사용)
- [x] 3.4 "repository 밖 DB 클라이언트 import 금지" lint 규칙(eslint no-restricted-imports)
- [x] 3.5 데이터 접근 감사 로깅(lib/audit auditDataAccess)
- [x] 3.6 최소권한 DB 계정 — 후속 과제로 문서화(README 열린 질문)

## 4. Supabase Auth로 인증 교체

- [x] 4.1 utils/supabase/server(@supabase/ssr) + middleware 세션 갱신 구성
- [x] 4.2 lib/auth/session을 Supabase 세션 + profiles 조회로 재작성(신원 출처 교체)
- [x] 4.3 로그인/로그아웃을 Supabase Auth로 교체(커스텀 login action·쿠키 id 세션 제거)
- [x] 4.4 lib/auth/users.ts(DEV_USERS)·constants 제거, scope-policy/scope-server는 유지
- [x] 4.5 미들웨어를 Supabase 세션 갱신 + i18n 라우팅 + 인증 게이트로 합성

## 5. 검증

- [x] 5.1 역할별 범위 격리 테스트(isInScope) 추가 — vitest 4 pass
- [x] 5.2 미인증 차단·로그인·역할 매핑 런타임 확인 — 종단 검증 5/5 통과
        ↳ 게이트 redirect/401, country→KR만, ?country=US 강제 시 무시, hq→전체, admin 게이팅
- [x] 5.3 클라이언트 번들에 DB 자격/anon 데이터 수단 미포함 확인(.next/static grep)

## 6. 문서화

- [x] 6.1 README: Supabase=인증+Postgres, Drizzle=데이터, RLS 미사용·앱레이어 강제, 설치형 이전 대비
- [x] 6.2 열린 질문 기록(profiles 관리 UI, 설치형 SSO/DB, 최소권한 계정)
