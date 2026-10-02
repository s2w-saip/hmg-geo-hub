# SNB 표준 프롬프트 열람 화면 — 콘텐츠 기획

> 목적: 역할별 스코프 필터링으로 **표준 프롬프트(Standard Prompt) 카탈로그를 열람**할 수 있는
> SNB(사이드 내비게이션) 진입점과 화면 콘텐츠를 정의한다.
> 본 문서는 기획 문서이며, 구현 착수 전 의사결정용이다.

작성일: 2026-06-15 · **상태: 구현 완료 (2026-06-15)**

> **구현 요약** — route `/standard/prompts` (NON_VENDOR, standard 그룹) 신설, SNB leaf 추가,
> `listStandardCatalogScoped(scope)` 신규 read(브랜드 스코프 + 멀티브랜드 제외 상수), 읽기 전용 페이지/컴포넌트,
> i18n(`standardPromptsView`), 단위 테스트. 검증: tsc/eslint/vitest(244)/check:strings 전부 통과.
> ⚠️ **dev 주의**: 뷰는 admin과 동일하게 루트 카탈로그(`prompts` root project)를 읽음. 데모 시드는
> `standard_prompts`만 채우므로 dev에서 비어 보일 수 있음 — 라이브 카탈로그 로더(gen-standard-prompts-v04)
> 적용 시 정상 노출(= live 미러 원칙).

---

## 1. 배경 · 문제 정의

표준 프롬프트 카탈로그는 현재 **admin 전용**으로만 노출된다.

- 라우트: `/admin/standards/prompts` — `ADMIN_ONLY` ([route-policy.ts:154-159](../../lib/auth/route-policy.ts#L154-L159))
- 화면: 등록/토글/삭제가 가능한 **관리(CRUD)** 화면 ([admin/standards/prompts/page.tsx](../../app/[locale]/(dash)/admin/standards/prompts/page.tsx))

문제: **hq / region / country 역할은 자기 권역에 적용되는 표준 프롬프트가 무엇인지 볼 방법이 없다.**
대시보드·Answer Analysis에서 "측정 결과"는 보지만, 그 결과를 만든 **질문(프롬프트) 카탈로그 자체**는
admin만 본다. 운영 투명성과 권역별 커뮤니케이션을 위해 **열람 전용(read-only) 뷰**가 필요하다.

→ 이 화면의 역할: **"내 권역에 어떤 표준 프롬프트가 돌고 있는가"를 보여주는 읽기 화면.**
관리(등록/수정/삭제)는 admin 화면에 그대로 둔다.

---

## 2. 현재 구조 (As-Is)

### 2.1 데이터 모델 — 표준 프롬프트는 **brand 축으로만** 스코프된다 ⚠️

| 테이블 | 스코프 관련 컬럼 | region/country |
| --- | --- | --- |
| `prompts` (표준 root project) | `brand`(nullable), `listType`, `depth1~4`, `funnelStage`, `scopePromptId` | **없음** |
| `standard_prompts` | `brand`(nullable), `promptType`, `category`, `enabled` | **없음** |
| `scope_prompts` | `promptId`, `text`, `funnelStage` | **없음** |
| `scope_answers` | … | **`region` 있음** (측정 결과 레벨) |

출처: [schema.ts:205-253](../../lib/db/schema.ts#L205-L253), `scope_answers.region` [schema.ts:517-536](../../lib/db/schema.ts#L517-L536)

**핵심**: region/country는 **측정 결과(answer) 레벨**에만 존재한다. 프롬프트 카탈로그 자체에는 없다.

### 2.2 역할 → 스코프 매핑 ([scope-policy.ts:24-34](../../lib/auth/scope-policy.ts#L24-L34))

| Role | brands | regions | countries |
| --- | --- | --- | --- |
| admin | 전체(`all`) | 전체 | 전체 |
| hq | 자사 브랜드 1개 | 전체 | 전체 |
| region | 자사 브랜드 1개 | 자기 권역 1개 | 전체 |
| country | 자사 브랜드 1개 | 자기 권역 1개 | 자기 국가 1개 |

`isInScope` 특이점 ([scope-policy.ts:55-70](../../lib/auth/scope-policy.ts#L55-L70)):
**`brand = null` 행은 "공통(COMMON)"으로 간주되어 모든 brand-스코프 사용자에게 보인다.**
region/country는 공통 의미가 없고 명시적 일치만 허용.

### 2.3 SNB 렌더링 ([components/dash/sidebar.tsx](../../components/dash/sidebar.tsx))

- 1depth = group(`standard` / `project` / `admin`) → GNB 탭
- 2/3depth = 하드코딩 트리(`STANDARD_SUB_ITEMS`, `ADMIN_SUB_ITEMS`, `PROJECT_SUB_ITEMS`)
- `visibleRoutes(role)` + `filterByPerm()`로 역할이 못 보는 항목 제거 ([sidebar.tsx:362-371](../../components/dash/sidebar.tsx#L362-L371))
- **메뉴 == 접근권한**: route-policy의 roles가 곧 서버 가드 ([route-policy.ts:198-216](../../lib/auth/route-policy.ts#L198-L216))

---

## 3. 핵심 의사결정 (확정)

> **확정 (2026-06-15): A1 + B1.**
> 스코프는 **계정에 종속**되며 화면에 별도 스코프/브랜드 필터 UI를 두지 않는다.
> 로그인한 계정의 `deriveScopeFilter(user)`에 따라 보이는 표준 프롬프트 집합이 자동으로 변동된다.
> region/country 세분화(A2)는 실제 요구 확인 시 후속 스펙으로 분리한다.

### 결정 A — "역할별 스코프 필터링"의 실제 의미 ✅ A1 확정

표준 프롬프트엔 region/country 컬럼이 없으므로, 역할 필터는 **brand 축에서만** 의미가 있다.
hq/region/country는 모두 brand 1개로 매핑되므로 셋 다 **"자사 브랜드 프롬프트 + 공통(brand=null) 프롬프트"**
라는 **동일한 집합**을 보게 된다. region/country 역할이라고 더 좁혀지지 않는다.

| 옵션 | 내용 | 트레이드오프 |
| --- | --- | --- |
| **A1 (권장)** | brand 필터로만 스코프. region/country 역할도 동일 집합. "공통+자사 브랜드" 명확히 표기 | 스키마 변경 없음. 즉시 구현. region/country 차별화 없음 |
| A2 | 프롬프트에 region/country 태깅 컬럼 추가 후 역할별 진짜 필터링 | 스키마·시드·admin 등록 UI 변경 큼. scope 연동 영향 |
| A3 | 측정 결과(`scope_answers.region`)로 역집계 → "내 권역에서 실제 측정된 프롬프트만" 노출 | 카탈로그가 아니라 "측정 이력" 뷰가 됨. 의미가 다름 |

→ **확정: A1.** 스코프 필터 UI는 두지 않고 계정 scope에 따라 자동 변동.
region/country 세분화가 실제 요구로 확인되면 A2를 후속 스펙으로.

### 결정 B — SNB 진입 위치 ✅ B1 확정

| 옵션 | 위치 | 비고 |
| --- | --- | --- |
| **B1 (권장)** | `standard` 그룹 하위 신규 leaf `/standard/prompts` | 열람은 "전사 표준 모니터링" 맥락 → standard 그룹이 자연스러움 |
| B2 | Answer Analysis 하위 자식으로 | 답변 분석과 묶이나, 프롬프트는 분석 이전 단계라 IA 어긋남 |
| B3 | admin 화면을 role-aware하게 열어 권한만 확장 | 관리 UI(토글/삭제)를 열람 역할에 노출하는 위험 → 비권장 |

→ **확정: B1.** admin CRUD 화면과 물리적으로 분리된 **읽기 전용 라우트** 신설.

---

## 4. 제안 화면 콘텐츠 (To-Be, A1 + B1 기준)

### 4.1 라우트 · 권한

신규 route-policy 엔트리 ([route-policy.ts:42-118](../../lib/auth/route-policy.ts#L42-L118) standard 그룹에 추가):

```
{ path: "/standard/prompts", key: "standardPrompts", roles: NON_VENDOR, group: "standard" }
```

- `NON_VENDOR` = hq/region/country/admin (vendor 제외 — 수행사는 프로젝트 단위만)
- SNB `STANDARD_SUB_ITEMS`에 leaf 추가, i18n 키 `standardPrompts` → `messages/{ko,en}.json`

### 4.2 화면 구성 — 읽기 전용

```
┌ 표준 프롬프트 (열람)
│  [스코프 배지] 내 권역: Kia · EU  |  보이는 범위: 자사 브랜드 + 공통
│
│  [필터]  Framework(depth1) ▾   Funnel Stage ▾   Presence(branded/unbranded) ▾   검색
│
│  [요약]  총 N개  ·  자사 브랜드 N  ·  공통 N
│
│  ┌ 테이블 (read-only) ──────────────────────────────────────────────
│  │ Prompt text │ Brand │ Framework(listType·depth) │ Funnel │ Presence │
│  └──────────────────────────────────────────────────────────────────
└
```

**스코프 필터 UI 없음**: 상단 [스코프 배지]는 계정에 적용된 범위를 **표시만** 한다(선택 불가).
보이는 프롬프트 집합은 `deriveScopeFilter(user)` 결과로 서버에서 이미 좁혀져 내려온다.
화면의 필터(Framework/Funnel/Presence/검색)는 스코프가 아니라 **콘텐츠 탐색용**이다.

admin 화면 대비 **제거할 것**: Tracking 상태 컬럼(scopePromptId 추적), 토글/삭제/등록 버튼,
scopeOrphans 통계 — 모두 운영 관심사라 열람 뷰에서 뺀다.

**유지할 것**: 프롬프트 텍스트, Brand 배지, Framework(listType+depth1~4), Funnel Stage, Presence(branded/unbranded).
필터는 depth1·funnelStage·검색 정도로 단순화.

컬럼/필터 원본: [admin/.../prompt-list.tsx](../../app/[locale]/(dash)/admin/standards/prompts/_components/prompt-list.tsx)

### 4.3 데이터 흐름

```
page.tsx (server component)
  → lib/scope/server.ts 또는 신규 repository read
  → listStandardCatalog() 재사용 후 scopeWhere(deriveScopeFilter(user))로 brand 필터링
  → admin이면 전체, hq/region/country면 (brand=자사 OR brand=null)
```

- 기존 `listStandardCatalog()` ([standards.ts:137-181](../../lib/db/repositories/standards.ts#L137-L181))는 **스코프 필터 없이 전체**를 반환 → 열람용은
  `scopeWhere`를 태운 **신규 read 함수** 또는 인자 추가가 필요.
- `scopeWhere`는 default-deny이므로 brand=null 공통 처리(`isInScope`)와 동일 술어를 SQL에서 보장해야 함
  ([scoped.ts](../../lib/db/scoped.ts), [development-guide.md](development-guide.md) 경계 #3).

### 4.4 노출 규칙 (확정 2026-06-15)

| 항목 | 규칙 |
| --- | --- |
| **숏리스트 = 추적 중만** | **현재 추적 중(`scope_prompt_id IS NOT NULL`, admin "사용중")인 프롬프트만 노출.** 미추적(미연동) 카탈로그 행은 숨김 — 열람 뷰는 실제 측정되는 것만 보여준다 |
| **공통(brand=null / umbrella 'HMG')** | 노출하고 **"공통" 배지** 부여 |
| **멀티브랜드 "잘못" 프롬프트** | **제외** — 한 프롬프트 문장에 현대/기아/제네시스 중 **2개 이상**이 함께 등장하는 프롬프트는 브랜드 분화가 안 된 오류 데이터이므로 노출하지 않음 |

> **변경 (2026-06-15)**: 초기 안은 "전체 표준 프롬프트(추적 여부 무관)"였으나, 열람 뷰를
> **추적 중인 것만 보여주는 숏리스트**로 좁힘. `listStandardCatalogScoped`가 SQL에서
> `scope_prompt_id IS NOT NULL`로 필터. (비활성/enabled 개념은 루트 `prompts` 카탈로그에
> 없음 — `status`는 lifecycle이라 열람 필터 대상 아님.)

**멀티브랜드 제외 — 방식 확정: 수동 큐레이션 + 백엔드 상수 (2026-06-15)**:
표준 프롬프트는 **고정 세트**이므로 자동 판정(휴리스틱)을 쓰지 않는다. 운영자(사용자)가
전체 프롬프트 리스트를 보고 멀티브랜드 "잘못" 항목을 **직접 판정**하고, 그 제외 목록을
**백엔드 상수로만** 보유한다(admin UI·런타임 텍스트 매칭 없음).

- 위치: 백엔드 상수(예: `lib/scope/standard-prompt-exclusions.ts`)에 제외 prompt id/text 배열.
- read 함수(`listStandardCatalogScoped`)가 이 상수로 최종 필터링.
- 현 데모 시드 12개([seed.ts](../../scripts/db/seed.ts))엔 멀티브랜드 패턴이 0개 → 제외 목록은 빈 배열로 시작,
  실제 라이브 카탈로그 판정 결과를 받아 채운다.
- `brandPresenceOf(brand)` ([brand-presence.ts:21-26](../../lib/scope/brand-presence.ts#L21-L26))는 `brand` 태그 한 칸만 보므로
  "3개 브랜드 동시 등장"을 표현 못 함 → 이 수동 목록이 그 공백을 메운다.

---

## 5. 구현 단계 (A1 + B1 채택 시)

1. **i18n**: `messages/{ko,en}.json`에 `standardPrompts.*` 키(타이틀/필터/스코프 배지/빈 상태) 추가
2. **route-policy**: `/standard/prompts` 엔트리 추가 (NON_VENDOR, standard 그룹)
3. **SNB**: `STANDARD_SUB_ITEMS`에 leaf 추가
4. **repository**: brand 스코프 필터를 태운 read 함수 (`listStandardCatalogScoped(scope)`)
   — `scopeWhere`로 brand(null=공통) 필터, region/country 컬럼 없으므로 brand만
   — **멀티브랜드 잘못 데이터 제외**(§4.4): 텍스트 휴리스틱 채택 시 여기서 필터
5. **page + read-only 컴포넌트**: 관리 액션 제거한 테이블 + 스코프 배지 + (활성/비활성·공통) 상태 배지 + 단순 필터
6. **테스트**: ① 역할별 노출 격리(hq는 타 브랜드 안 보임, 공통은 보임) ② 멀티브랜드 프롬프트 제외 ③ 비활성 노출
   — scope-policy `isInScope`와 SQL `scopeWhere` 일치 검증 (기존 안전망 패턴)

---

## 6. 결정 로그 (2026-06-15)

1. ✅ **결정 A** — A1. 스코프 필터 UI 없이 계정 scope에 따라 자동 변동.
2. ✅ **공통(brand=null) 표기** — "공통" 배지 부여하고 노출.
3. ✅ **vendor** — 제외. `vendor`=GEO 수행사([types.ts:4](../../lib/auth/types.ts#L4))로 standard/admin 메뉴 접근 불가,
   `roles: NON_VENDOR`면 자동 제외되어 별도 처리 불필요.
4. ✅ **비활성 프롬프트** — 노출함(상태 배지로 구분).
5. ✅ **멀티브랜드 잘못 데이터** — 제외(§4.4). 방식: **운영자 수동 판정 + 백엔드 상수**(휴리스틱·admin UI 없음).
6. ✅ **화면 용어** — **(A) 표준 프롬프트**. (admin 기존 용어와 일치)
7. ✅ **제외 목록 초기값** — **빈 배열**. 데모 12개에 멀티브랜드 패턴 없음. 향후 라이브 카탈로그 판정분만 추가.

→ **모든 결정 확정 — 구현 착수 (2026-06-15).**

---

## 부록 — 코드 앵커

| 관심사 | 위치 |
| --- | --- |
| 역할→스코프 매핑 | [scope-policy.ts:24-34](../../lib/auth/scope-policy.ts#L24-L34) |
| brand=null 공통 처리 | [scope-policy.ts:55-70](../../lib/auth/scope-policy.ts#L55-L70) |
| 라우트/권한 테이블 | [route-policy.ts:42-166](../../lib/auth/route-policy.ts#L42-L166) |
| SNB 트리·권한 필터 | [sidebar.tsx:101-189](../../components/dash/sidebar.tsx#L101-L189), [362-371](../../components/dash/sidebar.tsx#L362-L371) |
| 표준 카탈로그 조회 | [standards.ts:137-181](../../lib/db/repositories/standards.ts#L137-L181) |
| 표준 프롬프트 스키마 | [schema.ts:205-253](../../lib/db/schema.ts#L205-L253) |
| admin 관리 화면(참조) | [admin/standards/prompts/page.tsx](../../app/[locale]/(dash)/admin/standards/prompts/page.tsx) |
