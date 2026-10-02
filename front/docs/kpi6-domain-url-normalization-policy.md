# KPI ⑥ 도메인·URL 정규화 정책

**대상**: KPI ⑥ *AI 타겟 URL 인용률* (`citationAccuracy`)
**적용 코드**: [lib/scope/url-match.ts](../lib/scope/url-match.ts) · [lib/db/repositories/scope-aggregates.ts](../lib/db/repositories/scope-aggregates.ts) · [lib/scope/project-sync.ts](../lib/scope/project-sync.ts) · 프로젝트 생성/설정 액션
**검증**: `npm run verify:url-match` (SQL↔JS 정규화 패리티 강제)

---

## 0. 한 줄 요약

`projects.domain`은 **canonical(호스트+선택적 경로) 하나로 저장**하고, 소비처가 필요한 형태를 파생한다:
- **KPI ⑥ 분모(자사 도메인 인용)** ← 저장값 그대로 **경로 프리픽스** 매칭
- **scope 미러 동기화** ← 저장값에서 **호스트만** 잘라 전송
- **KPI ⑥ 분자(타겟 URL)** ← `project_tracked_urls`의 URL, 같은 규칙 정규화(쿼리스트링만 보존)

---

## 1. 왜 정규화가 필요한가

KPI ⑥ = `자사 도메인을 인용한 답변 중, 타겟 URL을 인용한 답변 비율`.

- **분모**: `scope_citations.domain/url`이 우리 사이트를 가리키는가.
- **분자**: 그 중 우리가 지정한 정확한 페이지(추적 URL)를 인용했는가.

scope가 수집한 인용 URL과 우리가 입력한 도메인·URL은 표기가 제각각이다
(`https://` vs `http://`, `www.` 유무, 끝 슬래시, `#fragment`, 대소문자). 정규화
없이 문자열 비교하면 같은 자원인데도 **조용히 누락**되어 인용률이 왜곡된다.

---

## 2. 정규화 규칙 — `normalizeUrlForMatch()`

[lib/scope/url-match.ts](../lib/scope/url-match.ts). 분모·분자·SQL(cnorm)이 **모두 이 규칙**을 따른다.

| 단계 | 처리 | 예 |
|---|---|---|
| 1 | `trim()` | `"  …  "` → `"…"` |
| 2 | `toLowerCase()` | `KIA.com` → `kia.com` |
| 3 | scheme 제거 | `https://` / `http://` → (제거) |
| 4 | 선행 `www.` 제거 | `www.kia.com` → `kia.com` |
| 5 | `#fragment` 제거 | `…/it#:~:text=…` → `…/it` |
| 6 | 끝 슬래시 제거 | `kia.com/it/` → `kia.com/it` |

결과 예: `https://www.KIA.com/it/it/modelli/#top` → `kia.com/it/it/modelli`

### 흡수하는 것 vs 보존하는 것

| 차이 | 처리 | 이유 |
|---|---|---|
| scheme (http/https) | **흡수** | 같은 자원 |
| `www.` (선행만) | **흡수** | 같은 자원. `shop.kia.com` 등 다른 서브도메인은 **보존**(별개) |
| 끝 슬래시 | **흡수** | 같은 자원 |
| `#fragment` (스크롤-투-텍스트 포함) | **흡수** | 항상 클라이언트 전용, 같은 자원 |
| **쿼리스트링 `?…`** | **보존** | 의도적. `?variant=ev`는 다른 페이지일 수 있어 **다른 URL로 취급** |
| 경로 대소문자 | 소문자화로 흡수 | (호스트·경로 모두 소문자) |

> ⚠️ SQL 쪽 동등식(`scope-aggregates.ts`의 `cnorm`)은 이 함수와 **단계까지 동일**해야 한다. `npm run verify:url-match`가 리터럴 SELECT로 SQL↔JS 일치를 강제한다(불일치 시 CI/로컬에서 exit 1).

---

## 3. `projects.domain` — 단일 저장, 소비처별 파생

`projects.domain`은 두 소비처를 겸한다. **저장은 canonical 하나, 파생은 소비처별**이 정책이다.

```
입력: "https://www.KIA.com/it/"
  │  normalizeUrlForMatch (저장 시)
  ▼
저장: projects.domain = "kia.com/it"        ← canonical (호스트+경로)
  ├── KPI ⑥ 분모      → "kia.com/it" 그대로 (경로 프리픽스 매칭)
  └── scope-sync      → domainHost() → "kia.com" (호스트만 전송)
```

### 3.1 저장 시 정규화 (canonical)

- **생성**: [projects/new/\_actions.ts](../app/[locale]/(dash)/projects/new/_actions.ts) — `normalizeUrlForMatch(domain)`
- **수정**: [setting/\_actions.ts::updateProject](../app/[locale]/(dash)/projects/[id]/setting/_actions.ts) — `normalizeUrlForMatch(patch.domain)`

빈 값이면 `null` 저장 → KPI ⑥ 분모는 글로벌 geo-catalog로 fallback(§5).

### 3.2 KPI ⑥ 분모 — 경로 프리픽스 매칭

[scope-aggregates.ts::aggregateCitationAccuracy](../lib/db/repositories/scope-aggregates.ts). 저장된 도메인을 **프리픽스**로 사용:

```sql
cnorm = prefix  OR  cnorm LIKE prefix || '/%'
```

| 저장 domain | 매칭되는 인용 | 매칭 안 되는 인용 |
|---|---|---|
| `kia.com/it` | `kia.com/it`, `kia.com/it/it/modelli` | `kia.com/de`, `kia.com/italy`(경계), `kia.com`(홈) |
| `kia.com` | `kia.com`, `kia.com/it`, `kia.com/de` | `shop.kia.com`(서브도메인) |

- **경로 포함** → 그 하위 경로만 (국가/언어 단위 스코프).
- **호스트만** → 사이트 전체.
- `/it`가 `/italy`를 먹지 않도록 `= prefix OR LIKE prefix||'/%'` 경계 처리.

### 3.3 scope 미러 — 호스트만 — `domainHost()`

scope 프로젝트의 `domain` 필드는 **호스트**(`kia.com`)를 기대한다(mock 예: `hyundai.com`). 그래서 [project-sync.ts](../lib/scope/project-sync.ts)는 전송 시 경로를 잘라 호스트만 보낸다.

```
저장 "kia.com/it"  →  domainHost()  →  scope 로 "kia.com"
```

이 분리가 없으면 scope에 `kia.com/it` 같은 경로 포함 도메인이 들어가 미러가 오염된다.

---

## 4. KPI ⑥ 분자 — 추적 URL (`project_tracked_urls`)

- 저장: `/projects/[id]/setting`의 **추적 URL** 섹션 (엑셀 import 가능). `new URL()` 검증 후 `toString()`으로 저장.
- 매칭: 조회 시 `normalizeUrlForMatch`로 재정규화하여 `cnorm IN (…)` 비교.
- **쿼리스트링 보존**이 핵심: 도메인(분모)과 달리 추적 URL은 특정 랜딩 페이지라, `?utm=…` 등 변형을 다른 URL로 남긴다. scope가 실제 인용하는 URL 표기와 정확히(쿼리 포함) 맞아야 분자에 잡힌다.

---

## 5. Fallback & 엣지 케이스

| 상황 | 동작 |
|---|---|
| `projects.domain` 미설정(null) | 분모 = 글로벌 geo-catalog 호스트 패턴(`GEO_OWNED_DOMAINS`). 프로젝트 도메인이 없어도 KPI가 죽지 않음. 단 전세계 HMG 도메인이 분모라 **과소평가** 가능 → 도메인 설정 권장 |
| 추적 URL 0개 | 분자 대상 없음 → `rate = null` → 카드 "측정 대기" |
| 분모 0 (자사 도메인 인용 답변 없음) | `rate = null` → "측정 대기" |
| scope 미러 비어있음(mock/미동기화) | 분모 0 → null. **KPI ⑥의 최대 전제**: scope 라이브 + 미러 동기화 |
| 서브도메인(`shop.kia.com`) | `www.`만 흡수하므로 별개 호스트로 취급 |

---

## 6. 요약 매트릭스

| 값 | 저장 형태 | 정규화 | 매칭 방식 | 쿼리스트링 |
|---|---|---|---|---|
| `projects.domain` (분모) | 호스트+경로 canonical | `normalizeUrlForMatch` | 경로 프리픽스 (`=` OR `LIKE …/%`) | (도메인엔 없음) |
| scope 미러 domain | 호스트만 | `domainHost` | scope 내부 | — |
| 추적 URL (분자) | 전체 URL | `normalizeUrlForMatch` | 정확 일치 (`IN`) | **보존(구분)** |

---

## 관련 문서

- [docs/feature-spec.md](feature-spec.md) — IA / KPI 개요
- [docs/scope-api-integration.md](scope-api-integration.md) — scope HTTP 계약
- `openspec/specs/scope-gateway` — per-project 측정 스코프(현재 pass-through, KPI ⑥가 root stand-in을 쓰는 원인)
