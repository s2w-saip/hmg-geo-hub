# hmg-geo

HMG 전용 **GEO(Generative Engine Optimization) 모니터링 프론트엔드**.

현대자동차그룹(현대 / 기아 / 제네시스, GTM 파트너 이노션)이 생성형 엔진(ChatGPT, Gemini 등)
상에서의 노출·인용을 모니터링하는 대시보드다.

## 정체성: thin client + BFF

이 레포는 독립 제품이 **아니다**. 모회사 측정 엔진 **scope**(Answer의 GEO 측정 엔진)의 API 위에
얹는 **얇은 클라이언트(thin client)** 이며, 측정 로직은 직접 만들지 않는다. scope가 측정 결과를
만들고, hmg-geo는 그것을 HMG가 보는 화면 + 권한 레이어를 제공한다.

```
scope (측정 엔진, workspace key로 HMG 전체 데이터 노출)
  └─ hmg-geo (이 레포: 자체 로그인/역할 + BFF + 시각화)
       └─ HMG 사용자 (HQ / 권역 / 국가 / 관리자)
```

## 보안 규칙 (BFF) — 가장 중요

scope workspace key 1개는 **HMG 전체 데이터**를 연다. 따라서 hmg-geo는 반드시 BFF로 동작한다:

1. **scope 접근은 서버단에서만.** 모든 scope 호출은 `lib/scope/server.ts`의 강제 레이어를 거친다
   (route handler `app/api/scope/*` 와 서버 컴포넌트가 공유). 클라이언트 컴포넌트에서 scope를
   직접 호출하는 것은 **PR 차단 대상**이다.
2. **workspace key는 서버 전용.** `SCOPE_API_KEY`는 `lib/scope/http.ts`에서만 읽으며 브라우저에
   절대 노출하지 않는다 (`NEXT_PUBLIC_` 금지).
3. **범위 필터는 서버가 강제.** 사용자의 역할 → 허용 범위 매핑은 `lib/auth/scope-policy.ts`
   한 곳에서만 도출하며, 클라가 보낸 location 파라미터는 무시한다. 국가 담당자가 파라미터를 바꿔
   전체 데이터를 보는 것을 차단하기 위함이다.
4. **사용자별 감사.** 단일 key로는 scope에서 호출자를 구분할 수 없으므로, `lib/audit.ts`가
   hmg-geo 서버단에서 "누가" 호출했는지 append-only `bff_audit_logs` 테이블에 기록한다(콘솔
   placeholder 제거). 쓰기는 fire-and-forget(`after()`로 응답 후 dispatch, 실패 시 `console.error`
   폴백) — 요청 지연·실패를 유발하지 않는다.

## 스택

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind 4 · next-intl(ko/en) ·
그래프 viz cytoscape + cytoscape-fcose · 차트 viz d3 + d3-sankey · 아이콘 lucide-react.

스택을 scope와 맞춘 이유는 scope의 ontology 시각화 자산을 공유/재사용하기 위함이다 (아래 참고).

## 디렉터리

```
app/
  [locale]/            # next-intl 로케일 라우팅 (/ko, /en)
    (dash)/            # 인증 뒤: dashboard / projects / standard / customer-interest / admin / no-access
    login/             # 로그인 (Supabase Auth)
  api/scope/           # BFF route handlers (scope 호출 경유지)
lib/
  scope/               # ScopeClient 계약 + mock/http + 서버 강제 레이어
  auth/                # 세션(Supabase) + 역할 + 역할→범위 매핑(scope-policy)
  db/                  # Drizzle 연결 + schema + repositories + scoped 강제 헬퍼
  viz/                 # scope ontology viz 자산 (복사 예정, 아래 참고)
utils/supabase/        # @supabase/ssr 서버 클라이언트 (인증 전용)
messages/              # ko.json / en.json — UI 문자열 = 용어 사전
components/            # 표현 컴포넌트
scripts/db/            # lockdown.sql(anon 권한 차단) + seed.ts(초기 사용자)
```

## 데이터 & 인증 (Supabase + Drizzle)

hmg-geo는 **Supabase를 매니지드 Postgres + Auth 제공자**로 쓴다(BaaS가 아니라). 측정/분석 데이터는
scope 소유이고 API로 받아오며, hmg-geo가 자체 보관하는 건 유저·역할·범위(`profiles`) 등 자기 도메인뿐이다.

- **인증**: Supabase Auth(`@supabase/ssr`). 신원은 Supabase가, 역할/허용범위는 `profiles` 테이블
  (서버 통제, `user_metadata` 아님)이 갖는다.
- **데이터**: Drizzle로 Postgres에 **직결**(연결 문자열). supabase-js 데이터 쿼리는 쓰지 않는다 →
  Supabase에 묶이지 않아 추후 **설치형(on-prem) 이전** 시 연결 문자열만 바꾸면 된다.
- **스키마는 코드**: `lib/db/schema.ts` → `npm run db:generate`로 마이그레이션 초안 생성,
  `npm run db:apply -- NNNN`으로 적용, `npm run db:drift`로 DB 와의 어긋남을 실측 확인.

## DB 보안 (RLS 없음)

RLS는 **의도적으로 쓰지 않는다**(DB 종속 + 운영 복잡성). 대신 보안은 **앱 레이어(Next 서버)** 가 강제한다:

- 브라우저는 DB에 직접 접근하지 않는다. 연결 문자열·service 키는 서버 전용. 인증용 anon 키는
  공개되더라도 데이터에 못 닿게 **테이블 권한을 차단**한다(`scripts/db/lockdown.sql`).
- 모든 데이터 접근은 `lib/db` repository 한 곳을 통과한다. repository 밖에서 DB 클라이언트 import는
  **lint로 차단**(PR 차단).
- scoped 쿼리는 역할에서 도출한 범위를 서버가 주입(`lib/db/scoped.ts`), 컨텍스트 없으면 default-deny.
- RLS 안전망 상실분은 보상통제로 — 역할별 범위 격리 테스트(`npm test`), 감사 로그, (권장) 최소권한 DB 계정.

## 실행

scope는 mock 기본(`SCOPE_MODE=mock`)이라 scope key는 필요 없지만, 인증/DB는 **Supabase 프로젝트가
필요**하다. `.env.local`에 `DATABASE_URL`(풀러), `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`를 채운다(`.env.example` 참고).

```bash
npm install

# 스키마 구축 — 이 순서를 지킬 것 (drizzle-kit migrate 는 쓰지 않는다, 아래 주의 참고)
psql "$DATABASE_URL" -f scripts/db/scope-mirror.sql  # scope_* 미러 5개 테이블 (저널 밖 DDL)
for n in 0000 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 \
         0015 0016 0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 \
         0029 0030 0031 0032 0033 0034 0035 0036 0037 0038 0039 0040 0041 0042 \
         0043_scope_sync_cursors 0043_citation_domain_overrides 0044; do
  npm run db:apply -- "$n"
done
npm run db:drift                                     # schema.ts ↔ DB 일치 확인 (읽기 전용)

psql "$DATABASE_URL" -f scripts/db/lockdown.sql     # anon/PostgREST 데이터 접근 차단
npx tsx --env-file=.env.local scripts/db/seed.ts    # 초기 사용자/역할 시드(데모)
npm run dev                                          # http://127.0.0.1:3333 → /ko/dashboard
```

> ⚠️ **`npm run db:migrate`(drizzle-kit migrate)는 차단돼 있다.** 이 리포는 0021 부터
> 마이그레이션을 저널 밖에서 손으로 적용해 왔고, `scope_*` 미러 테이블과 일부 컬럼은
> 마이그레이션 파일이 아닌 별도 DDL 로 들어갔다. drizzle 의 원장(`drizzle.__drizzle_migrations`)은
> 그 사실을 모르기 때문에, `migrate` 를 돌리면 **이미 적용된 마이그레이션을 재실행한다.**
> 적용은 `npm run db:apply -- NNNN` 으로만 한다 — 상세는 [docs/development-guide.md](docs/development-guide.md) "DB 마이그레이션 절차".
> 위 신규 구축 순서는 **아직 실환경에서 완주 검증되지 않았다**(2026-08-21 기준).

scope key가 발급되면 `.env.local`에 `SCOPE_MODE=live`, `SCOPE_API_KEY`, `SCOPE_API_BASE`만 추가하면
된다 — 코드 변경 없음.

```bash
npm run build           # 프로덕션 빌드 (타입 체크 포함)
npm run lint            # ESLint (repository 경계 규칙 포함)
npm test                # vitest (역할별 범위 격리)
npm run check:strings   # JSX 내 한글 하드코딩 휴리스틱 검사 (i18n 가드)
```

## 다국어 / 용어

- 모든 UI 문자열은 `messages/ko.json` / `messages/en.json`에서만 온다. **JSX 하드코딩 금지**
  (`npm run check:strings`로 점검). 언어 추가 = 사전 파일 + `i18n/routing.ts`의 locales 항목 추가.
- UI 용어 결정(aeorank 어휘 vs scope narrative 어휘)은 미정이며, 사전 값 편집만으로 전환된다.

## 시각 정체성 (BI)

HMG 코퍼릿 BI를 따른다. 시각 토큰은 **한 곳**(`app/globals.css`의 `@theme` 블록)에서만 정의되며,
모든 UI는 토큰을 참조한다 — 컴포넌트에 hex 리터럴 하드코딩 금지(`grep -rnE "#[0-9A-Fa-f]{6}" app components`로 점검).

- **컬러**: `--color-brand-700` = `#002c5f` (Hyundai Blue). Sand 톤 그레이(`--color-ink-*`)와
  Hyundai Light Sand 배경(`--color-bg-soft`), 액센트(Gold / Active Blue / Active Red / Sky Blue)가
  같은 블록에 정의. 정확한 값이 갱신되면 토큰 5줄만 교체.
- **폰트**: 1순위 Hyundai Sans (Head / Text 두 family), 2순위 Pretendard, 그 뒤 Apple SD Gothic Neo /
  Noto Sans KR / 시스템. `@font-face`는 `globals.css` 안에 있고 `font-display: swap`.
- **자산 정책**:
  - `public/fonts/HyundaiSans*` — gitignored (코퍼릿 라이선스, 공개 레포에 커밋 금지).
  - `public/fonts/PretendardVariable.woff2` — OFL, 커밋됨.
  - `public/brand/hmg-logo.svg` / `hyundai-logo.svg` — 코퍼릿 마크, 커밋됨.
- **자산 교체 절차**: 정확 hex 갱신 → `globals.css` 토큰 값 수정. 새 폰트/로고 → 같은 경로에 파일 교체.
  컴포넌트 코드 변경 없음.

## ontology viz 추출 계획

`lib/viz`는 scope의 ontology 시각화 자산(엔티티/관계 색·모양 encoding registry + 6개 뷰)을
단기적으로 **복사**해 쓰는 자리다. 목표 종착지는 이를 공유 패키지 **`@answer/ontology-viz`** 로
추출해 scope와 hmg-geo가 함께 소비하는 것. (현재 자산은 scope 레포 접근이 필요해 미복사 —
`lib/viz/README.md` 참고.)

## 열린 질문 (셋업 시점 미해결)

- **화면 ↔ scope API 매핑**: v1 화면 중 무엇이 기존 `/v1/results`로 되고, 무엇이 신규 집계
  엔드포인트(인용 채널 영향력, 프로젝트 현황)를 필요로 하는가? — scope 팀과 합의 필요.
  (현재 `lib/scope/client.ts`의 집계 메서드는 mock 계약 초안 상태.)
- **국가 담당 역할의 정확한 허용 범위** (기획 문서 공백 — `lib/auth/scope-policy.ts`에서 수정).
- **UI 용어**: aeorank vs scope 어휘 (사전으로 보류).
- **구글 키워드 / 커뮤니티 VoC 데이터 출처** (미정 — 해당 화면은 빈 상태 껍데기).
- **설치형(on-prem) 인증·DB**: Supabase Auth → HMG SSO/LDAP 교체 경로, 대상 DB 엔진(Postgres
  유지 vs Oracle/Tibero) 확정. 현재는 인터페이스 뒤에 격리해 준비만.
- **최소권한 DB 계정**: 처음부터 둘지 service_role로 시작 후 좁힐지.

> v1 범위: 경쟁사 cross-insight(share-of-voice)는 **제외**.
> 인증 백엔드는 **Supabase Auth + `profiles`로 확정**(데모 placeholder 제거됨).

## OpenSpec

이 레포는 [OpenSpec](https://github.com/Fission-AI/OpenSpec)으로 spec-driven 개발을 한다.
초기 셋업은 `openspec/changes/setup-frontend-scaffold/`에 기록되어 있다.

