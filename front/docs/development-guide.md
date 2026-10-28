# 개발 가이드

이 레포에서 개발할 때 지켜야 할 명령·절차·보안 경계를 정리한 문서다. 제품 맥락은 [README](../README.md)가 정본이다.

## What this repo is

`hmg-geo` is a **thin client + BFF** for HMG (Hyundai/Kia/Genesis, GTM partner 이노션) on top of Answer's GEO measurement engine **scope**. "geo" = Generative Engine Optimization, **not** geographic data. Measurement logic lives in scope — this repo only adds auth, role-scoped views, BFF, and visualization. 

## Commands

```bash
npm run dev            # next dev → http://127.0.0.1:3333 (/ko/dashboard)
npm run build          # production build (includes type check)
npm run lint           # ESLint — enforces repository-boundary rule for lib/db
npm test               # vitest run — role/scope isolation tests
npm run check:strings  # heuristic guard against hardcoded Korean in JSX (i18n)
npm run db:generate    # drizzle-kit generate (from lib/db/schema.ts) — SQL 초안 + 스냅샷 갱신
npm run db:apply -- NNNN  # 마이그레이션 적용 (유일한 적용 경로)
npm run db:drift       # schema.ts ↔ 대상 DB 대조 (읽기 전용, DATABASE_URL 필요)
npm run db:drift-sql   # 같은 대조를 SQL 로 출력 (DB 접속 불필요 — SQL Editor 에 붙여넣기)
npm run db:check       # drizzle 메타(저널·스냅샷) 정합 검사
```

⚠️ `npm run db:migrate` 는 **차단돼 있다** — 아래 참조.

Single test: `npx vitest run path/to/file.test.ts` (or `-t "name"` to filter by name).

## 배포 (2026-09-15 개정 — 머지는 배포가 아니다)

**main 머지는 프로덕션 배포를 일으키지 않는다.** `vercel.json` 의
`git.deploymentEnabled.main = false` 가 Git 트리거 프로덕션 배포를 막는다.

| 무엇 | 언제 | 어떻게 |
| --- | --- | --- |
| **PR 프리뷰** | PR·피처 브랜치 push | Vercel Git 연동이 자동 생성 (변경 없음) |
| **프로덕션 배포** | 사람이 명시적으로 실행할 때만 | Actions → **Deploy production** → Run workflow |
| **스케줄 배포** | 기본 **비활성** | `ci/github-workflows/deploy-production.yml` 의 `schedule:` 주석 해제 |

```bash
# 명시적 프로덕션 배포 (기본 ref = main)
gh workflow run deploy-production.yml -R Kongventures/hmg-geo -f ref=main
gh run list -R Kongventures/hmg-geo -w deploy-production.yml -L 3
```

- 워크플로가 요구하는 설정: 시크릿 `VERCEL_TOKEN`, 변수 `VERCEL_ORG_ID`·`VERCEL_PROJECT_ID`.
  하나라도 없으면 Preflight 스텝에서 **빌드 전에** 실패한다.
- 승인자를 붙이려면 Settings → Environments → `production` 에 Required reviewers 추가
  (워크플로 수정 불필요).
- **마이그레이션은 여전히 배포와 분리돼 있다** — 아래 DB 절차의 `db:apply` 를 **먼저** 돌린 뒤
  배포한다. 이 워크플로는 마이그레이션을 실행하지 않는다.
- Vercel cron(`/api/cron/*`)은 현재 프로덕션 배포에 붙어 계속 돈다 — 머지가 배포를 안 한다고
  cron 이 멈추지는 않는다. 다만 **cron 코드 변경은 배포를 해야 반영된다.**

## DB 마이그레이션 절차 (2026-08-21 개정 — 반드시 읽을 것)

**적용 경로는 `npm run db:apply -- NNNN` 하나뿐이다. `drizzle-kit migrate` 는 쓰지 않는다.**

왜 — `drizzle-kit migrate` 는 `drizzle.__drizzle_migrations` 의 **가장 큰 created_at 하나**만
읽고, 저널에서 그보다 `when` 이 큰 항목을 **전부 재실행**한다(파일 hash 는 대조하지 않는다).
이 리포는 **0020 부터** 저널 밖에서 손으로 적용해 왔으므로, 운영 DB 에서 그 명령은 이미 적용된
**24개(0020~0043)를 다시 돌린다**. 실측(2026-08-22, 프로덕션): `drizzle.__drizzle_migrations`
= **19행 · max(created_at) = 1782200000000 = `0019_website_sites_prompts`**. `npm run db:migrate` 는 이 사고를 막는 차단기
(`scripts/db/migrate-guard.mjs`)로 대체됐다.

**새 스키마 변경 절차**

1. `lib/db/schema.ts` 를 고친다 (스키마가 정본).
2. `npm run db:generate -- --name=<설명>` → `lib/db/migrations/NNNN_*.sql` 초안 + `meta/NNNN_snapshot.json` 생성.
3. 생성된 SQL 을 **멱등하게 손질한다** — `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` /
   `DROP CONSTRAINT IF EXISTS` 선행 / DML 은 `ON CONFLICT DO NOTHING`. drizzle 이 뽑는 원문은
   멱등하지 않다. 기존 테이블 `ALTER` 는 additive-only(컬럼 추가)만 — 타입 변경·컬럼 삭제는 금지.
4. `npm run db:check` (메타 정합) → `npm run db:apply -- NNNN` (사용자가 실행).
5. `npm run db:drift` 로 적용 결과를 실측 확인한다.

**드리프트 확인 두 경로**: `npm run db:drift`(DATABASE_URL 필요, introspect 로 대조) 또는
`npm run db:drift-sql`(DB 접속 불필요 — 대조 SQL 을 뽑아 Supabase SQL Editor 에
붙여넣는다). 후자는 워크트리·CI 처럼 접속 정보가 없는 환경용이다. 둘 다 읽기 전용.
기준선은 **`schema.ts` 를 직접 읽는다**(2026-09-15) — 종전에는 `meta/` 최신 스냅샷이었는데
0062 부터 `db:generate` 를 안 돌려 스냅샷이 0061 에 멈춰 있었고, 그래서 그 뒤에 추가된
테이블이 전부 `3_EXTRA_IN_DB` 로 떴다. `summary_*`·`webgeo_*`·`crawl_*` 처럼 drizzle 로
모델링한 적이 없는 계열은 결과에서 분류·제외한다(스크립트 상단 `OUT_OF_BAND_PREFIXES`).

**적용 여부의 정본은 저널이 아니라 DB 실측이다.** `meta/_journal.json` 은 이제 파일 목록과
`db:generate` 의 번호 매김을 담당할 뿐, "무엇이 적용됐는지"의 기록이 아니다.

**메타 기준선**: `meta/0043_snapshot.json` 은 2026-08-21 에 `schema.ts` 로부터 재구성한
베이스라인이다(0003~0020 스냅샷은 애초에 만들어진 적이 없다 — `git log` 확인). `db:generate` 는
이 스냅샷을 이전 상태로 보고 diff 한다.

**저널 밖 DDL 이 존재한다**: `scope_*` 미러 5개 테이블은 `scripts/db/scope-mirror.sql` 로,
`prompts`/`scope_mentions` 의 14개 컬럼은 대시보드/MCP 로 적용됐다(후자는
`0044_out_of_band_columns_backfill.sql` 로 회수). **마이그레이션 파일만으로 운영 DB 를 재현할 수
없다** — 신규 환경 구축 순서는 README.md 참고.

First-time setup additionally needs: `psql "$DATABASE_URL" -f scripts/db/lockdown.sql` (revokes anon DB privileges — compensating control for not using RLS), then `npx tsx --env-file=.env.local scripts/db/seed.ts` for demo users.

scope is mock by default (`SCOPE_MODE=mock`); switching to `live` is env-only — set `SCOPE_API_BASE` + `SCOPE_API_KEY`, no code change (see `lib/scope/index.ts`).

## Architecture — the security boundaries

These four boundaries are the load-bearing invariants. Most rules below exist to keep them intact.

### 1. scope is server-only (BFF)

A single workspace API key opens **all** HMG data, so scope must never be called from the browser.

- `lib/scope/server.ts` is the **only** enforced entry point. Route handlers (`app/api/scope/*`) and server components call its functions (`listProjects`, `getProject`, `createProject`/`updateProject`/`deleteProject`, `listPrompts`/`createPrompt`/…, `fetchOverview`, `fetchBrandScores`, `fetchBrandMentions`, `fetchCitations`, `fetchReports`, `fetchUsage`, …). Each call: requires session → audits per-user → (role→project gating) → calls `ScopeClient`.
- `ScopeClient` (`client.ts`) is a **role-blind transport contract** mirroring scope's public `/api/v1` surface (projects/prompts CRUD + result reads + usage/health). It takes no scope filter — scope's public reads are project-scoped aggregates with no value filters. Measurement triggers (`/query`, `/measurements`) and the internal `/results` feed are scope-internal and are deliberately absent. The scope HTTP contract itself is documented in `docs/scope-api-integration.md`.
- **Role→project gating ENFORCES** (2026-07-02, `server.ts::assertProjectInScope`): admin → all; 표준 루트 → all roles except vendor; hq/region/country → project `brand×country` within the account scope (pure predicate `scope-policy.ts::projectInScope`) or an active membership; vendor → active `project_members` row only; unknown project id → default-deny. The gate accepts both local and scope project ids.
- `lib/scope/index.ts::getScopeClient()` picks `MockScopeClient` vs `HttpScopeClient` from `SCOPE_MODE` (default mock). `SCOPE_API_BASE` is the bare host; `http.ts` appends `/api/v1`. `SCOPE_API_KEY` is read only inside `lib/scope/http.ts`. `NEXT_PUBLIC_` prefixing scope env is forbidden. Live-call smoke test: `npm run verify:scope` (drives `HttpScopeClient` directly off `.env.local`, bypassing the enforcement layer).
- Client components must not `fetch` scope directly — call `/api/scope/*` (still enforced by `server.ts`).

### 2. Server-derived scope filters (never trust the client)

`lib/auth/scope-policy.ts::deriveScopeFilter(user)` is the **single source of truth** mapping role → allowed `{brands, regions, countries}`. Client-sent location params are ignored. Adjust role scope here (e.g. the 국가-role open question) — nowhere else.

Route-level access (which URLs each role may visit) lives separately in `lib/auth/route-policy.ts::ROUTES`. Scope-policy decides *values*; route-policy decides *places*. The DashLayout reads `x-pathname` (set by `middleware.ts`) and calls `canAccessRoute()` as a server guard; the sidebar uses `visibleRoutes()` so menu == access. Add a new route to `ROUTES` before linking to it — unknown paths default-deny.

### 3. DB has no RLS — repositories + `scopeWhere` are the compensating control

RLS is intentionally not used (DB lock-in + ops complexity). Instead:

- Raw DB client lives in `lib/db`. **ESLint blocks `@/lib/db` imports from anywhere outside `lib/db/**`** (see `eslint.config.mjs::no-restricted-imports`). Everything else must import a repository from `lib/db/repositories/*`.
- `lib/db/scoped.ts::scopeWhere(scope, cols)` is **default-deny**: missing scope → throws `UnauthorizedError`; `scope.all` → no filter; otherwise `inArray` over brand/region/country columns. There is intentionally no "unscoped" helper — scoped tables can only be queried through this.
- The SQL predicate in `scopeWhere` mirrors the pure `isInScope` in `scope-policy.ts`. Both are unit-tested as the safety net.
- `lib/db` connects directly to Postgres via Drizzle + `postgres` (not `supabase-js` for data) — Supabase is used as managed Postgres + Auth, so a future on-prem move = swap `DATABASE_URL`.

### 4. i18n — no hardcoded JSX strings

All UI text lives in `messages/{ko,en}.json`. JSX must use `next-intl`'s `useTranslations` / `getTranslations`. `npm run check:strings` is a heuristic guard against Korean literals in JSX. A new locale = add file + entry in `i18n/routing.ts`.

UI **terminology** is RESOLVED (2026-07-02, amended 2026-07-23): the repo's CURRENT dictionary values are canonical — do not migrate toward aeorank-style ("인텐트") or scope narrative vocab. New strings should follow the existing terms in `messages/{ko,en}.json` (답변 분석 / 언급 / 인용 / 글로벌 프롬프트 / AI 노출률 계열). 2026-07-23 고객 피드백으로 "표준(Standard)" 계열은 어드민 메뉴까지 전부 "글로벌(Global)"로 개명됨 — 코드 내부 키/경로(`/standard/*`, `group: "standard"`, nav key 등)는 그대로이고 표시 문자열만 글로벌이다. 새 문자열에 "표준"을 쓰지 말 것.

## Visual identity (HMG BI)

All visual tokens are defined **once** in `app/globals.css` (`@theme` block: `--color-brand-700` = `#002c5f`, ink scale, `--color-bg-soft`, accent palette, Hyundai Sans `@font-face`). Components reference tokens — **no hex literals in components**. Quick check: `grep -rnE "#[0-9A-Fa-f]{6}" app components`. Replacing the palette = editing the `@theme` block.

Asset policy: `public/fonts/HyundaiSans*` is **gitignored** (corporate licence). `PretendardVariable.woff2` and `public/brand/*.svg` are committed.

shadcn-style primitives live in `components/ui/*` (config in `components.json`, style "new-york", base "neutral", with CSS variables). Import path alias: `@/*` → repo root.

## Directory map

```
app/
  [locale]/(dash)/     # auth-required: dashboard / projects / standard / customer-interest / admin / no-access
  [locale]/login/      # Supabase Auth
  api/scope/           # BFF route handlers — only legitimate scope egress alongside server components
lib/
  scope/   server.ts (enforced gateway), client.ts (contract), mock.ts, http.ts, index.ts (mode selector)
  auth/    session.ts (Supabase SSR), scope-policy.ts, route-policy.ts, errors.ts, actions.ts
  db/      schema.ts, scoped.ts (scopeWhere), repositories/* (only legal callers of @/lib/db — profiles, projects, prompts, project-members, member-audit-logs, bff-audit-logs, standards, tracked-entities, scope-mirror, scope-aggregates, keyword-cache, keyword-volume-cache)
  viz/     scope ontology viz assets — short-term copy, planned extraction to @answer/ontology-viz
utils/supabase/        # @supabase/ssr clients (auth only — not for data queries)
messages/{ko,en}.json  # the UI string + terminology dictionary
i18n/                  # next-intl routing + request config
scripts/
  paths.json           # 데이터·산출물 경로 정본 (paths.py / paths.cjs 가 읽는다)
  db/lockdown.sql      # revoke anon/PostgREST data access (must be run once per env)
  db/seed.ts           # demo profiles
  db/_input/           # gen-standard-prompts*.mjs 입력 (prompts.txt, prompts_v0.4.txt)
  reports/templates/   # 인용 리포트 렌더러 정본 (citation-v1.1.html, citation-v1.2.html)
  check-hardcoded-strings.mjs
docs/
  *.md                 # 설계·정책 문서
  assets/              # 리포트 생성기가 읽는 자산 (logos/, HMG_brand_color_guide.md)
  deliverables/        # 커밋해 두는 산출물 (소수)
  handoffs/            # 외부 인계 문서
  data/                # ★ git 비추적 데이터 루트 — .gitignore 참조
    1-source/  2-extract/  3-publish/  4-archive/  _tmp/
openspec/              # spec-driven workflow: changes/, specs/, config.yaml (project context)
middleware.ts          # next-intl locale + Supabase session refresh + auth gate + x-pathname header
```

## Spec workflow (OpenSpec)

This repo uses **OpenSpec** for spec-driven development. Authoritative behaviors live under `openspec/specs/` (e.g. `scope-gateway`, `access-control`, `data-access-security`, `persistence-foundation`, `localization`, `visual-identity`, `design-system`, `app-foundation`). Proposed changes live under `openspec/changes/` and graduate to `archive/<date>-<slug>/`. Project context for AI-generated artifacts is in `openspec/config.yaml`. Skills available: `openspec-propose`, `openspec-explore`, `openspec-apply-change`, `openspec-archive-change` (also exposed as `opsx:*`).

When touching one of the protected boundaries above, check whether a spec already constrains it before changing behavior.

## Auth model (concrete)

- Identity: Supabase Auth via `@supabase/ssr`. `middleware.ts` refreshes the session and redirects unauthenticated traffic (outside `/login`) to `/{locale}/login`.
- Role + allowed scope: stored in the `profiles` table (server-controlled — **never `user_metadata`**) and shaped into `User` by `lib/auth/session.ts::getSession()`.
- Roles: `hq | region | country | admin | vendor`. Only `admin` reaches `/admin`; `vendor` (외부 GEO 수행사) sees the Project menu only (no standard/admin). Users with zero menus land on `/no-access`. The role enum lives in `lib/auth/types.ts`; route-level role gating in `lib/auth/route-policy.ts`.
- Per-call attribution: `lib/audit.ts` records "who" called scope — the single workspace key can't differentiate callers. Both audit functions (`auditScopeCall`, `auditDataAccess`) persist to the append-only `bff_audit_logs` table via `lib/db/repositories/bff-audit-logs` (no longer a console placeholder). The write is **fire-and-forget** — dispatched after the response via `after()` (immediate async fallback outside a request context), so it never adds latency to or fails the request; on a sink write failure the payload falls back to `console.error` (no silent loss). Signatures stay synchronous `void`, so callsites are unchanged.

## Raw Data QA Console (`/raw-data-qa`)

측정 데이터를 사람이 눈으로 검수하는 **숨겨진 콘솔**. 답변 원문 옆에 그 답변에 매달린
분석 낱알(`scope_mentions` / `scope_citations` / `scope_acr_rollups` 행 전부)을 펴 놓고,
블록별 OK·이상 판정과 행 단위 노트를 남긴다. 여러 검수자가 락으로 동시에 작업한다.

- `(dash)` **밖**이라 `route-policy.ts::ROUTES` 에 없다. `middleware.ts` 의 `PUBLIC_PATHS`
  가 Supabase 로그인 게이트를 면제하고, `lib/qa/auth.ts` 의 HMAC 서명 세션 쿠키가 대신 막는다
  (검수자는 GGMD 계정이 없는 외부 인력). 쿠키는 **세션 쿠키 + 12시간 하드 만료** —
  브라우저를 닫으면 이름·비번을 다시 받는 것이 요구사항이다.
- `RAW_DATA_QA_ENABLED="1"` 일 때만 존재한다(아니면 전 경로 404). 비밀번호는
  `RAW_DATA_QA_PASSWORD`(기본 `qa-default-redacted`), 쿠키 서명 키는 `RAW_DATA_QA_SECRET`.
  전부 서버 전용, `NEXT_PUBLIC_` 금지.
- ⚠️ **이 표면은 role 스코프 경계를 의도적으로 우회한다** — `lib/db/repositories/qa-review.ts`
  는 `scopeWhere` 를 쓰지 않는다. 2026-09-04 제품 결정이며 근거는
  `docs/specs/2026-09-04-raw-data-qa-console-design.md` §3.
- 검수 산출물은 `qa_*` 테이블 4개(0055)이고 `scope_*` 와 **FK 로 묶지 않는다** —
  `replaceRun`(run 단위 delete+insert)이 정규 재싱크에서 지우기 때문이다(0054 와 같은 논리).
- 표면(글로벌/웹사이트/프로젝트) 판정은 프롬프트 카탈로그가 아니라 **run 의 소속 프로젝트**
  (`scope_runs.project_id` → `website_sites` / `projects` 의 `scope_project_id`)로 한다.

## Things that will trip you up

- **Don't import `@/lib/db` from app/components/lib/scope/etc.** — ESLint blocks it. Add a method to the relevant repository in `lib/db/repositories/*`.
- **Don't add a new `(dash)` route without adding it to `ROUTES` in `lib/auth/route-policy.ts`** — unknown paths default-deny via the server guard.
- **Don't bypass `lib/scope/server.ts`.** Even server components must go through it; instantiating `getScopeClient()` directly skips the auth/audit/filter enforcement.
- **Don't put Korean (or any user-facing text) in JSX.** `check:strings` will flag it; add a key to `messages/{ko,en}.json` and use `useTranslations`.
- **Don't hardcode brand hex in components.** Add/edit a CSS variable in `app/globals.css`.
- **고객 산출물을 검수 없이 업로드하지 말 것.** `verify-artifacts.py` 통과 → 매니페스트 → 업로드 순서다. 파일을 다시 만들었으면 검수도 다시 돌려야 한다(해시가 달라 자동 차단됨).
- **수치를 두 곳에 적지 말 것.** 벤치마크·임계값 같은 값이 리포트 본문·기준표·차트에 각각 박히면 조용히 어긋난다. 상수 한 곳에서 파생시키고, 불가능하면 게이트에 일치 검사를 추가한다.
- **`SCOPE_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only.** Never prefix with `NEXT_PUBLIC_`.
